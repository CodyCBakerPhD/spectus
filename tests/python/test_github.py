import datetime
import email.message
import io
import json
import pathlib
import typing
import urllib.error

import pytest

from spectus.cache import Cache
from spectus.github import GitHubClient, GitHubError, HttpResponse, RateLimitError, urllib_transport


class ScriptedTransport:
    """Answers each request with the next of a list of responses."""

    def __init__(self, *responses: HttpResponse) -> None:
        self.responses = list(responses)
        self.requests: list[dict] = []

    def __call__(self, *, method, url, headers, body):
        self.requests.append({"method": method, "url": url, "headers": headers, "body": body})
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def ok(payload, **headers) -> HttpResponse:
    return HttpResponse(status=200, headers=headers, body=json.dumps(payload).encode())


def status(code: int, **headers) -> HttpResponse:
    return HttpResponse(status=code, headers=headers, body=b"{}")


def client_for(transport, cache=None) -> tuple[GitHubClient, list[float]]:
    sleeps: list[float] = []
    client = GitHubClient(token="secret", cache=cache or Cache(), transport=transport, sleep=sleeps.append)
    return client, sleeps


def test_requests_are_authenticated():
    transport = ScriptedTransport(ok({}))
    client, _ = client_for(transport)
    client.rest("/rate_limit")
    assert transport.requests[0]["url"] == "https://api.github.com/rate_limit"
    assert transport.requests[0]["headers"]["Authorization"] == "bearer secret"


def test_rest_sends_the_etag_and_reports_not_modified():
    transport = ScriptedTransport(ok({"a": 1}, etag='W/"1"'), status(304, etag='W/"1"'))
    client, _ = client_for(transport)
    first = client.rest("/x")
    assert (first.data, first.etag, first.modified) == ({"a": 1}, 'W/"1"', True)
    assert "If-None-Match" not in transport.requests[0]["headers"]

    second = client.rest("/x", etag=first.etag)
    assert transport.requests[1]["headers"]["If-None-Match"] == 'W/"1"'
    assert (second.data, second.modified) == (None, False)
    assert (client.usage.rest_requests, client.usage.rest_not_modified) == (2, 1)


def test_rest_cached_serves_unchanged_resources_from_the_cache(tmp_path: pathlib.Path):
    cache = Cache(tmp_path)
    transport = ScriptedTransport(
        ok({"items": [1]}, etag='"e"', link='<https://api.github.com/x?page=2>; rel="next"'),
        status(304),
    )
    client, _ = client_for(transport, cache)
    assert client.rest_cached("/x").data == {"items": [1]}
    cache.save()

    client, _ = client_for(transport, Cache(tmp_path))
    result = client.rest_cached("/x")
    assert transport.requests[1]["headers"]["If-None-Match"] == '"e"'
    assert result.data == {"items": [1]}
    assert result.next_url == "https://api.github.com/x?page=2"
    assert result.modified is False


def test_rest_all_pages_follows_the_link_header():
    transport = ScriptedTransport(
        ok(
            {"workflows": [1, 2]},
            link='<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=2>; rel="last"',
        ),
        ok({"workflows": [3]}),
    )
    client, _ = client_for(transport)
    assert client.rest_all_pages("/x", key="workflows") == [1, 2, 3]
    assert transport.requests[1]["url"] == "https://api.github.com/x?page=2"


def test_server_errors_are_retried_with_backoff():
    transport = ScriptedTransport(status(502), status(503), ok({"done": True}))
    client, sleeps = client_for(transport)
    assert client.rest("/x").data == {"done": True}
    assert sleeps == [1, 2]


def test_network_errors_are_retried():
    transport = ScriptedTransport(ConnectionResetError(), ok({"done": True}))
    client, sleeps = client_for(transport)
    assert client.rest("/x").data == {"done": True}
    assert sleeps == [1]


def test_persistent_network_errors_raise():
    transport = ScriptedTransport(*[TimeoutError()] * 5)
    client, _ = client_for(transport)
    with pytest.raises(GitHubError, match="failed"):
        client.rest("/x")


def test_persistent_server_errors_raise():
    transport = ScriptedTransport(*[status(500)] * 5)
    client, _ = client_for(transport)
    with pytest.raises(GitHubError, match="500") as raised:
        client.rest("/x")
    assert raised.value.status == 500


def test_secondary_rate_limits_are_waited_out():
    transport = ScriptedTransport(status(403, **{"retry-after": "30"}), ok({}))
    client, sleeps = client_for(transport)
    client.rest("/x")
    assert sleeps == [30]


def test_an_exhausted_rate_limit_raises():
    transport = ScriptedTransport(status(403, **{"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1792332000"}))
    client, _ = client_for(transport)
    with pytest.raises(RateLimitError, match="2026"):
        client.rest("/x")


