/**
 * Plotly figures: pure functions from summaries (see stats.ts) and a theme to the data and layout Plotly draws.
 *
 * Outcomes wear the fixed status colors in both themes, each with a legend entry or a labeled badge beside it so that
 * none is told by color alone.  Gridlines and axes are hairlines one step off the surface; the data is the only thing
 * allowed to be loud.
 */

import type { Data, Layout } from "plotly.js";
import { format_count, format_duration, format_percent } from "./format.js";
import {
    type Aggregation,
    type CellState,
    CELL_LABELS,
    CELL_STATES,
    type DurationGroup,
    OUTCOME_COLORS,
    OUTCOME_LABELS,
    OUTCOMES,
    type OutcomesOverTime,
    type StatusGrid,
    success_rate,
} from "./stats.js";

/** The page's colors, mirroring the custom properties of styles.css. */
export interface Theme {
    name: "dark" | "light";
    bg: string;
    surface: string;
    border: string;
    text: string;
    text_secondary: string;
    /** The single hue of one-series charts, from the blue of the categorical palette. */
    series: string;
    /** A grid cell without runs, one step off the surface. */
    empty_cell: string;
}

export const DARK_THEME: Theme = {
    name: "dark",
    bg: "#1a1a2e",
    surface: "#16213e",
    border: "#2a2a4a",
    text: "#e0e0e0",
    text_secondary: "#a0a0b0",
    series: "#3987e5",
    empty_cell: "#1f2c4c",
};

export const LIGHT_THEME: Theme = {
    name: "light",
    bg: "#f5f7fa",
    surface: "#ffffff",
    border: "#d1d9e0",
    text: "#1a1a2e",
    text_secondary: "#5a6580",
    series: "#2a78d6",
    empty_cell: "#eef1f5",
};

/** The colors of the status grid's cell states: nothing, all passed, some failed, mostly failed. */
export function cell_colors(theme: Theme): Record<CellState, string> {
    return {
        none: theme.empty_cell,
        passing: OUTCOME_COLORS.succeeded,
        some_failed: OUTCOME_COLORS.other,
        mostly_failed: OUTCOME_COLORS.failed,
    };
}

export interface Figure {
    data: Data[];
    layout: Partial<Layout>;
}

const FONT = "'Source Sans 3', -apple-system, sans-serif";
/** Below this width, in pixels, a legend no longer fits on one row beside a plot's title. */
const NARROW_PLOT_WIDTH = 640;
/** The thickest a bar may be drawn, in pixels; what is left of its slot is air. */
const MAXIMUM_BAR_WIDTH = 24;

function axis(theme: Theme, title: string) {
    return {
        title: { text: title, font: { color: theme.text_secondary, size: 13 } },
        gridcolor: theme.border,
        linecolor: theme.border,
        zerolinecolor: theme.border,
        tickfont: { color: theme.text_secondary },
        automargin: true,
    };
}

/**
 * What every figure shares.  A narrow plot has its title set just above the plotting area rather than in the top
 * row, which the mode bar spans on a touch device, where it is always on show.
 */
function base_layout(theme: Theme, title: string, plot_width: number): Partial<Layout> {
    const narrow = plot_width < NARROW_PLOT_WIDTH;
    const placement = narrow ? { yref: "paper" as const, y: 1, yanchor: "bottom" as const, pad: { b: 12 } } : {};
    return {
        title: { text: title, font: { size: 17, color: theme.text }, ...placement },
        paper_bgcolor: theme.surface,
        plot_bgcolor: theme.surface,
        font: { family: FONT, color: theme.text },
        hoverlabel: { bgcolor: theme.bg, bordercolor: theme.border, font: { color: theme.text, family: FONT } },
        margin: { l: 64, r: 24, t: narrow ? 84 : 72, b: 56 },
    };
}

const BIN_NAMES: Record<Aggregation, string> = { daily: "day", weekly: "week", monthly: "month" };
const BIN_HOVER_FORMATS: Record<Aggregation, string> = {
    daily: "%a %b %-d, %Y",
    weekly: "Week of %b %-d, %Y",
    monthly: "%B %Y",
};
const BIN_AXIS_TITLES: Record<Aggregation, string> = { daily: "Date", weekly: "Week", monthly: "Month" };

/** The gap between bars that keeps each at most MAXIMUM_BAR_WIDTH across a plot of the given width. */
export function bar_gap(bars: number, plot_width: number): number {
    const slot = Math.max(plot_width - 120, 1) / Math.max(bars, 1);
    return Math.min(0.85, Math.max(0.15, 1 - MAXIMUM_BAR_WIDTH / slot));
}

