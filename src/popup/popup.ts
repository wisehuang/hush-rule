import { describeMuteState } from "../core/mute-label";
import { buildRuleDraft, findDuplicateRule, findMatchingRules, getHostname } from "../core/rules";
import type { Rule } from "../core/types";
import { byId, describeRule, el } from "../shared/dom";
import type { SetManualMuteMessage, SetManualMuteResponse } from "../shared/messages";
import { LOCAL_KEYS, loadConfig, loadTabState, saveAutoMuteEnabled, tabStateKey, updateRules } from "../shared/storage";

const autoToggle = byId<HTMLInputElement>("auto-toggle");
const tabHost = byId("tab-host");
const tabMuteState = byId("tab-mute-state");
const unsupported = byId("unsupported");
const matchingList = byId<HTMLUListElement>("matching-rules");
const autoOffNote = byId("auto-off-note");
const addDomainButton = byId<HTMLButtonElement>("add-domain");
const toggleMuteButton = byId<HTMLButtonElement>("toggle-mute");
const optionsButton = byId<HTMLButtonElement>("open-options");
const feedback = byId("feedback");

let activeTabId: number | null = null;

function setFeedback(text: string, kind: "success" | "error" | "info" = "info"): void {
  feedback.textContent = text;
  feedback.className = kind === "info" ? "hint" : `hint ${kind}`;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderMatches(matches: Rule[]): void {
  matchingList.replaceChildren();
  if (matches.length === 0) {
    matchingList.append(el("li", { className: "empty", text: "No matching rules" }));
    return;
  }
  for (const rule of matches) matchingList.append(el("li", { className: "mono", text: describeRule(rule) }));
}

async function render(): Promise<void> {
  const [config, tab] = await Promise.all([loadConfig(), getActiveTab()]);
  autoToggle.checked = config.autoMuteEnabled;
  autoOffNote.hidden = config.autoMuteEnabled;

  activeTabId = tab?.id ?? null;
  const url = tab?.url || tab?.pendingUrl;
  const hostname = getHostname(url);
  const supported = hostname !== null && activeTabId !== null;

  unsupported.hidden = supported;
  addDomainButton.disabled = !supported;
  toggleMuteButton.disabled = !supported;

  if (!tab || !supported || activeTabId === null) {
    tabHost.textContent = tab ? "Unsupported page" : "No active tab";
    tabMuteState.textContent = "";
    renderMatches([]);
    return;
  }

  tabHost.textContent = hostname;
  const mutedInfo = tab.mutedInfo ?? { muted: false };
  const state = await loadTabState(activeTabId);
  tabMuteState.textContent = describeMuteState(mutedInfo, state, chrome.runtime.id);
  toggleMuteButton.textContent = mutedInfo.muted ? "Unmute tab" : "Mute tab";

  // Show all enabled rules that match, even when the global switch is off.
  renderMatches(findMatchingRules(config.rules, url));

  const draft = buildRuleDraft("domain", hostname, false);
  const exists = draft.ok && findDuplicateRule(config.rules, draft.draft) !== undefined;
  addDomainButton.disabled = exists;
  addDomainButton.textContent = exists ? "This domain is already a rule" : "Add this domain to mute rules";
}

autoToggle.addEventListener("change", () => {
  const enabled = autoToggle.checked;
  saveAutoMuteEnabled(enabled)
    .then(() => setFeedback(enabled ? "Automatic muting turned on." : "Automatic muting turned off.", "success"))
    .catch((error: unknown) => setFeedback(`Could not save: ${String(error)}`, "error"));
});

addDomainButton.addEventListener("click", () => {
  void (async () => {
    const tab = await getActiveTab();
    const hostname = getHostname(tab?.url || tab?.pendingUrl);
    if (!hostname) return setFeedback("This page is not supported.", "error");
    const built = buildRuleDraft("domain", hostname, false);
    if (!built.ok) return setFeedback(built.error, "error");
    let duplicate = false;
    await updateRules((rules) => {
      if (findDuplicateRule(rules, built.draft)) {
        duplicate = true;
        return rules;
      }
      return [...rules, { id: crypto.randomUUID(), enabled: true, ...built.draft }];
    });
    setFeedback(duplicate ? "A rule for this domain already exists." : `Added rule for ${built.draft.value}.`, duplicate ? "info" : "success");
  })().catch((error: unknown) => setFeedback(`Could not add rule: ${String(error)}`, "error"));
});

toggleMuteButton.addEventListener("click", () => {
  void (async () => {
    if (activeTabId === null) return;
    const tab = await chrome.tabs.get(activeTabId);
    const message: SetManualMuteMessage = { type: "set-manual-mute", tabId: activeTabId, muted: !tab.mutedInfo?.muted };
    const response = (await chrome.runtime.sendMessage(message)) as SetManualMuteResponse | undefined;
    if (!response?.ok) return setFeedback(response?.error ?? "Could not change the mute state.", "error");
    setFeedback(
      message.muted
        ? "Muted manually. Automatic rules will not change this page until it reloads or navigates."
        : "Unmuted manually. Automatic rules will not change this page until it reloads or navigates.",
      "success",
    );
    await render();
  })().catch((error: unknown) => setFeedback(`Could not change the mute state: ${String(error)}`, "error"));
});

optionsButton.addEventListener("click", () => void chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  const relevant =
    (area === "local" && (LOCAL_KEYS.rules in changes || LOCAL_KEYS.autoMuteEnabled in changes)) ||
    (area === "session" && activeTabId !== null && tabStateKey(activeTabId) in changes);
  if (relevant) void render();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && (changeInfo.url || changeInfo.mutedInfo || changeInfo.status)) void render();
});

render().catch((error: unknown) => setFeedback(`Could not load: ${String(error)}`, "error"));
