import { describe, expect, it } from "vitest";
import { buildDefaultRules, DEFAULT_MUTED_DOMAINS } from "../src/core/defaults";
import { findDuplicateRule, findMatchingRules, sanitizeRules } from "../src/core/rules";

describe("default rules", () => {
  let n = 0;
  const rules = buildDefaultRules(() => `d${n++}`);

  it("are enabled, normalized domain rules including subdomains", () => {
    expect(rules.map((r) => r.value)).toEqual(["youtube.com", "x.com", "facebook.com", "threads.com", "instagram.com"]);
    expect(rules.every((r) => r.enabled && r.type === "domain" && r.includeSubdomains)).toBe(true);
    expect(sanitizeRules(rules)).toEqual(rules);
    expect(new Set(rules.map((r) => r.id)).size).toBe(DEFAULT_MUTED_DOMAINS.length);
  });

  it("contain no duplicates", () => {
    rules.forEach((rule) => expect(findDuplicateRule(rules, rule, rule.id)).toBeUndefined());
  });

  it.each([
    "https://www.youtube.com/watch?v=1",
    "https://m.youtube.com/",
    "https://x.com/home",
    "https://www.facebook.com/",
    "https://www.threads.com/@someone",
    "https://www.instagram.com/reels/",
  ])("match %s", (url) => {
    expect(findMatchingRules(rules, url)).toHaveLength(1);
  });

  it.each(["https://notyoutube.com/", "https://youtube.com.evil.test/", "https://box.com/", "https://threads.net/"])(
    "do not match %s",
    (url) => {
      expect(findMatchingRules(rules, url)).toEqual([]);
    },
  );
});
