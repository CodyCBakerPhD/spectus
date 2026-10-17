// @vitest-environment node
// The script reads and writes the file system, which is all it is tested against here.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build_manifest, bundle_data } from "../../src/scripts/build-data.mjs";

let root;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spectus-build-data-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function write(path, text = '{"2026-10-01T00:00":{"id":1}}\n') {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
}

describe("build_manifest", () => {
    it("lists each repository's months, sorted, ignoring anything that is not a month's records", async () => {
        await write("branch/data/dandi/dandi-cli/202610.jsonl");
        await write("branch/data/dandi/dandi-cli/202609.jsonl");
        await write("branch/data/dandi/dandi-cli/notes.txt");
        await write("branch/data/con/spectus/202610.jsonl");
        await mkdir(join(root, "branch/data/con/empty"), { recursive: true });
        await write("branch/data/stray.jsonl");

        const manifest = await build_manifest(join(root, "branch/data"), new Date("2026-10-17T12:00:00.123Z"));
        expect(manifest).toEqual({
            generated_at: "2026-10-17T12:00:00Z",
            repositories: {
                "con/spectus": ["202610"],
                "dandi/dandi-cli": ["202609", "202610"],
            },
        });
        expect(Object.keys(manifest.repositories)).toEqual(["con/spectus", "dandi/dandi-cli"]);
    });

    it("lists nothing without a checkout", async () => {
        expect((await build_manifest(join(root, "missing"))).repositories).toEqual({});
    });
});

describe("bundle_data", () => {
    it("copies the records beside the manifest", async () => {
        await write("branch/data/con/spectus/202610.jsonl", "records\n");
        const output = join(root, "dist/data");
        await bundle_data(join(root, "branch"), output);

        expect(await readFile(join(output, "con/spectus/202610.jsonl"), "utf8")).toBe("records\n");
        const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
        expect(manifest.repositories).toEqual({ "con/spectus": ["202610"] });
    });

    it("writes an empty manifest without a checkout", async () => {
        const output = join(root, "dist/data");
        await bundle_data(join(root, "missing"), output);
        expect(existsSync(join(output, "manifest.json"))).toBe(true);
    });
});
