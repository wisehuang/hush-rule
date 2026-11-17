import {
  applyExternalMuteChange,
  applyManualMute,
  applyNewDocument,
  decide,
  type TabSnapshot,
} from "./decide";
import { EMPTY_TAB_STATE, type MutedInfoLike, type Rule, type TabState } from "./types";

/** Minimal tab shape used by the controller (subset of `chrome.tabs.Tab`). */
export interface TabInfo {
  id: number;
  url?: string;
  mutedInfo?: MutedInfoLike;
}

/**
 * Browser surface the controller depends on. The background script provides
 * a Chrome implementation; tests provide an in-memory fake.
 */
export interface BrowserApi {
  selfId: string;
  /** Resolves `null` when the tab no longer exists. */
  getTab(tabId: number): Promise<TabInfo | null>;
  queryTabs(): Promise<TabInfo[]>;
  setMuted(tabId: number, muted: boolean): Promise<void>;
  /** Main-frame documentId, or null if unavailable. */
  getDocumentId(tabId: number): Promise<string | null>;
  loadConfig(): Promise<{ rules: Rule[]; autoMuteEnabled: boolean }>;
  loadTabState(tabId: number): Promise<TabState | null>;
  saveTabState(tabId: number, state: TabState): Promise<void>;
  removeTabState(tabId: number): Promise<void>;
  /** All tab ids with stored runtime state (for pruning stale entries). */
  listTabStateIds(): Promise<number[]>;
  log?(message: string, details?: unknown): void;
}

const MAX_RECHECKS = 3;

function snapshotOf(tab: TabInfo, documentId: string | null): TabSnapshot {
  return {
    // Only the committed URL is used: acting on pendingUrl would mute before
    // commit and then clash with overrides that a commit legitimately clears.
    url: tab.url || undefined,
    mutedInfo: tab.mutedInfo ?? { muted: false },
    documentId,
  };
}

