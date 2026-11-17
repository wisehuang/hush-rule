export type RuleType = "domain" | "url-prefix";

export interface Rule {
  id: string;
  enabled: boolean;
  type: RuleType;
  /** Normalized value: a hostname for domain rules, `origin + pathname` for url-prefix rules. */
  value: string;
  /** Only meaningful for domain rules. Always `false` for url-prefix rules. */
  includeSubdomains: boolean;
}

export interface Settings {
  autoMuteEnabled: boolean;
}

/** Subset of `chrome.tabs.MutedInfo` that the decision logic needs. */
export interface MutedInfoLike {
  muted: boolean;
  reason?: string;
  extensionId?: string;
}

/**
 * A mute decision taken by a person (toolbar click / options page) or by a third party
 * (user via tab strip, another extension). It suspends automatic rules for
 * the document it was taken on.
 */
export interface MuteOverride {
  muted: boolean;
  /** Main-frame documentId when known; `null` if it could not be read. */
  documentId: string | null;
  source: "manual" | "external";
}

/** Per-tab runtime state persisted in `chrome.storage.session`. */
export interface TabState {
  /** True only while the current mute was applied automatically by this extension. */
  autoMuted: boolean;
  override: MuteOverride | null;
}

export const EMPTY_TAB_STATE: Readonly<TabState> = Object.freeze({ autoMuted: false, override: null });
