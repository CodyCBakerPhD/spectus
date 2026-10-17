import json
import pathlib
import sys

import pytest

import spectus.__main__ as cli
from spectus.config import format_config
from spectus.github import GitHubClient

from .fake_github import FakeGitHub


def run(monkeypatch, *arguments: str) -> int:
    monkeypatch.setattr(sys, "argv", ["python -m spectus", *arguments])
    with pytest.raises(SystemExit) as exited:
        cli.main()
    return exited.value.code


def test_validate_config_accepts_a_valid_file(monkeypatch, tmp_path: pathlib.Path, capsys):
    path = tmp_path / "config.json"
    path.write_text(format_config({"organizations": ["con"], "repositories": []}))
    assert run(monkeypatch, "validate-config", str(path)) == 0
    assert "is valid" in capsys.readouterr().out


def test_validate_config_annotates_each_problem(monkeypatch, tmp_path: pathlib.Path, capsys):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"organizations": ["con", "con"], "repositories": []}))
    assert run(monkeypatch, "validate-config", str(path)) == 1
    out = capsys.readouterr().out
    assert f"::error file={path}::organizations: 'con' is listed more than once" in out
    assert "not formatted" in out

    assert run(monkeypatch, "validate-config", "--skip-format-check", str(path)) == 1
    assert "not formatted" not in capsys.readouterr().out


def test_scan_needs_a_token(monkeypatch, tmp_path: pathlib.Path, capsys):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    assert run(monkeypatch, "scan", "--config", "config.json", "--data-dir", str(tmp_path)) == 1
    assert "GITHUB_TOKEN" in capsys.readouterr().out


def test_scan_appends_and_reports(monkeypatch, tmp_path: pathlib.Path, capsys):
    github = FakeGitHub()
    workflow = github.add_workflow(github.add_repository("con/spectus"), "Tests")
    github.add_run(workflow, "2026-10-17T00:00:00Z")
    monkeypatch.setattr(cli, "GitHubClient", lambda **kwargs: GitHubClient(**kwargs, transport=github))

    config_path = tmp_path / "config.json"
    config_path.write_text(format_config({"organizations": ["nobody"], "repositories": ["con/spectus"]}))
    summary_path, output_path = tmp_path / "summary.md", tmp_path / "output"
    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_path))
    monkeypatch.setenv("GITHUB_OUTPUT", str(output_path))

    arguments = ["scan", "--config", str(config_path), "--data-dir", str(tmp_path / "data")]
    code = run(monkeypatch, *arguments, "--cache-dir", str(tmp_path / "cache"), "--time-budget-minutes", "5")
    assert code == 0
    assert "::warning::nobody: no such organization or user" in capsys.readouterr().out
    assert "Records appended: 1" in summary_path.read_text()
    assert output_path.read_text() == "appended=1\n"
    assert len(list((tmp_path / "data/data/con/spectus").glob("*.jsonl"))) == 1


def test_scan_warns_when_stopped_early(monkeypatch, tmp_path: pathlib.Path, capsys):
    github = FakeGitHub()
    github.add_repository("con/spectus")
    monkeypatch.setattr(cli, "GitHubClient", lambda **kwargs: GitHubClient(**kwargs, transport=github))
    config_path = tmp_path / "config.json"
    config_path.write_text(format_config({"organizations": [], "repositories": ["con/spectus"]}))
    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)

    arguments = ["scan", "--config", str(config_path), "--data-dir", str(tmp_path / "data")]
    assert run(monkeypatch, *arguments, "--time-budget-minutes", "0") == 0
    assert "::warning::Stopped early: the time budget ran out" in capsys.readouterr().out
