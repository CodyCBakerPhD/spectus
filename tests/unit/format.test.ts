import { describe, expect, it } from "vitest";
import {
    escape_html,
    format_count,
    format_duration,
    format_percent,
    format_relative,
    format_timestamp,
} from "../../src/format.js";

describe("escape_html", () => {
    it("escapes every character that could open markup or close an attribute", () => {
        expect(escape_html(`<a href="x" title='y'>&</a>`)).toBe(
            "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;"
        );
    });
});

describe("format_count", () => {
    it("groups thousands", () => {
        expect(format_count(1234567)).toBe("1,234,567");
        expect(format_count(0)).toBe("0");
    });
});

describe("format_percent", () => {
    it("rounds to one decimal place and drops a trailing zero", () => {
        expect(format_percent(0.8834)).toBe("88.3%");
        expect(format_percent(1)).toBe("100%");
        expect(format_percent(0)).toBe("0%");
    });

    it("shows a dash when there is nothing to divide", () => {
        expect(format_percent(null)).toBe("—");
        expect(format_percent(Number.NaN)).toBe("—");
    });
});

describe("format_duration", () => {
    it.each([
        [0, "0s"],
        [45, "45s"],
        [59.6, "1m"],
        [60, "1m"],
        [200, "3m 20s"],
        [3600, "1h"],
        [3720, "1h 2m"],
        [3601, "1h"],
        [90061, "1d 1h"],
        [86400 * 3 + 59, "3d"],
    ])("formats %s seconds as %s", (seconds, expected) => {
        expect(format_duration(seconds)).toBe(expected);
    });

    it("shows a dash for an unknown duration", () => {
        expect(format_duration(null)).toBe("—");
    });
});

describe("format_timestamp", () => {
    it("writes the UTC minute", () => {
        expect(format_timestamp(new Date("2026-10-17T12:34:56Z"))).toBe("2026-10-17 12:34 UTC");
    });
});

describe("format_relative", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    it.each([
        ["2026-10-17T11:59:30Z", "just now"],
        ["2026-10-17T12:00:30Z", "just now"],
        ["2026-10-17T11:59:00Z", "1 minute ago"],
        ["2026-10-17T11:15:00Z", "45 minutes ago"],
        ["2026-10-17T09:00:00Z", "3 hours ago"],
        ["2026-10-16T12:00:00Z", "1 day ago"],
        ["2026-09-01T12:00:00Z", "1 month ago"],
        ["2024-10-01T12:00:00Z", "2 years ago"],
    ])("says %s was %s", (date, expected) => {
        expect(format_relative(new Date(date), now)).toBe(expected);
    });
});
