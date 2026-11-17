import { describe, expect, it } from "vitest";
import {
  buildRuleDraft,
  findDuplicateRule,
  findMatchingRules,
  getHostname,
  hostnameMatchesDomain,
  isSupportedUrl,
  normalizeDomainInput,
  normalizeUrlPrefixInput,
  ruleMatchesUrl,
  rulesEquivalent,
  sanitizeRules,
  shouldAutoMute,
} from "../src/core/rules";
import type { Rule } from "../src/core/types";

let nextId = 0;
function domainRule(value: string, includeSubdomains = false, enabled = true): Rule {
  return { id: `r${nextId++}`, type: "domain", value, includeSubdomains, enabled };
}
function prefixRule(value: string, enabled = true): Rule {
  return { id: `r${nextId++}`, type: "url-prefix", value, includeSubdomains: false, enabled };
}
const matches = (rule: Rule, url: string) => ruleMatchesUrl(rule, url);

describe("domain rules: exact match and subdomain toggle", () => {
  const exact = domainRule("example.com");
  const withSubs = domainRule("example.com", true);

  it("matches only the exact hostname by default", () => {
    expect(matches(exact, "https://example.com/")).toBe(true);
    expect(matches(exact, "http://example.com/any/path?q=1#x")).toBe(true);
    expect(matches(exact, "https://example.com:8443/")).toBe(true);
    expect(matches(exact, "https://www.example.com/")).toBe(false);
    expect(matches(exact, "https://a.example.com/")).toBe(false);
  });

  it("matches subdomains when includeSubdomains is on", () => {
    expect(matches(withSubs, "https://example.com/")).toBe(true);
    expect(matches(withSubs, "https://www.example.com/")).toBe(true);
    expect(matches(withSubs, "https://a.example.com/")).toBe(true);
    expect(matches(withSubs, "https://deep.a.example.com/")).toBe(true);
  });

  it("matches hostnames with different case and a trailing dot", () => {
    expect(matches(exact, "https://EXAMPLE.com./")).toBe(true);
    expect(matches(withSubs, "https://WWW.Example.COM./x")).toBe(true);
  });
});

describe("domain rules: lookalike hostnames are rejected", () => {
  const rules = [domainRule("example.com"), domainRule("example.com", true)];
  const evil = [
    "https://notexample.com/",
    "https://example.com.evil.test/",
    "https://www.example.com.evil.test/",
    "https://example.co/",
    "https://xample.com/",
    "https://example.com-evil.test/",
    "https://evil.test/example.com",
    "https://evil.test/?u=https://example.com",
    "https://example.com@evil.test/",
    "https://evil-example.com/",
    "https://aexample.com/",
  ];
  for (const url of evil) {
    it(`never matches ${url}`, () => {
      for (const rule of rules) expect(matches(rule, url)).toBe(false);
    });
  }

  it("uses label boundaries, not substring checks", () => {
    expect(hostnameMatchesDomain("notexample.com", "example.com", true)).toBe(false);
    expect(hostnameMatchesDomain("a.example.com", "example.com", true)).toBe(true);
    expect(hostnameMatchesDomain("example.com", "", true)).toBe(false);
  });
});

describe("normalizeDomainInput", () => {
  it.each([
    ["example.com", "example.com"],
    ["  Example.COM  ", "example.com"],
    ["example.com.", "example.com"],
    ["EXAMPLE.com..", "example.com"],
    ["sub.example.co.uk", "sub.example.co.uk"],
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["bücher.de", "xn--bcher-kva.de"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeDomainInput(input)).toEqual({ ok: true, value: expected });
  });

  it("extracts the hostname from a pasted http(s) URL", () => {
    const result = normalizeDomainInput(" https://WWW.Example.com./news/1?x=1#top ");
    expect(result).toMatchObject({ ok: true, value: "www.example.com" });
    expect(result.ok && result.notice).toContain("www.example.com");
    const withPort = normalizeDomainInput("http://example.com:8080/");
    expect(withPort).toMatchObject({ ok: true, value: "example.com" });
    expect(withPort.ok && withPort.notice).toMatch(/port is ignored/i);
  });

  it.each([
    "",
    "   ",
    "example.com/path",
    "example.com/",
    "example.com?x=1",
    "example.com#x",
    "example.com:8080",
    "user@example.com",
    "exa mple.com",
    "*.example.com",
    "example..com",
    ".example.com",
    "ftp://example.com/",
    "file:///etc/hosts",
    "javascript://example.com",
    "chrome://settings",
    "[::1]",
    "exa$mple.com",
    "https://example.com@evil.test/",
    "https://user:pw@example.com/",
    "https://./",
  ])("rejects %j", (input) => {
    expect(normalizeDomainInput(input).ok).toBe(false);
  });
});

