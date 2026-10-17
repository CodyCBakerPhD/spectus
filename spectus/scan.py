"""
One scan: find what changed in the configured repositories since the last scan, and record the runs that finished.

1. Repositories. The public repositories of each organization (forks only with `include_forks`) and each listed
   repository are looked up through GraphQL, which also follows renames. The answer is cached for a few hours.
2. Change detection. The newest workflow run of each repository is requested from the REST API, conditional on the
   ETag the previous scan got. `304 Not Modified` costs no rate limit and means no run was created and the newest one
   is unchanged, so nothing else is asked about that repository, apart from the runs that had not finished when last
   seen.
3. Listing. Each changed repository's workflows are listed (REST, conditional, so usually `304` as well), and the
   newest runs of every workflow are paged through with GraphQL, many workflows per query, until reaching the newest
   run the previous scan saw (or, on a repository's first scan, the start of the backfill window).
4. Details. Finished runs that are not recorded yet, and runs that were unfinished last time, are fetched in batches
   through GraphQL, summarized as records, validated against the schema, and appended to the `data` branch.

Repositories are scanned in chunks, and the cache is saved after each, so a scan stopped by its time budget or by the
rate limit keeps what it finished and the next scan carries on from there.
"""

import concurrent.futures
import dataclasses
import datetime
import itertools
import typing

from . import queries
from .cache import Cache
from .config import Config
from .github import GitHubClient, GitHubError, RateLimitError, RestResult, Usage
from .records import Record, build_record, format_datetime, parse_datetime, validate_record
from .storage import DataStore

REPOSITORY_LOOKUP_CACHE = datetime.timedelta(hours=6)
# GitHub cancels any workflow run still going after 35 days
PENDING_EXPIRY = datetime.timedelta(days=35)
REPOSITORIES_PER_CHUNK = 25
REPOSITORIES_PER_LOOKUP = 50
REST_THREADS = 8

T = typing.TypeVar("T")


def _batches(items: typing.Iterable[T], size: int, /) -> typing.Iterator[list[T]]:
    iterator = iter(items)
    while batch := list(itertools.islice(iterator, size)):
        yield batch


def _normalize(timestamp: str, /) -> str:
    return format_datetime(parse_datetime(timestamp))


@dataclasses.dataclass
class ScanResult:
    """What a scan did, for its summary."""

    repositories: list[str] = dataclasses.field(default_factory=list)
    changed: list[str] = dataclasses.field(default_factory=list)
    appended: dict[str, int] = dataclasses.field(default_factory=dict)
    pending: int = 0
    warnings: list[str] = dataclasses.field(default_factory=list)
    stopped_early: str | None = None
    usage: Usage = dataclasses.field(default_factory=Usage)


@dataclasses.dataclass
class _Chunk:
    """The work of scanning one chunk of repositories, kept apart until it is complete."""

    probes: dict[str, RestResult] = dataclasses.field(default_factory=dict)
    # The node ids of every run listed
    listed: set[str] = dataclasses.field(default_factory=set)
    newest: dict[str, dict[str, str]] = dataclasses.field(default_factory=dict)
    # Run node id to (repository, created_at)
    pending: dict[str, tuple[str, str]] = dataclasses.field(default_factory=dict)
    # Run node id to repository
    to_fetch: dict[str, str] = dataclasses.field(default_factory=dict)
    records: list[Record] = dataclasses.field(default_factory=list)


