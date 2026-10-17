/**
 * The page's entry module: wires the controls to the URL, loads the records the selection needs, and draws every
 * section from them.
 */

import Plotly from "plotly.js-dist-min";
import { data_files, latest_records, months_between, RunLoader, select_repositories, type Manifest } from "./data.js";
import {
    escape_html,
    format_count,
    format_duration,
    format_percent,
    format_relative,
    format_timestamp,
} from "./format.js";
import {
    DARK_THEME,
    durations_figure,
    type Figure,
    LIGHT_THEME,
    over_time_figure,
    status_grid_figure,
    status_grid_legend,
    type Theme,
} from "./plots.js";
import {
    type Aggregation,
    build_status_grid,
    durations_by_workflow,
    events_of,
    filter_runs,
    OUTCOME_LABELS,
    OUTCOMES,
    outcome_of,
    outcomes_over_time,
    success_rate,
    totals,
    workflow_statuses,
    type WorkflowStatus,
} from "./stats.js";
import { github_link, outcome_badge, render_sortable_table, render_totals, type TableColumn } from "./tables.js";
import type { WorkflowRun } from "./data.js";

declare const __APP_VERSION__: string;
declare const __GIT_HASH__: string;
declare const __REPOSITORY__: string;

const DAY_MS = 86400000;
const PERIODS = ["7", "30", "90", "365"];
const AGGREGATIONS: Aggregation[] = ["daily", "weekly", "monthly"];

// ── State ────────────────────────────────────────────────────────────────────

interface State {
    repository: string;
    period: string;
    event: string;
    log_scale: boolean;
    over_time_view: "plot" | "table";
    aggregation: Aggregation;
    status_show: "all" | "failing";
    grid_bin: "daily" | "weekly";
    durations_view: "plot" | "table";
}

const DEFAULTS: State = {
    repository: "all",
    period: "30",
    event: "all",
    log_scale: false,
    over_time_view: "plot",
    aggregation: "daily",
    status_show: "all",
    grid_bin: "daily",
    durations_view: "plot",
};

/** Each setting's URL parameter; a setting left at its default is kept out of the URL. */
const URL_PARAMS: Record<keyof State, string> = {
    repository: "repo",
    period: "period",
    event: "event",
    log_scale: "log",
    over_time_view: "over_time",
    aggregation: "aggregation",
    status_show: "status",
    grid_bin: "grid",
    durations_view: "durations",
};

const state: State = { ...DEFAULTS };
const loader = new RunLoader();
let manifest: Manifest | null = null;
let manifest_error: string | null = null;
/** The runs of the current selection and period, before the event filter; null until loaded. */
let selection_runs: WorkflowRun[] | null = null;
let load_generation = 0;

// ── Theme ────────────────────────────────────────────────────────────────────

const PREFERS_DARK = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let is_dark = true;

function theme(): Theme {
    return is_dark ? DARK_THEME : LIGHT_THEME;
}

/**
 * Applies the saved theme, or the browser's preference when none was saved, and follows changes to that preference
 * for as long as the viewer has not chosen a theme themselves.
 *
 * NOTE: the defaulting logic (anything other than 'light' → dark) must stay in sync with the inline anti-FOUC script
 * in index.html.
 */
function init_theme() {
    const saved = localStorage.getItem("theme");
    is_dark = saved === "dark" || saved === "light" ? saved === "dark" : PREFERS_DARK ? PREFERS_DARK.matches : true;
    apply_theme();
    PREFERS_DARK?.addEventListener("change", (event) => {
        if (localStorage.getItem("theme")) return;
        is_dark = event.matches;
        apply_theme();
        render_plots();
    });
}

function apply_theme() {
    document.documentElement.setAttribute("data-theme", is_dark ? "dark" : "light");
    const button = document.getElementById("theme_toggle_btn");
    if (!button) return;
    const label = is_dark ? "Switch to light mode" : "Switch to dark mode";
    // Dark → the sun, to switch to light; light → the moon
    button.innerHTML = is_dark
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-13a1 1 0 0 0 1-1V2a1 1 0 1 0-2 0v1a1 1 0 0 0 1 1zm0 14a1 1 0 0 0-1 1v1a1 1 0 1 0 2 0v-1a1 1 0 0 0-1-1zm10-5a1 1 0 0 0 0-2h-1a1 1 0 1 0 0 2h1zM3 12a1 1 0 0 0-1-1H1a1 1 0 1 0 0 2h1a1 1 0 0 0 1-1zm15.36-6.36a1 1 0 0 0 0-1.41l-.71-.71a1 1 0 0 0-1.41 1.41l.71.71a1 1 0 0 0 1.41 0zM6.05 17.95a1 1 0 0 0-1.41 0l-.71.71a1 1 0 1 0 1.41 1.41l.71-.71a1 1 0 0 0 0-1.41zm12.02 2.12-.71-.71a1 1 0 0 0-1.41 1.41l.71.71a1 1 0 0 0 1.41-1.41zM5.34 5.64a1 1 0 0 0-1.41-1.41l-.71.71a1 1 0 1 0 1.41 1.41l.71-.71z"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>';
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
}

