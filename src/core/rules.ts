import type { Rule, RuleType } from "./types";

export type NormalizeResult =
  | { ok: true; value: string; notice?: string }
  | { ok: false; error: string };

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostname label characters accepted for domain rules (after IDN → punycode conversion). */
const HOSTNAME_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

function stripTrailingDots(hostname: string): string {
  return hostname.replace(/\.+$/, "");
}

/** Parses a string as an http(s) URL. Returns `null` for anything else. */
export function parseHttpUrl(input: string): URL | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  return SUPPORTED_PROTOCOLS.has(url.protocol) ? url : null;
}

/** True when the extension is allowed to act on this URL (http/https only). */
export function isSupportedUrl(url: string | undefined | null): url is string {
  return typeof url === "string" && parseHttpUrl(url) !== null;
}

/** Hostname of an http(s) URL, lowercase and without trailing dots; `null` otherwise. */
export function getHostname(url: string | undefined | null): string | null {
  if (typeof url !== "string") return null;
  const parsed = parseHttpUrl(url);
  return parsed ? stripTrailingDots(parsed.hostname) : null;
}

function validateHostname(hostname: string): NormalizeResult {
  if (hostname.length === 0) return { ok: false, error: "Enter a domain, for example example.com." };
  if (hostname.startsWith("[")) {
    return { ok: false, error: "IPv6 addresses are not supported in domain rules." };
  }
  if (!HOSTNAME_PATTERN.test(hostname)) {
    return {
      ok: false,
      error:
        "Domain contains invalid characters. Wildcards are not supported; use “Include subdomains” instead.",
    };
  }
  if (hostname.length > 253 || hostname.split(".").some((label) => label.length > 63)) {
    return { ok: false, error: "Domain is too long." };
  }
  return { ok: true, value: hostname };
}

/**
 * Normalizes user input for a domain rule.
 *
 * Accepts a bare hostname (`Example.COM.`) or a complete http(s) URL, from
 * which the hostname is extracted. Rejects ambiguous input such as
 * `example.com/path` (path without a scheme), ports, credentials and wildcards.
 */
export function normalizeDomainInput(raw: string): NormalizeResult {
  const input = raw.trim();
  if (input.length === 0) return { ok: false, error: "Enter a domain, for example example.com." };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    const url = parseHttpUrl(input);
    if (!url) return { ok: false, error: "Only http:// and https:// URLs are supported." };
    if (url.username || url.password) {
      return { ok: false, error: "URLs with a username or password are not supported." };
    }
    const result = validateHostname(stripTrailingDots(url.hostname));
    if (!result.ok) return result;
    const portNote = url.port ? " The port is ignored; domain rules match any port." : "";
    return { ok: true, value: result.value, notice: `Using the hostname “${result.value}” from the URL.${portNote}` };
  }

  if (/[\s/\\?#@:]/.test(input)) {
    return {
      ok: false,
      error:
        "Enter only a hostname (example.com), or paste a complete URL starting with http:// or https://. Paths, ports and spaces are not allowed.",
    };
  }

  // Let the WHATWG URL parser lowercase and convert IDNs to punycode.
  const url = parseHttpUrl(`http://${input}`);
  if (!url) return { ok: false, error: "This is not a valid domain." };
  return validateHostname(stripTrailingDots(url.hostname));
}

/**
 * Normalizes user input for a URL-prefix rule. Requires a complete http(s)
 * URL. The stored value is `origin + pathname`; query strings and fragments
 * are dropped because they are ignored by matching.
 */