describe("URL-prefix rules", () => {
  it("normalizes and strips query string and fragment", () => {
    expect(normalizeUrlPrefixInput("https://Example.com/news")).toEqual({ ok: true, value: "https://example.com/news" });
    expect(normalizeUrlPrefixInput("https://example.com")).toEqual({ ok: true, value: "https://example.com/" });
    expect(normalizeUrlPrefixInput("https://example.com:443/a")).toEqual({ ok: true, value: "https://example.com/a" });
    expect(normalizeUrlPrefixInput("https://example.com./a")).toEqual({ ok: true, value: "https://example.com/a" });
    const withQuery = normalizeUrlPrefixInput("https://example.com/news?page=2#top");
    expect(withQuery).toMatchObject({ ok: true, value: "https://example.com/news" });
    expect(withQuery.ok && withQuery.notice).toMatch(/query string and fragment/i);
  });

  it.each(["example.com/news", "/news", "ftp://example.com/news", "https://user:pw@example.com/", "https://", "", "chrome://settings/", "https://./a", "https://.../a"])(
    "rejects %j",
    (input) => {
      expect(normalizeUrlPrefixInput(input).ok).toBe(false);
    },
  );

  const news = prefixRule("https://example.com/news");
  const newsDir = prefixRule("https://example.com/news/");

  it("matches the pathname prefix including /newsletter", () => {
    expect(matches(news, "https://example.com/news")).toBe(true);
    expect(matches(news, "https://example.com/news/123")).toBe(true);
    expect(matches(news, "https://example.com/newsletter")).toBe(true);
    expect(matches(news, "https://example.com/")).toBe(false);
    expect(matches(news, "https://example.com/other/news")).toBe(false);
  });

  it("a trailing slash restricts to the directory", () => {
    expect(matches(newsDir, "https://example.com/news/123")).toBe(true);
    expect(matches(newsDir, "https://example.com/news/")).toBe(true);
    expect(matches(newsDir, "https://example.com/newsletter")).toBe(false);
    expect(matches(newsDir, "https://example.com/news")).toBe(false);
  });

  it("is case-sensitive in the pathname but not in the host", () => {
    expect(matches(news, "https://example.com/News")).toBe(false);
    expect(matches(news, "https://EXAMPLE.COM/news")).toBe(true);
  });

  it("requires an exact origin", () => {
    expect(matches(news, "http://example.com/news")).toBe(false);
    expect(matches(news, "https://www.example.com/news")).toBe(false);
    expect(matches(news, "https://example.com:8443/news")).toBe(false);
    expect(matches(news, "https://example.com:443/news")).toBe(true);
    expect(matches(news, "https://example.com.evil.test/news")).toBe(false);
    expect(matches(news, "https://example.com@evil.test/news")).toBe(false);
    expect(matches(news, "https://evil.test/https://example.com/news")).toBe(false);
  });

  it("ignores query strings and fragments of the tab URL", () => {
    expect(matches(news, "https://example.com/news?x=1#frag")).toBe(true);
    expect(matches(news, "https://example.com/?next=/news")).toBe(false);
    expect(matches(news, "https://example.com/#/news")).toBe(false);
  });
});

describe("enabled flag and global switch", () => {
  const enabled = domainRule("example.com");
  const disabled = domainRule("muted.test", false, false);

  it("disabled rules never match", () => {
    expect(findMatchingRules([disabled], "https://muted.test/")).toEqual([]);
    expect(findMatchingRules([enabled, disabled], "https://example.com/")).toEqual([enabled]);
  });

  it("any one matching enabled rule is enough", () => {
    const rules = [domainRule("other.test"), prefixRule("https://example.com/a"), enabled];
    expect(findMatchingRules(rules, "https://example.com/a/b")).toHaveLength(2);
  });

  it("the global off switch disables automatic muting", () => {
    expect(shouldAutoMute([enabled], true, "https://example.com/")).toBe(true);
    expect(shouldAutoMute([enabled], false, "https://example.com/")).toBe(false);
    expect(shouldAutoMute([disabled], true, "https://muted.test/")).toBe(false);
  });

  it("only http(s) URLs are supported", () => {
    const all = [domainRule("example.com", true)];
    for (const url of ["chrome://settings", "file:///tmp/example.com", "about:blank", "chrome-extension://abc/x", "", undefined, null, "not a url"]) {
      expect(findMatchingRules(all, url)).toEqual([]);
    }
    expect(isSupportedUrl("https://example.com")).toBe(true);
    expect(isSupportedUrl("data:text/html,hi")).toBe(false);
    expect(getHostname("https://WWW.example.com./")).toBe("www.example.com");
    expect(getHostname("chrome://newtab")).toBeNull();
  });
});

describe("duplicate detection", () => {
  it("treats normalized equivalents as duplicates", () => {
    const rules = [domainRule("example.com"), prefixRule("https://example.com/news")];
    const a = buildRuleDraft("domain", " https://EXAMPLE.com/x ", false);
    const b = buildRuleDraft("url-prefix", "https://example.com:443/news?x#y", false);
    expect(a.ok && findDuplicateRule(rules, a.draft)).toBe(rules[0]);
    expect(b.ok && findDuplicateRule(rules, b.draft)).toBe(rules[1]);
  });

  it("does not treat different subdomain settings or the edited rule itself as duplicates", () => {
    const rule = domainRule("example.com");
    expect(rulesEquivalent(rule, { ...rule, includeSubdomains: true })).toBe(false);
    expect(findDuplicateRule([rule], { type: "domain", value: "example.com", includeSubdomains: false }, rule.id)).toBeUndefined();
  });

  it("forces includeSubdomains=false for url-prefix drafts", () => {
    const draft = buildRuleDraft("url-prefix", "https://example.com/", true);
    expect(draft).toMatchObject({ ok: true, draft: { includeSubdomains: false } });
  });
});

describe("sanitizeRules", () => {
  it("drops malformed entries and re-normalizes values", () => {
    const result = sanitizeRules([
      { id: "a", type: "domain", value: "Example.COM.", enabled: true, includeSubdomains: true },
      { id: "b", type: "url-prefix", value: "https://x.test/a", includeSubdomains: true },
      { id: "c", type: "regex", value: ".*" },
      { id: "d", type: "domain", value: "bad/path" },
      null,
      "nope",
    ]);
    expect(result).toEqual([
      { id: "a", type: "domain", value: "example.com", enabled: true, includeSubdomains: true },
      { id: "b", type: "url-prefix", value: "https://x.test/a", enabled: true, includeSubdomains: false },
    ]);
    expect(sanitizeRules(undefined)).toEqual([]);
  });
});