function toggle_theme() {
    is_dark = !is_dark;
    localStorage.setItem("theme", is_dark ? "dark" : "light");
    apply_theme();
    render_plots();
}

// ── URL and controls ─────────────────────────────────────────────────────────

function parse_param<K extends keyof State>(key: K, value: string | null): State[K] | null {
    if (value === null) return null;
    const allowed: Partial<Record<keyof State, readonly string[]>> = {
        period: PERIODS,
        over_time_view: ["plot", "table"],
        aggregation: AGGREGATIONS,
        status_show: ["all", "failing"],
        grid_bin: ["daily", "weekly"],
        durations_view: ["plot", "table"],
    };
    if (key === "log_scale") return (value === "true") as State[K];
    if (allowed[key] && !allowed[key]!.includes(value)) return null;
    return value as State[K];
}

/** Reads the settings from the URL into the state and the controls. */
function sync_from_url() {
    const params = new URLSearchParams(window.location.search);
    for (const key of Object.keys(DEFAULTS) as Array<keyof State>) {
        const value = parse_param(key, params.get(URL_PARAMS[key]));
        (state as unknown as Record<string, unknown>)[key] = value ?? DEFAULTS[key];
    }
    sync_controls();
}

function check_radio(name: string, value: string) {
    const radio = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    if (radio) radio.checked = true;
}

function sync_controls() {
    check_radio("period", state.period);
    check_radio("over_time_view", state.over_time_view);
    check_radio("aggregation", state.aggregation);
    check_radio("status_show", state.status_show);
    check_radio("grid_bin", state.grid_bin);
    check_radio("durations_view", state.durations_view);
    const log_scale = document.getElementById("log_scale") as HTMLInputElement | null;
    if (log_scale) log_scale.checked = state.log_scale;
    ensure_option("repository_selector", state.repository, state.repository);
    ensure_option("event_filter", state.event, state.event);
    apply_view_visibility();
}

/** Selects an option of a <select>, adding it first if it is not there yet (a deep link ahead of the data). */
function ensure_option(select_id: string, value: string, label: string) {
    const select = document.getElementById(select_id) as HTMLSelectElement | null;
    if (!select) return;
    if (!Array.from(select.options).some((option) => option.value === value)) {
        select.append(new Option(label, value));
    }
    select.value = value;
}

function push_url() {
    const params = new URLSearchParams();
    for (const key of Object.keys(DEFAULTS) as Array<keyof State>) {
        if (state[key] !== DEFAULTS[key]) params.set(URL_PARAMS[key], String(state[key]));
    }
    const query = params.toString();
    window.history.pushState({}, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);
}

function apply_view_visibility() {
    const show = (id: string, visible: boolean) => {
        const element = document.getElementById(id);
        if (element) element.style.display = visible ? "" : "none";
    };
    show("over_time_plot", state.over_time_view === "plot");
    show("over_time_table", state.over_time_view === "table");
    show("durations_plot", state.durations_view === "plot");
    show("durations_table", state.durations_view === "table");
}

/** Opens and closes a settings panel: its button toggles it, and a click elsewhere or Escape closes it. */
function setup_settings_panel(button_id: string, panel_id: string) {
    const button = document.getElementById(button_id);
    const panel = document.getElementById(panel_id);
    if (!button || !panel) return;
    const set_open = (open: boolean) => {
        panel.classList.toggle("open", open);
        button.setAttribute("aria-expanded", String(open));
        panel.setAttribute("aria-hidden", String(!open));
    };
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        set_open(!panel.classList.contains("open"));
    });
    document.addEventListener("click", (event) => {
        if (!panel.contains(event.target as Node | null) && !button.contains(event.target as Node | null)) {
            set_open(false);
        }
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") set_open(false);
    });
}

