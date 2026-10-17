# Workflow runs dashboard

The dashboard is a static page, built with [Vite](https://vite.dev) and drawn with [Plotly](https://plotly.com/javascript/), deployed to GitHub Pages from the `gh-pages` branch.
Its layout and test setup follow [dandi/usage-page](https://github.com/dandi/usage-page).

It shows, for every configured repository or for one owner or repository at a time, over the last 7, 30, or 90 days or the last year:

- totals: runs, success rate, failures, workflows, repositories, and median duration;
- runs over time, stacked by outcome, per day, week, or month (or as a table);
- each workflow's latest run, with its success rate and median duration, failing workflows first;
- a grid of whether each repository (or, for one repository, each workflow) passed or failed each day or week;
- the spread of each workflow's run durations (or as a table).

Every setting is kept in the URL, so a view can be linked to.

## Data

The deploy checks out the `data` branch and bundles its records into the site, beside a `data/manifest.json` listing the months each repository has records for (see `src/scripts/build-data.mjs`).
The page's time window ends when the data was bundled.
Each run is counted once, in its latest recorded state.

The site is redeployed on every push to `main`, and after every scan that appended records.

## Setup

In the repository's Settings > Pages, set the source to **Deploy from a branch**, with the branch `gh-pages` and the folder `/ (root)`.
The first deploy creates the branch.

Optional repository secrets, as for dandi/usage-page:

- `CODECOV_TOKEN`, to report coverage to [Codecov](https://codecov.io);
- `CHROMATIC_STORYBOOK_PROJECT_TOKEN` and `CHROMATIC_PLAYWRIGHT_PROJECT_TOKEN`, to publish to [Chromatic](https://www.chromatic.com); without them, the upload is skipped;
- `MAIL_USERNAME` and `MAIL_PASSWORD`, for the emails about failing daily and weekly tests and npm audits.

## Development

```bash
npm install
git worktree add data-branch data  # optional: records to look at
npm run dev
```

`npm run dev` serves the records of `data-branch/` (or of `$SPECTUS_DATA_DIR`) at `./data/`, as the deploy bundles them.

### Tests

```bash
npm test                   # unit tests (Vitest, in jsdom)
npm run test:coverage      # the same, with a coverage report
npm run test:e2e           # integration tests (Playwright, in Chromium)
npm run test:visual        # screenshot comparison of the plots against committed baselines
npm run test:chromatic     # snapshots for Chromatic, at five viewports in both themes
npm run storybook          # the Storybook stories
```

Every suite renders the page from the same generated fixture, `tests/fixtures/mock-data.js`.
The unit tests cover the page's entry module (`src/main.ts`) as well as its helpers: `tests/unit/page-harness.ts` loads the page's markup into jsdom, stands in for Plotly and for the network, and drives the page through its controls.

Playwright is pinned to 1.56.1, whose Chromium is the one preinstalled in Claude Code cloud sessions, so that the screenshot baselines taken there match CI.
After bumping it, regenerate the baselines with `npm run test:visual -- --update-snapshots`.
