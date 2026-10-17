import json

import pytest

from spectus.records import build_record, from_line, identity, minute_key, month_of, to_line, validate_record


def node(**check_suite_overrides):
    check_suite = {
        "status": "COMPLETED",
        "conclusion": "FAILURE",
        "branch": {"name": "main"},
        "commit": {"oid": "a" * 40},
        "creator": {"login": "octocat"},
        "repository": {"nameWithOwner": "con/spectus"},
        "checkRuns": {
            "nodes": [
                {"startedAt": "2026-10-01T10:00:30Z", "completedAt": "2026-10-01T10:03:00Z"},
                {"startedAt": "2026-10-01T10:00:10Z", "completedAt": "2026-10-01T10:05:10Z"},
                {"startedAt": None, "completedAt": None},
            ],
        },
        **check_suite_overrides,
    }
    return {
        "id": "WFR_1",
        "databaseId": 123,
        "runNumber": 7,
        "event": "schedule",
        "createdAt": "2026-10-01T09:59:59Z",
        "updatedAt": "2026-10-01T10:05:12Z",
        "url": "https://github.com/con/spectus/actions/runs/123",
        "file": {"path": ".github/workflows/tests.yml"},
        "workflow": {"name": "Tests"},
        "checkSuite": check_suite,
    }


def test_build_record_summarizes_a_finished_run():
    assert build_record(node()) == {
        "id": 123,
        "repository": "con/spectus",
        "workflow_name": "Tests",
        "workflow_path": ".github/workflows/tests.yml",
        "run_number": 7,
        "event": "schedule",
        "status": "completed",
        "conclusion": "failure",
        "created_at": "2026-10-01T09:59:59Z",
        "updated_at": "2026-10-01T10:05:12Z",
        "started_at": "2026-10-01T10:00:10Z",
        "completed_at": "2026-10-01T10:05:10Z",
        "duration_seconds": 300,
        "head_branch": "main",
        "head_sha": "a" * 40,
        "actor": "octocat",
        "url": "https://github.com/con/spectus/actions/runs/123",
    }


def test_build_record_leaves_unknowns_null():
    record = build_record(node(branch=None, creator=None, checkRuns={"nodes": []}) | {"file": None})
    assert record["head_branch"] is None
    assert record["actor"] is None
    assert record["workflow_path"] is None
    assert record["started_at"] is None
    assert record["completed_at"] is None
    assert record["duration_seconds"] is None
    validate_record(record)


def test_an_unfinished_run_has_no_conclusion_or_completion():
    record = build_record(node(status="IN_PROGRESS", conclusion=None))
    assert record["status"] == "in_progress"
    assert record["conclusion"] is None
    assert record["completed_at"] is None
    assert record["started_at"] == "2026-10-01T10:00:10Z"
    validate_record(record)


def test_records_are_keyed_by_the_minute_and_month_their_run_was_created():
    record = build_record(node())
    assert minute_key(record) == "2026-10-01T09:59"
    assert month_of(record) == "202610"


def test_lines_round_trip():
    record = build_record(node())
    line = to_line(record)
    assert "\n" not in line
    assert json.loads(line) == {"2026-10-01T09:59": record}
    assert from_line(line) == record


@pytest.mark.parametrize("line", ["[]", "{}", '{"a": {}, "b": {}}'])
def test_lines_must_hold_exactly_one_record(line):
    with pytest.raises(ValueError, match="single key"):
        from_line(line)


def test_identity_is_the_run_and_its_last_update():
    record = build_record(node())
    assert identity(record) == (123, "2026-10-01T10:05:12Z")


@pytest.mark.parametrize(
    ("field", "value"),
    [("status", "done"), ("conclusion", "flaky"), ("head_sha", "abc"), ("id", 0), ("repository", "nope")],
)
def test_validate_record_rejects_what_the_schema_does(field, value):
    record = build_record(node()) | {field: value}
    with pytest.raises(ValueError, match=field):
        validate_record(record)


def test_validate_record_rejects_unknown_fields():
    with pytest.raises(ValueError, match="extra"):
        validate_record(build_record(node()) | {"extra": 1})
