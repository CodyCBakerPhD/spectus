"""
An in-memory GitHub that answers the REST and GraphQL requests a scan makes.

Repositories hold workflows, and workflows hold runs. REST responses carry an ETag derived from their body and answer
a matching `If-None-Match` with `304 Not Modified`, as GitHub does. GraphQL queries are recognized by what they select.
"""

import dataclasses
import hashlib
import json
import re
import typing
import urllib.parse

from spectus.github import API_URL, HttpResponse

PAGE_SIZE_PATTERN = re.compile(r"runs\(first: (\d+)")


@dataclasses.dataclass
class Run:
    database_id: int
    workflow: "Workflow"
    created_at: str
    updated_at: str
    status: str = "COMPLETED"
    conclusion: str | None = "SUCCESS"
    run_number: int = 1
    event: str = "push"
    branch: str | None = "main"
    sha: str = "0" * 40
    actor: str | None = "octocat"
    jobs: list[tuple[str | None, str | None]] = dataclasses.field(default_factory=list)

    @property
    def node_id(self) -> str:
        return f"WFR_{self.database_id}"


@dataclasses.dataclass
class Workflow:
    node_id: str
    name: str
    path: str
    repository: "Repository"
    runs: list[Run] = dataclasses.field(default_factory=list)


@dataclasses.dataclass
class Repository:
    name_with_owner: str
    fork: bool = False
    private: bool = False
    workflows: list[Workflow] = dataclasses.field(default_factory=list)


def _response(status: int, payload: object = None, *, headers: dict[str, str] | None = None) -> HttpResponse:
    body = b"" if payload is None else json.dumps(payload).encode()
    return HttpResponse(status=status, headers=headers or {}, body=body)


