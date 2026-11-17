import { actionAppearance } from "../core/action-icon";
import { TabController, type BrowserApi, type TabInfo } from "../core/controller";
import { isExtensionMessage, type SetManualMuteResponse } from "../shared/messages";
import {
  LOCAL_KEYS,
  listTabStateIds,
  loadConfig,
  loadTabState,
  removeTabState,
  saveTabState,
  seedDefaultRulesIfMissing,
} from "../shared/storage";

function toTabInfo(tab: chrome.tabs.Tab): TabInfo | null {
  if (tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) return null;
  return { id: tab.id, url: tab.url, mutedInfo: tab.mutedInfo };
}

const chromeApi: BrowserApi = {
  selfId: chrome.runtime.id,
  async getTab(tabId) {
    try {
      return toTabInfo(await chrome.tabs.get(tabId));
    } catch {
      return null; // "No tab with id" — closed or invalid
    }
  },
  async queryTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map(toTabInfo).filter((tab): tab is TabInfo => tab !== null);
  },
  async setMuted(tabId, muted) {
    await chrome.tabs.update(tabId, { muted });
  },
  async getDocumentId(tabId) {
    try {
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
      return frame?.documentId ?? null;
    } catch {
      return null;
    }
  },
  loadConfig,
  loadTabState,
  saveTabState,
  removeTabState,
  listTabStateIds,
  log(message, details) {
    console.warn(`[Hush Rules] ${message}`, details ?? "");
  },
};

const controller = new TabController(chromeApi);

/**
 * Shows the tab's actual mute state on the toolbar button. Chrome resets
 * tab-specific action icons on navigation, so this runs on every relevant
 * tab update. Errors (closed tab) are ignored.
 */
async function syncActionIcon(tabId: number, muted?: boolean): Promise<void> {
  try {
    const isMuted = muted ?? (await chrome.tabs.get(tabId)).mutedInfo?.muted ?? false;
    const { path, title } = actionAppearance(isMuted);
    await Promise.all([chrome.action.setIcon({ tabId, path }), chrome.action.setTitle({ tabId, title })]);
  } catch {
    // Tab closed or not yet ready; the next update event syncs it again.
  }
}

async function syncAllActionIcons(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => (tab.id === undefined ? undefined : syncActionIcon(tab.id, tab.mutedInfo?.muted))));
}

// Listeners are registered synchronously at top level so Chrome can wake the
// service worker for them after it has been stopped.

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
      try {
        await seedDefaultRulesIfMissing();
      } catch (error) {
        chromeApi.log?.("seeding default rules failed", error);
      }
    }
    await controller.evaluateAllTabs();
    await syncAllActionIcons();
  })();
});
chrome.runtime.onStartup.addListener(() => {
  void controller.evaluateAllTabs().then(syncAllActionIcons);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (LOCAL_KEYS.rules in changes || LOCAL_KEYS.autoMuteEnabled in changes) {
    void controller.evaluateAllTabs();
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  void controller.evaluateTab(tab.id);
  void syncActionIcon(tab.id, tab.mutedInfo?.muted);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.mutedInfo || changeInfo.url !== undefined || changeInfo.status !== undefined) {
    void syncActionIcon(tabId, tab.mutedInfo?.muted);
  }
  if (changeInfo.mutedInfo) void controller.handleMutedInfoChanged(tabId, changeInfo.mutedInfo);
  // `url` covers navigations including same-document (SPA) history changes;
  // `status` covers reloads where the URL does not change.
  if (changeInfo.url !== undefined || changeInfo.status !== undefined) void controller.evaluateTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => void controller.handleTabRemoved(tabId));
chrome.tabs.onReplaced.addListener((added, removed) => void controller.handleTabReplaced(added, removed));

// webNavigation distinguishes a new document (navigation/reload, which ends a
// manual override) from same-document SPA navigation (which keeps it).
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) void controller.handleNewDocument(details.tabId);
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) void controller.evaluateTab(details.tabId);
});
chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  if (details.frameId === 0) void controller.evaluateTab(details.tabId);
});

// Clicking the toolbar button toggles mute for that tab (manual override).
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) return;
  void controller.toggleManualMute(tab.id);
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isExtensionMessage(message)) return false;
  controller
    .setManualMute(message.tabId, message.muted)
    .then((ok) => sendResponse({ ok, error: ok ? undefined : "The tab is no longer available." } satisfies SetManualMuteResponse))
    .catch((error: unknown) => sendResponse({ ok: false, error: String(error) } satisfies SetManualMuteResponse));
  return true; // async response
});
