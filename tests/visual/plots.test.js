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

/**
 * Describes how a plot was laid out: where Plotly put its plotting area, how wide it measured the labels it made room
 * for, and which fonts the page had loaded.  A plot whose marks moved without changing is usually one whose labels
 * measured differently, which this names when a comparison fails.
 */
function describeLayout(page, id) {
    return page.evaluate((id) => {
        const plot = document.getElementById(id);
        const { l, t, w, h } = plot._fullLayout._size;
        const labels = Array.from(plot.querySelectorAll(".ytick text"), (text) => text.getBBox().width.toFixed(2));
        const fonts = Array.from(document.fonts)
            .filter((font) => font.status === "loaded")
            .map((font) => `${font.family} ${font.weight}`);
        return `Plotting area at (${l}, ${t}), ${w} by ${h}; y labels ${labels.join(", ")} px wide; fonts loaded: ${fonts.join(", ") || "none"}`;
    }, id);
}

/**
 * Moves a plot to the top-left corner of the viewport for its capture, and returns how to put it back.
 *
 * Its size in CSS pixels is a whole number, but its position is not certain to be: it sits below text whose height
 * rounds differently depending on the fonts available (the outcome badges' ✓ and ✕ are not in the page's typeface,
 * so each machine draws them from a font of its own).  An element straddling the pixel grid is captured one pixel
 * taller than it is, and Playwright rejects a size mismatch outright without comparing anything, so a baseline taken
 * on one machine could never match another.
 *
 * Pinning it to whole coordinates, over a backdrop of its own, makes the captured image depend on the plot alone.
 * Nothing is redrawn: the size is held as it was, so Plotly has no resize to react to.
 */
async function pinToViewportCorner(page, id) {
    await page.evaluate((id) => {
        const element = document.getElementById(id);
        const { width, height } = element.getBoundingClientRect();
        element.dataset.pinnedStyle = element.getAttribute("style") ?? "";
        Object.assign(element.style, {
            // Held at the size it was laid out at, which a fixed element would otherwise shrink from
            width: `${width}px`,
            height: `${height}px`,
            position: "fixed",
            top: "0",
            left: "0",
            margin: "0",
            background: getComputedStyle(document.body).backgroundColor,
            zIndex: "9999",
        });
    }, id);
    return () =>
        page.evaluate((id) => {
            const element = document.getElementById(id);
            element.setAttribute("style", element.dataset.pinnedStyle);
        }, id);
}

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
                const unpin = await pinToViewportCorner(page, id);
                const plot = page.locator(`#${id}`);
                await expect(plot, await describeLayout(page, id)).toHaveScreenshot(
                    `${id}-${theme}-${viewport.name}.png`,
                    {
                        mask: MASKED_TEXT.map((selector) => plot.locator(selector)),
                        // Room for antialiasing to differ between machines, and nowhere near enough to let a plot whose
                        // marks moved or changed color pass
                        maxDiffPixelRatio: 0.02,
                        animations: "disabled",
                    }
                );
                await unpin();
            }
        });
    }
}
