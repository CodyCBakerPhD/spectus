import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    after_each,
    before_each,
    by_id,
    change,
    check,
    choose,
    fetched_urls,
    install_environment,
    last_plot,
    load_page,
    media_query,
    not_found,
    plot_calls,
    plotly,
    query,
    scrolled_to,
    serve,
    settle,
    table_headers,
    table_rows,
    totals,
    url_params,
} from "./page-harness.js";
import { latest_records, parse_jsonl } from "../../src/data.js";
import { format_count, format_percent } from "../../src/format.js";
import { filter_runs, totals as compute_totals } from "../../src/stats.js";
import { DATA_FILES, GENERATED_AT } from "../fixtures/mock-data.js";

// The stub is taken from the global the harness keeps it in (see PLOTLY_STUB_GLOBAL)
vi.mock("plotly.js-dist-min", () => ({ default: (globalThis as any).__page_harness_plotly__ }));

install_environment();
beforeEach(before_each);
afterEach(after_each);

const END = new Date(GENERATED_AT);
const ALL_RUNS = latest_records(Object.values(DATA_FILES).flatMap((text) => parse_jsonl(text)));

/** What the totals should read for the runs of the last `days` days that match `keep`. */
function expected_totals(days: number, keep: (run: (typeof ALL_RUNS)[number]) => boolean = () => true) {
    const runs = filter_runs(ALL_RUNS, { start: new Date(END.getTime() - days * 86400000), end: END, event: "all" });
    return compute_totals(runs.filter(keep));
}

const selector_options = () =>
    Array.from(by_id<HTMLSelectElement>("repository_selector").options).map((option) => [option.value, option.text]);

// ── Page load ────────────────────────────────────────────────────────────────

