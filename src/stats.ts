/**
 * Summaries of workflow runs: pure functions from records to the numbers the page draws.
 *
 * Every date here is a UTC calendar date written `YYYY-MM-DD`; a week is named by its Monday and a month by its first.
 */

import type { WorkflowRun } from "./data.js";

/** What became of a run, in the four groups the page distinguishes. */
export type Outcome = "failed" | "succeeded" | "other" | "cancelled";

/** In stacking order: failures sit on the baseline, so they can be compared from one bar to the next. */
export const OUTCOMES: Outcome[] = ["failed", "succeeded", "other", "cancelled"];

export const OUTCOME_LABELS: Record<Outcome, string> = {
    failed: "Failed",
    succeeded: "Succeeded",
    other: "Needs attention",
    cancelled: "Cancelled or skipped",
};

/** The fixed status colors, the same in both themes (see the status palette in styles.css). */
export const OUTCOME_COLORS: Record<Outcome, string> = {
    failed: "#d03b3b",
    succeeded: "#0ca30c",
    other: "#fab219",
    cancelled: "#898781",
};

/** Paired with each status color, so an outcome is never told by color alone. */
export const OUTCOME_ICONS: Record<Outcome, string> = {
    failed: "✕",
    succeeded: "✓",
    other: "!",
    cancelled: "–",
};

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
const CANCELLED_CONCLUSIONS = new Set(["cancelled", "skipped"]);

export function outcome_of(run: WorkflowRun): Outcome {
    if (run.conclusion === "success") return "succeeded";
    if (run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)) return "failed";
    if (run.conclusion !== null && CANCELLED_CONCLUSIONS.has(run.conclusion)) return "cancelled";
    return "other";
}

export type Aggregation = "daily" | "weekly" | "monthly";

const DAY_MS = 86400000;

/** The UTC calendar date of a moment. */
export function utc_date(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** The date naming the day, week (its Monday), or month (its first) a moment falls in. */
export function bin_of(date: Date, aggregation: Aggregation): string {
    if (aggregation === "monthly") return `${utc_date(date).slice(0, 7)}-01`;
    if (aggregation === "weekly") {
        const days_since_monday = (date.getUTCDay() + 6) % 7;
        return utc_date(new Date(Date.parse(utc_date(date)) - days_since_monday * DAY_MS));
    }
    return utc_date(date);
}

/** Every bin from the one holding `start` to the one holding `end`, oldest first. */
export function bins_between(start: Date, end: Date, aggregation: Aggregation): string[] {
    const bins: string[] = [];
    const last = bin_of(end, aggregation);
    let current = bin_of(start, aggregation);
    while (current <= last) {
        bins.push(current);
        const date = new Date(`${current}T00:00:00Z`);
        if (aggregation === "monthly") date.setUTCMonth(date.getUTCMonth() + 1);
        else date.setUTCDate(date.getUTCDate() + (aggregation === "weekly" ? 7 : 1));
        current = utc_date(date);
    }
    return bins;
}

export interface RunFilter {
    start: Date;
    end: Date;
    /** Only runs triggered by this event, or every run for "all". */
    event: string;
}

/** The finished runs created within the window and triggered by the chosen event. */
export function filter_runs(runs: WorkflowRun[], filter: RunFilter): WorkflowRun[] {
    const start = filter.start.getTime();
    const end = filter.end.getTime();
    return runs.filter((run) => {
        const created = Date.parse(run.created_at);
        return (
            run.status === "completed" &&
            created >= start &&
            created <= end &&
            (filter.event === "all" || run.event === filter.event)
        );
    });
}

/** The events the runs were triggered by, most common first. */
export function events_of(runs: WorkflowRun[]): string[] {
    const counts = new Map<string, number>();
    for (const run of runs) counts.set(run.event, (counts.get(run.event) ?? 0) + 1);
    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([event]) => event);
}

export function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Succeeded runs as a share of those that succeeded or failed; null if none did either. */
export function success_rate(succeeded: number, failed: number): number | null {
    return succeeded + failed === 0 ? null : succeeded / (succeeded + failed);
}

