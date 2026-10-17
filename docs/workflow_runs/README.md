# Workflow run scan

The `Scan workflow runs` workflow runs every hour.
It finds the GitHub Actions runs that finished since the last scan in every configured repository, and appends a summary of each to the `data` branch.
When it appended anything, it redeploys the [dashboard](../dashboard/README.md).

## Configuration: the `config` branch

The `config` branch holds a single file, `config.json`, pretty-printed with an indent of four spaces:

```json
{
    "organizations": [
        "con",
        "dandi"
    ],
    "repositories": [
        "CodyCBakerPhD/spectus"
    ],
    "include_forks": false
}
```

- `organizations`: every public repository of each of these organizations (or users) is scanned.
- `repositories`: individual repositories, each written as `owner/name` so the owner is never ambiguous.
  A repository also covered by an organization is scanned once.
- `include_forks` (optional, default `false`): whether the repositories of the organizations that are forks are scanned too.
  A fork listed under `repositories` is always scanned.

The schema is [`schemas/config.yaml`](../../schemas/config.yaml), written in [LinkML](https://linkml.io), with its JSON Schema export [`schemas/config.schema.json`](../../schemas/config.schema.json) beside it.
Beyond the schema, no organization or repository may be listed twice (GitHub names are case-insensitive).

To change the configuration, open a pull request into `config`.
The `Validate config` workflow checks it against the schema on `main`, along with its formatting, and that `config.json` is the only file on the branch.
Since the `config` branch carries no workflows of its own, that check reaches pull requests into it through `pull_request_target`, which always runs the workflow as it is on `main`.
It reads the pull request's `config.json` as data and runs nothing from it.
The current configuration is also checked every day, and whenever the schema changes.

To check a configuration locally:

```bash
pip install --group scan
python -m spectus validate-config path/to/config.json
```

## Records: the `data` branch

The `data` branch holds `data/{owner}/{repository}/{YYYYMM}.jsonl`.
Each line is a JSON object whose only key is the minute the run was created (UTC, `YYYY-MM-DDTHH:MM`), and whose value is one record:

```json
{"2026-10-17T09:00":{"id":18000000001,"repository":"con/spectus","workflow_name":"Tests","workflow_path":".github/workflows/tests.yml","run_number":42,"event":"push","status":"completed","conclusion":"success","created_at":"2026-10-17T09:00:12Z","updated_at":"2026-10-17T09:06:40Z","started_at":"2026-10-17T09:00:20Z","completed_at":"2026-10-17T09:06:38Z","duration_seconds":378,"head_branch":"main","head_sha":"…","actor":"octocat","url":"https://github.com/con/spectus/actions/runs/18000000001"}}
```

A file holds the runs created in its month.
The schema of a record is [`schemas/workflow_run.yaml`](../../schemas/workflow_run.yaml), with its JSON Schema export [`schemas/workflow_run.schema.json`](../../schemas/workflow_run.schema.json) beside it; every record is validated against it before it is written.

Only finished runs are recorded.
Lines are only ever appended, never rewritten, and a record is never appended twice: what a file already holds decides what is new.
A run is told apart by its ID and the time it was last updated, so a run that is re-run after it was recorded is recorded again, in its new state.

`started_at` and `completed_at` are when the first job of the latest attempt started and its last job finished, and `duration_seconds` is the time between them.
They are taken from the run's first 100 jobs.

## How a scan stays cheap

1. **Repositories.** The public repositories of each organization, and each listed repository, are looked up through GraphQL, which also follows renames.
   The answer is cached for six hours.
2. **Change detection.** The newest run of each repository is requested from the REST API with the ETag of the previous scan.
   GitHub answers `304 Not Modified` when nothing changed, which does not count against the rate limit, and that repository is skipped.
3. **Listing.** For a repository that changed, its workflows are listed (REST, also conditional), and the newest runs of all of its workflows are paged through with GraphQL, many workflows per query, back to the newest run the previous scan saw.
   On a repository's first scan, it pages back 90 days.
4. **Details.** The finished runs not yet recorded are fetched through GraphQL in batches of 50, along with the runs that had not finished when last seen, which are looked up directly by ID.

What a scan leaves for the next (the ETags and cached responses, the newest run seen of each workflow, and the unfinished runs) is kept with `actions/cache`.
The cache is saved only once the records it describes are pushed.
Losing it costs API calls, not data: the scan looks back again, and appends nothing the `data` branch already has.

Repositories are scanned in chunks of 25, and a scan stops starting new chunks after 40 minutes or when the rate limit runs out, keeping what it finished.
The next scan carries on from there.

Each run writes a summary of what it found and what it spent: REST requests and how many were `304`, and GraphQL points.

## Running it by hand

From the Actions tab, `Scan workflow runs` can be run with:

- **force**: list the newest runs of every repository, even those whose newest run looks unchanged.
  This picks up re-runs of older runs, which the change detection does not see.
- **backfill-days**: how far back to look on the first scan of a repository.

Locally, with a token that can read the repositories:

```bash
pip install --group scan
git worktree add data-branch data
GITHUB_TOKEN=... python -m spectus scan --config config.json --data-dir data-branch --cache-dir .spectus-cache
```

## Setup

1. Create the `config` branch with only `config.json` on it, if it does not exist yet.
2. Optionally, add a repository secret named `SPECTUS_TOKEN` holding a personal access token.
   The workflow's own token works for public repositories, but GraphQL allows it only 1,000 points an hour; a personal access token gets 5,000.
   A fine-grained token with read-only access to public repositories is enough.
3. Run `Scan workflow runs` once by hand.
   The first scan creates the `data` branch.

## Development

```bash
pip install --group test
python -m pytest
```

The tests run the scan against an in-memory GitHub (`tests/python/fake_github.py`) that answers the REST and GraphQL requests a scan makes, ETags included.

After changing a LinkML schema, regenerate its JSON Schema export:

```bash
pip install --group schemas
python scripts/generate_json_schemas.py
```

CI fails if an export does not match its schema.