describe("page load", () => {
    it("lists every repository, grouped by owner, after an option for all of them", async () => {
        await load_page();
        expect(selector_options()).toEqual([
            ["all", "All repositories (5)"],
            ["con", "con (all 2)"],
            ["con/datalad-usage-dashboard", "con/datalad-usage-dashboard"],
            ["con/spectus", "con/spectus"],
            ["dandi", "dandi (all 3)"],
            ["dandi/dandi-archive", "dandi/dandi-archive"],
            ["dandi/dandi-cli", "dandi/dandi-cli"],
            ["dandi/dandi-schema", "dandi/dandi-schema"],
        ]);
        expect(document.querySelectorAll("#repository_selector optgroup").length).toBe(2);
    });

    it("totals the last 30 days of every repository", async () => {
        await load_page();
        const expected = expected_totals(30);
        expect(totals()).toEqual([
            ["Runs", format_count(expected.runs)],
            ["Success rate", format_percent(expected.success_rate)],
            ["Failed", format_count(expected.failed)],
            ["Workflows", "9"],
            ["Repositories", "5"],
            ["Median duration", expect.stringMatching(/^\d+m \d+s$/)],
        ]);
    });

    it("loads only the months the period reaches", async () => {
        await load_page();
        const files = fetched_urls().filter((url) => url.endsWith(".jsonl"));
        expect(files).toHaveLength(10);
        expect(files.every((url) => /\/(202609|202610)\.jsonl$/.test(url))).toBe(true);
    });

    it("draws every section", async () => {
        await load_page();
        expect(last_plot("over_time_plot").data.map((trace) => trace.type)).toEqual(["bar", "bar", "bar", "bar"]);
        expect(last_plot("grid_plot").data[0].type).toBe("heatmap");
        expect(last_plot("grid_plot").data[0].y).toEqual([
            "con/datalad-usage-dashboard",
            "con/spectus",
            "dandi/dandi-archive",
            "dandi/dandi-cli",
            "dandi/dandi-schema",
        ]);
        expect(last_plot("durations_plot").data).toHaveLength(9);
        expect(last_plot("over_time_plot").config).toMatchObject({ displaylogo: false, responsive: true });
        expect(document.querySelectorAll("#grid_legend .grid-legend-item")).toHaveLength(4);
    });

    it("lists each workflow's latest run, failing first", async () => {
        await load_page();
        expect(table_headers("status_table")).toEqual([
            "Repository",
            "Workflow",
            "Latest run",
            "When",
            "Runs",
            "Success rate",
            "Median duration",
        ]);
        const rows = table_rows("status_table");
        expect(rows).toHaveLength(9);
        expect(rows[0].slice(0, 3)).toEqual(["dandi/dandi-archive", "Nightly", "Failed"]);
        expect(rows.slice(1).every((row) => row[2] !== "Failed")).toBe(true);
        const link = query<HTMLAnchorElement>("#status_table tbody tr td:nth-child(4) a");
        expect(link.href).toMatch(/^https:\/\/github\.com\/dandi\/dandi-archive\/actions\/runs\/\d+$/);
        expect(link.title).toMatch(/^#\d+ on main, 2026-10-1\d \d\d:\d\d UTC$/);
    });

    it("stamps the version and commit in the footer, and links the repository it was built from", async () => {
        await load_page();
        expect(by_id("site_version").textContent).toBe("v1.2.3+abcdef12");
        expect(by_id<HTMLAnchorElement>("source_link").href).toBe("https://github.com/con/spectus");
        expect(by_id<HTMLAnchorElement>("data_link").href).toBe("https://github.com/con/spectus/tree/data");
    });

    it("says how fresh the data is", async () => {
        await load_page();
        expect(by_id("data_status").textContent).toMatch(/^Data as of 2026-10-17 12:00 UTC \(.+\)$/);
    });

    it("re-enables transitions once the first paint has been committed", async () => {
        await load_page();
        expect(document.documentElement.classList.contains("preload")).toBe(false);
    });

    it("leaves the URL alone while every setting is at its default", async () => {
        await load_page();
        expect(window.location.search).toBe("");
    });
});

// ── Controls ─────────────────────────────────────────────────────────────────

describe("controls", () => {
    it("narrows everything to one repository, with a grid row per workflow", async () => {
        await load_page();
        change("repository_selector", "dandi/dandi-archive");
        await settle();
        expect(url_params().get("repo")).toBe("dandi/dandi-archive");
        expect(totals()[4]).toEqual(["Repositories", "1"]);
        expect(table_rows("status_table").map((row) => row[1])).toEqual(["Nightly", "CI"]);
        expect(last_plot("grid_plot").data[0].y).toEqual(["CI", "Nightly"]);
        expect(last_plot("durations_plot").data.map((trace) => trace.name)).toEqual(["Nightly", "CI"]);
    });

    it("narrows everything to one owner", async () => {
        await load_page();
        change("repository_selector", "con");
        await settle();
        const expected = expected_totals(30, (run) => run.repository.startsWith("con/"));
        expect(totals()[0]).toEqual(["Runs", format_count(expected.runs)]);
        expect(fetched_urls().filter((url) => url.includes("/dandi/"))).toHaveLength(6);
    });

    it("reaches further back over a longer period, loading the months it needs", async () => {
        await load_page();
        choose("period", "90");
        await settle();
        expect(url_params().get("period")).toBe("90");
        expect(totals()[0]).toEqual(["Runs", format_count(expected_totals(90).runs)]);
        expect(fetched_urls().some((url) => url.endsWith("/202607.jsonl"))).toBe(true);
    });

    it("counts the runs of one event, offering the events the selection has", async () => {
        await load_page();
        const events = Array.from(by_id<HTMLSelectElement>("event_filter").options).map((option) => option.value);
        expect(events[0]).toBe("all");
        expect(events.slice(1).sort()).toEqual(["pull_request", "push", "schedule"]);

        change("event_filter", "schedule");
        await settle();
        expect(url_params().get("event")).toBe("schedule");
        const expected = expected_totals(30, (run) => run.event === "schedule");
        expect(totals()[0]).toEqual(["Runs", format_count(expected.runs)]);
    });

    it("aggregates the runs over time by week or month", async () => {
        await load_page();
        choose("aggregation", "weekly");
        await settle();
        expect(url_params().get("aggregation")).toBe("weekly");
        expect(last_plot("over_time_plot").layout.title.text).toBe("Runs per week");
        choose("aggregation", "monthly");
        await settle();
        expect(last_plot("over_time_plot").data[0].x).toEqual(["2026-09-01", "2026-10-01"]);
    });

    it("shows the runs over time as a table", async () => {
        await load_page();
        choose("over_time_view", "table");
        await settle();
        expect(by_id("over_time_plot").style.display).toBe("none");
        expect(by_id("over_time_table").style.display).toBe("");
        expect(table_headers("over_time_table")).toEqual([
            "Date",
            "Failed",
            "Succeeded",
            "Needs attention",
            "Cancelled or skipped",
            "Success rate",
        ]);
        const rows = table_rows("over_time_table");
        expect(rows).toHaveLength(31);
        expect(rows[0][0]).toBe("2026-10-17");

        choose("aggregation", "monthly");
        await settle();
        expect(table_rows("over_time_table").map((row) => row[0])).toEqual(["2026-10", "2026-09"]);
        expect(table_headers("over_time_table")[0]).toBe("Month");
    });

    it("shows only the workflows whose latest run failed", async () => {
        await load_page();
        choose("status_show", "failing");
        await settle();
        expect(url_params().get("status")).toBe("failing");
        expect(table_rows("status_table").map((row) => row.slice(0, 2))).toEqual([["dandi/dandi-archive", "Nightly"]]);

        change("repository_selector", "con/spectus");
        await settle();
        expect(table_rows("status_table")).toEqual([["No workflow's latest run failed."]]);
    });

    it("bins the status grid by week", async () => {
        await load_page();
        choose("grid_bin", "weekly");
        await settle();
        expect(url_params().get("grid")).toBe("weekly");
        expect(last_plot("grid_plot").layout.title.text).toBe("Status per week");
    });

    it("shows the durations as a table, and on a log scale", async () => {
        await load_page();
        check("log_scale", true);
        await settle();
        expect(url_params().get("log")).toBe("true");
        expect(last_plot("durations_plot").layout.xaxis.type).toBe("log");

        choose("durations_view", "table");
        await settle();
        expect(by_id("durations_plot").style.display).toBe("none");
        expect(table_headers("durations_table")).toEqual(["Workflow", "Timed runs", "Median", "Longest"]);
        expect(table_rows("durations_table")).toHaveLength(9);
    });

    it("keeps a table's sort through a change of period", async () => {
        await load_page();
        query<HTMLElement>("#status_table th:nth-child(5)").click();
        const sorted = table_rows("status_table").map((row) => Number(row[4]));
        expect(sorted).toEqual([...sorted].sort((a, b) => b - a));

        choose("period", "7");
        await settle();
        const resorted = table_rows("status_table").map((row) => Number(row[4]));
        expect(resorted).toEqual([...resorted].sort((a, b) => b - a));
    });

    it("opens and closes the settings panel", async () => {
        await load_page();
        const panel = by_id("settings_panel");
        by_id("settings_btn").click();
        expect(panel.classList.contains("open")).toBe(true);
        expect(by_id("settings_btn").getAttribute("aria-expanded")).toBe("true");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(panel.classList.contains("open")).toBe(false);

        by_id("settings_btn").click();
        panel.click();
        expect(panel.classList.contains("open")).toBe(true);
        document.body.click();
        expect(panel.classList.contains("open")).toBe(false);
    });

    it("links to a section without leaving the page", async () => {
        await load_page({ url: "/?period=7" });
        query<HTMLAnchorElement>('a.section-anchor[href="#grid"]').click();
        expect(window.location.hash).toBe("#grid");
        expect(window.location.search).toBe("?period=7");
        expect(scrolled_to).toHaveBeenCalled();
    });

    it("redraws the plots once a resize has settled", async () => {
        await load_page();
        const before = plot_calls("over_time_plot").length;
        window.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("resize"));
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(plot_calls("over_time_plot").length).toBe(before + 1);
    });
});

