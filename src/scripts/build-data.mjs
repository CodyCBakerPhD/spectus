/**
 * Bundles the workflow run records of the `data` branch into the built site.
 *
 * Copies every `data/{owner}/{repository}/{YYYYMM}.jsonl` of a checkout of the `data` branch to `dist/data/`, and
 * writes `dist/data/manifest.json` beside them: the months each repository has records for, and when the data was
 * bundled, which is where the page's time window ends.  Without a checkout, the manifest lists no repositories and
 * the page says that nothing has been recorded yet.
 *
 *     SPECTUS_DATA_DIR=data-branch node src/scripts/build-data.mjs
 *
 * The checkout defaults to `data-branch/` at the root of the repository.
 */

import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const MONTH_FILE = /^\d{6}\.jsonl$/;

/** Lists the months each repository has records for, under the `data/` directory of a checkout. */
export async function build_manifest(records_dir, generated_at = new Date()) {
    const repositories = {};
    if (existsSync(records_dir)) {
        for (const owner of (await readdir(records_dir, { withFileTypes: true })).filter((entry) =>
            entry.isDirectory()
        )) {
            const owner_dir = join(records_dir, owner.name);
            for (const repository of (await readdir(owner_dir, { withFileTypes: true })).filter((entry) =>
                entry.isDirectory()
            )) {
                const months = (await readdir(join(owner_dir, repository.name)))
                    .filter((name) => MONTH_FILE.test(name))
                    .map((name) => name.slice(0, 6))
                    .sort();
                if (months.length) repositories[`${owner.name}/${repository.name}`] = months;
            }
        }
    }
    const sorted = Object.fromEntries(Object.entries(repositories).sort(([a], [b]) => a.localeCompare(b)));
    return { generated_at: generated_at.toISOString().replace(/\.\d{3}Z$/, "Z"), repositories: sorted };
}

/** Copies the records of a checkout of the `data` branch into `output_dir`, with their manifest. */
export async function bundle_data(data_branch_dir, output_dir) {
    const records_dir = join(data_branch_dir, "data");
    const manifest = await build_manifest(records_dir);
    for (const [repository, months] of Object.entries(manifest.repositories)) {
        for (const month of months) {
            const target = join(output_dir, repository, `${month}.jsonl`);
            await mkdir(dirname(target), { recursive: true });
            await copyFile(join(records_dir, repository, `${month}.jsonl`), target);
        }
    }
    await mkdir(output_dir, { recursive: true });
    await writeFile(join(output_dir, "manifest.json"), JSON.stringify(manifest, null, 4) + "\n");
    return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const data_branch_dir = resolve(ROOT_DIR, process.env.SPECTUS_DATA_DIR ?? "data-branch");
    const manifest = await bundle_data(data_branch_dir, resolve(ROOT_DIR, "dist", "data"));
    const count = Object.keys(manifest.repositories).length;
    console.log(`Bundled the records of ${count} repositories from ${data_branch_dir}`);
}
