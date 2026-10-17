import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "../tests/integration",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    // On CI, failures are also reported as annotations on the run, readable without downloading the report
    reporter: process.env.CI
        ? [["github"], ["html", { outputFolder: "../playwright-report", open: "never" }]]
        : [["html", { outputFolder: "../playwright-report", open: "never" }]],
    use: {
        baseURL: "http://localhost:5173",
        trace: "on-first-retry",
        launchOptions: {
            // Without hinting, as text is measured in Claude Code cloud sessions; GitHub's runners otherwise hint
            // fully, which rounds glyph widths to whole pixels and moves whatever Plotly lays out around its labels
            args: ["--disable-gpu", "--font-render-hinting=none"],
        },
    },
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
