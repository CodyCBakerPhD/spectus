import { test, expect } from "@playwright/test";
import { fixClock, setupDataMocks, waitForPlotsToRender } from "../fixtures/page-mocks.js";

// ── Why this suite exists ────────────────────────────────────────────────────
//
// The unit and integration suites check what the page hands Plotly and what it writes into the DOM, and the
// Chromatic run archives the DOM for review by eye.  This suite is the one that fails the build when what the browser
// actually painted changes: it compares the runs-over-time plot and the status grid against PNGs committed beside it.
//
// The baselines are per platform (Playwright suffixes them with the browser and OS), and are the Linux ones CI runs
// on, taken with the Chromium of the Playwright version pinned in package.json.  Regenerate with:
//
//     npm run test:visual -- --update-snapshots
//
// ── What is compared ─────────────────────────────────────────────────────────
//
// The plots' text is masked out of the comparison.  Fonts rasterize differently between machines, and the point here
// is the marks: whether the bars and cells carrying data are drawn, in the right places, in the right colors.

const MASKED_TEXT = [".gtitle", ".xtick", ".ytick", ".g-xtitle", ".g-ytitle", ".legendtext"];

// Widths at which each plot, sized at 95% of the viewport, lands on whole pixels; an element straddling the pixel
// grid is captured a pixel larger than it is, and Playwright rejects a size mismatch without comparing anything.
const VIEWPORTS = [
    { name: "desktop", width: 1280, height: 720 },
    { name: "mobile-portrait", width: 400, height: 844 },
];

const PLOTS = ["over_time_plot", "grid_plot"];

for (const viewport of VIEWPORTS) {
    for (const theme of ["dark", "light"]) {
        test(`plots — ${theme} — ${viewport.name}`, async ({ page }) => {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await setupDataMocks(page);
            await fixClock(page);
            await page.addInitScript((theme) => localStorage.setItem("theme", theme), theme);
            await page.goto("/");
            await waitForPlotsToRender(page);
            await page.evaluate(() => document.fonts.ready);
            // Out of the way of every plot, so that no hover label or mode bar is drawn
            await page.mouse.move(0, 0);

            for (const id of PLOTS) {
                const plot = page.locator(`#${id}`);
                await expect(plot).toHaveScreenshot(`${id}-${theme}-${viewport.name}.png`, {
                    mask: MASKED_TEXT.map((selector) => plot.locator(selector)),
                    maxDiffPixelRatio: 0.01,
                    animations: "disabled",
                });
            }
        });
    }
}