export function normalizeUrlPrefixInput(raw: string): NormalizeResult {
  const input = raw.trim();
  if (input.length === 0) {
    return { ok: false, error: "Enter a complete URL, for example https://example.com/news." };
  }
  if (!/^https?:\/\//i.test(input)) {
    return { ok: false, error: "URL prefixes must start with http:// or https://." };
  }
  const url = parseHttpUrl(input);
  if (!url) return { ok: false, error: "This is not a valid URL." };
  if (url.username || url.password) {
    return { ok: false, error: "URLs with a username or password are not supported." };
  }
  const hostname = stripTrailingDots(url.hostname);
  if (hostname === "") return { ok: false, error: "This URL has no valid hostname." };
  const hadQueryOrFragment = url.search !== "" || url.hash !== "" || /[?#]/.test(input);
  url.hostname = hostname;
  const value = `${url.origin}${url.pathname}`;
  return hadQueryOrFragment
    ? { ok: true, value, notice: "The query string and fragment were removed; they are ignored when matching." }
    : { ok: true, value };
}

export function normalizeRuleValue(type: RuleType, raw: string): NormalizeResult {
  return type === "domain" ? normalizeDomainInput(raw) : normalizeUrlPrefixInput(raw);
}

interface ComparableUrl {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
}

function toComparable(url: URL): ComparableUrl {
  return {
    protocol: url.protocol,
    hostname: stripTrailingDots(url.hostname),
    port: url.port,
    pathname: url.pathname,
  };
}

/**
 * Domain match with hostname-label boundaries: `example.com` matches
 * `example.com`, and with subdomains `*.example.com`, but never
 * `notexample.com` or `example.com.evil.test`.
 */
export function hostnameMatchesDomain(hostname: string, domain: string, includeSubdomains: boolean): boolean {
  if (domain.length === 0) return false;
  if (hostname === domain) return true;
  if (!includeSubdomains) return false;
  const hostLabels = hostname.split(".");
  const domainLabels = domain.split(".");
  if (hostLabels.length <= domainLabels.length) return false;
  const tail = hostLabels.slice(hostLabels.length - domainLabels.length);
  return tail.every((label, index) => label === domainLabels[index]);
}

/**
 * URL-prefix match: exact origin (scheme, host, port) and a case-sensitive
 * pathname prefix. Query strings and fragments are ignored.
 */
export function urlMatchesPrefix(target: URL, prefixValue: string): boolean {
  const prefixUrl = parseHttpUrl(prefixValue);
  if (!prefixUrl) return false;
  const a = toComparable(target);
  const b = toComparable(prefixUrl);
  if (a.protocol !== b.protocol || a.hostname !== b.hostname || a.port !== b.port) return false;
  return a.pathname.startsWith(b.pathname);
}

/** Whether a single rule matches the URL, ignoring its `enabled` flag. */
export function ruleMatchesUrl(rule: Rule, url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  if (rule.type === "domain") {
    return hostnameMatchesDomain(stripTrailingDots(parsed.hostname), rule.value, rule.includeSubdomains);
  }
  return urlMatchesPrefix(parsed, rule.value);
}

/** All enabled rules that match the URL. Empty for unsupported schemes. */
export function findMatchingRules(rules: readonly Rule[], url: string | undefined | null): Rule[] {
  if (!isSupportedUrl(url)) return [];
  return rules.filter((rule) => rule.enabled && ruleMatchesUrl(rule, url));
}

/** Whether the tab URL should be muted automatically given the global switch and rules. */
export function shouldAutoMute(
  rules: readonly Rule[],
  autoMuteEnabled: boolean,
  url: string | undefined | null,
): boolean {
  return autoMuteEnabled && findMatchingRules(rules, url).length > 0;
}

export interface RuleDraft {
  type: RuleType;
  value: string;
  includeSubdomains: boolean;
}

/** Two rules are equivalent when they would match exactly the same URLs. */
export function rulesEquivalent(a: RuleDraft, b: RuleDraft): boolean {
  if (a.type !== b.type || a.value !== b.value) return false;
  return a.type === "url-prefix" || a.includeSubdomains === b.includeSubdomains;
}

/** Returns an existing rule equivalent to `draft`, skipping the rule with `ignoreId` (the one being edited). */
export function findDuplicateRule(
  rules: readonly Rule[],
  draft: RuleDraft,
  ignoreId?: string,
): Rule | undefined {
  return rules.find((rule) => rule.id !== ignoreId && rulesEquivalent(rule, draft));
}

export type BuildRuleResult = { ok: true; draft: RuleDraft; notice?: string } | { ok: false; error: string };

/** Validates raw form input into a normalized rule draft. */
export function buildRuleDraft(type: RuleType, rawValue: string, includeSubdomains: boolean): BuildRuleResult {
  const normalized = normalizeRuleValue(type, rawValue);
  if (!normalized.ok) return normalized;
  const draft: RuleDraft = {
    type,
    value: normalized.value,
    includeSubdomains: type === "domain" ? includeSubdomains : false,
  };
  return normalized.notice ? { ok: true, draft, notice: normalized.notice } : { ok: true, draft };
}

/** Defensive parsing of rules read from storage; drops malformed entries. */
export function sanitizeRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) return [];
  const rules: Rule[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || (r.type !== "domain" && r.type !== "url-prefix")) continue;
    if (typeof r.value !== "string") continue;
    const normalized = normalizeRuleValue(r.type, r.value);
    if (!normalized.ok) continue;
    rules.push({
      id: r.id,
      enabled: r.enabled !== false,
      type: r.type,
      value: normalized.value,
      includeSubdomains: r.type === "domain" && r.includeSubdomains === true,
    });
  }
  return rules;
}
