import { defineConfig, devices } from "@playwright/test";

/**
 * Screenshot-comparison suite.  Separate from the Chromatic config because the
 * two answer different questions: Chromatic diffs an archived DOM in its own
 * service, this one diffs pixels the browser painted against PNGs committed
 * beside the tests, which is the only way to hold a WebGL canvas to account.
 */
export default defineConfig({
    testDir: "../tests/visual",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [["html", { outputFolder: "../playwright-report-visual", open: "never" }]],
    use: {
        baseURL: "http://localhost:5173",
        trace: "on-first-retry",
        launchOptions: {
            args: ["--disable-gpu"],
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
