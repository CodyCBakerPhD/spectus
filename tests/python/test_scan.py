import datetime
import json
import pathlib

import pytest

from spectus.github import GitHubError, HttpResponse
from spectus.records import from_line
from spectus.scan import render_summary

from .conftest import NOW, config
from .fake_github import FakeGitHub


def stored(data_dir: pathlib.Path, repository: str = "con/spectus") -> list[dict]:
    entries = []
    for path in sorted((data_dir / "data" / repository).glob("*.jsonl")):
        entries += [from_line(line) for line in path.read_text().splitlines()]
    return entries


@pytest.fixture
def spectus(github: FakeGitHub):
    repository = github.add_repository("con/spectus")
    tests = github.add_workflow(repository, "Tests")
    github.add_run(tests, "2026-10-16T10:00:00Z", jobs=[("2026-10-16T10:00:30Z", "2026-10-16T10:02:30Z")])
    github.add_run(tests, "2026-10-17T09:00:00Z", conclusion="FAILURE")
    return repository


def test_first_scan_records_every_finished_run(github, spectus, make_scanner, data_dir):
    scanner, _ = make_scanner()
    result = scanner.scan(config(repositories=["con/spectus"]))

    assert result.repositories == ["con/spectus"]
    assert result.changed == ["con/spectus"]
    assert result.appended == {"con/spectus": 2}
    records = stored(data_dir)
    assert [(record["run_number"], record["conclusion"]) for record in records] == [(1, "success"), (2, "failure")]
    assert records[0]["duration_seconds"] == 120
    assert (data_dir / "data/con/spectus/202610.jsonl").exists()


def test_an_unchanged_repository_costs_one_free_request(github, spectus, make_scanner, data_dir):
    make_scanner()[0].scan(config(repositories=["con/spectus"]))
    github.clear_requests()

    scanner, client = make_scanner()
    result = scanner.scan(config(repositories=["con/spectus"]))

    assert result.changed == []
    assert result.appended == {}
    # The repository lookup is cached, and the probe is answered 304
    assert github.graphql_queries() == []
    ((url, headers),) = github.rest_requests()
    assert url.endswith("/repos/con/spectus/actions/runs?per_page=1")
    assert "If-None-Match" in headers
    assert (client.usage.rest_requests, client.usage.rest_not_modified) == (1, 1)
    assert len(stored(data_dir)) == 2


def test_new_runs_are_appended_once(github, spectus, make_scanner, data_dir, clock):
    make_scanner()[0].scan(config(repositories=["con/spectus"]))
    github.add_run(spectus.workflows[0], "2026-10-17T11:00:00Z")
    clock.now += datetime.timedelta(hours=1)

    result = make_scanner()[0].scan(config(repositories=["con/spectus"]))
    assert result.appended == {"con/spectus": 1}
    # The workflow list did not change, so it was answered from the cache
    assert any(not url.endswith("per_page=1") for url, _ in github.rest_requests())

    result = make_scanner(force=True)[0].scan(config(repositories=["con/spectus"]))
    assert result.appended == {}
    assert [record["run_number"] for record in stored(data_dir)] == [1, 2, 3]


def test_unfinished_runs_are_recorded_once_they_finish(github, spectus, make_scanner, data_dir, clock):
    tests = spectus.workflows[0]
    running = github.add_run(tests, "2026-10-17T11:30:00Z", status="IN_PROGRESS", conclusion=None)
    # Newer than the running one, so the repository's newest run never changes again
    github.add_run(tests, "2026-10-17T11:45:00Z")

    result = make_scanner()[0].scan(config(repositories=["con/spectus"]))
    assert result.appended == {"con/spectus": 3}
    assert result.pending == 1

    running.status, running.conclusion, running.updated_at = "COMPLETED", "CANCELLED", "2026-10-17T12:30:00Z"
    github.clear_requests()
    result = make_scanner()[0].scan(config(repositories=["con/spectus"]))

    # The probe saw nothing new, but the run left pending last time was looked up directly
    assert result.changed == []
    assert result.appended == {"con/spectus": 1}
    assert result.pending == 0
    (query,) = github.graphql_queries()
    assert query["variables"] == {"ids": [running.node_id]}
    assert stored(data_dir)[-1]["conclusion"] == "cancelled"


def test_a_rerun_is_recorded_again(github, spectus, make_scanner, data_dir):
    make_scanner()[0].scan(config(repositories=["con/spectus"]))
    newest = spectus.workflows[0].runs[-1]
    newest.conclusion, newest.updated_at = "SUCCESS", "2026-10-17T11:59:00Z"

    result = make_scanner()[0].scan(config(repositories=["con/spectus"]))
    assert result.appended == {"con/spectus": 1}
    assert [(record["id"], record["conclusion"]) for record in stored(data_dir)][1:] == [
        (newest.database_id, "failure"),
        (newest.database_id, "success"),
    ]