def test_other_client_errors_raise_with_their_status():
    transport = ScriptedTransport(status(404))
    client, _ = client_for(transport)
    with pytest.raises(GitHubError) as raised:
        client.rest("/x")
    assert raised.value.status == 404


def test_graphql_returns_data_and_tracks_points():
    transport = ScriptedTransport(
        ok({"data": {"rateLimit": {"cost": 3, "remaining": 4990}, "viewer": {"login": "me"}}}),
    )
    client, _ = client_for(transport)
    data = client.graphql("query { viewer { login } }", {"a": 1})
    assert data["viewer"] == {"login": "me"}
    assert json.loads(transport.requests[0]["body"]) == {"query": "query { viewer { login } }", "variables": {"a": 1}}
    assert (client.usage.graphql_points, client.usage.graphql_points_remaining) == (3, 4990)


def test_graphql_responses_are_cached_when_asked(tmp_path: pathlib.Path):
    cache = Cache(tmp_path)
    transport = ScriptedTransport(ok({"data": {"x": 1}}), ok({"data": {"x": 2}}))
    client, _ = client_for(transport, cache)
    hour = datetime.timedelta(hours=1)
    assert client.graphql("query { x }", cache_for=hour) == {"x": 1}
    assert client.graphql("query { x }", cache_for=hour) == {"x": 1}
    assert client.graphql("query { x }", {"different": True}, cache_for=hour) == {"x": 2}
    assert client.usage.graphql_cached == 1
    assert len(transport.requests) == 2


def test_expired_graphql_responses_are_fetched_again():
    cache = Cache()
    transport = ScriptedTransport(ok({"data": {"x": 1}}), ok({"data": {"x": 2}}))
    client, _ = client_for(transport, cache)
    client.graphql("query { x }", cache_for=datetime.timedelta(seconds=-1))
    assert client.graphql("query { x }", cache_for=datetime.timedelta(hours=1)) == {"x": 2}

    cache.prune_graphql(now=datetime.datetime.now(tz=datetime.UTC) + datetime.timedelta(hours=2))
    assert cache.graphql == {}


def test_graphql_tolerates_missing_nodes():
    errors = [{"type": "NOT_FOUND", "message": "Could not resolve to a node"}]
    transport = ScriptedTransport(ok({"data": {"nodes": [None, {"id": "b"}]}, "errors": errors}))
    client, _ = client_for(transport)
    assert client.graphql("query { nodes }")["nodes"] == [None, {"id": "b"}]


def test_graphql_raises_on_other_errors():
    transport = ScriptedTransport(ok({"data": None, "errors": [{"message": "Parse error"}]}))
    client, _ = client_for(transport)
    with pytest.raises(GitHubError, match="Parse error"):
        client.graphql("query {")


def test_graphql_raises_on_its_rate_limit():
    transport = ScriptedTransport(ok({"data": None, "errors": [{"type": "RATE_LIMITED", "message": "API rate limit"}]}))
    client, _ = client_for(transport)
    with pytest.raises(RateLimitError):
        client.graphql("query { x }")


def test_graphql_raises_on_http_errors():
    transport = ScriptedTransport(status(401))
    client, _ = client_for(transport)
    with pytest.raises(GitHubError, match="401"):
        client.graphql("query { x }")


def test_urllib_transport_refuses_other_hosts():
    with pytest.raises(ValueError, match="outside"):
        urllib_transport(method="GET", url="https://example.com/", headers={}, body=None)


class FakeUrlopenResponse:
    status = 200
    headers: typing.ClassVar = {"ETag": '"x"'}

    def __enter__(self):
        return self

    def __exit__(self, *exception):
        return False

    def read(self):
        return b'{"ok": true}'


def test_urllib_transport_returns_responses(monkeypatch):
    monkeypatch.setattr("urllib.request.urlopen", lambda request, timeout: FakeUrlopenResponse())
    response = urllib_transport(method="GET", url="https://api.github.com/x", headers={}, body=None)
    assert (response.status, response.headers, response.body) == (200, {"etag": '"x"'}, b'{"ok": true}')


def test_urllib_transport_returns_error_statuses_rather_than_raising(monkeypatch):
    def not_modified(request, timeout):
        headers = email.message.Message()
        headers["ETag"] = '"x"'
        raise urllib.error.HTTPError(request.full_url, 304, "Not Modified", headers, io.BytesIO(b""))

    monkeypatch.setattr("urllib.request.urlopen", not_modified)
    response = urllib_transport(method="GET", url="https://api.github.com/x", headers={}, body=None)
    assert (response.status, response.headers) == (304, {"etag": '"x"'})
