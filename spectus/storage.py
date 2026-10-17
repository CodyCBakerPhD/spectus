"""
The JSON Lines files of the `data` branch, appended to without ever rewriting a line already there.

What a file already holds decides what is new: a record whose identity (see `records.identity`) is already in its file
is not appended again, whatever the scan cache says.
"""

import collections
import os
import pathlib

from . import records


def _ends_without_newline(path: pathlib.Path, /) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return False
    with path.open("rb") as file:
        file.seek(-1, os.SEEK_END)
        return file.read(1) != b"\n"


class DataStore:
    """The `data/` directory of a checkout of the `data` branch."""

    def __init__(self, root: pathlib.Path, /) -> None:
        self.directory = root / "data"
        self._identities: dict[pathlib.Path, set[tuple[int, str]]] = {}

    def path_for(self, *, repository: str, month: str) -> pathlib.Path:
        """Return the file holding the records of a repository's runs created in a month (`YYYYMM`)."""
        return self.directory / repository / f"{month}.jsonl"

    def _identities_in(self, path: pathlib.Path, /) -> set[tuple[int, str]]:
        if path not in self._identities:
            identities: set[tuple[int, str]] = set()
            if path.exists():
                with path.open() as file:
                    identities = {records.identity(records.from_line(line)) for line in file if line.strip()}
            self._identities[path] = identities
        return self._identities[path]

    def contains(self, *, repository: str, run_id: int, created_at: str, updated_at: str) -> bool:
        """Whether a run, as last updated at `updated_at`, is already recorded."""
        month = records.month_of({"created_at": created_at})
        path = self.path_for(repository=repository, month=month)
        return (run_id, updated_at) in self._identities_in(path)

    def append(self, new_records: list[records.Record], /) -> dict[str, int]:
        """
        Append the records not already stored, oldest first within each file.

        Returns
        -------
        dict of str to int
            The number of records appended per repository.

        """
        by_path: dict[pathlib.Path, list[records.Record]] = collections.defaultdict(list)
        for record in new_records:
            path = self.path_for(repository=record["repository"], month=records.month_of(record))
            identities = self._identities_in(path)
            if records.identity(record) in identities:
                continue
            identities.add(records.identity(record))
            by_path[path].append(record)

        appended: dict[str, int] = collections.Counter()
        for path, path_records in by_path.items():
            path_records.sort(key=lambda record: (record["created_at"], record["id"], record["updated_at"]))
            path.parent.mkdir(parents=True, exist_ok=True)
            needs_newline = _ends_without_newline(path)
            with path.open("a") as file:
                if needs_newline:
                    file.write("\n")
                file.writelines(records.to_line(record) + "\n" for record in path_records)
            for record in path_records:
                appended[record["repository"]] += 1

        return dict(appended)