def test_backfill_pages_back_to_the_window_and_no_further(github, make_scanner, data_dir):
    repository = github.add_repository("con/busy")
    workflow = github.add_workflow(repository, "CI")
    start = NOW - datetime.timedelta(days=10)
    for hour in range(240):
        github.add_run(workflow, (start + datetime.timedelta(hours=hour)).strftime("%Y-%m-%dT%H:%M:%SZ"))

    result = make_scanner(backfill_days=2)[0].scan(config(repositories=["con/busy"]))

    # Two days of hourly runs are two pages of 25 runs; the second page reaches back past the window
    assert len(github.graphql_queries("... on Workflow ")) == 2
    assert result.appended == {"con/busy": 50}
    assert min(record["created_at"] for record in stored(data_dir, "con/busy")) < "2026-10-15T12:00:00Z"


def test_later_scans_page_back_only_to_the_newest_run_seen(github, make_scanner, clock):
    repository = github.add_repository("con/busy")
    workflow = github.add_workflow(repository, "CI")
    github.add_run(workflow, "2026-10-17T00:00:00Z")
    make_scanner()[0].scan(config(repositories=["con/busy"]))

    for minute in range(30):
        github.add_run(workflow, f"2026-10-17T13:{minute:02d}:00Z")
    clock.now += datetime.timedelta(hours=2)
    github.clear_requests()
    result = make_scanner()[0].scan(config(repositories=["con/busy"]))

    assert len(github.graphql_queries("... on Workflow ")) == 2
    assert result.appended == {"con/busy": 30}


def test_organizations_cover_their_public_repositories_but_not_forks(github, make_scanner):
    github.add_repository("dandi/dandi-cli")
    github.add_repository("dandi/dandi-archive")
    github.add_repository("dandi/a-fork", fork=True)
    github.add_repository("dandi/secret", private=True)
    github.add_repository("con/other")

    scanner, _ = make_scanner()
    assert scanner.resolve_repositories(config(organizations=["dandi"])) == (
        ["dandi/dandi-archive", "dandi/dandi-cli"],
        [],
    )
    assert scanner.resolve_repositories(config(organizations=["dandi"], include_forks=True))[0] == [
        "dandi/a-fork",
        "dandi/dandi-archive",
        "dandi/dandi-cli",
    ]
    (query,) = github.graphql_queries("repositoryOwner")[:1]
    assert query["variables"]["isFork"] is False


def test_organizations_are_paged_through(github, make_scanner):
    for index in range(130):
        github.add_repository(f"big/repo-{index:03d}")
    repositories, _ = make_scanner()[0].resolve_repositories(config(organizations=["big"]))
    assert len(repositories) == 130
    assert len(github.graphql_queries("repositoryOwner")) == 2


def test_listed_repositories_are_resolved_and_merged_with_organizations(github, make_scanner):
    github.add_repository("dandi/dandi-cli")
    github.add_repository("con/datalad-usage-dashboard", fork=True)
    github.add_repository("con/renamed-now")
    github.renamed["con/old-name"] = "con/renamed-now"

    repositories, warnings = make_scanner()[0].resolve_repositories(
        config(
            organizations=["dandi", "nobody"],
            repositories=["DANDI/dandi-cli", "con/datalad-usage-dashboard", "con/old-name", "con/missing"],
        ),
    )
    assert repositories == ["con/datalad-usage-dashboard", "con/renamed-now", "dandi/dandi-cli"]
    assert warnings == [
        "nobody: no such organization or user",
        "con/missing: no such repository, or it is not accessible",
    ]


def test_inaccessible_repositories_are_skipped_with_a_warning(github, spectus, make_scanner):
    # Resolvable through GraphQL, but its workflow runs answer 404, as when Actions are not visible to the token
    github.add_repository("con/hidden")
    real_rest = github._rest
    github._rest = lambda url, headers: real_rest(url.replace("con/hidden", "con/nowhere"), headers)

    result = make_scanner()[0].scan(config(repositories=["con/spectus", "con/hidden"]))
    assert result.appended == {"con/spectus": 2}
    assert result.warnings == ["con/hidden: workflow runs are not accessible (404)"]


def test_repositories_whose_workflows_cannot_be_listed_are_skipped_with_a_warning(github, spectus, make_scanner):
    real_rest = github._rest

    def no_workflows(url, headers):
        if url.endswith("/actions/workflows?per_page=100"):
            return real_rest("/repos/con/nowhere/actions/workflows", headers)
        return real_rest(url, headers)

    github._rest = no_workflows
    result = make_scanner()[0].scan(config(repositories=["con/spectus"]))
    assert result.changed == []
    assert result.warnings == ["con/spectus: workflows are not accessible (404)"]


def test_deleted_workflows_and_runs_are_skipped(github, spectus, make_scanner):
    scanner, _ = make_scanner()
    real_details = github._run_details
    github._run_details = lambda node_id: None if node_id.endswith("1001") else real_details(node_id)
    result = scanner.scan(config(repositories=["con/spectus"]))
    assert result.appended == {"con/spectus": 1}


