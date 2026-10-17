import { beforeEach, describe, expect, it } from "vitest";
import {
    github_link,
    outcome_badge,
    render_sortable_table,
    render_totals,
    type TableColumn,
} from "../../src/tables.js";

interface Row {
    name: string;
    count: number | null;
}

const columns: Array<TableColumn<Row>> = [
    { label: "Name", sort_value: (row) => row.name, render: (row) => row.name, align_left: true },
    { label: "Count", sort_value: (row) => row.count, render: (row) => String(row.count ?? "—") },
];

const rows: Row[] = [
    { name: "beta", count: 2 },
    { name: "alpha", count: null },
    { name: "gamma", count: 10 },
];

let container: HTMLElement;

beforeEach(() => {
    document.body.innerHTML = '<div id="table"></div>';
    container = document.getElementById("table")!;
});

const cells = (column: number) =>
    Array.from(container.querySelectorAll("tbody tr")).map((tr) => tr.querySelectorAll("td")[column].textContent);
const header = (index: number) => container.querySelectorAll<HTMLElement>("th")[index];

describe("render_sortable_table", () => {
    it("renders the rows in the order given, under a title", () => {
        render_sortable_table(container, "Things", columns, rows);
        expect(container.querySelector("h3")!.textContent).toBe("Things");
        expect(cells(0)).toEqual(["beta", "alpha", "gamma"]);
        expect(header(0).className).toContain("cell-left");
    });

    it("sorts numbers high to low first, text A to Z, and reverses on a second click", () => {
        render_sortable_table(container, "Things", columns, rows);
        header(1).click();
        expect(cells(0)).toEqual(["gamma", "beta", "alpha"]);
        expect(header(1).getAttribute("aria-sort")).toBe("descending");
        header(1).click();
        // A missing value sinks to the bottom either way
        expect(cells(0)).toEqual(["beta", "gamma", "alpha"]);
        header(0).click();
        expect(cells(0)).toEqual(["alpha", "beta", "gamma"]);
        expect(header(0).getAttribute("aria-sort")).toBe("ascending");
    });

    it("keeps the viewer's sort when the same table is rendered again", () => {
        render_sortable_table(container, "Things", columns, rows);
        header(0).click();
        render_sortable_table(container, "Things", columns, [...rows, { name: "aardvark", count: 1 }]);
        expect(cells(0)).toEqual(["aardvark", "alpha", "beta", "gamma"]);

        render_sortable_table(container, "Other", [columns[1]], rows);
        expect(cells(0)).toEqual(["2", "—", "10"]);
    });

    it("says so when there are no rows", () => {
        render_sortable_table(container, "Things", columns, [], "Nothing here.");
        expect(cells(0)).toEqual(["Nothing here."]);
        expect(container.querySelector("td")!.getAttribute("colspan")).toBe("2");
    });
});

describe("outcome_badge", () => {
    it("pairs the status color with an icon and a label", () => {
        document.body.innerHTML = outcome_badge("failed");
        const badge = document.querySelector(".outcome-badge")!;
        expect(badge.className).toContain("outcome-failed");
        expect(badge.getAttribute("data-icon")).toBe("✕");
        expect(badge.textContent).toBe("Failed");
    });
});

describe("github_link", () => {
    it("links to GitHub only", () => {
        expect(github_link("https://github.com/con/spectus", "con/spectus", "Go")).toBe(
            '<a class="table-cell-link" href="https://github.com/con/spectus" target="_blank" rel="noopener" title="Go">con/spectus</a>'
        );
        expect(github_link("javascript:alert(1)", "<b>x</b>")).toBe("<span>&lt;b&gt;x&lt;/b&gt;</span>");
    });
});

describe("render_totals", () => {
    it("lays out each metric with its caveat behind an info icon", () => {
        render_totals(container, {
            runs: 1234,
            succeeded: 1000,
            failed: 100,
            success_rate: 10 / 11,
            repositories: 3,
            workflows: 7,
            median_duration: 125,
        });
        const values = Array.from(container.querySelectorAll("tr")).map((tr) => [
            tr.querySelector("th")!.textContent,
            tr.querySelector("td")!.textContent,
        ]);
        expect(values).toEqual([
            ["Runs", "1,234"],
            ["Success ratei", "90.9%"],
            ["Failedi", "100"],
            ["Workflows", "7"],
            ["Repositories", "3"],
            ["Median durationi", "2m 5s"],
        ]);
        expect(container.querySelector(".info-icon")!.getAttribute("data-tooltip")).toBe(
            "Succeeded runs among those that succeeded or failed"
        );
    });
});
