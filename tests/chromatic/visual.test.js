import { test, takeSnapshot } from "@chromatic-com/playwright";
import {
    expectModeBarClearOfTitles,
    expectNoHorizontalOverflow,
    expectPlotsRendered,
    fixClock,
    mockVersion,
    setupDataMocks,
    waitForPlotsToRender,
} from "../fixtures/page-mocks.js";

/**
 * Viewports every snapshot is taken at, as a matrix of the two device classes against the two orientations, plus the
 * desktop width the suite started at (the Desktop Chrome default this config runs under).
 *
 * These are per-test rather than per-project because Chromatic keys an archive by the test's title alone: run as
 * Playwright projects, each viewport writes over the last one's manifest and only the project that runs last reaches
 * Chromatic at all.  Naming the viewport in the test title keeps them apart.
 */
const VIEWPORTS = [
    { name: "desktop", width: 1280, height: 720 },
    { name: "tablet-portrait", width: 768, height: 1024 },
    { name: "tablet-landscape", width: 1024, height: 768 },
    { name: "mobile-portrait", width: 390, height: 844 },
    { name: "mobile-landscape", width: 844, height: 390 },
];

test.describe("Spectus Workflow Runs Page", () => {
    // The Chromatic fixture calls takeSnapshot automatically after the test body unless disableAutoSnapshot is set.
    // Since we call takeSnapshot explicitly ourselves, disabling the automatic one prevents two identical captures per
    // test (which would show up as redundant snapshots in Chromatic's UI).
    test.use({ disableAutoSnapshot: true });

    for (const viewport of VIEWPORTS) {
        for (const theme of ["dark", "light"]) {
            test(`${theme} theme — ${viewport.name}`, async ({ page }, testInfo) => {
                await page.setViewportSize({ width: viewport.width, height: viewport.height });
                await setupDataMocks(page);
                await fixClock(page);
                await page.addInitScript((theme) => {
                    localStorage.setItem("theme", theme);
                }, theme);
                await page.goto("/");
                await waitForPlotsToRender(page);
                await mockVersion(page);
                await expectPlotsRendered(page);
                await expectNoHorizontalOverflow(page);
                await expectModeBarClearOfTitles(page);
                await takeSnapshot(page, testInfo.title, testInfo);
            });
        }
    }
});
