/**
 * Harness for exercising src/main.ts — the page's entry module — the way the browser does.
 *
 * The module has no exports: everything it does, it does on import and in response to events.  So it is imported
 * into a jsdom document holding the body of index.html, its DOMContentLoaded and load handlers are fired, and the
 * page is then driven through its controls.  Plotly is replaced by a recording stub (there is no layout to draw into
 * here) and fetch by a router over the same fixture data the Playwright suites mock the network with, so what is
 * asserted on is what the module hands Plotly and writes into the DOM.
 */

import { expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_FILES, MANIFEST } from "../fixtures/mock-data.js";

// ── Plotly stub ──────────────────────────────────────────────────────────────

/** What the stub's newPlot records on the graph div, as Plotly's does. */
export interface PlotElement extends HTMLElement {
    data: any[];
    layout: any;
    config: any;
}

/** What the stub does for Plotly.newPlot: records the call on the graph div. */
export async function draw_plot(target: string | HTMLElement, data: any[], layout: any, config: any): Promise<void> {
    const element = (typeof target === "string" ? document.getElementById(target) : target) as PlotElement | null;
    if (!element) throw new Error(`No element to plot into: ${String(target)}`);
    element.data = data;
    element.layout = layout;
    element.config = config;
    element.classList.add("js-plotly-plot");
}

function make_plotly_stub() {
    return {
        newPlot: vi.fn(draw_plot),
        purge: vi.fn((element: HTMLElement) => element.classList.remove("js-plotly-plot")),
    };
}

/**
 * Where the stub is kept for the `vi.mock("plotly.js-dist-min")` factory of each test file to hand to the page.  The
 * factory cannot import it from here: loading the page resets the module registry, so the import would evaluate this
 * module a second time and hand the page a second stub, one the tests never see.  A global survives the reset.
 */
export const PLOTLY_STUB_GLOBAL = "__page_harness_plotly__";

export const plotly: ReturnType<typeof make_plotly_stub> = ((globalThis as any)[PLOTLY_STUB_GLOBAL] ??=
    make_plotly_stub());

/** Every newPlot call drawn into the element with this id, oldest first. */
export function plot_calls(id: string): Array<[HTMLElement, any[], any, any]> {
    return plotly.newPlot.mock.calls.filter(([target]) => (target as HTMLElement).id === id) as Array<
        [HTMLElement, any[], any, any]
    >;
}

/** The most recent newPlot call drawn into the element with this id. */
export function last_plot(id: string): { data: any[]; layout: any; config: any } {
    const calls = plot_calls(id);
    expect(calls.length, `plots drawn into #${id}`).toBeGreaterThan(0);
    const [, data, layout, config] = calls[calls.length - 1];
    return { data, layout, config };
}

// ── Fetch router ─────────────────────────────────────────────────────────────

type Responder = (url: string) => Response;
type Route = [matches: (url: string) => boolean, respond: Responder];

export const ok = (body: string): Response => new Response(body, { status: 200, statusText: "OK" });
export const not_found = (): Response => new Response("", { status: 404, statusText: "Not Found" });

const data_path = (url: string): string => url.slice("./data/".length);

function default_routes(): Route[] {
    return [
        [(url) => url === "./data/manifest.json", () => ok(JSON.stringify(MANIFEST))],
        [
            (url) => url.startsWith("./data/") && data_path(url) in DATA_FILES,
            (url) => ok(DATA_FILES[data_path(url) as keyof typeof DATA_FILES]),
        ],
    ];
}

let routes: Route[] = [];
let in_flight = 0;

/**
 * Serves `body` for every URL matching `pattern` from now on, ahead of the defaults and of earlier overrides.  A
 * string pattern matches a URL ending with it; a 404 is served by passing `not_found`.
 */
export function serve(pattern: string | RegExp, body: string | Responder): void {
    const matches =
        typeof pattern === "string" ? (url: string) => url.endsWith(pattern) : (url: string) => pattern.test(url);
    const respond: Responder = typeof body === "string" ? () => ok(body) : body;
    routes.unshift([matches, respond]);
}

export const fetch_mock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    in_flight += 1;
    try {
        const route = routes.find(([matches]) => matches(url));
        return route ? route[1](url) : not_found();
    } finally {
        in_flight -= 1;
    }
});

/** The URLs fetched so far, in order. */
export function fetched_urls(): string[] {
    return fetch_mock.mock.calls.map(([input]) => String(input));
}

/**
 * Resolves once the page has gone quiet: no fetch has been in flight for a number of consecutive turns of the event
 * loop.  Each response is consumed and rendered in microtasks, which one turn drains.
 */
export async function settle(): Promise<void> {
    for (let quiet = 0; quiet < 10;) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        quiet = in_flight === 0 ? quiet + 1 : 0;
    }
}

// ── The page ─────────────────────────────────────────────────────────────────

export const BODY_HTML = readFileSync(resolve(__dirname, "../../src/index.html"), "utf8").match(
    /<body[^>]*>([\s\S]*)<\/body>/i
)![1];

export interface PageOptions {
    /** The address the page is opened at, e.g. "/?period=90#status". */
    url?: string;
    /** A theme stored from an earlier visit. */
    theme?: "dark" | "light";
    /** The browser's own preference, offered through matchMedia; absent by default, as in jsdom. */
    prefers_dark?: boolean;
}

/** The fake MediaQueryList the last page was given, if any. */
export let media_query: { fire: (matches: boolean) => void } | null = null;