def test_the_time_budget_stops_between_chunks_and_the_next_scan_carries_on(github, make_scanner, clock):
    for index in range(30):
        repository = github.add_repository(f"con/repo-{index:02d}")
        github.add_run(github.add_workflow(repository, "CI"), "2026-10-17T00:00:00Z")
    names = [f"con/repo-{index:02d}" for index in range(30)]

    scanner, _ = make_scanner()
    real_scan_chunk = scanner._scan_chunk

    def slow_scan_chunk(chunk, *, result):
        real_scan_chunk(chunk, result=result)
        clock.now += datetime.timedelta(minutes=10)

    scanner._scan_chunk = slow_scan_chunk
    result = scanner.scan(config(repositories=names), deadline=NOW + datetime.timedelta(minutes=5))
    assert result.stopped_early == "the time budget ran out"
    assert sum(result.appended.values()) == 25

    result = make_scanner()[0].scan(config(repositories=names))
    assert sum(result.appended.values()) == 5


def test_running_out_of_rate_limit_keeps_what_was_finished(github, spectus, make_scanner, data_dir):
    scanner, _ = make_scanner()
    github.graphql_errors = [{"type": "RATE_LIMITED", "message": "API rate limit exceeded"}]
    result = scanner.scan(config(repositories=["con/spectus"]))
    assert result.stopped_early == "GraphQL rate limit exhausted"
    assert stored(data_dir) == []


def test_the_cache_forgets_repositories_no_longer_configured(github, spectus, make_scanner, cache_dir):
    github.add_run(github.add_workflow(github.add_repository("con/other"), "CI"), "2026-10-17T00:00:00Z")
    make_scanner()[0].scan(config(repositories=["con/spectus", "con/other"]))
    make_scanner()[0].scan(config(repositories=["con/spectus"]))

    state = json.loads((cache_dir / "state.json").read_text())
    rest = json.loads((cache_dir / "rest.json").read_text())
    assert list(state) == ["con/spectus"]
    assert all("/repos/con/spectus/" in url for url in rest)


def test_every_record_matches_the_schema(github, make_scanner, data_dir):
    repository = github.add_repository("con/spectus")
    workflow = github.add_workflow(repository, "Weird Workflow")
    github.add_run(workflow, "2026-10-17T00:00:00Z", conclusion="STARTUP_FAILURE", branch=None, actor=None)
    github.add_run(workflow, "2026-10-17T00:01:00Z", conclusion="ACTION_REQUIRED", event="pull_request_target")
    result = make_scanner()[0].scan(config(repositories=["con/spectus"]))
    assert result.appended == {"con/spectus": 2}


def test_render_summary(github, spectus, make_scanner):
    result = make_scanner()[0].scan(config(organizations=["nobody"], repositories=["con/spectus"]))
    summary = render_summary(result)
    assert "Repositories: 1, of which 1 had new or changed runs" in summary
    assert "| `con/spectus` | 2 |" in summary
    assert "- nobody: no such organization or user" in summary

    result.stopped_early = "the time budget ran out"
    assert "**Stopped early:** the time budget ran out." in render_summary(result)


def test_runs_still_unfinished_stay_pending(github, spectus, make_scanner):
    tests = spectus.workflows[0]
    github.add_run(tests, "2026-10-17T11:30:00Z", status="QUEUED", conclusion=None)
    github.add_run(tests, "2026-10-17T11:45:00Z")
    make_scanner()[0].scan(config(repositories=["con/spectus"]))

    result = make_scanner()[0].scan(config(repositories=["con/spectus"]))
    assert result.changed == []
    assert result.pending == 1
    assert len(github.graphql_queries("... on WorkflowRun")) == 2


def test_runs_pending_for_longer_than_github_allows_are_forgotten(github, spectus, make_scanner, clock):
    github.add_run(spectus.workflows[0], "2026-10-17T11:30:00Z", status="WAITING", conclusion=None)
    github.add_run(spectus.workflows[0], "2026-10-17T11:45:00Z")
    make_scanner()[0].scan(config(repositories=["con/spectus"]))

    clock.now += datetime.timedelta(days=36)
    assert make_scanner()[0].scan(config(repositories=["con/spectus"])).pending == 0


def test_a_workflow_deleted_since_it_was_listed_is_skipped(github, spectus, make_scanner):
    github.add_run(github.add_workflow(spectus, "Deleted"), "2026-10-17T00:00:00Z")
    real_workflows_by_id = github._workflows_by_id
    github._workflows_by_id = lambda: {
        node_id: workflow for node_id, workflow in real_workflows_by_id().items() if workflow.name != "Deleted"
    }
    assert make_scanner()[0].scan(config(repositories=["con/spectus"])).appended == {"con/spectus": 2}


def test_unexpected_errors_are_raised(github, spectus, make_scanner):
    github._rest = lambda url, headers: HttpResponse(status=401, headers={}, body=b"{}")
    with pytest.raises(GitHubError, match="401"):
        make_scanner()[0].scan(config(repositories=["con/spectus"]))
