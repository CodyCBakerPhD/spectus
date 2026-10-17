"""
The scan configuration: which organizations and repositories to cover.

It lives as `config.json` on the `config` branch and is checked against `schemas/config.schema.json`, the JSON Schema
export of `schemas/config.yaml`. Beyond what the schema can express, entries must be unique (GitHub names are
case-insensitive, so `Org` and `org` are the same) and the file must be pretty-printed with an indent of four spaces.
"""

import dataclasses
import json
import pathlib
import typing

import jsonschema

SCHEMAS_DIRECTORY = pathlib.Path(__file__).parent.parent / "schemas"
CONFIG_SCHEMA_PATH = SCHEMAS_DIRECTORY / "config.schema.json"


@dataclasses.dataclass(frozen=True)
class Config:
    """A validated scan configuration."""

    organizations: tuple[str, ...]
    repositories: tuple[str, ...]
    include_forks: bool = False


def format_config(instance: typing.Any, /) -> str:  # noqa: ANN401 (any JSON value)
    """Return the canonical text of a configuration: pretty-printed with an indent of four and a final newline."""
    return json.dumps(instance, indent=4) + "\n"


def _duplicates(values: list[str], /) -> list[str]:
    seen: set[str] = set()
    duplicates: list[str] = []
    for value in values:
        folded = value.casefold()
        if folded in seen:
            duplicates.append(value)
        seen.add(folded)
    return duplicates


def validate_config_text(
    text: str,
    /,
    *,
    check_format: bool = True,
    schema_path: pathlib.Path = CONFIG_SCHEMA_PATH,
) -> list[str]:
    """
    Check the text of a `config.json` and describe everything wrong with it.

    Parameters
    ----------
    text : str
        The contents of the file.
    check_format : bool, default: True
        Whether to also require the canonical formatting (see `format_config`).
    schema_path : pathlib.Path
        The JSON Schema to validate against.

    Returns
    -------
    list of str
        One message per problem; empty if the configuration is valid.

    """
    try:
        instance = json.loads(text)
    except json.JSONDecodeError as exception:
        return [f"not valid JSON: {exception}"]

    schema = json.loads(schema_path.read_text())
    validator = jsonschema.Draft201909Validator(schema, format_checker=jsonschema.Draft201909Validator.FORMAT_CHECKER)
    problems = [
        f"{'/'.join(str(part) for part in error.absolute_path) or '(root)'}: {error.message}"
        for error in sorted(
            validator.iter_errors(instance),
            key=lambda error: [str(part) for part in error.absolute_path],
        )
    ]
    if problems:
        return problems

    for key in ("organizations", "repositories"):
        problems += [f"{key}: {value!r} is listed more than once" for value in _duplicates(instance[key])]

    if check_format and text != format_config(instance):
        problems.append("not formatted as JSON pretty-printed with an indent of 4 spaces and a final newline")

    return problems


def load_config(path: pathlib.Path, /) -> Config:
    """
    Read and validate a `config.json`, raising `ValueError` with every problem found if it is invalid.

    Formatting is left to the CI check on the `config` branch; a scan only needs the contents to be valid.
    """
    text = path.read_text()
    problems = validate_config_text(text, check_format=False)
    if problems:
        message = f"Invalid configuration {path}:\n" + "\n".join(f"  - {problem}" for problem in problems)
        raise ValueError(message)

    instance = json.loads(text)
    return Config(
        organizations=tuple(instance["organizations"]),
        repositories=tuple(instance["repositories"]),
        include_forks=bool(instance.get("include_forks") or False),
    )
