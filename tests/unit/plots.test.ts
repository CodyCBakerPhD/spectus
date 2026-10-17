import { describe, expect, it } from "vitest";
import {
    bar_gap,
    cell_colors,
    DARK_THEME,
    durations_figure,
    LIGHT_THEME,
    over_time_figure,
    status_grid_figure,
    status_grid_legend,
} from "../../src/plots.js";
import { OUTCOME_COLORS, type StatusGrid } from "../../src/stats.js";

const series = {
    bins: ["2026-10-15", "2026-10-16"],
    counts: { failed: [1, 0], succeeded: [4, 2], other: [0, 1], cancelled: [0, 0] },
};

describe("over_time_figure", () => {
    it("stacks one bar trace per outcome, failures first so they sit on the baseline", () => {
        const { data, layout } = over_time_figure(series, "daily", DARK_THEME, 1000);
        expect(data.map((trace: any) => trace.name)).toEqual([
            "Failed",
            "Succeeded",
            "Needs attention",
            "Cancelled or skipped",
        ]);
        expect((data[0] as any).y).toEqual([1, 0]);
        expect((data[0] as any).marker.color).toBe(OUTCOME_COLORS.failed);
        expect(layout.barmode).toBe("stack");
        expect((layout.title as any).text).toBe("Runs per day");
        expect((layout.xaxis as any).hoverformat).toBe("%a %b %-d, %Y");
        expect(layout.paper_bgcolor).toBe(DARK_THEME.surface);
    });

    it("names the bin it aggregates by", () => {
        expect((over_time_figure(series, "weekly", LIGHT_THEME, 1000).layout.title as any).text).toBe("Runs per week");
        const monthly = over_time_figure(series, "monthly", LIGHT_THEME, 1000).layout;
        expect((monthly.title as any).text).toBe("Runs per month");
        expect((monthly.xaxis as any).title.text).toBe("Month");
    });

    it("moves the legend below a narrow plot, and its title down out of the mode bar's row", () => {
        const wide = over_time_figure(series, "daily", DARK_THEME, 1000).layout;
        const narrow = over_time_figure(series, "daily", DARK_THEME, 390).layout;
        expect((wide.legend as any).yanchor).toBe("bottom");
        expect((narrow.legend as any).yanchor).toBe("top");
        expect((wide.title as any).yref).toBeUndefined();
        expect(narrow.title as any).toMatchObject({ yref: "paper", y: 1, yanchor: "bottom" });
    });
});

describe("bar_gap", () => {
    it("keeps bars at most 24 px across, within bounds", () => {
        expect(bar_gap(30, 1000)).toBeCloseTo(1 - 24 / (880 / 30));
        expect(bar_gap(3, 1000)).toBe(0.85);
        expect(bar_gap(365, 1000)).toBe(0.15);
        expect(bar_gap(0, 0)).toBe(0.15);
    });
});

describe("status_grid_figure", () => {
    const grid: StatusGrid = {
        rows: ["a/a", "b/b"],
        bins: ["2026-10-12", "2026-10-19"],
        cells: [
            [
                { state: "passing", succeeded: 2, failed: 0, runs: 2 },
                { state: "none", succeeded: 0, failed: 0, runs: 0 },
            ],
            [
                { state: "some_failed", succeeded: 3, failed: 1, runs: 5 },
                { state: "mostly_failed", succeeded: 0, failed: 1, runs: 1 },
            ],
        ],
        hidden_rows: 0,
    };

    it("draws each cell's state on a discrete color scale", () => {
        const { data } = status_grid_figure(grid, "weekly", DARK_THEME, 1000);
        const heatmap = data[0] as any;
        expect(heatmap.z).toEqual([
            [1, 0],
            [2, 3],
        ]);
        expect(heatmap.colorscale[0]).toEqual([0, DARK_THEME.empty_cell]);
        expect(heatmap.colorscale[heatmap.colorscale.length - 1]).toEqual([1, OUTCOME_COLORS.failed]);
        expect(heatmap.text[1][0]).toBe(
            "b/b<br>Week of 2026-10-12<br>5 runs: 3 succeeded, 1 failed<br>Success rate 75%"
        );
        expect(heatmap.text[0][1]).toBe("a/a<br>Week of 2026-10-19<br>No runs");
        expect(heatmap.text[1][1]).toBe("b/b<br>Week of 2026-10-19<br>1 run: 0 succeeded, 1 failed<br>Success rate 0%");
    });

    it("says how many rows it left out", () => {
        const title = (status_grid_figure({ ...grid, hidden_rows: 3 }, "daily", LIGHT_THEME, 1000).layout.title as any)
            .text;
        expect(title).toBe("Status per day (busiest 2 of 5)");
    });

    it("does not rate a cell without succeeded or failed runs", () => {
        const cancelled: StatusGrid = {
            ...grid,
            rows: ["a/a"],
            bins: ["2026-10-12"],
            cells: [[{ state: "none", succeeded: 0, failed: 0, runs: 2 }]],
        };
        const heatmap = status_grid_figure(cancelled, "daily", DARK_THEME, 1000).data[0] as any;
        expect(heatmap.text[0][0]).toBe("a/a<br>2026-10-12<br>2 runs: 0 succeeded, 0 failed");
    });

    it("has a labeled legend entry per state, in the theme's colors", () => {
        expect(status_grid_legend(LIGHT_THEME).map((entry) => [entry.label, entry.color])).toEqual([
            ["No runs that succeeded or failed", LIGHT_THEME.empty_cell],
            ["All succeeded", OUTCOME_COLORS.succeeded],
            ["Some failed", OUTCOME_COLORS.other],
            ["Half or more failed", OUTCOME_COLORS.failed],
        ]);
        expect(cell_colors(DARK_THEME).none).toBe(DARK_THEME.empty_cell);
    });
});

describe("durations_figure", () => {
    const groups = [
        { key: "a", label: "Slow", durations: [600, 1200], median: 900 },
        { key: "b", label: "Fast", durations: [30], median: 30 },
    ];

    it("draws a box per workflow in minutes, in the series hue", () => {
        const { data, layout } = durations_figure(groups, LIGHT_THEME, false, 1000);
        expect(data.map((trace: any) => trace.name)).toEqual(["Slow", "Fast"]);
        expect((data[0] as any).x).toEqual([10, 20]);
        expect((data[0] as any).marker.color).toBe(LIGHT_THEME.series);
        expect((data[0] as any).hovertemplate).toBe("Slow<br>Median 15m<extra></extra>");
        expect((layout.xaxis as any).type).toBe("linear");
    });

    it("can use a log scale", () => {
        expect((durations_figure(groups, DARK_THEME, true, 400).layout.xaxis as any).type).toBe("log");
    });
});