function durations(runs: WorkflowRun[]): number[] {
    return runs.map((run) => run.duration_seconds).filter((value): value is number => value !== null);
}

function count_outcomes(runs: WorkflowRun[]): Record<Outcome, number> {
    const counts: Record<Outcome, number> = { failed: 0, succeeded: 0, other: 0, cancelled: 0 };
    for (const run of runs) counts[outcome_of(run)] += 1;
    return counts;
}

export interface Totals {
    runs: number;
    succeeded: number;
    failed: number;
    success_rate: number | null;
    repositories: number;
    workflows: number;
    median_duration: number | null;
}

/** A workflow is told apart by its repository and its file, which outlasts a change of its name. */
export function workflow_key(run: WorkflowRun): string {
    return `${run.repository}/${run.workflow_path ?? run.workflow_name}`;
}

export function totals(runs: WorkflowRun[]): Totals {
    const counts = count_outcomes(runs);
    return {
        runs: runs.length,
        succeeded: counts.succeeded,
        failed: counts.failed,
        success_rate: success_rate(counts.succeeded, counts.failed),
        repositories: new Set(runs.map((run) => run.repository)).size,
        workflows: new Set(runs.map(workflow_key)).size,
        median_duration: median(durations(runs)),
    };
}

export interface OutcomesOverTime {
    bins: string[];
    counts: Record<Outcome, number[]>;
}

/** How many runs of each outcome were created in each bin of the window, empty bins included. */
export function outcomes_over_time(
    runs: WorkflowRun[],
    start: Date,
    end: Date,
    aggregation: Aggregation
): OutcomesOverTime {
    const bins = bins_between(start, end, aggregation);
    const index = new Map(bins.map((bin, position) => [bin, position]));
    const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, bins.map(() => 0)])) as Record<
        Outcome,
        number[]
    >;
    for (const run of runs) {
        const position = index.get(bin_of(new Date(run.created_at), aggregation));
        if (position !== undefined) counts[outcome_of(run)][position] += 1;
    }
    return { bins, counts };
}

export interface WorkflowStatus {
    key: string;
    repository: string;
    workflow: string;
    /** The most recently created run. */
    latest: WorkflowRun;
    runs: number;
    succeeded: number;
    failed: number;
    success_rate: number | null;
    median_duration: number | null;
}

const SEVERITY: Record<Outcome, number> = { failed: 0, other: 1, cancelled: 2, succeeded: 3 };

/**
 * Each workflow's latest outcome and record over the runs given: workflows whose latest run failed first, then those
 * needing attention, and within each, by repository and workflow.
 */
export function workflow_statuses(runs: WorkflowRun[]): WorkflowStatus[] {
    const by_workflow = new Map<string, WorkflowRun[]>();
    for (const run of runs) {
        const key = workflow_key(run);
        const list = by_workflow.get(key);
        if (list) list.push(run);
        else by_workflow.set(key, [run]);
    }

    const statuses: WorkflowStatus[] = [];
    for (const [key, workflow_runs] of by_workflow) {
        const latest = workflow_runs.reduce((newest, run) =>
            run.created_at > newest.created_at || (run.created_at === newest.created_at && run.id > newest.id)
                ? run
                : newest
        );
        const counts = count_outcomes(workflow_runs);
        statuses.push({
            key,
            repository: latest.repository,
            workflow: latest.workflow_name,
            latest,
            runs: workflow_runs.length,
            succeeded: counts.succeeded,
            failed: counts.failed,
            success_rate: success_rate(counts.succeeded, counts.failed),
            median_duration: median(durations(workflow_runs)),
        });
    }
    return statuses.sort(
        (a, b) =>
            SEVERITY[outcome_of(a.latest)] - SEVERITY[outcome_of(b.latest)] ||
            a.repository.localeCompare(b.repository) ||
            a.workflow.localeCompare(b.workflow)
    );
}

