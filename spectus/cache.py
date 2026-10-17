"""
What one scan leaves for the next, so that it only asks GitHub about what changed.

The cache is a directory of JSON files, restored before and saved after each scan by `actions/cache`. Losing it costs
API calls, not data: the records on the `data` branch are what decides whether a run is new, so a scan without a cache
looks back over the backfill window again and appends nothing it already has.

- `rest.json` holds the ETag and body of each cached REST response, so that a repeated request can be made
  conditional; GitHub answers an unchanged resource with `304 Not Modified`, which costs no rate limit.
- `graphql.json` holds GraphQL responses that are reused until they expire, such as the repositories of an
  organization.
- `state.json` holds the progress of the scan per repository: the ETag of its latest workflow runs, the newest run
  seen of each workflow, and the runs that had not finished when last seen.
"""

import datetime
import json
import pathlib
import typing

JSON = typing.Any

_FILES = ("rest", "graphql", "state")


def _repository_of(url: str, /) -> str:
    """Return the `owner/name` of a REST API URL such as `https://api.github.com/repos/owner/name/actions/runs`."""
    _, _, path = url.partition("/repos/")
    return "/".join(path.split("/")[:2])


class Cache:
    """The scan cache, held in memory and written back to its directory by `save`."""

    def __init__(self, directory: pathlib.Path | None = None) -> None:
        self.directory = directory
        self.rest: dict[str, dict[str, JSON]] = {}
        self.graphql: dict[str, dict[str, JSON]] = {}
        self.state: dict[str, dict[str, JSON]] = {}
        if directory is None:
            return

        for name in _FILES:
            path = directory / f"{name}.json"
            if path.exists():
                setattr(self, name, json.loads(path.read_text()))

    def save(self) -> None:
        """Write the cache to its directory, if it has one."""
        if self.directory is None:
            return

        self.directory.mkdir(parents=True, exist_ok=True)
        for name in _FILES:
            path = self.directory / f"{name}.json"
            temporary_path = path.with_suffix(".json.tmp")
            temporary_path.write_text(json.dumps(getattr(self, name), separators=(",", ":")))
            temporary_path.replace(path)

    def repository_state(self, repository: str, /) -> dict[str, JSON]:
        """Return the mutable progress record of a repository, creating an empty one if there is none."""
        return self.state.setdefault(repository, {"runs_etag": None, "workflows": {}, "pending": {}})

    def forget_all_but(self, repositories: list[str], /) -> None:
        """Drop the progress and cached responses of every repository not among `repositories`."""
        kept = set(repositories)
        self.state = {repository: state for repository, state in self.state.items() if repository in kept}
        self.rest = {url: entry for url, entry in self.rest.items() if _repository_of(url) in kept}

    def get_graphql(self, key: str, /, *, now: datetime.datetime) -> JSON | None:
        """Return the cached data of a GraphQL request, or None if there is none or it has expired."""
        entry = self.graphql.get(key)
        if entry is None or datetime.datetime.fromisoformat(entry["expires_at"]) <= now:
            return None
        return entry["data"]

    def put_graphql(self, key: str, data: JSON, /, *, expires_at: datetime.datetime) -> None:
        """Cache the data of a GraphQL request until `expires_at`."""
        self.graphql[key] = {"expires_at": expires_at.isoformat(), "data": data}

    def prune_graphql(self, *, now: datetime.datetime) -> None:
        """Drop every cached GraphQL response that has expired."""
        self.graphql = {
            key: entry
            for key, entry in self.graphql.items()
            if datetime.datetime.fromisoformat(entry["expires_at"]) > now
        }