class FakeGitHub:
    """A transport (see `spectus.github.Transport`) backed by in-memory repositories."""

    def __init__(self) -> None:
        self.repositories: dict[str, Repository] = {}
        self.renamed: dict[str, str] = {}
        self.requests: list[tuple[str, str, dict[str, str], typing.Any]] = []
        self.graphql_errors: list[dict] = []
        self.failures: list[HttpResponse] = []
        self._next_run_id = 1000

    # ── Building the world ──────────────────────────────────────────────────────────────────────────────────────────

    def add_repository(self, name_with_owner: str, *, fork: bool = False, private: bool = False) -> Repository:
        repository = Repository(name_with_owner=name_with_owner, fork=fork, private=private)
        self.repositories[name_with_owner] = repository
        return repository

    def add_workflow(self, repository: Repository, name: str, path: str | None = None) -> Workflow:
        index = len(repository.workflows)
        workflow = Workflow(
            node_id=f"W_{repository.name_with_owner}_{index}",
            name=name,
            path=path or f".github/workflows/{name.lower().replace(' ', '-')}.yml",
            repository=repository,
        )
        repository.workflows.append(workflow)
        return workflow

    def add_run(self, workflow: Workflow, created_at: str, **fields: object) -> Run:
        self._next_run_id += 1
        fields.setdefault("updated_at", created_at)
        fields.setdefault("run_number", len(workflow.runs) + 1)
        run = Run(database_id=self._next_run_id, workflow=workflow, created_at=created_at, **fields)  # type: ignore[arg-type]
        workflow.runs.append(run)
        return run

    # ── Inspecting what was asked ───────────────────────────────────────────────────────────────────────────────────

    def graphql_queries(self, containing: str = "") -> list[dict]:
        return [body for method, _, _, body in self.requests if method == "POST" and containing in body["query"]]

    def rest_requests(self, containing: str = "") -> list[tuple[str, dict[str, str]]]:
        return [(url, headers) for method, url, headers, _ in self.requests if method == "GET" and containing in url]

    def clear_requests(self) -> None:
        self.requests.clear()

    # ── The transport ───────────────────────────────────────────────────────────────────────────────────────────────

    def __call__(self, *, method: str, url: str, headers: dict[str, str], body: bytes | None) -> HttpResponse:
        payload: typing.Any = json.loads(body) if body else None
        self.requests.append((method, url, headers, payload))
        if self.failures:
            return self.failures.pop(0)
        if method == "POST":
            return self._graphql(payload)
        return self._rest(url, headers)

    def _with_etag(self, payload: object, headers: dict[str, str]) -> HttpResponse:
        etag = 'W/"' + hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16] + '"'
        if headers.get("If-None-Match") == etag:
            return _response(304, headers={"etag": etag})
        return _response(200, payload, headers={"etag": etag})

    def _rest(self, url: str, headers: dict[str, str]) -> HttpResponse:
        parsed = urllib.parse.urlparse(url.removeprefix(API_URL))
        match = re.fullmatch(r"/repos/([^/]+/[^/]+)/actions/(runs|workflows)", parsed.path)
        repository = self.repositories.get(match.group(1)) if match else None
        if match is None or repository is None:
            return _response(404, {"message": "Not Found"})

        if match.group(2) == "workflows":
            workflows = [
                {"node_id": workflow.node_id, "name": workflow.name, "path": workflow.path, "state": "active"}
                for workflow in repository.workflows
            ]
            return self._with_etag({"total_count": len(workflows), "workflows": workflows}, headers)

        runs = sorted(
            (run for workflow in repository.workflows for run in workflow.runs),
            key=lambda run: (run.created_at, run.database_id),
            reverse=True,
        )
        newest = [
            {"id": run.database_id, "status": run.status.lower(), "updated_at": run.updated_at} for run in runs[:1]
        ]
        return self._with_etag({"total_count": len(runs), "workflow_runs": newest}, headers)

    def _graphql(self, payload: dict) -> HttpResponse:
        query, variables = payload["query"], payload["variables"]
        if "repositoryOwner" in query:
            data = self._owner_repositories(variables)
        elif "repository(owner:" in query:
            data = self._repositories(variables)
        elif "... on Workflow " in query:
            data = self._workflow_runs(query, variables)
        elif "... on WorkflowRun" in query:
            data = {"nodes": [self._run_details(node_id) for node_id in variables["ids"]]}
        else:  # pragma: no cover
            message = f"Unexpected query: {query}"
            raise AssertionError(message)

        data["rateLimit"] = {"cost": 1, "remaining": 4999}
        response: dict = {"data": data}
        if self.graphql_errors:
            response["errors"] = self.graphql_errors
        return _response(200, response)

    def _owner_repositories(self, variables: dict) -> dict:
        login = variables["login"].casefold()
        owned = [
            repository
            for name, repository in sorted(self.repositories.items(), key=lambda item: item[0].casefold())
            if name.split("/")[0].casefold() == login and not repository.private
        ]
        if not owned:
            return {"repositoryOwner": None}
        if variables["isFork"] is not None:
            owned = [repository for repository in owned if repository.fork == variables["isFork"]]
        start = int(variables["after"] or 0)
        page = owned[start : start + 100]
        return {
            "repositoryOwner": {
                "repositories": {
                    "pageInfo": {"hasNextPage": start + 100 < len(owned), "endCursor": str(start + 100)},
                    "nodes": [{"nameWithOwner": repository.name_with_owner} for repository in page],
                },
            },
        }

    def _repositories(self, variables: dict) -> dict:
        data: dict = {}
        for key, owner in variables.items():
            if not key.startswith("owner"):
                continue
            index = key.removeprefix("owner")
            name = self.renamed.get(f"{owner}/{variables[f'name{index}']}", f"{owner}/{variables[f'name{index}']}")
            found = next(
                (repository for key, repository in self.repositories.items() if key.casefold() == name.casefold()),
                None,
            )
            data[f"r{index}"] = {"nameWithOwner": found.name_with_owner} if found else None
        return data

    def _workflows_by_id(self) -> dict[str, Workflow]:
        return {
            workflow.node_id: workflow for repository in self.repositories.values() for workflow in repository.workflows
        }

    def _workflow_runs(self, query: str, variables: dict) -> dict:
        page_size = int(typing.cast("re.Match[str]", PAGE_SIZE_PATTERN.search(query)).group(1))
        workflows = self._workflows_by_id()
        data: dict = {}
        for key, workflow_id in variables.items():
            if not key.startswith("id"):
                continue
            index = key.removeprefix("id")
            workflow = workflows.get(workflow_id)
            if workflow is None:
                data[f"w{index}"] = None
                continue
            runs = sorted(workflow.runs, key=lambda run: (run.created_at, run.database_id), reverse=True)
            start = int(variables[f"after{index}"] or 0)
            page = runs[start : start + page_size]
            data[f"w{index}"] = {
                "runs": {
                    "pageInfo": {"hasNextPage": start + page_size < len(runs), "endCursor": str(start + page_size)},
                    "nodes": [
                        {
                            "id": run.node_id,
                            "databaseId": run.database_id,
                            "createdAt": run.created_at,
                            "updatedAt": run.updated_at,
                            "checkSuite": {"status": run.status},
                        }
                        for run in page
                    ],
                },
            }
        return data

    def _run_details(self, node_id: str) -> dict | None:
        runs = {run.node_id: run for workflow in self._workflows_by_id().values() for run in workflow.runs}
        run = runs.get(node_id)
        if run is None:
            return None
        return {
            "id": run.node_id,
            "databaseId": run.database_id,
            "runNumber": run.run_number,
            "event": run.event,
            "createdAt": run.created_at,
            "updatedAt": run.updated_at,
            "url": f"https://github.com/{run.workflow.repository.name_with_owner}/actions/runs/{run.database_id}",
            "file": {"path": run.workflow.path},
            "workflow": {"name": run.workflow.name},
            "checkSuite": {
                "status": run.status,
                "conclusion": run.conclusion if run.status == "COMPLETED" else None,
                "branch": {"name": run.branch} if run.branch else None,
                "commit": {"oid": run.sha},
                "creator": {"login": run.actor} if run.actor else None,
                "repository": {"nameWithOwner": run.workflow.repository.name_with_owner},
                "checkRuns": {
                    "nodes": [{"startedAt": started, "completedAt": completed} for started, completed in run.jobs],
                },
            },
        }