class Scanner:
    """Scans the repositories of a configuration and appends their finished workflow runs to a data store."""

    def __init__(  # noqa: PLR0913 (all keyword-only)
        self,
        *,
        client: GitHubClient,
        cache: Cache,
        store: DataStore,
        backfill: datetime.timedelta,
        force: bool = False,
        now: typing.Callable[[], datetime.datetime] = lambda: datetime.datetime.now(tz=datetime.UTC),
    ) -> None:
        self._client = client
        self._cache = cache
        self._store = store
        self._backfill = backfill
        self._force = force
        self._now = now

    def resolve_repositories(self, config: Config, /) -> tuple[list[str], list[str]]:
        """
        List the repositories a configuration covers, by their current `owner/name`.

        Returns
        -------
        repositories : list of str
            Each repository once, sorted case-insensitively.
        warnings : list of str
            Organizations and repositories that could not be found.

        """
        names: dict[str, str] = {}
        warnings: list[str] = []
        for organization in config.organizations:
            after: str | None = None
            while True:
                data = self._client.graphql(
                    queries.OWNER_REPOSITORIES,
                    {"login": organization, "after": after, "isFork": None if config.include_forks else False},
                    cache_for=REPOSITORY_LOOKUP_CACHE,
                )
                if data.get("repositoryOwner") is None:
                    warnings.append(f"{organization}: no such organization or user")
                    break
                connection = data["repositoryOwner"]["repositories"]
                for node in connection["nodes"]:
                    names.setdefault(node["nameWithOwner"].casefold(), node["nameWithOwner"])
                if not connection["pageInfo"]["hasNextPage"]:
                    break
                after = connection["pageInfo"]["endCursor"]

        for batch in _batches(config.repositories, REPOSITORIES_PER_LOOKUP):
            query, variables = queries.repositories_query(batch)
            data = self._client.graphql(query, variables, cache_for=REPOSITORY_LOOKUP_CACHE)
            for index, name in enumerate(batch):
                node = data.get(f"r{index}")
                if node is None:
                    warnings.append(f"{name}: no such repository, or it is not accessible")
                    continue
                names.setdefault(node["nameWithOwner"].casefold(), node["nameWithOwner"])

        return sorted(names.values(), key=str.casefold), warnings

    def scan(self, config: Config, /, *, deadline: datetime.datetime | None = None) -> ScanResult:
        """Scan every repository of a configuration, stopping between chunks once past the deadline."""
        result = ScanResult(usage=self._client.usage)
        try:
            result.repositories, result.warnings = self.resolve_repositories(config)
            self._cache.forget_all_but(result.repositories)
            for chunk in _batches(result.repositories, REPOSITORIES_PER_CHUNK):
                if deadline is not None and self._now() >= deadline:
                    result.stopped_early = "the time budget ran out"
                    break
                self._scan_chunk(chunk, result=result)
                self._cache.save()
        except RateLimitError as exception:
            result.stopped_early = str(exception)

        self._cache.prune_graphql(now=self._now())
        self._cache.save()
        result.pending = sum(len(state["pending"]) for state in self._cache.state.values())
        return result

    def _probe(self, repository: str, /) -> RestResult | str:
        """Ask whether a repository's newest workflow run changed; return why not to scan it if it cannot be."""
        etag = None if self._force else self._cache.repository_state(repository)["runs_etag"]
        try:
            return self._client.rest(f"/repos/{repository}/actions/runs?per_page=1", etag=etag)
        except GitHubError as exception:
            if exception.status in (403, 404):
                return f"{repository}: workflow runs are not accessible ({exception.status})"
            raise

    def _list_workflows(self, repository: str, /) -> list[str] | str:
        try:
            workflows = self._client.rest_all_pages(
                f"/repos/{repository}/actions/workflows?per_page=100",
                key="workflows",
            )
        except GitHubError as exception:
            if exception.status in (403, 404):
                return f"{repository}: workflows are not accessible ({exception.status})"
            raise
        return [workflow["node_id"] for workflow in workflows]

    def _scan_chunk(self, repositories: list[str], /, *, result: ScanResult) -> None:
        chunk = _Chunk()
        workflows = self._find_changes(repositories, chunk=chunk, result=result)
        self._list_runs(workflows, chunk=chunk)
        for repository in repositories:
            for node_id in self._cache.repository_state(repository)["pending"]:
                if node_id not in chunk.listed:
                    chunk.to_fetch[node_id] = repository
        self._fetch_details(chunk)

        appended = self._store.append(chunk.records)
        for repository, count in appended.items():
            result.appended[repository] = result.appended.get(repository, 0) + count
        result.changed += list(chunk.probes)
        self._commit(repositories, chunk=chunk)

    def _find_changes(self, repositories: list[str], /, *, chunk: _Chunk, result: ScanResult) -> list[tuple[str, str]]:
        """Probe each repository for changes, and list the workflows of those that changed as (repository, id)."""
        for repository in repositories:
            self._cache.repository_state(repository)

        workflows: list[tuple[str, str]] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=REST_THREADS) as executor:
            for repository, probe in zip(repositories, executor.map(self._probe, repositories), strict=True):
                if isinstance(probe, str):
                    result.warnings.append(probe)
                elif probe.modified:
                    chunk.probes[repository] = probe

            changed = list(chunk.probes)
            for repository, listed in zip(changed, executor.map(self._list_workflows, changed), strict=True):
                if isinstance(listed, str):
                    result.warnings.append(listed)
                    del chunk.probes[repository]
                    continue
                workflows += [(repository, workflow_id) for workflow_id in listed]
        return workflows

    def _cutoff(self, repository: str, workflow_id: str, /) -> str:
        """Return the creation time at which paging back through a workflow's runs can stop."""
        newest_seen: str | None = self._cache.repository_state(repository)["workflows"].get(workflow_id)
        return newest_seen or format_datetime(self._now() - self._backfill)

    def _list_runs(self, workflows: list[tuple[str, str]], /, *, chunk: _Chunk) -> None:
        """Page through the newest runs of each workflow, noting which need their details fetched."""
        repository_of = {workflow_id: repository for repository, workflow_id in workflows}
        cursors: dict[str, str | None] = dict.fromkeys(repository_of)
        queue = list(repository_of)
        while queue:
            batch, queue = queue[: queries.WORKFLOWS_PER_QUERY], queue[queries.WORKFLOWS_PER_QUERY :]
            query, variables = queries.workflow_runs_query(
                [(workflow_id, cursors[workflow_id]) for workflow_id in batch],
            )
            data = self._client.graphql(query, variables)
            for index, workflow_id in enumerate(batch):
                repository = repository_of[workflow_id]
                runs = (data.get(f"w{index}") or {}).get("runs")
                if runs is None:
                    continue
                nodes = [node for node in runs["nodes"] if node]
                for node in nodes:
                    self._classify(node, repository=repository, workflow_id=workflow_id, chunk=chunk)
                if (
                    runs["pageInfo"]["hasNextPage"]
                    and nodes
                    and _normalize(nodes[-1]["createdAt"]) > self._cutoff(repository, workflow_id)
                ):
                    cursors[workflow_id] = runs["pageInfo"]["endCursor"]
                    queue.append(workflow_id)

    def _classify(self, node: dict[str, typing.Any], /, *, repository: str, workflow_id: str, chunk: _Chunk) -> None:
        chunk.listed.add(node["id"])
        created_at = _normalize(node["createdAt"])
        newest = chunk.newest.setdefault(repository, {})
        newest[workflow_id] = max(newest.get(workflow_id, created_at), created_at)
        if node["checkSuite"]["status"] != "COMPLETED":
            chunk.pending[node["id"]] = (repository, created_at)
        elif not self._store.contains(
            repository=repository,
            run_id=node["databaseId"],
            created_at=created_at,
            updated_at=_normalize(node["updatedAt"]),
        ):
            chunk.to_fetch[node["id"]] = repository

    def _fetch_details(self, chunk: _Chunk, /) -> None:
        for batch in _batches(list(chunk.to_fetch), queries.RUN_DETAILS_PER_QUERY):
            data = self._client.graphql(queries.RUN_DETAILS, {"ids": batch})
            for node_id, node in zip(batch, data["nodes"], strict=True):
                # A run deleted since it was listed comes back null
                if not node:
                    continue
                record = build_record(node)
                if record["status"] != "completed":
                    chunk.pending[node_id] = (chunk.to_fetch[node_id], record["created_at"])
                    continue
                validate_record(record)
                chunk.records.append(record)

    def _commit(self, repositories: list[str], /, *, chunk: _Chunk) -> None:
        """Record the progress of a finished chunk in the cache."""
        oldest_pending = format_datetime(self._now() - PENDING_EXPIRY)
        for repository in repositories:
            state = self._cache.repository_state(repository)
            if repository in chunk.probes:
                state["runs_etag"] = chunk.probes[repository].etag
                for workflow_id, created_at in chunk.newest.get(repository, {}).items():
                    state["workflows"][workflow_id] = max(state["workflows"].get(workflow_id, created_at), created_at)
            state["pending"] = {
                node_id: created_at
                for node_id, (pending_repository, created_at) in chunk.pending.items()
                if pending_repository == repository and created_at >= oldest_pending
            }


def render_summary(result: ScanResult, /) -> str:
    """Describe a scan in Markdown, for the job summary."""
    usage = result.usage
    lines = [
        "## Workflow run scan",
        "",
        f"- Repositories: {len(result.repositories)}, of which {len(result.changed)} had new or changed runs",
        f"- Records appended: {sum(result.appended.values())}",
        f"- Runs still in progress: {result.pending}",
        f"- REST requests: {usage.rest_requests}, of which {usage.rest_not_modified} were answered `304 Not Modified`",
        f"- GraphQL queries: {usage.graphql_requests} costing {usage.graphql_points} points"
        + (f" ({usage.graphql_points_remaining} remaining)" if usage.graphql_points_remaining is not None else "")
        + f", plus {usage.graphql_cached} answered from the cache",
    ]
    if result.stopped_early:
        lines += ["", f"**Stopped early:** {result.stopped_early}. The next scan carries on from here."]
    if result.appended:
        lines += ["", "| Repository | Records appended |", "|---|---|"]
        lines += [f"| `{repository}` | {count} |" for repository, count in sorted(result.appended.items())]
    if result.warnings:
        lines += ["", "### Warnings", ""] + [f"- {warning}" for warning in result.warnings]
    return "\n".join(lines) + "\n"
