import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build_manifest } from "../src/scripts/build-data.mjs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const ROOT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));

let gitHash = "unknown";
try {
    gitHash = execSync("git rev-parse --short=8 HEAD").toString().trim();
} catch {
    // Not a git repo or git not available; leave as "unknown"
}

/**
 * Serves a local checkout of the `data` branch at `./data/` while developing, as the deploy bundles it into the
 * built site (see src/scripts/build-data.mjs): `git worktree add data-branch data` and `npm run dev`.
 */
function serve_data_branch() {
    const records_dir = resolve(ROOT_DIR, process.env.SPECTUS_DATA_DIR ?? "data-branch", "data");
    return {
        name: "spectus-serve-data-branch",
        configureServer(server) {
            server.middlewares.use("/data", async (request, response, next) => {
                const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
                try {
                    if (path === "/manifest.json") {
                        response.setHeader("Content-Type", "application/json");
                        response.end(JSON.stringify(await build_manifest(records_dir)));
                        return;
                    }
                    const file = normalize(join(records_dir, path));
                    if (!file.startsWith(records_dir) || !file.endsWith(".jsonl")) return next();
                    response.setHeader("Content-Type", "text/plain");
                    response.end(await readFile(file));
                } catch {
                    next();
                }
            });
        },
    };
}

export default defineConfig({
    root: "src",
    publicDir: false,
    base: "./",
    build: {
        outDir: "../dist",
        emptyOutDir: true,
        // Plotly alone is some 4.5 MB minified, and the page has nothing to split off from it
        chunkSizeWarningLimit: 5000,
    },
    plugins: [serve_data_branch()],
    define: {
        __APP_VERSION__: JSON.stringify(version),
        __GIT_HASH__: JSON.stringify(gitHash),
        // Where the source and the data branch are linked to; set by GitHub Actions to the repository it runs in
        __REPOSITORY__: JSON.stringify(process.env.GITHUB_REPOSITORY ?? "con/spectus"),
    },
});
