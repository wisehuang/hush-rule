import { TabController, type BrowserApi, type TabInfo } from "../src/core/controller";
import type { MutedInfoLike, Rule, TabState } from "../src/core/types";

export const SELF_ID = "hush-rules-self-id";

interface FakeTab {
  id: number;
  url?: string;
  pendingUrl?: string;
  mutedInfo: MutedInfoLike;
  documentId: string;
}

/**
 * In-memory stand-in for the Chrome APIs the controller uses. It models the
 * documented semantics (mutedInfo.reason/extensionId, documentId per
 * document) but it is NOT a browser: passing tests here do not prove real
 * Chrome event ordering or timing.
 */
export class FakeBrowser {
  tabs = new Map<number, FakeTab>();
  rules: Rule[] = [];
  autoMuteEnabled = true;
  /** Survives "service worker restarts" (new controller instances), like chrome.storage.session. */
  session = new Map<number, TabState>();
  setMutedCalls: Array<{ tabId: number; muted: boolean }> = [];
  logs: string[] = [];
  /** Hook to inject races: runs inside getTab before returning. */
  onGetTab?: (tabId: number) => void;
  private docCounter = 0;

  readonly api: BrowserApi = {
    selfId: SELF_ID,
    getTab: async (tabId) => {
      await Promise.resolve();
      this.onGetTab?.(tabId);
      const tab = this.tabs.get(tabId);
      return tab ? this.toInfo(tab) : null;
    },
    queryTabs: async () => [...this.tabs.values()].map((tab) => this.toInfo(tab)),
    setMuted: async (tabId, muted) => {
      await Promise.resolve();
      const tab = this.tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      this.setMutedCalls.push({ tabId, muted });
      tab.mutedInfo = { muted, reason: "extension", extensionId: SELF_ID };
    },
    getDocumentId: async (tabId) => this.tabs.get(tabId)?.documentId ?? null,
    loadConfig: async () => ({ rules: structuredClone(this.rules), autoMuteEnabled: this.autoMuteEnabled }),
    loadTabState: async (tabId) => structuredClone(this.session.get(tabId) ?? null),
    saveTabState: async (tabId, state) => {
      this.session.set(tabId, structuredClone(state));
    },
    removeTabState: async (tabId) => {
      this.session.delete(tabId);
    },
    listTabStateIds: async () => [...this.session.keys()],
    log: (message) => {
      this.logs.push(message);
    },
  };

  private toInfo(tab: FakeTab): TabInfo {
    return { id: tab.id, url: tab.url, mutedInfo: { ...tab.mutedInfo } };
  }

  newDocumentId(): string {
    return `doc-${++this.docCounter}`;
  }

  addTab(id: number, url: string | undefined, mutedInfo: MutedInfoLike = { muted: false }): FakeTab {
    const tab: FakeTab = { id, url, mutedInfo, documentId: this.newDocumentId() };
    this.tabs.set(id, tab);
    return tab;
  }

  tab(id: number): FakeTab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`fake tab ${id} missing`);
    return tab;
  }

  /** User (or another extension) changes the mute state, as Chrome would report it. */
  externalMute(id: number, muted: boolean, reason: "user" | "extension" = "user", extensionId?: string): MutedInfoLike {
    const info: MutedInfoLike = reason === "extension" ? { muted, reason, extensionId } : { muted, reason };
    this.tab(id).mutedInfo = info;
    return info;
  }

  controller(): TabController {
    return new TabController(this.api);
  }
}

/** Simulates Chrome's events for a cross-document navigation (or reload when url is unchanged). */
export async function navigateNewDocument(fake: FakeBrowser, controller: TabController, id: number, url: string): Promise<void> {
  const tab = fake.tab(id);
  tab.url = url;
  tab.documentId = fake.newDocumentId();
  await Promise.all([controller.evaluateTab(id), controller.handleNewDocument(id)]);
}

/** Simulates a same-document (history.pushState / fragment) navigation. */
export async function navigateSameDocument(fake: FakeBrowser, controller: TabController, id: number, url: string): Promise<void> {
  fake.tab(id).url = url;
  await controller.evaluateTab(id);
}