// ── URL ──────────────────────────────────────────────────────────────────────

describe("URL", () => {
    it("opens on the settings it names", async () => {
        await load_page({
            url: "/?repo=dandi&period=7&over_time=table&aggregation=weekly&status=failing&grid=weekly&durations=table&log=true&event=push",
        });
        expect(by_id<HTMLSelectElement>("repository_selector").value).toBe("dandi");
        expect(query<HTMLInputElement>('input[name="period"]:checked').value).toBe("7");
        expect(query<HTMLInputElement>('input[name="aggregation"]:checked').value).toBe("weekly");
        expect(query<HTMLInputElement>('input[name="status_show"]:checked').value).toBe("failing");
        expect(query<HTMLInputElement>('input[name="grid_bin"]:checked').value).toBe("weekly");
        expect(by_id<HTMLInputElement>("log_scale").checked).toBe(true);
        expect(by_id<HTMLSelectElement>("event_filter").value).toBe("push");
        expect(by_id("over_time_plot").style.display).toBe("none");
        expect(by_id("durations_table").style.display).toBe("");
        expect(totals()[4]).toEqual(["Repositories", "3"]);
    });

    it("falls back to the defaults for values it does not know", async () => {
        await load_page({ url: "/?period=12&aggregation=hourly&over_time=chart" });
        expect(query<HTMLInputElement>('input[name="period"]:checked').value).toBe("30");
        expect(query<HTMLInputElement>('input[name="aggregation"]:checked').value).toBe("daily");
        expect(by_id("over_time_plot").style.display).toBe("");
    });

    it("keeps a selection the data does not have, covering nothing", async () => {
        await load_page({ url: "/?repo=nobody/nothing" });
        expect(by_id<HTMLSelectElement>("repository_selector").value).toBe("nobody/nothing");
        expect(totals()[0]).toEqual(["Runs", "0"]);
        expect(by_id("over_time_plot").textContent).toBe("No finished runs in this period.");
    });

    it("restores the settings of the history entry it goes back to", async () => {
        await load_page();
        choose("period", "90");
        await settle();
        choose("aggregation", "weekly");
        await settle();

        window.history.replaceState({}, "", "/?period=90");
        window.dispatchEvent(new PopStateEvent("popstate"));
        await settle();
        expect(query<HTMLInputElement>('input[name="aggregation"]:checked').value).toBe("daily");
        expect(last_plot("over_time_plot").layout.title.text).toBe("Runs per day");

        window.history.replaceState({}, "", "/");
        window.dispatchEvent(new PopStateEvent("popstate"));
        await settle();
        expect(query<HTMLInputElement>('input[name="period"]:checked').value).toBe("30");
        expect(totals()[0]).toEqual(["Runs", format_count(expected_totals(30).runs)]);
    });
});

