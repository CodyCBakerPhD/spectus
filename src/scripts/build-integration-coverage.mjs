import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convert } from "ast-v8-to-istanbul";
import istanbulCoverage from "istanbul-lib-coverage";
import istanbulReport from "istanbul-lib-report";
import istanbulReports from "istanbul-reports";
import { parseAstAsync } from "vite";

const { createCoverageMap } = istanbulCoverage;
const { createContext } = istanbulReport;
const reports = istanbulReports;

const ROOT_DIR = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE_DIR = resolve(ROOT_DIR, "src");
const RAW_COVERAGE_DIR = resolve(ROOT_DIR, "coverage", "integration", "raw");
const OUTPUT_DIR = resolve(ROOT_DIR, "coverage", "integration");

// The page's own modules are what the report is about.  Vite serves them from
// the root it is started with (src/, see configs/vite.config.js) by their path
// under it — plots.ts is http://localhost:5173/plots.ts — and transpiles the
// TypeScript on the way out, appending an inline source map back to the file.
// Everything else the page loads lives outside that root: the pre-bundled
// dependencies (/@fs/<absolute path>/node_modules/.vite/deps/...) and Vite's
// own client (/@vite/client), which resolve to nothing under src/.
const SOURCE_EXTENSIONS = new Set([".ts", ".js"]);
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

async function resolveLocalSourcePath(scriptUrl) {
    let url;
    try {
        url = new URL(scriptUrl);
    } catch {
        return null;
    }
    if (!LOCAL_HOSTNAMES.has(url.hostname)) return null;

    // Vite appends a cache-busting query to some URLs (?v=..., ?t=...); the
    // path alone names the file.
    const resolvedPath = resolve(SOURCE_DIR, "." + decodeURIComponent(url.pathname));
    if (!resolvedPath.startsWith(SOURCE_DIR + sep)) return null;
    if (!SOURCE_EXTENSIONS.has(extname(resolvedPath))) return null;

    const isFile = await stat(resolvedPath).then(
        (stats) => stats.isFile(),
        () => false
    );
    return isFile ? resolvedPath : null;
}

const fileNames = await readdir(RAW_COVERAGE_DIR).catch(() => []);
const coverageMap = createCoverageMap({});

for (const fileName of fileNames) {
    const filePath = resolve(RAW_COVERAGE_DIR, fileName);
    const rawContent = await readFile(filePath, "utf-8");
    const entries = JSON.parse(rawContent);

    for (const entry of entries) {
        const sourcePath = await resolveLocalSourcePath(entry.url);
        if (!sourcePath || typeof entry.source !== "string") continue;

        // `entry.source` is the module as the browser ran it, transpiled, with
        // Vite's inline source map at its end; the converter reads that map,
        // so the coverage is reported against the TypeScript rather than
        // against the JavaScript it was compiled to.
        const converted = await convert({
            ast: await parseAstAsync(entry.source),
            code: entry.source,
            wrapperLength: 0,
            coverage: {
                url: pathToFileURL(sourcePath).href,
                functions: entry.functions,
            },
        });

        coverageMap.merge(converted);
    }
}

if (coverageMap.files().length === 0) {
    throw new Error(
        "No Playwright integration coverage data was collected. Ensure PW_COVERAGE=1 is set and integration tests completed successfully."
    );
}

await mkdir(OUTPUT_DIR, { recursive: true });
const context = createContext({ dir: OUTPUT_DIR, coverageMap });
reports.create("lcovonly", { file: "lcov.info" }).execute(context);
reports.create("text-summary").execute(context);
