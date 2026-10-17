"""
The command line of the scan.

    python -m spectus validate-config config.json
    python -m spectus scan --config config.json --data-dir data-branch --cache-dir .spectus-cache

A scan reads its token from the `GITHUB_TOKEN` environment variable. Run inside GitHub Actions, both commands report
problems as annotations, and a scan writes its summary to the job summary and the number of records it appended to the
`appended` step output.
"""

import argparse
import datetime
import os
import pathlib
import sys

from .cache import Cache
from .config import load_config, validate_config_text
from .github import GitHubClient
from .scan import Scanner, render_summary
from .storage import DataStore


def _validate_config(arguments: argparse.Namespace, /) -> int:
    problems = validate_config_text(arguments.path.read_text(), check_format=not arguments.skip_format_check)
    for problem in problems:
        print(f"::error file={arguments.path}::{problem}")
    if not problems:
        print(f"{arguments.path} is valid")
    return 1 if problems else 0


def _write_github_file(variable: str, text: str, /) -> None:
    path = os.environ.get(variable)
    if path:
        with pathlib.Path(path).open("a") as file:
            file.write(text)


def _scan(arguments: argparse.Namespace, /) -> int:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("::error::Set GITHUB_TOKEN to a token that can read the repositories to scan")
        return 1

    config = load_config(arguments.config)
    cache = Cache(arguments.cache_dir)
    scanner = Scanner(
        client=GitHubClient(token=token, cache=cache),
        cache=cache,
        store=DataStore(arguments.data_dir),
        backfill=datetime.timedelta(days=arguments.backfill_days),
        force=arguments.force,
    )
    deadline = None
    if arguments.time_budget_minutes is not None:
        deadline = datetime.datetime.now(tz=datetime.UTC) + datetime.timedelta(minutes=arguments.time_budget_minutes)

    result = scanner.scan(config, deadline=deadline)
    for warning in result.warnings:
        print(f"::warning::{warning}")
    if result.stopped_early:
        print(f"::warning::Stopped early: {result.stopped_early}")

    summary = render_summary(result)
    print(summary)
    _write_github_file("GITHUB_STEP_SUMMARY", summary)
    _write_github_file("GITHUB_OUTPUT", f"appended={sum(result.appended.values())}\n")
    return 0


def main() -> None:
    """Run the command line."""
    parser = argparse.ArgumentParser(prog="python -m spectus", description=__doc__.split("\n\n")[0].strip())
    commands = parser.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate-config", help="Check a config.json against the schema.")
    validate.add_argument("path", type=pathlib.Path)
    validate.add_argument(
        "--skip-format-check",
        action="store_true",
        help="Accept any formatting, not only pretty-printing with an indent of four spaces.",
    )

    scan = commands.add_parser("scan", help="Append the finished workflow runs of the configured repositories.")
    scan.add_argument("--config", type=pathlib.Path, required=True, help="The config.json to scan.")
    scan.add_argument("--data-dir", type=pathlib.Path, required=True, help="A checkout of the data branch.")
    scan.add_argument("--cache-dir", type=pathlib.Path, default=None, help="Where to keep the cache between scans.")
    scan.add_argument(
        "--backfill-days",
        type=float,
        default=90,
        help="How far back to look on the first scan of a repository (default: 90).",
    )
    scan.add_argument(
        "--time-budget-minutes",
        type=float,
        default=None,
        help="Stop starting new chunks of repositories after this long, keeping what was finished.",
    )
    scan.add_argument(
        "--force",
        action="store_true",
        help="List the newest runs of every repository, even those whose newest run looks unchanged.",
    )

    arguments = parser.parse_args()
    handler = _validate_config if arguments.command == "validate-config" else _scan
    sys.exit(handler(arguments))


if __name__ == "__main__":
    main()
