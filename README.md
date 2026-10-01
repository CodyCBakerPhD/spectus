# spectus
Metaview of cross-org GitHub status for maintenance purposes.

## Keepalive for scheduled workflows

GitHub disables scheduled workflows in public repositories after 60 days without repository activity.
When that happens, daily tests and checks stop running without any notification.

The `Keep scheduled workflows alive` workflow runs every Monday.
It re-enables workflows in every repository that the keepalive GitHub App is installed on.
Enabling a workflow through the API resets the inactivity timer.

It only touches workflows that are `active` or `disabled_inactivity`.
Workflows that were disabled manually are left alone.
So are workflows disabled because the repository is a fork.
Archived repositories are skipped.

Each run writes a summary listing any workflows that had been disabled for inactivity.
The run fails if any installation, repository, or workflow could not be reached.

### Setup

1. Create a GitHub App (Settings > Developer settings > GitHub Apps > New GitHub App).
   - Disable the webhook.
   - Under **Repository permissions**, set **Actions** to **Read and write**.
   - Allow it to be installed on **Any account** so it can be installed on every organization.
2. Generate a private key for the App.
3. Install the App on every organization and account to cover, with access to **All repositories**.
   Make sure this repository is included so the keepalive workflow keeps itself alive.
4. Add two repository secrets here.
   - `KEEPALIVE_APP_ID` is the App ID.
   - `KEEPALIVE_APP_PRIVATE_KEY` is the full contents of the private key file.
5. Run the workflow manually with **dry** checked to preview what it would enable.
   Then run it once without **dry** to re-enable anything already disabled.

To cover a new organization later, install the App there. No code changes are needed.
