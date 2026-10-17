import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "../tests/chromatic",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    // On CI, failures are also reported as annotations on the run, readable without downloading the report
    reporter: process.env.CI
        ? [["github"], ["html", { outputFolder: "../playwright-report-chromatic", open: "never" }]]
        : [["html", { outputFolder: "../playwright-report-chromatic", open: "never" }]],
    use: {
        baseURL: "http://localhost:5173",
        trace: "on-first-retry",
        launchOptions: {
            // Without hinting, as text is measured in Claude Code cloud sessions; GitHub's runners otherwise hint
            // fully, which rounds glyph widths to whole pixels and moves whatever Plotly lays out around its labels
            args: ["--disable-gpu", "--font-render-hinting=none"],
        },
    },
    // One project only: the viewports each snapshot is taken at are set per
    // test rather than per project, since Chromatic keys an archive by the
    // test's title alone.  See tests/chromatic/visual.test.js.
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: {
        command: "npm run dev",
        url: "http://localhost:5173",
        reuseExistingServer: !process.env.CI,
    },
});
