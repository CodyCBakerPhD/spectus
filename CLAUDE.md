# Agent instructions

- Always run `pre-commit` before committing and pushing changes
- Always bump the version in `package.json` appropriately when any file under `src/`, or `package.json` itself, is changed
- Leave a short description of the change or addition in the top `# Upcoming` section of the `CHANGELOG.md`; include the GitHub PR link at the end of each entry in the format `([#N](https://github.com/CodyCBakerPhD/spectus/pull/N))`
- Keep changelog entries concise: one sentence each, two at the very most. Say what changed and, where it is not obvious, why; leave implementation details, reasoning, and exhaustive lists of options or labels to the PR description
- PR titles should be human-readable and in the past tense; they should NOT use conventional commit style
- Use American English spelling everywhere (code, comments, UI text, changelog entries, and PR descriptions): "normalize" not "normalise", "color" not "colour", "behavior" not "behaviour"
- After changing a LinkML schema under `schemas/`, regenerate its JSON Schema export with `python scripts/generate_json_schemas.py`
- After a change to the plots that is meant, regenerate the screenshot baselines with `npm run test:visual -- --update-snapshots`