function install_media_query(matches: boolean): void {
    let listener: ((event: { matches: boolean }) => void) | null = null;
    const list = {
        matches,
        addEventListener: (_type: string, handler: (event: { matches: boolean }) => void) => {
            listener = handler;
        },
    };
    media_query = {
        fire: (now_matches: boolean) => {
            list.matches = now_matches;
            listener?.({ matches: now_matches });
        },
    };
    vi.stubGlobal(
        "matchMedia",
        vi.fn(() => list)
    );
}

// Listeners the module registers on the document and window would otherwise outlive the test that loaded it and
// fire again, with that instance's own state, on every later page; they are recorded here and removed after each.
const tracked: Array<
    [EventTarget, string, EventListenerOrEventListenerObject, AddEventListenerOptions | boolean | undefined]
> = [];
const patched: Array<() => void> = [];

function track_listeners(target: EventTarget): void {
    const original = target.addEventListener;
    Object.defineProperty(target, "addEventListener", {
        configurable: true,
        writable: true,
        value(
            this: EventTarget,
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: AddEventListenerOptions | boolean
        ) {
            tracked.push([target, type, listener, options]);
            return original.call(this, type, listener, options);
        },
    });
    patched.push(() =>
        Object.defineProperty(target, "addEventListener", { configurable: true, writable: true, value: original })
    );
}

/** Everything `scrollIntoView` was asked to do. */
export const scrolled_to = vi.fn<(this: Element, options?: unknown) => void>();

/** Installs what jsdom lacks and the page relies on.  Call once per file. */
export function install_environment(): void {
    // Nor does jsdom lay anything out: a plot measures as wide as the page says it is (data-mock-width), 1000 px by
    // default, and 0 when hidden.
    const hidden = (element: HTMLElement) => element.style.display === "none" || !element.isConnected;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
        configurable: true,
        get(this: HTMLElement) {
            return hidden(this) ? 0 : Number(this.dataset.mockWidth ?? 1000);
        },
    });
    Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
        scrolled_to.call(this, options);
    } as any;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
    }) as any;
    Object.assign(globalThis, {
        __APP_VERSION__: "1.2.3",
        __GIT_HASH__: "abcdef12",
        __REPOSITORY__: "con/spectus",
    });
}

/** Resets the routes, stubs and spies before a test.  Call from beforeEach. */
export function before_each(): void {
    routes = default_routes();
    in_flight = 0;
    media_query = null;
    fetch_mock.mockClear();
    plotly.newPlot.mockReset();
    plotly.newPlot.mockImplementation(draw_plot);
    plotly.purge.mockClear();
    scrolled_to.mockClear();
    vi.stubGlobal("fetch", fetch_mock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    track_listeners(document);
    track_listeners(window);
}

/** Drains the page's pending work and removes what the test left behind. */
export async function after_each(): Promise<void> {
    await settle();
    tracked
        .splice(0)
        .forEach(([target, type, listener, options]) => target.removeEventListener(type, listener, options));
    patched.splice(0).forEach((restore) => restore());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
}

/**
 * Opens the page: a fresh instance of src/main.ts against a fresh copy of the markup, with the load-time events
 * fired, and waits for it to render.
 */
export async function load_page({ url = "/", theme, prefers_dark }: PageOptions = {}): Promise<void> {
    window.history.replaceState({}, "", url);
    localStorage.clear();
    if (theme) localStorage.setItem("theme", theme);
    if (prefers_dark !== undefined) install_media_query(prefers_dark);
    document.documentElement.classList.add("preload");
    document.documentElement.removeAttribute("data-theme");
    document.body.innerHTML = BODY_HTML;

    vi.resetModules();
    await import("../../src/main.js");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    window.dispatchEvent(new Event("load"));
    await settle();
}

// ── Driving the page ─────────────────────────────────────────────────────────

export const by_id = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = document.getElementById(id) as T | null;
    expect(element, `#${id}`).not.toBeNull();
    return element!;
};

export const query = <T extends Element = HTMLElement>(selector: string): T => {
    const element = document.querySelector(selector) as T | null;
    expect(element, selector).not.toBeNull();
    return element!;
};

/** Sets a select's value and fires its change event. */
export function change(id: string, value: string): void {
    const element = by_id<HTMLSelectElement | HTMLInputElement>(id);
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Checks or unchecks a checkbox and fires its change event. */
export function check(id: string, checked: boolean): void {
    const element = by_id<HTMLInputElement>(id);
    element.checked = checked;
    element.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Selects one radio button of a group and fires its change event. */
export function choose(name: string, value: string): void {
    const radio = query<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The page's current URL parameters. */
export const url_params = (): URLSearchParams => new URLSearchParams(window.location.search);

/** The text of a table's column headers, sort indicators stripped. */
export function table_headers(container_id: string): string[] {
    return Array.from(document.querySelectorAll(`#${container_id} th`)).map((th) =>
        th.textContent!.replace(/[▲▼⇅]/g, "").trim()
    );
}

/** The text of a table's cells, row by row. */
export function table_rows(container_id: string): string[][] {
    return Array.from(document.querySelectorAll(`#${container_id} tbody tr`)).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => td.textContent!)
    );
}

/** The labels and values of the totals summary, in order. */
export function totals(): Array<[string, string]> {
    return Array.from(document.querySelectorAll("#totals tbody tr")).map((tr) => [
        tr.querySelector("th")!.textContent!.replace(/\s*i$/, "").trim(),
        tr.querySelector("td")!.textContent!,
    ]);
}
