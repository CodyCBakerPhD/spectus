import { describe, expect, it } from "vitest";
import type { WorkflowRun } from "../../src/data.js";
import {
    bin_of,
    bins_between,
    build_status_grid,
    cell_state,
    durations_by_workflow,
    events_of,
    filter_runs,
    median,
    outcome_of,
    outcomes_over_time,
    success_rate,
    totals,
    workflow_key,
    workflow_statuses,
} from "../../src/stats.js";

let next_id = 1;

function run(fields: Partial<WorkflowRun> = {}): WorkflowRun {
    const id = next_id++;
    return {
        id,
        repository: "con/spectus",
        workflow_name: "Tests",
        workflow_path: ".github/workflows/tests.yml",
        run_number: id,
        event: "push",
        status: "completed",
        conclusion: "success",
        created_at: "2026-10-15T10:00:00Z",
        updated_at: "2026-10-15T10:05:00Z",
        started_at: "2026-10-15T10:00:10Z",
        completed_at: "2026-10-15T10:05:00Z",
        duration_seconds: 290,
        head_branch: "main",
        head_sha: "0".repeat(40),
        actor: "octocat",
        url: `https://github.com/con/spectus/actions/runs/${id}`,
        ...fields,
    };
}

describe("outcome_of", () => {
    it.each([
        ["success", "succeeded"],
        ["failure", "failed"],
        ["timed_out", "failed"],
        ["startup_failure", "failed"],
        ["cancelled", "cancelled"],
        ["skipped", "cancelled"],
        ["action_required", "other"],
        ["neutral", "other"],
        ["stale", "other"],
        [null, "other"],
    ])("groups %s as %s", (conclusion, outcome) => {
        expect(outcome_of(run({ conclusion }))).toBe(outcome);
    });
});