/** What a change of each control means: which setting it sets, and whether new data must be loaded for it. */
function on_change<K extends keyof State>(key: K, value: State[K], reload: boolean) {
    state[key] = value;
    push_url();
    apply_view_visibility();
    if (reload) void load_and_render();
    else render_all();
}

function bind_radios(name: string, key: keyof State, reload = false) {
    document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((radio) => {
        radio.addEventListener("change", () => {
            if (radio.checked) on_change(key, radio.value as never, reload);
        });
    });
}

function bind_controls() {
    document.getElementById("theme_toggle_btn")?.addEventListener("click", toggle_theme);
    setup_settings_panel("settings_btn", "settings_panel");

    const repository = document.getElementById("repository_selector") as HTMLSelectElement | null;
    repository?.addEventListener("change", () => on_change("repository", repository.value, true));
    const event_filter = document.getElementById("event_filter") as HTMLSelectElement | null;
    event_filter?.addEventListener("change", () => on_change("event", event_filter.value, false));
    const log_scale = document.getElementById("log_scale") as HTMLInputElement | null;
    log_scale?.addEventListener("change", () => on_change("log_scale", log_scale.checked, false));

    bind_radios("period", "period", true);
    bind_radios("over_time_view", "over_time_view");
    bind_radios("aggregation", "aggregation");
    bind_radios("status_show", "status_show");
    bind_radios("grid_bin", "grid_bin");
    bind_radios("durations_view", "durations_view");

    // Back and forward restore the settings of the entry they land on
    window.addEventListener("popstate", () => {
        const previous_repository = state.repository;
        const previous_period = state.period;
        sync_from_url();
        if (state.repository !== previous_repository || state.period !== previous_period) void load_and_render();
        else render_all();
    });

    let resize_timer: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener("resize", () => {
        clearTimeout(resize_timer);
        resize_timer = setTimeout(render_plots, 200);
    });
}

// ── Data ─────────────────────────────────────────────────────────────────────

function window_of(current: Manifest): { start: Date; end: Date } {
    const end = new Date(current.generated_at);
    return { start: new Date(end.getTime() - Number(state.period) * DAY_MS), end };
}

function populate_repositories(current: Manifest) {
    const select = document.getElementById("repository_selector") as HTMLSelectElement | null;
    if (!select) return;
    const repositories = select_repositories(current, "all");
    const owners = new Map<string, string[]>();
    for (const repository of repositories) {
        const owner = repository.split("/")[0];
        owners.set(owner, [...(owners.get(owner) ?? []), repository]);
    }
    select.innerHTML = "";
    select.append(new Option(`All repositories (${format_count(repositories.length)})`, "all"));
    for (const [owner, owned] of owners) {
        const group = document.createElement("optgroup");
        group.label = owner;
        group.append(new Option(`${owner} (all ${format_count(owned.length)})`, owner));
        for (const repository of owned) group.append(new Option(repository, repository));
        select.append(group);
    }
    ensure_option("repository_selector", state.repository, state.repository);
}

function populate_events(runs: WorkflowRun[]) {
    const select = document.getElementById("event_filter") as HTMLSelectElement | null;
    if (!select) return;
    select.innerHTML = "";
    select.append(new Option("All events", "all"));
    for (const event of events_of(runs)) select.append(new Option(event, event));
    ensure_option("event_filter", state.event, state.event);
}

function set_status(text: string) {
    const element = document.getElementById("data_status");
    if (element) element.textContent = text;
}

/** Loads the runs of the selected repositories and period, then draws everything; a newer load supersedes it. */
async function load_and_render(): Promise<void> {
    const generation = ++load_generation;
    if (!manifest) return render_all();
    const { start, end } = window_of(manifest);
    const paths = data_files(manifest, select_repositories(manifest, state.repository), months_between(start, end));
    try {
        const runs = latest_records(await loader.load(paths));
        if (generation !== load_generation) return;
        selection_runs = filter_runs(runs, { start, end, event: "all" });
        manifest_error = null;
    } catch (error) {
        if (generation !== load_generation) return;
        console.error(error);
        selection_runs = null;
        manifest_error = "Failed to load the workflow runs.";
    }
    populate_events(selection_runs ?? []);
    render_all();
}

// ── Rendering ────────────────────────────────────────────────────────────────

const PLOTLY_CONFIG: Partial<Plotly.Config> = {
    displaylogo: false,
    responsive: true,
    // Down to zooming, panning, resetting, and downloading, which leaves room beside a title on a narrow plot
    modeBarButtonsToRemove: [
        "select2d",
        "lasso2d",
        "autoScale2d",
        "zoomIn2d",
        "zoomOut2d",
    ] as Plotly.ModeBarDefaultButtons[],
    toImageButtonOptions: { format: "png", filename: "spectus" },
};

