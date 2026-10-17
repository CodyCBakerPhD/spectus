import { test as base, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixClock, setupDataMocks, waitForPlotsToRender } from "../fixtures/page-mocks.js";

const COVERAGE_ENABLED = process.env.PW_COVERAGE === "1";
const COVERAGE_RAW_OUTPUT_DIR = resolve(process.cwd(), "coverage", "integration", "raw");

const test = COVERAGE_ENABLED
    ? base.extend({
          page: async ({ page }, use, testInfo) => {
              if (typeof page.coverage?.startJSCoverage !== "function") {
                  await use(page);
                  return;
              }

              await page.coverage.startJSCoverage({ resetOnNavigation: false });
              try {
                  await use(page);
              } finally {
                  const coverage = await page.coverage.stopJSCoverage();
                  if (coverage.length === 0) return;

                  await mkdir(COVERAGE_RAW_OUTPUT_DIR, { recursive: true });
                  const fileHash = createHash("sha1").update(testInfo.testId).digest("hex");
                  const outputFile = resolve(COVERAGE_RAW_OUTPUT_DIR, `${fileHash}.json`);
                  await writeFile(outputFile, JSON.stringify(coverage));
              }
          },
      })
    : base;

test.describe("Spectus workflow runs page", () => {
    test.beforeEach(async ({ page }) => {
        page.on("console", (msg) => {
            if (msg.type() === "warning") {
                const text = msg.text();
                // Suppress GPU/GL driver performance warnings emitted by the software rasterizer (SwiftShader) in
                // headless CI environments.
                if (text.includes("GL Driver Message")) return;
                console.warn(`[browser:warning] ${text}`);
            }
        });
        await page.addInitScript(() => localStorage.clear());
        await setupDataMocks(page);
        await fixClock(page);
    });

    test("page loads and displays the header with its logo", async ({ page }) => {
        await page.goto("/");
        await expect(page.locator("header")).toBeVisible();
        await expect(page.locator("header img.site-logo")).toBeVisible();
        await expect(page).toHaveTitle("Spectus · Workflow Runs");
    });

    test("every section draws from the data", async ({ page }) => {
        await page.goto("/");
        await waitForPlotsToRender(page);
        await expect(page.locator("#over_time_plot .gtitle")).toHaveText("Runs per day");
        await expect(page.locator("#grid_plot .gtitle")).toHaveText("Status per day");
        await expect(page.locator("#durations_plot .gtitle")).toHaveText("Run duration per workflow");
        await expect(page.locator("#status_table tbody tr")).toHaveCount(9);
        await expect(page.locator("#totals td").first()).not.toHaveText("0");
        await expect(page.locator("#data_status")).toHaveText("Data as of 2026-10-17 12:00 UTC (30 minutes ago)");
    });

    test("the repository selector narrows the page and is kept in the URL", async ({ page }) => {
        await page.goto("/");
        await waitForPlotsToRender(page);
        await page.locator("#repository_selector").selectOption("dandi/dandi-archive");
        await expect(page).toHaveURL(/\?repo=dandi%2Fdandi-archive$/);
        await expect(page.locator("#status_table tbody tr")).toHaveCount(2);
        await expect(page.locator("#status_table tbody tr").first()).toContainText("Nightly");
        await expect(page.locator("#status_table tbody tr").first()).toContainText("Failed");
    });

    test("a deep link opens on the view it names", async ({ page }) => {
        await page.goto("/?period=90&over_time=table&status=failing");
        await expect(page.locator("#period_90")).toBeChecked();
        await expect(page.locator("#over_time_table")).toBeVisible();
        await expect(page.locator("#over_time_plot")).toBeHidden();
        await expect(page.locator("#status_table tbody tr")).toHaveCount(1);
    });

    test("tables sort by the column clicked", async ({ page }) => {
        await page.goto("/");
        const runs = page.locator("#status_table tbody td:nth-child(5)");
        await expect(runs).toHaveCount(9);
        await page.locator("#status_table th", { hasText: "Runs" }).click();
        const counts = (await runs.allTextContents()).map(Number);
        expect(counts).toEqual([...counts].sort((a, b) => b - a));
    });

    test("settings panel opens and closes", async ({ page }) => {
        await page.goto("/");
        const settingsPanel = page.locator("#settings_panel");
        await page.locator("#settings_btn").click();
        await expect(settingsPanel).toHaveClass(/open/);
        await page.keyboard.press("Escape");
        await expect(settingsPanel).not.toHaveClass(/open/);
    });

    test("theme toggle switches between dark and light mode", async ({ page }) => {
        await page.goto("/");
        const html = page.locator("html");
        const initialTheme = await html.getAttribute("data-theme");
        const otherTheme = initialTheme === "dark" ? "light" : "dark";

        await page.locator("#theme_toggle_btn").click();
        await expect(html).toHaveAttribute("data-theme", otherTheme);
        await page.locator("#theme_toggle_btn").click();
        await expect(html).toHaveAttribute("data-theme", initialTheme);
    });

    test("the page says so when the data fails to load", async ({ page }) => {
        await page.route("**/data/manifest.json", (route) => route.fulfill({ status: 500, body: "" }));
        await page.goto("/");
        await expect(page.locator("#data_status")).toHaveText("Failed to load the data.");
        await expect(page.locator("#over_time_plot")).toHaveText("Failed to load the data.");
    });
});