describe("bins", () => {
    it("names a day by its date, a week by its Monday, and a month by its first", () => {
        const sunday = new Date("2026-10-18T23:59:59Z");
        expect(bin_of(sunday, "daily")).toBe("2026-10-18");
        expect(bin_of(sunday, "weekly")).toBe("2026-10-12");
        expect(bin_of(new Date("2026-10-12T00:00:00Z"), "weekly")).toBe("2026-10-12");
        expect(bin_of(sunday, "monthly")).toBe("2026-10-01");
    });

    it("lists every bin of a window, including the partial ones at its ends", () => {
        const start = new Date("2026-09-29T12:00:00Z");
        const end = new Date("2026-10-02T01:00:00Z");
        expect(bins_between(start, end, "daily")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
        expect(bins_between(start, end, "weekly")).toEqual(["2026-09-28"]);
        expect(bins_between(start, end, "monthly")).toEqual(["2026-09-01", "2026-10-01"]);
        expect(bins_between(new Date("2026-01-31Z"), new Date("2026-03-01Z"), "monthly")).toEqual([
            "2026-01-01",
            "2026-02-01",
            "2026-03-01",
        ]);
    });
});

describe("filter_runs", () => {
    const window = { start: new Date("2026-10-10T00:00:00Z"), end: new Date("2026-10-17T00:00:00Z") };

    it("keeps finished runs created within the window", () => {
        const runs = [
            run({ created_at: "2026-10-09T23:59:59Z" }),
            run({ created_at: "2026-10-10T00:00:00Z" }),
            run({ created_at: "2026-10-16T12:00:00Z", status: "in_progress", conclusion: null }),
            run({ created_at: "2026-10-17T00:00:00Z" }),
            run({ created_at: "2026-10-17T00:00:01Z" }),
        ];
        expect(filter_runs(runs, { ...window, event: "all" }).map((kept) => kept.created_at)).toEqual([
            "2026-10-10T00:00:00Z",
            "2026-10-17T00:00:00Z",
        ]);
    });

    it("keeps the runs of one event", () => {
        const runs = [run({ event: "push" }), run({ event: "schedule" })];
        expect(filter_runs(runs, { ...window, event: "schedule" }).map((kept) => kept.event)).toEqual(["schedule"]);
    });
});

describe("events_of", () => {
    it("lists events most common first, ties by name", () => {
        const runs = ["push", "schedule", "pull_request", "schedule", "push", "schedule"].map((event) =>
            run({ event })
        );
        expect(events_of(runs)).toEqual(["schedule", "push", "pull_request"]);
    });
});

describe("median and success_rate", () => {
    it("takes the middle value, or the mean of the middle two", () => {
        expect(median([5, 1, 3])).toBe(3);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(median([])).toBeNull();
    });

    it("weighs succeeded against failed runs only", () => {
        expect(success_rate(3, 1)).toBe(0.75);
        expect(success_rate(0, 0)).toBeNull();
    });
});

describe("totals", () => {
    it("summarizes the runs", () => {
        const runs = [
            run({ conclusion: "success", duration_seconds: 100 }),
            run({ conclusion: "failure", duration_seconds: 300 }),
            run({ conclusion: "cancelled", duration_seconds: null }),
            run({ repository: "dandi/dandi-cli", conclusion: "success", duration_seconds: 200 }),
            run({ workflow_path: ".github/workflows/lint.yml", workflow_name: "Lint" }),
        ];
        expect(totals(runs)).toEqual({
            runs: 5,
            succeeded: 3,
            failed: 1,
            success_rate: 0.75,
            repositories: 2,
            workflows: 3,
            median_duration: 245,
        });
    });

    it("has nothing to rate or time without runs", () => {
        expect(totals([])).toMatchObject({ runs: 0, success_rate: null, median_duration: null });
    });
});

describe("workflow_key", () => {
    it("tells workflows apart by repository and file, falling back to the name", () => {
        expect(workflow_key(run())).toBe("con/spectus/.github/workflows/tests.yml");
        expect(workflow_key(run({ workflow_path: null, workflow_name: "Pages" }))).toBe("con/spectus/Pages");
    });
});

describe("outcomes_over_time", () => {
    it("counts each outcome per bin, empty bins included", () => {
        const runs = [
            run({ created_at: "2026-10-15T01:00:00Z", conclusion: "failure" }),
            run({ created_at: "2026-10-15T23:00:00Z" }),
            run({ created_at: "2026-10-17T05:00:00Z", conclusion: "skipped" }),
            run({ created_at: "2026-10-01T05:00:00Z" }),
        ];
        const series = outcomes_over_time(
            runs,
            new Date("2026-10-15T00:00:00Z"),
            new Date("2026-10-17T12:00:00Z"),
            "daily"
        );
        expect(series.bins).toEqual(["2026-10-15", "2026-10-16", "2026-10-17"]);
        expect(series.counts).toEqual({
            failed: [1, 0, 0],
            succeeded: [1, 0, 0],
            other: [0, 0, 0],
            cancelled: [0, 0, 1],
        });
    });
});

describe("workflow_statuses", () => {
    it("reports each workflow's latest run, failing workflows first", () => {
        const runs = [
            run({ repository: "b/b", created_at: "2026-10-10T00:00:00Z", conclusion: "failure" }),
            run({ repository: "b/b", created_at: "2026-10-12T00:00:00Z", conclusion: "success" }),
            run({ repository: "a/a", created_at: "2026-10-12T00:00:00Z", conclusion: "success" }),
            run({ repository: "c/c", created_at: "2026-10-12T00:00:00Z", conclusion: "action_required" }),
            run({ repository: "d/d", created_at: "2026-10-11T00:00:00Z", conclusion: "success" }),
            run({ repository: "d/d", created_at: "2026-10-12T00:00:00Z", conclusion: "timed_out" }),
            run({ repository: "e/e", created_at: "2026-10-12T00:00:00Z", conclusion: "cancelled" }),
        ];
        const statuses = workflow_statuses(runs);
        expect(statuses.map((status) => [status.repository, status.latest.conclusion])).toEqual([
            ["d/d", "timed_out"],
            ["c/c", "action_required"],
            ["e/e", "cancelled"],
            ["a/a", "success"],
            ["b/b", "success"],
        ]);
        expect(statuses[4]).toMatchObject({
            runs: 2,
            succeeded: 1,
            failed: 1,
            success_rate: 0.5,
            median_duration: 290,
        });
    });

    it("breaks a tie in creation time by the later run", () => {
        const first = run({ created_at: "2026-10-12T00:00:00Z", conclusion: "failure" });
        const second = run({ created_at: "2026-10-12T00:00:00Z", conclusion: "success" });
        expect(workflow_statuses([second, first])[0].latest).toBe(second);
    });
});

describe("cell_state", () => {
    it.each([
        [0, 0, "none"],
        [3, 0, "passing"],
        [3, 1, "some_failed"],
        [1, 1, "mostly_failed"],
        [0, 2, "mostly_failed"],
    ])("calls %s succeeded and %s failed %s", (succeeded, failed, state) => {
        expect(cell_state(succeeded, failed)).toBe(state);
    });
});

describe("build_status_grid", () => {
    const start = new Date("2026-10-14T00:00:00Z");
    const end = new Date("2026-10-15T12:00:00Z");

    it("has a row per repository across several repositories", () => {
        const runs = [
            run({ repository: "b/b", created_at: "2026-10-14T01:00:00Z" }),
            run({ repository: "b/b", created_at: "2026-10-14T02:00:00Z", conclusion: "failure" }),
            run({ repository: "a/a", created_at: "2026-10-15T01:00:00Z", conclusion: "cancelled" }),
        ];
        const grid = build_status_grid(runs, start, end, "daily");
        expect(grid.rows).toEqual(["a/a", "b/b"]);
        expect(grid.bins).toEqual(["2026-10-14", "2026-10-15"]);
        expect(grid.cells.map((row) => row.map((cell) => cell.state))).toEqual([
            ["none", "none"],
            ["mostly_failed", "none"],
        ]);
        expect(grid.cells[0][1]).toEqual({ state: "none", succeeded: 0, failed: 0, runs: 1 });
        expect(grid.hidden_rows).toBe(0);
    });

    it("has a row per workflow within one repository", () => {
        const runs = [run({ workflow_name: "Tests" }), run({ workflow_name: "Lint", conclusion: "failure" })];
        const grid = build_status_grid(runs, start, new Date("2026-10-16T00:00:00Z"), "daily");
        expect(grid.rows).toEqual(["Lint", "Tests"]);
    });

    it("keeps the busiest rows and counts the rest", () => {
        const runs = ["a/a", "b/b", "b/b", "c/c", "c/c", "c/c"].map((repository) =>
            run({ repository, created_at: "2026-10-14T01:00:00Z" })
        );
        const grid = build_status_grid(runs, start, end, "daily", 2);
        expect(grid.rows).toEqual(["b/b", "c/c"]);
        expect(grid.hidden_rows).toBe(1);
    });
});

describe("durations_by_workflow", () => {
    it("groups timed runs by workflow, slowest median first", () => {
        const runs = [
            run({ workflow_name: "Fast", workflow_path: "fast.yml", duration_seconds: 10 }),
            run({ workflow_name: "Fast", workflow_path: "fast.yml", duration_seconds: 30 }),
            run({ workflow_name: "Slow", workflow_path: "slow.yml", duration_seconds: 600 }),
            run({ workflow_name: "Slow", workflow_path: "slow.yml", duration_seconds: null }),
        ];
        expect(durations_by_workflow(runs)).toEqual([
            { key: "con/spectus/slow.yml", label: "Slow", durations: [600], median: 600 },
            { key: "con/spectus/fast.yml", label: "Fast", durations: [10, 30], median: 20 },
        ]);
    });

    it("names each workflow's repository when there are several, and keeps the most timed", () => {
        const runs = [
            run({ repository: "a/a", duration_seconds: 5 }),
            run({ repository: "b/b", duration_seconds: 5 }),
            run({ repository: "b/b", duration_seconds: 7 }),
        ];
        expect(durations_by_workflow(runs, 1).map((group) => group.label)).toEqual(["b/b · Tests"]);
    });
});