/** Runs per bin as bars stacked by outcome, failures on the baseline. */
export function over_time_figure(
    series: OutcomesOverTime,
    aggregation: Aggregation,
    theme: Theme,
    plot_width: number
): Figure {
    const data: Data[] = OUTCOMES.map((outcome) => ({
        type: "bar",
        name: OUTCOME_LABELS[outcome],
        x: series.bins,
        y: series.counts[outcome],
        marker: { color: OUTCOME_COLORS[outcome], line: { color: theme.surface, width: 1 } },
        hovertemplate: `%{y:,}<extra>${OUTCOME_LABELS[outcome]}</extra>`,
    }));
    const narrow = plot_width < NARROW_PLOT_WIDTH;
    // Rounded data-ends; the option is newer than the type definitions
    const layout: Partial<Layout> & { barcornerradius: number } = {
        ...base_layout(theme, `Runs per ${BIN_NAMES[aggregation]}`, plot_width),
        barmode: "stack",
        barcornerradius: 4,
        bargap: bar_gap(series.bins.length, plot_width),
        hovermode: "x unified",
        margin: { l: 64, r: 24, t: narrow ? 84 : 72, b: narrow ? 150 : 56 },
        // Above the plot, unless it is too narrow for the legend to fit on one row there
        legend: {
            orientation: "h",
            x: 0.5,
            xanchor: "center",
            y: narrow ? -0.3 : 1.02,
            yanchor: narrow ? "top" : "bottom",
            font: { color: theme.text_secondary },
            traceorder: "normal",
        },
        xaxis: {
            ...axis(theme, BIN_AXIS_TITLES[aggregation]),
            type: "date",
            hoverformat: BIN_HOVER_FORMATS[aggregation],
            showgrid: false,
        },
        yaxis: { ...axis(theme, "Runs"), rangemode: "tozero", tickformat: "~s" },
    };
    return { data, layout };
}

function cell_hover(row: string, bin: string, cell: StatusGrid["cells"][number][number], aggregation: Aggregation) {
    const period = aggregation === "weekly" ? `Week of ${bin}` : bin;
    if (cell.runs === 0) return `${row}<br>${period}<br>No runs`;
    const rate = success_rate(cell.succeeded, cell.failed);
    return (
        `${row}<br>${period}<br>${format_count(cell.runs)} run${cell.runs === 1 ? "" : "s"}: ` +
        `${format_count(cell.succeeded)} succeeded, ${format_count(cell.failed)} failed` +
        (rate === null ? "" : `<br>Success rate ${format_percent(rate)}`)
    );
}

/** Whether each row passed or failed in each bin, as a grid of status-colored cells. */
export function status_grid_figure(
    grid: StatusGrid,
    aggregation: Aggregation,
    theme: Theme,
    plot_width: number
): Figure {
    const colors = cell_colors(theme);
    const steps = CELL_STATES.length;
    // A discrete scale: each state owns an equal band of [0, 1], its own color across the whole band
    const colorscale = CELL_STATES.flatMap((state, index) => [
        [index / steps, colors[state]],
        [(index + 1) / steps, colors[state]],
    ]) as Array<[number, string]>;
    const data: Data[] = [
        {
            type: "heatmap",
            x: grid.bins,
            y: grid.rows,
            z: grid.cells.map((row) => row.map((cell) => CELL_STATES.indexOf(cell.state))),
            zmin: -0.5,
            zmax: steps - 0.5,
            colorscale,
            showscale: false,
            xgap: 2,
            ygap: 2,
            text: grid.cells.map((row, row_index) =>
                row.map((cell, column) => cell_hover(grid.rows[row_index], grid.bins[column], cell, aggregation))
            ) as unknown as string[],
            hovertemplate: "%{text}<extra></extra>",
        },
    ];
    const title =
        grid.hidden_rows > 0
            ? `Status per ${BIN_NAMES[aggregation]} (busiest ${grid.rows.length} of ${grid.rows.length + grid.hidden_rows})`
            : `Status per ${BIN_NAMES[aggregation]}`;
    const layout: Partial<Layout> = {
        ...base_layout(theme, title, plot_width),
        height: Math.max(220, 130 + grid.rows.length * 26),
        xaxis: { ...axis(theme, ""), type: "date", showgrid: false, hoverformat: "%b %-d, %Y" },
        yaxis: { ...axis(theme, ""), autorange: "reversed", showgrid: false, type: "category" },
    };
    return { data, layout };
}

/** The legend of the status grid: one labeled swatch per cell state. */
export function status_grid_legend(theme: Theme): Array<{ state: CellState; label: string; color: string }> {
    const colors = cell_colors(theme);
    return CELL_STATES.map((state) => ({ state, label: CELL_LABELS[state], color: colors[state] }));
}

/** The spread of each workflow's run durations as horizontal box plots, slowest median on top. */
export function durations_figure(
    groups: DurationGroup[],
    theme: Theme,
    log_scale: boolean,
    plot_width: number
): Figure {
    const data: Data[] = groups.map((group) => ({
        type: "box",
        name: group.label,
        x: group.durations.map((seconds) => seconds / 60),
        orientation: "h",
        boxpoints: "outliers",
        marker: { color: theme.series, size: 5 },
        line: { color: theme.series, width: 1.5 },
        fillcolor: `${theme.series}33`,
        showlegend: false,
        hovertemplate: `${group.label}<br>Median ${format_duration(group.median)}<extra></extra>`,
    }));
    const layout: Partial<Layout> = {
        ...base_layout(theme, "Run duration per workflow", plot_width),
        height: Math.max(260, 140 + groups.length * 34),
        xaxis: { ...axis(theme, "Minutes"), type: log_scale ? "log" : "linear", rangemode: "tozero" },
        yaxis: { ...axis(theme, ""), autorange: "reversed", showgrid: false, type: "category" },
    };
    return { data, layout };
}
