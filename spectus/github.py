"""
A small client for the GitHub REST and GraphQL APIs.

REST requests are made conditional whenever an ETag is known for them: GitHub answers an unchanged resource with
`304 Not Modified`, which does not count against the rate limit. GraphQL requests cannot be made conditional, so those
whose answer changes slowly are cached for a while instead. Every request is retried on server errors and on GitHub's
secondary rate limits; running out of the primary rate limit raises `RateLimitError` so a scan can stop and keep what
it has.
"""

import dataclasses
import datetime
import hashlib
import json
import threading
import time
import typing
import urllib.error
import urllib.request

from .cache import Cache

API_URL = "https://api.github.com"
GRAPHQL_URL = f"{API_URL}/graphql"

JSON = typing.Any

_RETRIES = 4
_LONGEST_WAIT_SECONDS = 120
# A GraphQL query that asks for a node that no longer exists still answers for every other node
_TOLERATED_GRAPHQL_ERRORS = frozenset({"NOT_FOUND"})


class GitHubError(RuntimeError):
    """A request to GitHub that failed."""

    def __init__(self, message: str, /, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class RateLimitError(GitHubError):
    """The primary rate limit is exhausted; no request will succeed until it resets."""


@dataclasses.dataclass(frozen=True)
class HttpResponse:
    """What a transport returns: the status, the headers (with lowercase names), and the raw body."""

    status: int
    headers: dict[str, str]
    body: bytes


class Transport(typing.Protocol):
    """Sends one HTTP request; swapped out in tests."""

    def __call__(self, *, method: str, url: str, headers: dict[str, str], body: bytes | None) -> HttpResponse:
        """Send the request and return the response, whatever its status."""


def urllib_transport(*, method: str, url: str, headers: dict[str, str], body: bytes | None) -> HttpResponse:
    """Send a request to the GitHub API with `urllib`."""
    if not url.startswith(f"{API_URL}/"):
        message = f"Refusing to request a URL outside of {API_URL}: {url}"
        raise ValueError(message)

    request = urllib.request.Request(url=url, method=method, headers=headers, data=body)  # noqa: S310 (checked above)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 (scheme is checked above)
            return HttpResponse(
                status=response.status,
                headers={key.lower(): value for key, value in response.headers.items()},
                body=response.read(),
            )
    except urllib.error.HTTPError as exception:
        # urllib raises for every status of 300 and above, including the 304 a conditional request hopes for
        return HttpResponse(
            status=exception.code,
            headers={key.lower(): value for key, value in exception.headers.items()},
            body=exception.read(),
        )


@dataclasses.dataclass
class Usage:
    """What a client has spent, for the scan summary."""

    rest_requests: int = 0
    rest_not_modified: int = 0
    graphql_requests: int = 0
    graphql_cached: int = 0
    graphql_points: int = 0
    graphql_points_remaining: int | None = None


@dataclasses.dataclass(frozen=True)
class RestResult:
    """A REST response: its JSON body, its ETag, its next page, and whether it changed since the ETag sent."""

    data: JSON
    etag: str | None
    next_url: str | None
    modified: bool


def _next_link(link_header: str, /) -> str | None:
    for part in link_header.split(","):
        url, _, parameters = part.partition(";")
        if 'rel="next"' in parameters:
            return url.strip().removeprefix("<").removesuffix(">")
    return None


class GitHubClient:
    """Authenticated access to the GitHub API, with conditional REST requests and cached GraphQL queries."""

    def __init__(
        self,
        *,
        token: str,
        cache: Cache,
        transport: Transport = urllib_transport,
        sleep: typing.Callable[[float], None] = time.sleep,
        now: typing.Callable[[], datetime.datetime] = lambda: datetime.datetime.now(tz=datetime.UTC),
    ) -> None:
        self._token = token
        self._cache = cache
        self._transport = transport
        self._sleep = sleep
        self._now = now
        # REST requests are made from several threads at once
        self._lock = threading.Lock()
        self.usage = Usage()

    def _send(self, *, method: str, url: str, headers: dict[str, str], body: bytes | None = None) -> HttpResponse:
        headers = {
            "Authorization": f"bearer {self._token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "spectus-scan",
            **headers,
        }
        for attempt in range(_RETRIES + 1):
            try:
                response = self._transport(method=method, url=url, headers=headers, body=body)
            except OSError as exception:
                if attempt == _RETRIES:
                    message = f"{method} {url} failed: {exception}"
                    raise GitHubError(message) from exception
                self._sleep(2**attempt)
                continue

            wait = self._wait_before_retry(response=response, attempt=attempt)
            if wait is None or attempt == _RETRIES:
                return response
            self._sleep(wait)

        message = f"{method} {url} failed after {_RETRIES} retries"  # pragma: no cover (the loop always returns)
        raise GitHubError(message)  # pragma: no cover

    @staticmethod
    def _wait_before_retry(*, response: HttpResponse, attempt: int) -> float | None:
        """Return how long to wait before retrying the request that got this response, or None not to retry."""
        if response.status in (403, 429):
            if response.headers.get("x-ratelimit-remaining") == "0":
                reset = int(response.headers.get("x-ratelimit-reset", "0"))
                message = f"Rate limit exhausted until {datetime.datetime.fromtimestamp(reset, tz=datetime.UTC)}"
                raise RateLimitError(message, status=response.status)
            if "retry-after" in response.headers:
                return min(float(response.headers["retry-after"]), _LONGEST_WAIT_SECONDS)
            return None
        if response.status >= 500:
            return float(2**attempt)
        return None

    def rest(self, path_or_url: str, /, *, etag: str | None = None) -> RestResult:
        """
        Make a GET request to the REST API, conditional on `etag` if one is given.

        An unchanged resource comes back with `modified` False and no data.
        """
        url = path_or_url if path_or_url.startswith(API_URL) else f"{API_URL}{path_or_url}"
        response = self._send(method="GET", url=url, headers={"If-None-Match": etag} if etag else {})
        with self._lock:
            self.usage.rest_requests += 1
            if response.status == 304:
                self.usage.rest_not_modified += 1
        next_url = _next_link(response.headers.get("link", ""))
        if response.status == 304:
            return RestResult(data=None, etag=etag, next_url=next_url, modified=False)
        if response.status != 200:
            message = f"GET {url} returned {response.status}: {response.body[:500]!r}"
            raise GitHubError(message, status=response.status)

        return RestResult(
            data=json.loads(response.body),
            etag=response.headers.get("etag"),
            next_url=next_url,
            modified=True,
        )

    def rest_cached(self, path_or_url: str, /) -> RestResult:
        """Make a GET request to the REST API through the cache: a resource that has not changed is served from it."""
        url = path_or_url if path_or_url.startswith(API_URL) else f"{API_URL}{path_or_url}"
        cached = self._cache.rest.get(url)
        result = self.rest(url, etag=cached["etag"] if cached else None)
        if not result.modified and cached is not None:
            return dataclasses.replace(result, data=cached["data"], next_url=cached["next_url"])

        if result.etag is not None:
            self._cache.rest[url] = {"etag": result.etag, "data": result.data, "next_url": result.next_url}
        return result

    def rest_all_pages(self, path: str, /, *, key: str) -> list[JSON]:
        """Collect the items under `key` from every page of a paginated REST resource, through the cache."""
        items: list[JSON] = []
        next_url: str | None = path
        while next_url is not None:
            result = self.rest_cached(next_url)
            items += result.data[key]
            next_url = result.next_url
        return items

    def graphql(
        self,
        query: str,
        /,
        variables: dict[str, JSON] | None = None,
        *,
        cache_for: datetime.timedelta | None = None,
    ) -> JSON:
        """
        Run a GraphQL query and return its data.

        With `cache_for`, an identical query made again within that time is answered from the cache. Errors about
        nodes that do not exist are tolerated, leaving those nodes null in the data; any other error raises.
        """
        variables = variables or {}
        key = hashlib.sha256(json.dumps([query, variables], sort_keys=True).encode()).hexdigest()
        now = self._now()
        if cache_for is not None:
            cached = self._cache.get_graphql(key, now=now)
            if cached is not None:
                self.usage.graphql_cached += 1
                return cached

        response = self._send(
            method="POST",
            url=GRAPHQL_URL,
            headers={"Content-Type": "application/json"},
            body=json.dumps({"query": query, "variables": variables}).encode(),
        )
        self.usage.graphql_requests += 1
        if response.status != 200:
            message = f"GraphQL query returned {response.status}: {response.body[:500]!r}"
            raise GitHubError(message, status=response.status)

        payload = json.loads(response.body)
        errors = payload.get("errors") or []
        if any(error.get("type") == "RATE_LIMITED" for error in errors):
            message = "GraphQL rate limit exhausted"
            raise RateLimitError(message)
        fatal = [error for error in errors if error.get("type") not in _TOLERATED_GRAPHQL_ERRORS]
        data = payload.get("data")
        if fatal or data is None:
            message = f"GraphQL query failed: {json.dumps(fatal or errors)[:1000]}"
            raise GitHubError(message)

        rate_limit = data.get("rateLimit") or {}
        self.usage.graphql_points += rate_limit.get("cost", 0)
        self.usage.graphql_points_remaining = rate_limit.get("remaining", self.usage.graphql_points_remaining)
        if cache_for is not None:
            self._cache.put_graphql(key, data, expires_at=now + cache_for)
        return data
