"""
Workflow run records: built from GraphQL, checked against `schemas/workflow_run.schema.json`, and keyed for storage.

On the `data` branch, each record is one line of `data/{owner}/{repository}/{YYYYMM}.jsonl`, written as a JSON object
whose only key is the minute the run was created (UTC, `YYYY-MM-DDTHH:MM`). The month of that minute names the file.
"""

import datetime
import functools
import json
import pathlib
import typing

import jsonschema

SCHEMAS_DIRECTORY = pathlib.Path(__file__).parent.parent / "schemas"
WORKFLOW_RUN_SCHEMA_PATH = SCHEMAS_DIRECTORY / "workflow_run.schema.json"

Record = dict[str, typing.Any]
JSON = typing.Any


def parse_datetime(value: str, /) -> datetime.datetime:
    """Parse a GitHub timestamp such as `2026-10-17T01:33:20Z`."""
    return datetime.datetime.fromisoformat(value)


def format_datetime(value: datetime.datetime, /) -> str:
    """Format a timestamp the way GitHub does, to the second in UTC."""
    return value.astimezone(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def minute_key(record: Record, /) -> str:
    """Return the key a record is stored under: the minute its run was created, in UTC."""
    return parse_datetime(record["created_at"]).astimezone(datetime.UTC).strftime("%Y-%m-%dT%H:%M")


def month_of(record: Record, /) -> str:
    """Return the month a record is stored in, as `YYYYMM`."""
    return parse_datetime(record["created_at"]).astimezone(datetime.UTC).strftime("%Y%m")


def identity(record: Record, /) -> tuple[int, str]:
    """
    Return what makes a record distinct from the others: its run, and when that run was last updated.

    A run observed again unchanged has the same identity and is not recorded twice; a run that was re-run has a later
    `updated_at` and is recorded again.
    """
    return record["id"], record["updated_at"]


def to_line(record: Record, /) -> str:
    """Render a record as its line of a `.jsonl` file, without the newline."""
    return json.dumps({minute_key(record): record}, separators=(",", ":"), ensure_ascii=False)


def from_line(line: str, /) -> Record:
    """Read the record out of a line of a `.jsonl` file."""
    entry = json.loads(line)
    if not isinstance(entry, dict) or len(entry) != 1:
        message = f"Expected an object with a single key, got: {line[:200]}"
        raise ValueError(message)
    (record,) = entry.values()
    return typing.cast("Record", record)


def build_record(node: JSON, /) -> Record:
    """Summarize a `WorkflowRun` node from the `RUN_DETAILS` query as a record."""
    check_suite = node["checkSuite"]
    check_runs = (check_suite.get("checkRuns") or {}).get("nodes") or []
    started = [parse_datetime(run["startedAt"]) for run in check_runs if run and run.get("startedAt")]
    completed = [parse_datetime(run["completedAt"]) for run in check_runs if run and run.get("completedAt")]

    status = check_suite["status"].lower()
    started_at = min(started) if started else None
    completed_at = max(completed) if completed and status == "completed" else None
    duration_seconds = None
    if started_at is not None and completed_at is not None and completed_at >= started_at:
        duration_seconds = int((completed_at - started_at).total_seconds())

    return {
        "id": node["databaseId"],
        "repository": check_suite["repository"]["nameWithOwner"],
        "workflow_name": node["workflow"]["name"],
        "workflow_path": (node.get("file") or {}).get("path"),
        "run_number": node["runNumber"],
        "event": node["event"],
        "status": status,
        "conclusion": check_suite["conclusion"].lower() if check_suite.get("conclusion") else None,
        "created_at": format_datetime(parse_datetime(node["createdAt"])),
        "updated_at": format_datetime(parse_datetime(node["updatedAt"])),
        "started_at": format_datetime(started_at) if started_at else None,
        "completed_at": format_datetime(completed_at) if completed_at else None,
        "duration_seconds": duration_seconds,
        "head_branch": (check_suite.get("branch") or {}).get("name"),
        "head_sha": check_suite["commit"]["oid"],
        "actor": (check_suite.get("creator") or {}).get("login"),
        "url": node["url"],
    }


@functools.cache
def _validator() -> jsonschema.Draft201909Validator:
    schema = json.loads(WORKFLOW_RUN_SCHEMA_PATH.read_text())
    return jsonschema.Draft201909Validator(schema, format_checker=jsonschema.Draft201909Validator.FORMAT_CHECKER)


def validate_record(record: Record, /) -> None:
    """Raise `ValueError` if a record does not match the workflow run schema."""
    errors = [
        f"{'/'.join(str(part) for part in error.absolute_path) or '(root)'}: {error.message}"
        for error in _validator().iter_errors(record)
    ]
    if errors:
        message = f"Workflow run record {record.get('id')} does not match the schema: " + "; ".join(errors)
        raise ValueError(message)
