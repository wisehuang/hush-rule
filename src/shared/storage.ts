import { buildDefaultRules } from "../core/defaults";
import { sanitizeRules } from "../core/rules";
import type { Rule, TabState } from "../core/types";

/** Keys in `chrome.storage.local`. */
export const LOCAL_KEYS = { rules: "rules", autoMuteEnabled: "autoMuteEnabled" } as const;

const TAB_STATE_PREFIX = "tab:";

export async function loadRules(): Promise<Rule[]> {
  const data = await chrome.storage.local.get(LOCAL_KEYS.rules);
  return sanitizeRules(data[LOCAL_KEYS.rules]);
}

export async function saveRules(rules: readonly Rule[]): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEYS.rules]: rules });
}

/**
 * Seeds the default rules on first install. Does nothing if a rule list was
 * ever saved (including an empty one), so user deletions are respected.
 */
export async function seedDefaultRulesIfMissing(): Promise<boolean> {
  const data = await chrome.storage.local.get(LOCAL_KEYS.rules);
  if (data[LOCAL_KEYS.rules] !== undefined) return false;
  await saveRules(buildDefaultRules(() => crypto.randomUUID()));
  return true;
}

export async function loadAutoMuteEnabled(): Promise<boolean> {
  const data = await chrome.storage.local.get(LOCAL_KEYS.autoMuteEnabled);
  return data[LOCAL_KEYS.autoMuteEnabled] !== false; // default: on
}

export async function saveAutoMuteEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEYS.autoMuteEnabled]: enabled });
}

export async function loadConfig(): Promise<{ rules: Rule[]; autoMuteEnabled: boolean }> {
  const data = await chrome.storage.local.get([LOCAL_KEYS.rules, LOCAL_KEYS.autoMuteEnabled]);
  return {
    rules: sanitizeRules(data[LOCAL_KEYS.rules]),
    autoMuteEnabled: data[LOCAL_KEYS.autoMuteEnabled] !== false,
  };
}

/**
 * Applies `update` to the stored rule list. Read-modify-write; concurrent
 * edits from two extension pages at the same instant can lose one write
 * (documented limitation).
 */
export async function updateRules(update: (rules: Rule[]) => Rule[]): Promise<Rule[]> {
  const next = update(await loadRules());
  await saveRules(next);
  return next;
}

export function tabStateKey(tabId: number): string {
  return `${TAB_STATE_PREFIX}${tabId}`;
}

function sanitizeTabState(value: unknown): TabState | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const o = v.override as Record<string, unknown> | null | undefined;
  const override =
    o && typeof o === "object" && typeof o.muted === "boolean"
      ? {
          muted: o.muted,
          documentId: typeof o.documentId === "string" ? o.documentId : null,
          source: o.source === "manual" ? ("manual" as const) : ("external" as const),
        }
      : null;
  return { autoMuted: v.autoMuted === true, override };
}

export async function loadTabState(tabId: number): Promise<TabState | null> {
  const key = tabStateKey(tabId);
  const data = await chrome.storage.session.get(key);
  return sanitizeTabState(data[key]);
}

export async function saveTabState(tabId: number, state: TabState): Promise<void> {
  await chrome.storage.session.set({ [tabStateKey(tabId)]: state });
}

export async function removeTabState(tabId: number): Promise<void> {
  await chrome.storage.session.remove(tabStateKey(tabId));
}

export async function listTabStateIds(): Promise<number[]> {
  const all = await chrome.storage.session.get(null);
  return Object.keys(all)
    .filter((key) => key.startsWith(TAB_STATE_PREFIX))
    .map((key) => Number(key.slice(TAB_STATE_PREFIX.length)))
    .filter((id) => Number.isInteger(id));
}