/** Draws a figure into its container, or a message in its place when there is nothing to draw. */
function draw(id: string, figure: Figure | null, message: string) {
    const element = document.getElementById(id);
    if (!element || element.style.display === "none") return;
    if (!figure) {
        Plotly.purge(element);
        element.innerHTML = `<div class="plot-empty">${escape_html(message)}</div>`;
        return;
    }
    element.innerHTML = "";
    Plotly.newPlot(element, figure.data, figure.layout, PLOTLY_CONFIG).catch((error: unknown) => {
        console.error(error);
        element.innerHTML = `<div class="plot-empty">Failed to draw this plot.</div>`;
    });
}

function visible_runs(): WorkflowRun[] {
    return filter_runs(selection_runs ?? [], { start: new Date(0), end: new Date(8.64e15), event: state.event });
}

function empty_message(): string {
    if (manifest_error) return manifest_error;
    if (!manifest || selection_runs === null) return "Loading…";
    if (Object.keys(manifest.repositories).length === 0) return "No workflow runs have been recorded yet.";
    return "No finished runs in this period.";
}

function render_plots() {
    const runs = visible_runs();
    const current = manifest;
    const message = empty_message();
    if (!current || runs.length === 0) {
        draw("over_time_plot", null, message);
        draw("grid_plot", null, message);
        draw("durations_plot", null, message);
        render_grid_legend(false);
        return;
    }
    const { start, end } = window_of(current);
    // How wide each plot is drawn decides how thick its bars may be and where its title and legend go
    const width = (id: string) => document.getElementById(id)?.offsetWidth || 800;
    const series = outcomes_over_time(runs, start, end, state.aggregation);
    draw("over_time_plot", over_time_figure(series, state.aggregation, theme(), width("over_time_plot")), message);
    const grid = build_status_grid(runs, start, end, state.grid_bin);
    draw("grid_plot", status_grid_figure(grid, state.grid_bin, theme(), width("grid_plot")), message);
    const groups = durations_by_workflow(runs);
    const durations = groups.length
        ? durations_figure(groups, theme(), state.log_scale, width("durations_plot"))
        : null;
    draw("durations_plot", durations, "No timed runs in this period.");
    render_grid_legend(true);
}

function render_grid_legend(visible: boolean) {
    const legend = document.getElementById("grid_legend");
    if (!legend) return;
    legend.innerHTML = visible
        ? status_grid_legend(theme())
              .map(
                  ({ state: cell, label, color }) =>
                      `<span class="grid-legend-item" data-state="${cell}">` +
                      `<span class="grid-legend-swatch" style="background:${color}"></span>${escape_html(label)}</span>`
              )
              .join("")
        : "";
}

