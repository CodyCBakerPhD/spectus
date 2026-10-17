import pathlib

from spectus.records import from_line
from spectus.storage import DataStore


def record(run_id: int, created_at: str, updated_at: str | None = None, repository: str = "con/spectus") -> dict:
    return {
        "id": run_id,
        "repository": repository,
        "created_at": created_at,
        "updated_at": updated_at or created_at,
    }


def lines(path: pathlib.Path) -> list[dict]:
    return [from_line(line) for line in path.read_text().splitlines()]


def test_records_go_to_the_month_of_their_creation(tmp_path: pathlib.Path):
    store = DataStore(tmp_path)
    appended = store.append(
        [
            record(1, "2026-09-30T23:59:59Z"),
            record(2, "2026-10-01T00:00:00Z"),
            record(3, "2026-10-01T00:00:00Z", repository="dandi/dandi-cli"),
        ],
    )
    assert appended == {"con/spectus": 2, "dandi/dandi-cli": 1}
    assert [entry["id"] for entry in lines(tmp_path / "data/con/spectus/202609.jsonl")] == [1]
    assert [entry["id"] for entry in lines(tmp_path / "data/con/spectus/202610.jsonl")] == [2]
    assert [entry["id"] for entry in lines(tmp_path / "data/dandi/dandi-cli/202610.jsonl")] == [3]


def test_lines_are_keyed_by_minute(tmp_path: pathlib.Path):
    DataStore(tmp_path).append([record(1, "2026-10-05T08:09:59Z")])
    text = (tmp_path / "data/con/spectus/202610.jsonl").read_text()
    assert text.startswith('{"2026-10-05T08:09":{"id":1,')
    assert text.endswith("}}\n")


def test_the_same_record_is_never_appended_twice(tmp_path: pathlib.Path):
    DataStore(tmp_path).append([record(1, "2026-10-05T08:09:00Z")])
    # A fresh store, as the next scan would have, reads what is already there
    store = DataStore(tmp_path)
    assert store.append([record(1, "2026-10-05T08:09:00Z"), record(1, "2026-10-05T08:09:00Z")]) == {}
    assert len(lines(tmp_path / "data/con/spectus/202610.jsonl")) == 1


def test_a_rerun_is_appended_as_a_new_record(tmp_path: pathlib.Path):
    store = DataStore(tmp_path)
    store.append([record(1, "2026-10-05T08:09:00Z", "2026-10-05T08:20:00Z")])
    store.append([record(1, "2026-10-05T08:09:00Z", "2026-10-06T10:00:00Z")])
    assert [entry["updated_at"] for entry in lines(tmp_path / "data/con/spectus/202610.jsonl")] == [
        "2026-10-05T08:20:00Z",
        "2026-10-06T10:00:00Z",
    ]


def test_existing_lines_are_kept_and_new_ones_appended_oldest_first(tmp_path: pathlib.Path):
    store = DataStore(tmp_path)
    store.append([record(5, "2026-10-20T00:00:00Z")])
    store.append([record(7, "2026-10-22T00:00:00Z"), record(6, "2026-10-21T00:00:00Z")])
    assert [entry["id"] for entry in lines(tmp_path / "data/con/spectus/202610.jsonl")] == [5, 6, 7]


def test_a_file_missing_its_final_newline_is_repaired_before_appending(tmp_path: pathlib.Path):
    store = DataStore(tmp_path)
    store.append([record(1, "2026-10-01T00:00:00Z")])
    path = tmp_path / "data/con/spectus/202610.jsonl"
    path.write_text(path.read_text().rstrip("\n"))
    DataStore(tmp_path).append([record(2, "2026-10-02T00:00:00Z")])
    assert [entry["id"] for entry in lines(path)] == [1, 2]


def test_contains(tmp_path: pathlib.Path):
    store = DataStore(tmp_path)
    store.append([record(1, "2026-10-05T08:09:00Z", "2026-10-05T08:20:00Z")])
    store = DataStore(tmp_path)
    created_at = "2026-10-05T08:09:00Z"
    assert store.contains(repository="con/spectus", run_id=1, created_at=created_at, updated_at="2026-10-05T08:20:00Z")
    assert not store.contains(
        repository="con/spectus",
        run_id=1,
        created_at=created_at,
        updated_at="2026-10-05T09:00:00Z",
    )
    assert not store.contains(
        repository="con/other",
        run_id=1,
        created_at=created_at,
        updated_at="2026-10-05T08:20:00Z",
    )
