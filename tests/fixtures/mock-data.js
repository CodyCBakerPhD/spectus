// Static fixture data standing in for the records the page fetches.
//
// Shared by every suite that renders the page against fixed content: the Playwright suites mock the network with it
// (see page-mocks.js) and the jsdom harness serves it from a stubbed fetch, so a change here reaches both.  The runs
// are generated from a fixed seed, so snapshots and assertions are never affected by live data changing between runs.

/** When the mock data was bundled, which is where the page's time window ends. */
export const GENERATED_AT = "2026-10-17T12:00:00Z";

const DAY_MS = 86400000;
const DAYS = 100;

// A small, seeded pseudo-random generator (mulberry32), so every suite sees the same runs.
function random_generator(seed) {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The workflows of the mock repositories: how many runs each has a day, how they are triggered, how often they fail,
 * and how long they take.  `failing_since` makes a workflow fail on every run from that many days before the end.
 */
const WORKFLOWS = [
    {
        repository: "con/spectus",
        name: "Tests",
        path: "tests.yml",
        per_day: 3,
        events: ["push", "pull_request"],
        failure: 0.08,
        minutes: 6,
    },
    {
        repository: "con/spectus",
        name: "Scan workflow runs",
        path: "scan-workflow-runs.yml",
        per_day: 2,
        events: ["schedule"],
        failure: 0.02,
        minutes: 3,
    },
    {
        repository: "con/spectus",
        name: "Keep scheduled workflows alive",
        path: "keepalive_scheduled_workflows.yml",
        per_day: 1 / 7,
        events: ["schedule"],
        failure: 0,
        minutes: 1,
    },
    {
        repository: "con/datalad-usage-dashboard",
        name: "Update",
        path: "update.yml",
        per_day: 1,
        events: ["schedule"],
        failure: 0.05,
        minutes: 25,
    },
    {
        repository: "dandi/dandi-cli",
        name: "Tests",
        path: "test.yml",
        per_day: 2,
        events: ["push", "pull_request", "schedule"],
        failure: 0.2,
        minutes: 18,
    },
    {
        repository: "dandi/dandi-cli",
        name: "Lint",
        path: "lint.yml",
        per_day: 1.5,
        events: ["push", "pull_request"],
        failure: 0.05,
        minutes: 1,
    },
    {
        repository: "dandi/dandi-archive",
        name: "CI",
        path: "ci.yml",
        per_day: 2,
        events: ["push", "pull_request"],
        failure: 0.1,
        minutes: 12,
    },
    {
        repository: "dandi/dandi-archive",
        name: "Nightly",
        path: "nightly.yml",
        per_day: 1,
        events: ["schedule"],
        failure: 0.1,
        minutes: 40,
        failing_since: 5,
    },
    {
        repository: "dandi/dandi-schema",
        name: "Tests",
        path: "tests.yml",
        per_day: 0.5,
        events: ["push", "pull_request"],
        failure: 0.1,
        minutes: 4,
    },
];

const OTHER_CONCLUSIONS = ["cancelled", "cancelled", "skipped", "timed_out", "action_required", "startup_failure"];

function iso(milliseconds) {
    return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function generate_runs() {
    const random = random_generator(20261017);
    const end = Date.parse(GENERATED_AT);
    const runs = [];
    let id = 18000000000;
    for (const workflow of WORKFLOWS) {
        let run_number = 1;
        for (let day = DAYS; day >= 1; day--) {
            const expected = workflow.per_day;
            const count = Math.floor(expected) + (random() < expected - Math.floor(expected) ? 1 : 0);
            for (let index = 0; index < count; index++) {
                const created = end - day * DAY_MS + Math.floor(random() * DAY_MS * 0.9);
                const event = workflow.events[Math.floor(random() * workflow.events.length)];
                const failing = workflow.failing_since !== undefined && day <= workflow.failing_since;
                const roll = random();
                let conclusion = "success";
                if (failing || roll < workflow.failure) conclusion = "failure";
                else if (roll > 0.96) conclusion = OTHER_CONCLUSIONS[Math.floor(random() * OTHER_CONCLUSIONS.length)];
                const queued = Math.floor(random() * 40) * 1000;
                const seconds = Math.max(5, Math.round(workflow.minutes * 60 * (0.6 + random() * 0.8)));
                const timed = conclusion !== "startup_failure" && conclusion !== "skipped";
                const started = created + queued;
                const completed = started + (timed ? seconds * 1000 : 0);
                id += 1 + Math.floor(random() * 1000);
                runs.push({
                    id,
                    repository: workflow.repository,
                    workflow_name: workflow.name,
                    workflow_path: `.github/workflows/${workflow.path}`,
                    run_number: run_number++,
                    event,
                    status: "completed",
                    conclusion,
                    created_at: iso(created),
                    updated_at: iso(completed + 2000),
                    started_at: timed ? iso(started) : null,
                    completed_at: timed ? iso(completed) : null,
                    duration_seconds: timed ? seconds : null,
                    head_branch: event === "pull_request" ? `feature-${run_number % 7}` : "main",
                    head_sha: id.toString(16).padStart(40, "0").slice(-40),
                    actor: event === "schedule" ? null : ["octocat", "yarikoptic", "CodyCBakerPhD"][run_number % 3],
                    url: `https://github.com/${workflow.repository}/actions/runs/${id}`,
                });
            }
        }
    }
    // Every workflow's latest run passed, except for the one failing on purpose, so that it alone heads the status table
    for (const workflow of WORKFLOWS.filter((workflow) => workflow.failing_since === undefined)) {
        const latest = runs
            .filter((run) => run.repository === workflow.repository && run.workflow_name === workflow.name)
            .reduce((newest, run) => (run.created_at > newest.created_at ? run : newest));
        latest.conclusion = "success";
    }
    return runs.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
}

export const RUNS = generate_runs();

// A failed run of con/spectus that was re-run and passed: recorded twice, the later record superseding the earlier.
const RERUN = RUNS.find((run) => run.repository === "con/spectus" && run.created_at >= "2026-10-10");
export const RERUN_ID = RERUN.id;
const RERUN_RECORDS = [
    { ...RERUN, conclusion: "failure" },
    { ...RERUN, conclusion: "success", updated_at: iso(Date.parse(RERUN.updated_at) + 3600000) },
];

function minute_key(run) {
    return run.created_at.slice(0, 16);
}

function build_files() {
    /** @type {Record<string, string>} */
    const files = {};
    const records = [...RUNS.filter((run) => run.id !== RERUN_ID), ...RERUN_RECORDS];
    for (const run of records) {
        const path = `${run.repository}/${run.created_at.slice(0, 4)}${run.created_at.slice(5, 7)}.jsonl`;
        files[path] = (files[path] ?? "") + JSON.stringify({ [minute_key(run)]: run }) + "\n";
    }
    return files;
}

/**
 * The text of each data file, by its path under `data/`.
 * @type {Record<string, string>}
 */
export const DATA_FILES = build_files();

/**
 * The manifest the deploy would write for these files.
 * @type {{ generated_at: string, repositories: Record<string, string[]> }}
 */
export const MANIFEST = {
    generated_at: GENERATED_AT,
    repositories: Object.fromEntries(
        [...new Set(Object.keys(DATA_FILES).map((path) => path.slice(0, path.lastIndexOf("/"))))]
            .sort()
            .map((repository) => [
                repository,
                Object.keys(DATA_FILES)
                    .filter((path) => path.startsWith(`${repository}/`))
                    .map((path) => path.slice(-12, -6))
                    .sort(),
            ])
    ),
};
