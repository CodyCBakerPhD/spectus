import { expect } from "@playwright/test";
import { DATA_FILES, MANIFEST } from "./mock-data.js";

// This module is shared by every Playwright suite that needs the page rendered against fixed content: the
// integration, Chromatic, and screenshot-comparison runs all import it.

/** A moment shortly after the mock data was bundled, which the page's clock is fixed at. */
export const MOCK_NOW = new Date("2026-10-17T12:30:00Z");

/**
 * Registers Playwright route handlers that answer every request for the bundled data with the fixture of
 * mock-data.js (shared with the jsdom harness), so that the page is always drawn from the same records and never
 * from whatever a local checkout of the data branch holds.  Must be called before page.goto().
 */
export async function setupDataMocks(page) {
    await page.route("**/data/manifest.json", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MANIFEST) })
    );
    await page.route("**/data/**/*.jsonl", (route) => {
        const path = new URL(route.request().url()).pathname.replace(/^.*?\/data\//, "");
        const body = DATA_FILES[path];
        return body === undefined
            ? route.fulfill({ status: 404, body: "" })
            : route.fulfill({ status: 200, contentType: "text/plain", body });
    });
}

/**
 * Fixes the page's clock, so that "how long ago" reads the same on every run.  Timers still run.  Must be called
 * before page.goto().
 */
export async function fixClock(page) {
    await page.clock.setFixedTime(MOCK_NOW);
}

/**
 * Replaces the footer version string with a fixed mock value so that snapshots are not invalidated by version bumps
 * or new commits.
 */
export async function mockVersion(page) {
    await page.evaluate(() => {
        const versionEl = document.getElementById("site_version");
        if (versionEl) versionEl.textContent = "v0.0.0+test0000";
    });
}

export const PLOT_IDS = ["over_time_plot", "grid_plot", "durations_plot"];

// Text the page writes into a plot's container when it gives up on it
export const PLOT_FAILURE_TEXT = "Failed to";

/**
 * Waits until every plot has settled: either each has drawn, or at least one has given up and written its failure
 * message.  A plot counts as drawn only once it holds a drawing surface, not merely the "js-plotly-plot" class Plotly
 * adds partway through newPlot().
 */
export async function waitForPlotsToRender(page) {
    await page.waitForFunction(
        ([ids, failureText]) => {
            const failed = ids.some((id) => (document.getElementById(id)?.innerText ?? "").includes(failureText));
            const drawn = ids.every((id) => {
                const el = document.getElementById(id);
                return el?.classList.contains("js-plotly-plot") && el.querySelector("svg") !== null;
            });
            return failed || drawn;
        },
        [PLOT_IDS, PLOT_FAILURE_TEXT],
        { timeout: 30000 }
    );
}

/** Asserts that no plot rendered its failure placeholder. */
export async function expectPlotsRendered(page) {
    const failed = await page.evaluate(
        ([ids, failureText]) =>
            ids.filter((id) => (document.getElementById(id)?.innerText ?? "").includes(failureText)),
        [PLOT_IDS, PLOT_FAILURE_TEXT]
    );
    expect(failed, "Plots showing a failure message instead of a plot").toEqual([]);
}

/**
 * Asserts that no plot's title is run over by its mode bar, which Plotly draws across the first row of the plot —
 * hidden until hovered on a mouse, but on show for good on a touch device.
 */
export async function expectModeBarClearOfTitles(page) {
    const { collisions, checked } = await page.evaluate((ids) => {
        const collisions = [];
        let checked = 0;
        for (const id of ids) {
            const plot = document.getElementById(id);
            const bar = plot?.querySelector(".modebar");
            const title = plot?.querySelector(".gtitle");
            if (!bar || !title) continue;
            const b = bar.getBoundingClientRect();
            const t = title.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) continue;
            checked += 1;
            const clears = t.top >= b.bottom || t.bottom <= b.top || t.left >= b.right || t.right <= b.left;
            if (!clears)
                collisions.push(
                    `${id} (title ${Math.round(t.top)}-${Math.round(t.bottom)}, mode bar ${Math.round(b.top)}-${Math.round(b.bottom)})`
                );
        }
        return { collisions, checked };
    }, PLOT_IDS);
    expect(collisions, "Plot titles run over by their mode bar").toEqual([]);
    expect(checked, "Plots whose mode bar could be compared against their title").toBeGreaterThan(0);
}

/**
 * Asserts that the page does not scroll sideways at the current viewport, and names the elements that overflow it
 * when it does.  A table wider than the viewport scrolls inside its own container, which is allowed.
 */
export async function expectNoHorizontalOverflow(page) {
    const { scrollWidth, clientWidth, offenders } = await page.evaluate(() => {
        const root = document.documentElement;
        const offenders = [];
        document.querySelectorAll("body *").forEach((el) => {
            // Plotly measures text in a deliberately oversized off-screen SVG.
            if (el.id === "js-plotly-tester") return;
            // A plot's internal geometry is drawn to its own coordinate space; the <svg> that holds it is checked.
            if (el.ownerSVGElement) return;
            // Wide tables scroll within their container rather than the page.
            if (el.closest(".plot-table-container table")) return;
            const { width } = el.getBoundingClientRect();
            if (width > root.clientWidth + 1) {
                const id = el.id ? `#${el.id}` : "";
                const names = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
                const classes = names.length ? `.${names.join(".")}` : "";
                offenders.push(`${el.tagName.toLowerCase()}${id}${classes} (${Math.round(width)}px)`);
            }
        });
        return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, offenders };
    });
    expect(offenders, `Elements wider than the ${clientWidth}px viewport`).toEqual([]);
    expect(scrollWidth, `Page scrolls sideways at ${clientWidth}px`).toBeLessThanOrEqual(clientWidth + 1);
}
