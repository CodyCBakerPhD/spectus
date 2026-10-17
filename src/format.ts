/**
 * Text formatting shared by the totals, tables, and hover labels.
 */

const EMPTY = "—";

/** Escapes a string for use as HTML text or an attribute value. */
export function escape_html(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** A whole number with thousands separators, e.g. "12,345". */
export function format_count(value: number): string {
    return value.toLocaleString("en-US");
}

/** A fraction as a percentage to at most one decimal place, e.g. "97.5%"; a dash when there is none. */
export function format_percent(fraction: number | null): string {
    if (fraction === null || !Number.isFinite(fraction)) return EMPTY;
    return `${(Math.round(fraction * 1000) / 10).toLocaleString("en-US")}%`;
}

/** A length of time in seconds, to its two largest units, e.g. "45s", "3m 20s", "1h 5m", "2d 4h". */
export function format_duration(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds)) return EMPTY;
    const total = Math.round(seconds);
    if (total < 60) return `${total}s`;
    const units: Array<[string, number]> = [
        ["d", 86400],
        ["h", 3600],
        ["m", 60],
        ["s", 1],
    ];
    const parts: string[] = [];
    let remainder = total;
    for (const [unit, size] of units) {
        const amount = Math.floor(remainder / size);
        remainder -= amount * size;
        if (amount > 0 || parts.length > 0) parts.push(`${amount}${unit}`);
        if (parts.length === 2) break;
    }
    return parts.filter((part) => !/^0[a-z]$/.test(part)).join(" ");
}

/** A UTC timestamp to the minute, e.g. "2026-10-17 12:34 UTC". */
export function format_timestamp(date: Date): string {
    return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** How long before `now` a moment was, e.g. "just now", "5 minutes ago", "3 days ago". */
export function format_relative(date: Date, now: Date): string {
    const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
    if (seconds < 60) return "just now";
    const units: Array<[string, number]> = [
        ["year", 365 * 86400],
        ["month", 30 * 86400],
        ["day", 86400],
        ["hour", 3600],
        ["minute", 60],
    ];
    for (const [unit, size] of units) {
        const amount = Math.floor(seconds / size);
        if (amount >= 1) return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
    }
    /* c8 ignore next */
    return "just now";
}
