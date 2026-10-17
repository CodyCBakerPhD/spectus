import json
import pathlib

import pytest

from spectus.config import Config, format_config, load_config, validate_config_text

VALID = {"organizations": ["con", "dandi"], "repositories": ["CodyCBakerPhD/spectus"]}


def test_valid_config_has_no_problems():
    assert validate_config_text(format_config(VALID)) == []


def test_include_forks_is_optional_and_boolean():
    assert validate_config_text(format_config({**VALID, "include_forks": True})) == []
    assert validate_config_text(format_config({**VALID, "include_forks": "yes"})) != []


def test_empty_lists_are_valid():
    assert validate_config_text(format_config({"organizations": [], "repositories": []})) == []


@pytest.mark.parametrize("missing", ["organizations", "repositories"])
def test_both_lists_are_required(missing):
    instance = {key: value for key, value in VALID.items() if key != missing}
    (problem,) = validate_config_text(format_config(instance))
    assert f"'{missing}' is a required property" in problem


def test_unknown_keys_are_rejected():
    (problem,) = validate_config_text(format_config({**VALID, "repository": ["a/b"]}))
    assert "repository" in problem


@pytest.mark.parametrize(
    "organization",
    ["-leading-dash", "trailing-dash-", "double--dash", "has/slash", "", "a" * 40, "under_score"],
)
def test_malformed_organizations_are_rejected(organization):
    problems = validate_config_text(format_config({**VALID, "organizations": [organization]}))
    assert problems
    assert problems[0].startswith("organizations/0:")


@pytest.mark.parametrize("repository", ["no-owner", "owner/", "/name", "owner/name/extra", "owner/has space"])
def test_repositories_need_an_owner_and_a_name(repository):
    problems = validate_config_text(format_config({**VALID, "repositories": [repository]}))
    assert problems
    assert problems[0].startswith("repositories/0:")


@pytest.mark.parametrize("repository", ["con/spectus", "a-b/c.d", "x/.github", "A1/repo_name-2"])
def test_well_formed_repositories_are_accepted(repository):
    assert validate_config_text(format_config({**VALID, "repositories": [repository]})) == []


def test_duplicates_are_rejected_regardless_of_case():
    instance = {"organizations": ["con", "CON"], "repositories": ["a/b", "c/d", "A/B"]}
    assert validate_config_text(format_config(instance)) == [
        "organizations: 'CON' is listed more than once",
        "repositories: 'A/B' is listed more than once",
    ]


def test_formatting_must_be_indented_by_four_spaces():
    assert validate_config_text(json.dumps(VALID)) == [
        "not formatted as JSON pretty-printed with an indent of 4 spaces and a final newline",
    ]
    assert validate_config_text(json.dumps(VALID, indent=2) + "\n") != []
    assert validate_config_text(json.dumps(VALID, indent=4)) != []
    assert validate_config_text(json.dumps(VALID), check_format=False) == []


def test_invalid_json_is_reported():
    (problem,) = validate_config_text("{")
    assert problem.startswith("not valid JSON")


def test_load_config(tmp_path: pathlib.Path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({**VALID, "include_forks": True}))
    assert load_config(path) == Config(
        organizations=("con", "dandi"),
        repositories=("CodyCBakerPhD/spectus",),
        include_forks=True,
    )


def test_load_config_defaults_to_skipping_forks(tmp_path: pathlib.Path):
    path = tmp_path / "config.json"
    path.write_text(format_config(VALID))
    assert load_config(path).include_forks is False


def test_load_config_lists_every_problem(tmp_path: pathlib.Path):
    path = tmp_path / "config.json"
    path.write_text(format_config({"organizations": ["-bad"], "repositories": ["bad"]}))
    with pytest.raises(ValueError, match=r"organizations/0:.*\n.*repositories/0:"):
        load_config(path)