// ── Theme ────────────────────────────────────────────────────────────────────

describe("theme", () => {
    it("defaults to dark, and draws the plots on the dark surface", async () => {
        await load_page();
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
        expect(last_plot("over_time_plot").layout.paper_bgcolor).toBe("#16213e");
        expect(by_id("theme_toggle_btn").getAttribute("aria-label")).toBe("Switch to light mode");
    });

    it("toggles, remembers the choice, and redraws the plots", async () => {
        await load_page();
        by_id("theme_toggle_btn").click();
        await settle();
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
        expect(localStorage.getItem("theme")).toBe("light");
        expect(last_plot("over_time_plot").layout.paper_bgcolor).toBe("#ffffff");
        expect(by_id("theme_toggle_btn").getAttribute("aria-label")).toBe("Switch to dark mode");
    });

    it("opens on a saved theme", async () => {
        await load_page({ theme: "light" });
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });

    it("follows the browser's preference until a theme is chosen", async () => {
        await load_page({ prefers_dark: false });
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
        media_query!.fire(true);
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

        by_id("theme_toggle_btn").click();
        media_query!.fire(true);
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
});

// ── Failures and empty data ──────────────────────────────────────────────────

describe("failures", () => {
    it("says so when the manifest fails to load", async () => {
        serve("manifest.json", not_found);
        await load_page();
        expect(by_id("data_status").textContent).toBe("Failed to load the data.");
        expect(by_id("over_time_plot").textContent).toBe("Failed to load the data.");
        expect(table_rows("status_table")).toEqual([["Failed to load the data."]]);
        expect(totals()[0]).toEqual(["Runs", "0"]);
    });

    it("says so when the runs fail to load, and loads them again on the next change", async () => {
        serve(/\.jsonl$/, not_found);
        await load_page();
        expect(by_id("data_status").textContent).toBe("Failed to load the workflow runs.");
        expect(by_id("grid_plot").textContent).toBe("Failed to load the workflow runs.");

        serve(/\.jsonl$/, (url) => new Response(DATA_FILES[url.slice("./data/".length) as keyof typeof DATA_FILES]));
        choose("period", "7");
        await settle();
        expect(by_id("data_status").textContent).toMatch(/^Data as of/);
        expect(last_plot("grid_plot").data[0].type).toBe("heatmap");
    });

    it("says that nothing has been recorded yet", async () => {
        serve("manifest.json", JSON.stringify({ generated_at: GENERATED_AT, repositories: {} }));
        await load_page();
        expect(selector_options()).toEqual([["all", "All repositories (0)"]]);
        expect(by_id("over_time_plot").textContent).toBe("No workflow runs have been recorded yet.");
        expect(plotly.purge).toHaveBeenCalled();
    });

    it("reports a plot that fails to draw in its place", async () => {
        plotly.newPlot.mockImplementation(async () => {
            throw new Error("WebGL is not available");
        });
        await load_page();
        expect(by_id("over_time_plot").textContent).toBe("Failed to draw this plot.");
    });

    it("draws only the latest of overlapping loads", async () => {
        await load_page();
        change("repository_selector", "con/spectus");
        change("repository_selector", "dandi/dandi-cli");
        await settle();
        expect(table_rows("status_table").every((row) => row[0] === "dandi/dandi-cli")).toBe(true);
    });

    it("says there is nothing to time when no run has a duration", async () => {
        const untimed = Object.fromEntries(
            Object.entries(DATA_FILES).map(([path, text]) => [
                path,
                text.replace(/"duration_seconds":\d+/g, '"duration_seconds":null'),
            ])
        );
        serve(/\.jsonl$/, (url) => new Response(untimed[url.slice("./data/".length)]));
        await load_page();
        expect(by_id("durations_plot").textContent).toBe("No timed runs in this period.");
        expect(totals()[5]).toEqual(["Median duration", "—"]);
    });
});
