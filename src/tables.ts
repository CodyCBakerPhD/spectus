/**
 * HTML tables: the totals summary and the sortable tables each section offers in place of, or beside, its plot.
 */

import { escape_html, format_count, format_duration, format_percent } from "./format.js";
import { OUTCOME_ICONS, OUTCOME_LABELS, type Outcome, type Totals } from "./stats.js";

export interface TableColumn<Row> {
    label: string;
    /** What the column sorts by: a number (missing values always sink to the bottom) or text. */
    sort_value: (row: Row) => number | string | null;
    /** The cell's HTML; it must escape anything it did not write itself. */
    render: (row: Row) => string;
    align_left?: boolean;
}

interface SortState {
    signature: string;
    column: number;
    ascending: boolean;
}

// Re-rendering a table with fresh rows (a change of period, say) keeps the sort the viewer last chose for it, as
// long as it is still the same table.
const SORT_STATE = new WeakMap<HTMLElement, SortState>();

function compare(a: number | string | null, b: number | string | null, ascending: boolean): number {
    const a_missing = a === null || (typeof a === "number" && !Number.isFinite(a));
    const b_missing = b === null || (typeof b === "number" && !Number.isFinite(b));
    if (a_missing || b_missing) return a_missing === b_missing ? 0 : a_missing ? 1 : -1;
    const factor = ascending ? 1 : -1;
    if (typeof a === "number" && typeof b === "number") return factor * (a - b);
    return factor * String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * Renders rows into a container as a table whose columns sort when their header is clicked.  Rows start in the order
 * given unless the viewer has already sorted this table.
 */
export function render_sortable_table<Row>(
    container: HTMLElement,
    title: string,
    columns: Array<TableColumn<Row>>,
    rows: Row[],
    empty_message = "No runs to show."
): void {
    const signature = columns.map((column) => column.label).join("\u0000");
    const remembered = SORT_STATE.get(container);
    let state: SortState | null = remembered?.signature === signature ? remembered : null;

    const render = () => {
        const sorted = state
            ? [...rows].sort((a, b) =>
                  compare(columns[state!.column].sort_value(a), columns[state!.column].sort_value(b), state!.ascending)
              )
            : rows;
        const header = columns
            .map((column, index) => {
                const sorted_here = state?.column === index;
                const indicator = sorted_here ? (state!.ascending ? "▲" : "▼") : "⇅";
                const classes = [sorted_here ? "th-sorted" : "th-sortable", column.align_left ? "cell-left" : ""];
                const aria = sorted_here ? ` aria-sort="${state!.ascending ? "ascending" : "descending"}"` : "";
                return (
                    `<th class="${classes.join(" ").trim()}" data-column="${index}"${aria}>` +
                    `${escape_html(column.label)} <span class="sort-indicator">${indicator}</span></th>`
                );
            })
            .join("");
        const body = sorted.length
            ? sorted
                  .map(
                      (row) =>
                          "<tr>" +
                          columns
                              .map(
                                  (column) =>
                                      `<td${column.align_left ? ' class="cell-left"' : ""}>${column.render(row)}</td>`
                              )
                              .join("") +
                          "</tr>"
                  )
                  .join("")
            : `<tr><td colspan="${columns.length}" class="cell-muted">${escape_html(empty_message)}</td></tr>`;
        container.innerHTML =
            `<div class="plot-table-header"><h3>${escape_html(title)}</h3></div>` +
            `<div class="plot-table-container"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;

        container.querySelectorAll<HTMLElement>("th[data-column]").forEach((th) => {
            th.addEventListener("click", () => {
                const column = Number(th.dataset.column);
                // A first click sorts numbers high to low and text A to Z; another click reverses it
                const first_ascending = typeof columns[column].sort_value(rows[0]) !== "number";
                state = {
                    signature,
                    column,
                    ascending: state?.column === column ? !state.ascending : first_ascending,
                };
                SORT_STATE.set(container, state);
                render();
            });
        });
    };
    render();
}

/** A run outcome as a badge: its status color, an icon, and its label. */
export function outcome_badge(outcome: Outcome): string {
    return (
        `<span class="outcome-badge outcome-${outcome}" data-icon="${OUTCOME_ICONS[outcome]}">` +
        `${escape_html(OUTCOME_LABELS[outcome])}</span>`
    );
}

/** A link to a page on GitHub, or the bare text if the address is not one. */
export function github_link(href: string, text: string, title?: string): string {
    const title_attribute = title ? ` title="${escape_html(title)}"` : "";
    if (!/^https:\/\/github\.com\//.test(href)) return `<span${title_attribute}>${escape_html(text)}</span>`;
    return (
        `<a class="table-cell-link" href="${escape_html(href)}" target="_blank" rel="noopener"${title_attribute}>` +
        `${escape_html(text)}</a>`
    );
}

/** The headline numbers of the selection, as a row of labeled columns. */
export function render_totals(container: HTMLElement, totals: Totals): void {
    const metrics: Array<[string, string, string | null]> = [
        ["Runs", format_count(totals.runs), null],
        ["Success rate", format_percent(totals.success_rate), "Succeeded runs among those that succeeded or failed"],
        ["Failed", format_count(totals.failed), "Failed, timed out, or failed to start"],
        ["Workflows", format_count(totals.workflows), null],
        ["Repositories", format_count(totals.repositories), null],
        [
            "Median duration",
            format_duration(totals.median_duration),
            "From the first job starting to the last finishing",
        ],
    ];
    const rows = metrics
        .map(([label, value, tooltip]) => {
            const info = tooltip
                ? `<span class="info-icon" data-tooltip="${escape_html(tooltip)}" tabindex="0" role="img" ` +
                  `aria-label="${escape_html(`${label}: ${tooltip}`)}">i</span>`
                : "";
            return (
                `<tr><th scope="row"><span class="totals-th-inner">${escape_html(label)}${info}</span></th>` +
                `<td>${escape_html(value)}</td></tr>`
            );
        })
        .join("");
    container.innerHTML = `<table class="totals-table"><tbody>${rows}</tbody></table>`;
}
