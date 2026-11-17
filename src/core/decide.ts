import { findMatchingRules, isSupportedUrl } from "./rules";
import type { MutedInfoLike, Rule, TabState } from "./types";

export interface TabSnapshot {
  /** Committed `tab.url`; undefined while no URL is known yet. */
  url: string | undefined;
  mutedInfo: MutedInfoLike;
  /** Current main-frame documentId, or null if it could not be read. */
  documentId: string | null;
}

export interface DecisionInput {
  tab: TabSnapshot;
  state: TabState;
  rules: readonly Rule[];
  autoMuteEnabled: boolean;
  selfId: string;
}

export type MuteAction = "mute" | "unmute" | "none";

export interface Decision {
  action: MuteAction;
  /** State to persist after the action has been applied successfully. */
  nextState: TabState;
  matchedRules: Rule[];
  reason: string;
}

/** True when `mutedInfo` says this extension is the source of the current mute. */
export function isMutedBySelf(mutedInfo: MutedInfoLike, selfId: string): boolean {
  return mutedInfo.muted && mutedInfo.reason === "extension" && mutedInfo.extensionId === selfId;
}

/** True when a mutedInfo change was caused by this extension's own `tabs.update()` call. */
export function isSelfCausedChange(mutedInfo: MutedInfoLike, selfId: string): boolean {
  return mutedInfo.reason === "extension" && mutedInfo.extensionId === selfId;
}

/**
 * Drops an override that belongs to a different document. Overrides recorded
 * without a documentId (null) stay until the next main-frame commit clears them.
 */
export function overrideStillValid(state: TabState, documentId: string | null): boolean {
  const override = state.override;
  if (!override) return false;
  if (override.documentId === null || documentId === null) return true;
  return override.documentId === documentId;
}

/**
 * Pure per-tab decision. Rules:
 * - An active override (manual toolbar/options action, or user / other extension
 *   change) suspends automatic behavior for the current document.
 * - Mute when an enabled rule matches and the tab is not muted yet; claim
 *   ownership only for mutes this extension applies.
 * - Restore audio only if this extension auto-muted the tab AND mutedInfo
 *   still names this extension as the source.
 */
export function decide(input: DecisionInput): Decision {
  const { tab, rules, autoMuteEnabled, selfId } = input;
  const unsupportedPage = tab.url !== undefined && !isSupportedUrl(tab.url);
  // Navigating to an unsupported page is a new document; overrides end there.
  let override =
    !unsupportedPage && overrideStillValid(input.state, tab.documentId) ? input.state.override : null;
  const ownsMute = input.state.autoMuted && isMutedBySelf(tab.mutedInfo, selfId);
  if (input.state.autoMuted && !ownsMute && !override && tab.url !== undefined && !unsupportedPage) {
    // We auto-muted this tab, but mutedInfo no longer names us: the user or
    // another extension changed it, possibly before its onUpdated event was
    // handled. Treat it as an external override instead of reverting it.
    override = { muted: tab.mutedInfo.muted, documentId: tab.documentId, source: "external" };
  }
  const state: TabState = { autoMuted: ownsMute, override };

  const matchedRules = autoMuteEnabled ? findMatchingRules(rules, tab.url) : [];

  if (tab.url === undefined) {
    return { action: "none", nextState: state, matchedRules, reason: "no-url-yet" };
  }
  if (override) {
    return { action: "none", nextState: state, matchedRules, reason: "override" };
  }
  if (matchedRules.length > 0) {
    if (tab.mutedInfo.muted) {
      return { action: "none", nextState: state, matchedRules, reason: ownsMute ? "already-auto-muted" : "muted-by-other" };
    }
    return { action: "mute", nextState: { autoMuted: true, override: null }, matchedRules, reason: "rule-match" };
  }
  if (ownsMute) {
    return { action: "unmute", nextState: { autoMuted: false, override: null }, matchedRules, reason: "restore" };
  }
  return { action: "none", nextState: state, matchedRules, reason: "no-match" };
}

/**
 * State update for a mutedInfo change observed via `tabs.onUpdated`. Changes
 * made by this extension are ignored (prevents feedback loops). Changes made
 * by the user or another extension become a document-scoped override so they
 * are not immediately reverted, and this extension gives up ownership.
 */
export function applyExternalMuteChange(
  state: TabState,
  mutedInfo: MutedInfoLike,
  selfId: string,
  documentId: string | null,
): TabState {
  if (isSelfCausedChange(mutedInfo, selfId)) return state;
  return { autoMuted: false, override: { muted: mutedInfo.muted, documentId, source: "external" } };
}

/** State after a manual mute/unmute (toolbar click or options page). Never counts as an automatic mute. */
export function applyManualMute(muted: boolean, documentId: string | null): TabState {
  return { autoMuted: false, override: { muted, documentId, source: "manual" } };
}

/**
 * State after a new main-frame document committed (navigation or reload):
 * overrides end. If our automatic mute was already taken over by someone
 * else, ownership is dropped here so that change is not carried over to the
 * new document as an override.
 */
export function applyNewDocument(state: TabState, mutedInfo: MutedInfoLike, selfId: string): TabState {
  return { autoMuted: state.autoMuted && isMutedBySelf(mutedInfo, selfId), override: null };
}
