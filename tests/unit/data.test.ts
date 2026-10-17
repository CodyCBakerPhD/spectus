import { describe, expect, it, vi } from "vitest";
import {
    data_files,
    latest_records,
    type Manifest,
    months_between,
    parse_jsonl,
    RunLoader,
    select_repositories,
    type WorkflowRun,
} from "../../src/data.js";
import { DATA_FILES, MANIFEST, RERUN_ID } from "../fixtures/mock-data.js";

const manifest: Manifest = {
    generated_at: "2026-10-17T12:00:00Z",
    repositories: {
        "dandi/dandi-cli": ["202609", "202610"],
        "con/spectus": ["202608", "202610"],
        "con/datalad": ["202610"],
    },
};

describe("parse_jsonl", () => {
    it("reads the record out of each line, skipping blank ones", () => {
        const text = '{"2026-10-01T00:00":{"id":1}}\n\n{"2026-10-02T00:00":{"id":2}}\n';
        expect(parse_jsonl(text).map((run) => run.id)).toEqual([1, 2]);
    });

    it("rejects a line holding anything but one record", () => {
        expect(() => parse_jsonl('{"a":{"id":1},"b":{"id":2}}')).toThrow("one record per line");
    });

    it("reads every fixture file", () => {
        const runs = Object.values(DATA_FILES).flatMap((text) => parse_jsonl(text));
        expect(runs.length).toBeGreaterThan(1000);
    });
});

describe("months_between", () => {
    it("lists every month from the start's to the end's", () => {
        expect(months_between(new Date("2026-08-31T23:00:00Z"), new Date("2026-10-01T00:00:00Z"))).toEqual([
            "202608",
            "202609",
            "202610",
        ]);
    });

    it("crosses a year", () => {
        expect(months_between(new Date("2025-11-15Z"), new Date("2026-01-15Z"))).toEqual([
            "202511",
            "202512",
            "202601",
        ]);
    });

    it("is a single month when both ends fall in it", () => {
        expect(months_between(new Date("2026-10-01Z"), new Date("2026-10-31Z"))).toEqual(["202610"]);
    });
});

describe("select_repositories", () => {
    it("covers everything, an owner's repositories, or one repository", () => {
        expect(select_repositories(manifest, "all")).toEqual(["con/datalad", "con/spectus", "dandi/dandi-cli"]);
        expect(select_repositories(manifest, "con")).toEqual(["con/datalad", "con/spectus"]);
        expect(select_repositories(manifest, "con/spectus")).toEqual(["con/spectus"]);
    });

    it("covers nothing for an unknown selection", () => {
        expect(select_repositories(manifest, "nobody")).toEqual([]);
        expect(select_repositories(manifest, "con/nothing")).toEqual([]);
    });
});

describe("data_files", () => {
    it("lists only the months each repository has", () => {
        expect(data_files(manifest, ["con/spectus", "dandi/dandi-cli", "con/unknown"], ["202609", "202610"])).toEqual([
            "con/spectus/202610.jsonl",
            "dandi/dandi-cli/202609.jsonl",
            "dandi/dandi-cli/202610.jsonl",
        ]);
    });
});

describe("latest_records", () => {
    it("keeps each run once, in its most recently updated state", () => {
        const runs = Object.values(DATA_FILES).flatMap((text) => parse_jsonl(text));
        const latest = latest_records(runs);
        expect(latest.length).toBe(runs.length - 1);
        const rerun = latest.filter((run) => run.id === RERUN_ID);
        expect(rerun.map((run) => run.conclusion)).toEqual(["success"]);
    });

    it("keeps the later record whichever order they come in", () => {
        const older = { id: 1, updated_at: "2026-10-01T00:00:00Z", conclusion: "failure" } as WorkflowRun;
        const newer = { id: 1, updated_at: "2026-10-02T00:00:00Z", conclusion: "success" } as WorkflowRun;
        expect(latest_records([newer, older])).toEqual([newer]);
        expect(latest_records([older, newer])).toEqual([newer]);
    });
});

describe("RunLoader", () => {
    const respond = (url: string): Promise<Response> => {
        if (url === "./data/manifest.json") return Promise.resolve(new Response(JSON.stringify(MANIFEST)));
        const text = DATA_FILES[url.slice("./data/".length) as keyof typeof DATA_FILES];
        return Promise.resolve(text ? new Response(text) : new Response("", { status: 404 }));
    };

    it("loads the manifest", async () => {
        expect(await new RunLoader(respond).manifest()).toEqual(MANIFEST);
    });

    it("reports a manifest that failed to load", async () => {
        const loader = new RunLoader(async () => new Response("", { status: 500 }));
        await expect(loader.manifest()).rejects.toThrow("(500)");
    });

    it("loads each file once, however often it is asked for", async () => {
        const fetcher = vi.fn(respond);
        const loader = new RunLoader(fetcher, "./data", 2);
        const paths = ["con/spectus/202609.jsonl", "con/spectus/202610.jsonl", "dandi/dandi-cli/202610.jsonl"];
        const first = await loader.load(paths);
        const second = await loader.load(paths.slice(0, 1));
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(first.length).toBeGreaterThan(second.length);
        expect(await loader.load([])).toEqual([]);
    });

    it("fetches a file that failed again next time", async () => {
        let fail = true;
        const fetcher = vi.fn(async (url: string) => (fail ? new Response("", { status: 503 }) : respond(url)));
        const loader = new RunLoader(fetcher);
        await expect(loader.load(["con/spectus/202610.jsonl"])).rejects.toThrow("con/spectus/202610.jsonl (503)");
        fail = false;
        expect((await loader.load(["con/spectus/202610.jsonl"])).length).toBeGreaterThan(0);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
