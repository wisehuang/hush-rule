import { buildRuleDraft } from "./rules";
import type { Rule } from "./types";

/**
 * Domains seeded as rules on first install. Subdomains are included so that
 * www./m. hosts (e.g. www.youtube.com, m.facebook.com) are covered.
 */
export const DEFAULT_MUTED_DOMAINS: readonly string[] = [
  "youtube.com",
  "x.com",
  "facebook.com",
  "threads.com",
  "instagram.com",
];

export function buildDefaultRules(createId: () => string): Rule[] {
  return DEFAULT_MUTED_DOMAINS.map((domain) => {
    const built = buildRuleDraft("domain", domain, true);
    if (!built.ok) throw new Error(`Invalid default domain: ${domain}`);
    return { id: createId(), enabled: true, ...built.draft };
  });
}
