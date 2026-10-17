"""
Export each LinkML schema under `schemas/` to the JSON Schema beside it.

Each `schemas/{name}.yaml` is written out as `schemas/{name}.schema.json`.
With `--check`, nothing is written; the run fails if any export is out of date.
"""

import argparse
import pathlib
import sys

from linkml.generators.jsonschemagen import JsonSchemaGenerator

SCHEMAS_DIRECTORY = pathlib.Path(__file__).parent.parent / "schemas"


def _export(*, linkml_path: pathlib.Path) -> str:
    generator = JsonSchemaGenerator(schema=str(linkml_path), mergeimports=True)
    # The generator ends its output with a blank line, which the end-of-file pre-commit hook would strip
    return generator.serialize().rstrip() + "\n"


def main() -> None:
    """Write or check the JSON Schema export of every LinkML schema."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail instead of writing if any export is out of date.")
    arguments = parser.parse_args()

    stale: list[str] = []
    for linkml_path in sorted(SCHEMAS_DIRECTORY.glob("*.yaml")):
        json_schema_path = linkml_path.with_suffix(".schema.json")
        exported = _export(linkml_path=linkml_path)
        current = json_schema_path.read_text() if json_schema_path.exists() else None
        if exported == current:
            continue

        if arguments.check:
            stale.append(json_schema_path.name)
        else:
            json_schema_path.write_text(exported)
            print(f"wrote {json_schema_path.relative_to(SCHEMAS_DIRECTORY.parent)}")

    for name in stale:
        print(f"::error file=schemas/{name}::Out of date; run `python scripts/generate_json_schemas.py`")
    if stale:
        sys.exit(1)


if __name__ == "__main__":
    main()
