"""
Re-enable GitHub Actions workflows across every repository a personal access token (classic) can push to.

GitHub disables scheduled workflows in public repositories after 60 days without repository activity.
Calling the 'enable' endpoint on a workflow resets that timer.

Covered repositories are those owned by the token's user or by any organization the user belongs to.
Archived repositories and repositories the user cannot push to are skipped.

Only workflows that are currently 'active' or 'disabled_inactivity' are touched.
Workflows disabled manually, or disabled because the repository is a fork, are left alone.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

API_URL = "https://api.github.com"
ENABLEABLE_STATES = ("active", "disabled_inactivity")


def _request(*, method: str, url: str, token: str) -> tuple[object, dict[str, str]]:
    request = urllib.request.Request(
        url=url,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"token {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "spectus-keepalive",
        },
    )
    with urllib.request.urlopen(request) as response:
        body = response.read()
        headers = dict(response.headers)

    payload = json.loads(body) if body else None
    return payload, headers


def _paginate(*, url: str, token: str, key: str | None = None) -> list[dict]:
    items = []
    next_url: str | None = url
    while next_url is not None:
        payload, headers = _request(method="GET", url=next_url, token=token)
        page = payload[key] if key is not None else payload
        items.extend(page)

        match = re.search(pattern=r'<([^>]+)>;\s*rel="next"', string=headers.get("Link", ""))
        next_url = match.group(1) if match is not None else None

    return items


def _is_sso_error(exception: urllib.error.HTTPError, /) -> bool:
    is_sso_error = exception.code == 403 and exception.headers.get("X-GitHub-SSO") is not None
    return is_sso_error


def keepalive(*, token: str, dry_run: bool) -> list[str]:
    """
    Enable every eligible workflow in every repository the token can push to.

    Returns
    -------
    list of str
        Human-readable descriptions of any failures.
    """
    repositories = _paginate(
        url=f"{API_URL}/user/repos?affiliation=owner,organization_member&per_page=100", token=token
    )
    repositories = [
        repository
        for repository in repositories
        if not repository["archived"] and repository.get("permissions", {}).get("push", False)
    ]
    print(f"Checking {len(repositories)} repositories")

    summary_rows = []
    failures = []
    sso_blocked_owners: set[str] = set()
    for repository in repositories:
        full_name = repository["full_name"]
        owner = repository["owner"]["login"]
        if owner in sso_blocked_owners:
            continue

        try:
            workflows = _paginate(
                url=f"{API_URL}/repos/{full_name}/actions/workflows?per_page=100", token=token, key="workflows"
            )
        except urllib.error.HTTPError as exception:
            if _is_sso_error(exception):
                sso_blocked_owners.add(owner)
                failures.append(f"{owner}: token is not authorized for this organization's SAML SSO")
            else:
                failures.append(f"{full_name}: could not list workflows ({exception.code})")
            continue

        for workflow in workflows:
            # Dynamic workflows (Dependabot, CodeQL, Pages) cannot be enabled through the API
            if not workflow["path"].startswith(".github/workflows/"):
                continue
            if workflow["state"] not in ENABLEABLE_STATES:
                continue

            label = f"{full_name}/{workflow['path'].removeprefix('.github/workflows/')}"
            if dry_run:
                print(f"[dry run] would enable {label} ({workflow['state']})")
            else:
                try:
                    _request(
                        method="PUT",
                        url=f"{API_URL}/repos/{full_name}/actions/workflows/{workflow['id']}/enable",
                        token=token,
                    )
                except urllib.error.HTTPError as exception:
                    failures.append(f"{label}: could not enable ({exception.code})")
                    continue
                print(f"enabled {label} ({workflow['state']})")

            if workflow["state"] == "disabled_inactivity":
                summary_rows.append(f"| `{full_name}` | `{workflow['path']}` |")

    _write_step_summary(summary_rows=summary_rows, failures=failures, dry_run=dry_run)
    return failures


def _write_step_summary(*, summary_rows: list[str], failures: list[str], dry_run: bool) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path is None:
        return

    lines = ["## Keepalive for scheduled workflows", ""]
    if dry_run:
        lines += ["_Dry run. Nothing was changed._", ""]
    if summary_rows:
        lines += ["Workflows that had been disabled for inactivity:", "", "| Repository | Workflow |", "|---|---|"]
        lines += summary_rows
    else:
        lines += ["No workflows were disabled for inactivity."]
    if failures:
        lines += ["", "### Failures", ""] + [f"- {failure}" for failure in failures]

    with open(summary_path, mode="a") as file:
        file.write("\n".join(lines) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry", action="store_true", help="List the workflows that would be enabled.")
    arguments = parser.parse_args()

    failures = keepalive(token=os.environ["KEEPALIVE_TOKEN"], dry_run=arguments.dry)
    for failure in failures:
        print(f"::error::{failure}")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