/** The state of one row in one bin of the status grid. */
export type CellState = "none" | "passing" | "some_failed" | "mostly_failed";

export const CELL_STATES: CellState[] = ["none", "passing", "some_failed", "mostly_failed"];

export const CELL_LABELS: Record<CellState, string> = {
    none: "No runs that succeeded or failed",
    passing: "All succeeded",
    some_failed: "Some failed",
    mostly_failed: "Half or more failed",
};

export function cell_state(succeeded: number, failed: number): CellState {
    if (succeeded + failed === 0) return "none";
    if (failed === 0) return "passing";
    return failed / (succeeded + failed) >= 0.5 ? "mostly_failed" : "some_failed";
}

export interface StatusGrid {
    /** The row labels, top to bottom. */
    rows: string[];
    bins: string[];
    /** Per row, per bin: the state, and the counts behind it. */
    cells: Array<Array<{ state: CellState; succeeded: number; failed: number; runs: number }>>;
    /** How many rows were left out to keep the grid readable. */
    hidden_rows: number;
}

/**
 * Whether the runs of each row passed or failed in each bin of the window.  Across several repositories a row is a
 * repository; within one, a row is one of its workflows.  The rows with the most runs are kept, up to `limit`, and
 * are listed by name.
 */
export function build_status_grid(
    runs: WorkflowRun[],
    start: Date,
    end: Date,
    aggregation: Aggregation,
    limit = 30
): StatusGrid {
    const by_repository = new Set(runs.map((run) => run.repository)).size > 1;
    const row_of = (run: WorkflowRun) => (by_repository ? run.repository : run.workflow_name);
    const bins = bins_between(start, end, aggregation);
    const index = new Map(bins.map((bin, position) => [bin, position]));

    const totals_by_row = new Map<string, number>();
    for (const run of runs) totals_by_row.set(row_of(run), (totals_by_row.get(row_of(run)) ?? 0) + 1);
    const kept = Array.from(totals_by_row.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([row]) => row)
        .sort((a, b) => a.localeCompare(b));
    const row_index = new Map(kept.map((row, position) => [row, position]));

    const cells = kept.map(() => bins.map(() => ({ state: "none" as CellState, succeeded: 0, failed: 0, runs: 0 })));
    for (const run of runs) {
        const row = row_index.get(row_of(run));
        const column = index.get(bin_of(new Date(run.created_at), aggregation));
        if (row === undefined || column === undefined) continue;
        const cell = cells[row][column];
        const outcome = outcome_of(run);
        cell.runs += 1;
        if (outcome === "succeeded") cell.succeeded += 1;
        if (outcome === "failed") cell.failed += 1;
    }
    for (const row of cells) for (const cell of row) cell.state = cell_state(cell.succeeded, cell.failed);

    return { rows: kept, bins, cells, hidden_rows: totals_by_row.size - kept.length };
}

export interface DurationGroup {
    key: string;
    label: string;
    durations: number[];
    median: number | null;
}

/** The durations of the runs of each workflow, for the `limit` workflows with the most timed runs, slowest first. */
export function durations_by_workflow(runs: WorkflowRun[], limit = 15): DurationGroup[] {
    const several_repositories = new Set(runs.map((run) => run.repository)).size > 1;
    const groups = new Map<string, DurationGroup>();
    for (const run of runs) {
        if (run.duration_seconds === null) continue;
        const key = workflow_key(run);
        let group = groups.get(key);
        if (!group) {
            const label = several_repositories ? `${run.repository} · ${run.workflow_name}` : run.workflow_name;
            group = { key, label, durations: [], median: null };
            groups.set(key, group);
        }
        group.durations.push(run.duration_seconds);
    }
    return Array.from(groups.values())
        .sort((a, b) => b.durations.length - a.durations.length || a.label.localeCompare(b.label))
        .slice(0, limit)
        .map((group) => ({ ...group, median: median(group.durations) }))
        .sort((a, b) => (b.median ?? 0) - (a.median ?? 0) || a.label.localeCompare(b.label));
}