function statesEqual(a: TabState, b: TabState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Event-driven tab controller.
 *
 * - All work for one tab runs through a serialized queue, so concurrent events
 *   cannot interleave read-decide-write cycles. The queue is only a lock; all
 *   durable state lives in storage, so a service worker restart loses nothing.
 * - Every evaluation re-reads config, tab and state, and re-checks the tab
 *   right before changing it to avoid acting on stale results.
 * - Errors (closed tabs, invalid ids) are caught and logged, never thrown.
 */
export class TabController {
  private readonly queues = new Map<number, Promise<void>>();

  constructor(private readonly api: BrowserApi) {}

  /** Runs `task` after all earlier tasks for the same tab. Never rejects. */
  private enqueue(tabId: number, label: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      this.api.log?.(`${label} failed for tab ${tabId}`, error);
    });
    this.queues.set(tabId, next);
    void next.then(() => {
      if (this.queues.get(tabId) === next) this.queues.delete(tabId);
    });
    return next;
  }

  private async readState(tabId: number): Promise<TabState> {
    return (await this.api.loadTabState(tabId)) ?? { ...EMPTY_TAB_STATE };
  }

  private async writeState(tabId: number, before: TabState, after: TabState): Promise<void> {
    if (statesEqual(before, after)) return;
    if (!after.autoMuted && after.override === null) {
      await this.api.removeTabState(tabId);
    } else {
      await this.api.saveTabState(tabId, after);
    }
  }

  /** Evaluates one tab against the current rules and applies the decision. */
  evaluateTab(tabId: number): Promise<void> {
    return this.enqueue(tabId, "evaluate", () => this.evaluateNow(tabId));
  }

  private async evaluateNow(tabId: number): Promise<void> {
    const config = await this.api.loadConfig();

    for (let attempt = 0; attempt < MAX_RECHECKS; attempt++) {
      const stored = await this.readState(tabId);
      const tab = await this.api.getTab(tabId);
      if (!tab) {
        await this.api.removeTabState(tabId);
        return;
      }
      const documentId = await this.api.getDocumentId(tabId);
      const snapshot = snapshotOf(tab, documentId);
      const decision = decide({
        tab: snapshot,
        state: stored,
        rules: config.rules,
        autoMuteEnabled: config.autoMuteEnabled,
        selfId: this.api.selfId,
      });

      if (decision.action === "none") {
        await this.writeState(tabId, stored, decision.nextState);
        return;
      }

      // Re-check right before acting: the tab may have navigated, closed, or
      // been (un)muted by someone else while we were awaiting.
      const fresh = await this.api.getTab(tabId);
      if (!fresh) {
        await this.api.removeTabState(tabId);
        return;
      }
      const freshSnapshot = snapshotOf(fresh, documentId);
      if (
        freshSnapshot.url !== snapshot.url ||
        JSON.stringify(freshSnapshot.mutedInfo) !== JSON.stringify(snapshot.mutedInfo)
      ) {
        continue;
      }

      try {
        await this.api.setMuted(tabId, decision.action === "mute");
      } catch (error) {
        // Most likely the tab closed. Do not record ownership we failed to take.
        this.api.log?.(`setMuted failed for tab ${tabId}`, error);
        if (!(await this.api.getTab(tabId))) await this.api.removeTabState(tabId);
        return;
      }
      await this.writeState(tabId, stored, decision.nextState);
      return;
    }
    this.api.log?.(`tab ${tabId} kept changing; giving up this evaluation`);
    return;
  }

  /** Re-evaluates every open tab and prunes state of tabs that no longer exist. */
  async evaluateAllTabs(): Promise<void> {
    let tabs: TabInfo[];
    try {
      tabs = await this.api.queryTabs();
    } catch (error) {
      this.api.log?.("queryTabs failed", error);
      return;
    }
    const openIds = new Set(tabs.map((tab) => tab.id));
    try {
      const storedIds = await this.api.listTabStateIds();
      await Promise.all(
        storedIds.filter((id) => !openIds.has(id)).map((id) => this.enqueue(id, "prune", () => this.api.removeTabState(id))),
      );
    } catch (error) {
      this.api.log?.("pruning tab state failed", error);
    }
    await Promise.all(tabs.map((tab) => this.evaluateTab(tab.id)));
  }

  /** `tabs.onUpdated` with a `mutedInfo` change. */
  handleMutedInfoChanged(tabId: number, mutedInfo: MutedInfoLike): Promise<void> {
    return this.enqueue(tabId, "mutedInfo", async () => {
      const before = await this.readState(tabId);
      const documentId = await this.api.getDocumentId(tabId);
      const after = applyExternalMuteChange(before, mutedInfo, this.api.selfId, documentId);
      await this.writeState(tabId, before, after);
    });
  }

  /** A new main-frame document committed (navigation or reload): clear overrides, then evaluate. */
  handleNewDocument(tabId: number): Promise<void> {
    return this.enqueue(tabId, "newDocument", async () => {
      const tab = await this.api.getTab(tabId);
      if (!tab) {
        await this.api.removeTabState(tabId);
        return;
      }
      const before = await this.readState(tabId);
      const after = applyNewDocument(before, tab.mutedInfo ?? { muted: false }, this.api.selfId);
      await this.writeState(tabId, before, after);
      await this.evaluateNow(tabId);
    });
  }

  /** Manual mute/unmute from the popup. Returns the resulting muted state. */
  async setManualMute(tabId: number, muted: boolean): Promise<boolean> {
    let result = false;
    await this.enqueue(tabId, "manual", async () => {
      const tab = await this.api.getTab(tabId);
      if (!tab) throw new Error(`Tab ${tabId} no longer exists`);
      const before = await this.readState(tabId);
      const documentId = await this.api.getDocumentId(tabId);
      await this.api.setMuted(tabId, muted);
      await this.writeState(tabId, before, applyManualMute(muted, documentId));
      result = true;
    });
    return result;
  }

  handleTabRemoved(tabId: number): Promise<void> {
    return this.enqueue(tabId, "remove", () => this.api.removeTabState(tabId));
  }

  /** `tabs.onReplaced` (prerender / instant): drop the old id's state, evaluate the new tab. */
  async handleTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
    await this.handleTabRemoved(removedTabId);
    await this.evaluateTab(addedTabId);
  }
}
