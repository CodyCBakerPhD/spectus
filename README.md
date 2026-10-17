# spectus
Metaview of cross-org GitHub status for maintenance purposes.

## Dashboard

- [Workflow runs dashboard](docs/dashboard/README.md) is the web page on GitHub Pages that shows how the GitHub Actions runs of every configured repository have gone: runs over time, each workflow's latest status, a daily status grid, and run durations.

## Workflows

- [Workflow run scan](docs/workflow_runs/README.md) records the finished GitHub Actions runs of the repositories listed on the `config` branch to the `data` branch every hour.
- [Keepalive for scheduled workflows](docs/keepalive_scheduled_workflows/README.md) re-enables scheduled workflows across every repository we can push to so GitHub does not disable them for inactivity.

## Branches

| Branch | Holds |
| --- | --- |
| `main` | The dashboard, the scan, the schemas, and every workflow. |
| `config` | Only `config.json`: which organizations and repositories to scan. Changed through pull requests, which are validated against the schema. |
| `data` | Only `data/{owner}/{repository}/{YYYYMM}.jsonl`: one record per workflow run, appended by the scan. |
| `gh-pages` | The deployed dashboard, and the previews of open pull requests. |