function render_tables() {
    const runs = visible_runs();
    const current = manifest;
    const over_time_table = document.getElementById("over_time_table");
    if (over_time_table && current) {
        const { start, end } = window_of(current);
        const series = outcomes_over_time(runs, start, end, state.aggregation);
        const rows = series.bins.map((bin, index) => ({
            bin,
            counts: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, series.counts[outcome][index]])),
        }));
        const label = { daily: "Date", weekly: "Week of", monthly: "Month" }[state.aggregation];
        render_sortable_table(
            over_time_table,
            "Runs over time",
            [
                {
                    label,
                    sort_value: (row) => row.bin,
                    render: (row) => escape_html(state.aggregation === "monthly" ? row.bin.slice(0, 7) : row.bin),
                },
                ...OUTCOMES.map((outcome) => ({
                    label: OUTCOME_LABELS[outcome],
                    sort_value: (row: (typeof rows)[number]) => row.counts[outcome],
                    render: (row: (typeof rows)[number]) => format_count(row.counts[outcome]),
                })),
                {
                    label: "Success rate",
                    sort_value: (row) => success_rate(row.counts.succeeded, row.counts.failed),
                    render: (row) => format_percent(success_rate(row.counts.succeeded, row.counts.failed)),
                },
            ],
            [...rows].reverse()
        );
    }

    const status_table = document.getElementById("status_table");
    if (status_table) {
        const now = current ? new Date(current.generated_at) : new Date();
        const statuses = workflow_statuses(runs).filter(
            (status) => state.status_show === "all" || outcome_of(status.latest) === "failed"
        );
        const columns: Array<TableColumn<WorkflowStatus>> = [
            {
                label: "Repository",
                sort_value: (row) => row.repository,
                render: (row) => github_link(`https://github.com/${row.repository}`, row.repository),
                align_left: true,
            },
            {
                label: "Workflow",
                sort_value: (row) => row.workflow,
                render: (row) => escape_html(row.workflow),
                align_left: true,
            },
            {
                label: "Latest run",
                sort_value: (row) => OUTCOMES.indexOf(outcome_of(row.latest)),
                render: (row) => outcome_badge(outcome_of(row.latest)),
                align_left: true,
            },
            {
                label: "When",
                sort_value: (row) => Date.parse(row.latest.created_at),
                render: (row) =>
                    github_link(
                        row.latest.url,
                        format_relative(new Date(row.latest.created_at), now),
                        `#${row.latest.run_number} on ${row.latest.head_branch ?? "a deleted branch"}, ` +
                            `${format_timestamp(new Date(row.latest.created_at))}`
                    ),
            },
            { label: "Runs", sort_value: (row) => row.runs, render: (row) => format_count(row.runs) },
            {
                label: "Success rate",
                sort_value: (row) => row.success_rate,
                render: (row) => format_percent(row.success_rate),
            },
            {
                label: "Median duration",
                sort_value: (row) => row.median_duration,
                render: (row) => format_duration(row.median_duration),
            },
        ];
        const message = runs.length === 0 ? empty_message() : "No workflow's latest run failed.";
        render_sortable_table(status_table, "Latest status per workflow", columns, statuses, message);
    }

    const durations_table = document.getElementById("durations_table");
    if (durations_table) {
        const groups = durations_by_workflow(runs, Infinity);
        render_sortable_table(
            durations_table,
            "Run duration per workflow",
            [
                {
                    label: "Workflow",
                    sort_value: (row) => row.label,
                    render: (row) => escape_html(row.label),
                    align_left: true,
                },
                {
                    label: "Timed runs",
                    sort_value: (row) => row.durations.length,
                    render: (row) => format_count(row.durations.length),
                },
                { label: "Median", sort_value: (row) => row.median, render: (row) => format_duration(row.median) },
                {
                    label: "Longest",
                    sort_value: (row) => Math.max(...row.durations),
                    render: (row) => format_duration(Math.max(...row.durations)),
                },
            ],
            groups,
            runs.length === 0 ? empty_message() : "No timed runs in this period."
        );
    }
}

function render_all() {
    const totals_element = document.getElementById("totals");
    if (totals_element) render_totals(totals_element, totals(visible_runs()));
    if (manifest_error) set_status(manifest_error);
    else if (manifest)
        set_status(
            `Data as of ${format_timestamp(new Date(manifest.generated_at))} ` +
                `(${format_relative(new Date(manifest.generated_at), new Date())})`
        );
    render_plots();
    render_tables();
}

// ── Start-up ─────────────────────────────────────────────────────────────────

function link_repository() {
    const repository = __REPOSITORY__;
    const source = document.getElementById("source_link") as HTMLAnchorElement | null;
    if (source) source.href = `https://github.com/${repository}`;
    const data = document.getElementById("data_link") as HTMLAnchorElement | null;
    if (data) data.href = `https://github.com/${repository}/tree/data`;
}

// Theme, settings, and controls are applied before the first paint, so that nothing is seen changing as it loads.
document.addEventListener("DOMContentLoaded", () => {
    init_theme();
    link_repository();
    const version = document.getElementById("site_version");
    if (version) version.textContent = `v${__APP_VERSION__}+${__GIT_HASH__}`;
    sync_from_url();
    window.requestAnimationFrame(() => document.documentElement.classList.remove("preload"));

    document.querySelectorAll<HTMLAnchorElement>(".section-anchor").forEach((anchor) => {
        anchor.addEventListener("click", (event) => {
            event.preventDefault();
            const href = anchor.getAttribute("href")!;
            window.history.pushState(null, "", window.location.search + href);
            document.querySelector(href)?.scrollIntoView({ behavior: "smooth" });
        });
    });
});

window.addEventListener("load", () => {
    bind_controls();
    render_all();
    loader
        .manifest()
        .then((loaded) => {
            manifest = loaded;
            populate_repositories(loaded);
            return load_and_render();
        })
        .catch((error: unknown) => {
            console.error(error);
            manifest_error = "Failed to load the data.";
            render_all();
        });
});
