import rawHTML from "../src/index.html?raw";
import { latest_records, parse_jsonl } from "../src/data.ts";
import { format_count, format_duration, format_percent } from "../src/format.ts";
import { filter_runs, outcome_of, totals, workflow_statuses } from "../src/stats.ts";
import { github_link, outcome_badge, render_sortable_table, render_totals } from "../src/tables.ts";
import { DATA_FILES, GENERATED_AT } from "../tests/fixtures/mock-data.js";

export default {
    title: "Spectus/Sections",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extracts all elements matched by `selectors` from the raw HTML and joins their outer HTML. */
function extractSections(html, ...selectors) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    return selectors
        .map((selector) => {
            const element = doc.querySelector(selector);
            return element ? element.outerHTML : "";
        })
        .join("\n");
}

function themed(theme, html) {
    return () => {
        document.documentElement.setAttribute("data-theme", theme);
        return html;
    };
}

// The last 30 days of the fixture the Playwright suites render the page from
const END = new Date(GENERATED_AT);
const RUNS = filter_runs(latest_records(Object.values(DATA_FILES).flatMap((text) => parse_jsonl(text))), {
    start: new Date(END.getTime() - 30 * 86400000),
    end: END,
    event: "all",
});

// ── Controls ──────────────────────────────────────────────────────────────────

const controlsHTML = extractSections(rawHTML, ".page-content > .ControllerContainer");

export const ControlsDark = { name: "Controls – Dark", render: themed("dark", controlsHTML) };
export const ControlsLight = { name: "Controls – Light", render: themed("light", controlsHTML) };

// ── Totals ────────────────────────────────────────────────────────────────────

function renderTotals(theme) {
    return {
        render: themed(theme, '<div id="totals"></div>'),
        play: async ({ canvasElement }) => {
            render_totals(canvasElement.querySelector("#totals"), totals(RUNS));
        },
    };
}

export const TotalsDark = { name: "Totals – Dark", ...renderTotals("dark") };
export const TotalsLight = { name: "Totals – Light", ...renderTotals("light") };

// ── Status table ──────────────────────────────────────────────────────────────

const STATUS_COLUMNS = [
    {
        label: "Repository",
        sort_value: (row) => row.repository,
        render: (row) => github_link(`https://github.com/${row.repository}`, row.repository),
        align_left: true,
    },
    { label: "Workflow", sort_value: (row) => row.workflow, render: (row) => row.workflow, align_left: true },
    {
        label: "Latest run",
        sort_value: (row) => outcome_of(row.latest),
        render: (row) => outcome_badge(outcome_of(row.latest)),
        align_left: true,
    },
    { label: "Runs", sort_value: (row) => row.runs, render: (row) => format_count(row.runs) },
    { label: "Success rate", sort_value: (row) => row.success_rate, render: (row) => format_percent(row.success_rate) },
    {
        label: "Median duration",
        sort_value: (row) => row.median_duration,
        render: (row) => format_duration(row.median_duration),
    },
];

function renderStatusTable(theme) {
    return {
        render: themed(theme, extractSections(rawHTML, "#status", ".view-section:has(#status_table)")),
        play: async ({ canvasElement }) => {
            render_sortable_table(
                canvasElement.querySelector("#status_table"),
                "Latest status per workflow",
                STATUS_COLUMNS,
                workflow_statuses(RUNS)
            );
        },
    };
}

export const StatusTableDark = { name: "Status Table – Dark", ...renderStatusTable("dark") };
export const StatusTableLight = { name: "Status Table – Light", ...renderStatusTable("light") };

// ── Outcome badges ────────────────────────────────────────────────────────────

const badgesHTML = `<div style="display:flex;gap:16px;padding:16px">${["failed", "succeeded", "other", "cancelled"]
    .map(outcome_badge)
    .join("")}</div>`;

export const OutcomeBadgesDark = { name: "Outcome Badges – Dark", render: themed("dark", badgesHTML) };
export const OutcomeBadgesLight = { name: "Outcome Badges – Light", render: themed("light", badgesHTML) };
