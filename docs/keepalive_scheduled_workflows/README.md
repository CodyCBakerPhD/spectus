# Keepalive for scheduled workflows

GitHub disables scheduled workflows in public repositories after 60 days without repository activity.
When that happens, daily tests and checks stop running without any notification.

The `Keep scheduled workflows alive` workflow runs every Monday.
It uses a personal access token (classic) to re-enable workflows across repositories.
Enabling a workflow through the API resets the inactivity timer.

It covers every repository owned by the token's user or by any organization that user belongs to.
Repositories the user cannot push to are skipped.
Archived repositories are skipped.

It only touches workflows that are `active` or `disabled_inactivity`.
Workflows that were disabled manually are left alone.
So are workflows disabled because the repository is a fork.

Each run writes a summary listing any workflows that had been disabled for inactivity.
The run fails if any organization, repository, or workflow could not be reached.

## Setup

1. Create a personal access token (classic) at Settings > Developer settings > Personal access tokens > Tokens (classic).
   - Select the `repo` scope.
   - Choose an expiration. If it expires, the weekly run fails and GitHub emails you.
2. For any organization that enforces SAML single sign-on, click **Configure SSO** next to the token and authorize it.
   Organizations that are not authorized are listed as failures in each run.
3. Add a repository secret here named `KEEPALIVE_TOKEN` containing the token.
4. Run the workflow manually with **dry** checked to preview what it would enable.
   Then run it once without **dry** to re-enable anything already disabled.

New organizations are covered automatically once the token's user joins them.
Organizations with SAML single sign-on also need the token authorized as in step 2.
