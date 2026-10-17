/**
 * Loading the workflow run records the site is built with.
 *
 * The deploy copies the `data` branch's `data/{owner}/{repository}/{YYYYMM}.jsonl` files beside the page and adds
 * `data/manifest.json`, which lists the months each repository has records for and when the data was bundled (see
 * src/scripts/build-data.mjs).  Each line of a file is an object whose only key is the minute the run was created and
 * whose value is the record, as described by schemas/workflow_run.yaml.
 */

/** One workflow run, as recorded on the `data` branch. */
export interface WorkflowRun {
    id: number;
    repository: string;
    workflow_name: string;
    workflow_path: string | null;
    run_number: number;
    event: string;
    status: string;
    conclusion: string | null;
    created_at: string;
    updated_at: string;
    started_at: string | null;
    completed_at: string | null;
    duration_seconds: number | null;
    head_branch: string | null;
    head_sha: string;
    actor: string | null;
    url: string;
}

export interface Manifest {
    /** When the data was bundled into the site, which is where the page's time window ends. */
    generated_at: string;
    /** The months (`YYYYMM`) each repository (`owner/name`) has records for. */
    repositories: Record<string, string[]>;
}

/** Where the bundled data is served, relative to the page. */
export const DATA_URL = "./data";

/** Reads the records out of the text of a `.jsonl` file, skipping blank lines. */
export function parse_jsonl(text: string): WorkflowRun[] {
    const runs: WorkflowRun[] = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as Record<string, WorkflowRun>;
        const values = Object.values(entry);
        if (values.length !== 1) throw new Error(`Expected one record per line, got: ${line.slice(0, 200)}`);
        runs.push(values[0]);
    }
    return runs;
}

/** The months (`YYYYMM`, UTC) from the one holding `start` to the one holding `end`, oldest first. */
export function months_between(start: Date, end: Date): string[] {
    const months: string[] = [];
    let year = start.getUTCFullYear();
    let month = start.getUTCMonth();
    while (year < end.getUTCFullYear() || (year === end.getUTCFullYear() && month <= end.getUTCMonth())) {
        months.push(`${year}${String(month + 1).padStart(2, "0")}`);
        month += 1;
        if (month === 12) {
            month = 0;
            year += 1;
        }
    }
    return months;
}

/**
 * The repositories a selection covers: "all", an owner (every repository of that owner), or one `owner/name`.
 * A selection the manifest does not know covers nothing.
 */
export function select_repositories(manifest: Manifest, selection: string): string[] {
    const repositories = Object.keys(manifest.repositories).sort((a, b) => a.localeCompare(b));
    if (selection === "all") return repositories;
    if (selection.includes("/")) return repositories.filter((repository) => repository === selection);
    return repositories.filter((repository) => repository.split("/")[0] === selection);
}

/** The data files (`owner/name/YYYYMM.jsonl`) holding the runs of some repositories created in some months. */
export function data_files(manifest: Manifest, repositories: string[], months: string[]): string[] {
    const wanted = new Set(months);
    return repositories.flatMap((repository) =>
        (manifest.repositories[repository] ?? [])
            .filter((month) => wanted.has(month))
            .map((month) => `${repository}/${month}.jsonl`)
    );
}

/**
 * Each run once, in its latest recorded state.  A run that was re-run after it was first recorded is recorded again,
 * with a later `updated_at`; the earlier record is history, not another run.
 */
export function latest_records(runs: WorkflowRun[]): WorkflowRun[] {
    const latest = new Map<number, WorkflowRun>();
    for (const run of runs) {
        const previous = latest.get(run.id);
        if (!previous || run.updated_at > previous.updated_at) latest.set(run.id, run);
    }
    return Array.from(latest.values());
}

type Fetcher = (url: string) => Promise<Response>;

/** Fetches the manifest and data files, each file at most once, a few at a time. */
export class RunLoader {
    private readonly files = new Map<string, Promise<WorkflowRun[]>>();

    constructor(
        private readonly fetcher: Fetcher = (url) => fetch(url),
        private readonly base_url: string = DATA_URL,
        private readonly concurrency = 6
    ) {}

    /** The manifest of the bundled data. */
    async manifest(): Promise<Manifest> {
        const response = await this.fetcher(`${this.base_url}/manifest.json`);
        if (!response.ok) throw new Error(`Failed to load the data manifest (${response.status})`);
        return (await response.json()) as Manifest;
    }

    /** The records of the given data files, in no particular order. */
    async load(paths: string[]): Promise<WorkflowRun[]> {
        const results: WorkflowRun[][] = [];
        const queue = [...paths];
        const worker = async () => {
            for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
                results.push(await this.load_file(path));
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.concurrency, paths.length) }, worker));
        return results.flat();
    }

    private load_file(path: string): Promise<WorkflowRun[]> {
        let file = this.files.get(path);
        if (!file) {
            file = this.fetcher(`${this.base_url}/${path}`).then(async (response) => {
                if (!response.ok) throw new Error(`Failed to load ${path} (${response.status})`);
                return parse_jsonl(await response.text());
            });
            // A failed file is fetched again next time rather than remembered as failed.
            file.catch(() => this.files.delete(path));
            this.files.set(path, file);
        }
        return file;
    }
}
