import { describeMuteState } from "../core/mute-label";
import { type RuleDraft, buildRuleDraft, findDuplicateRule, findMatchingRules, getHostname, isSupportedUrl, ruleMatchesUrl } from "../core/rules";
import type { Rule, RuleType } from "../core/types";
import { byId, describeRule, el } from "../shared/dom";
import type { SetManualMuteMessage, SetManualMuteResponse } from "../shared/messages";
import { LOCAL_KEYS, loadConfig, loadTabState, saveAutoMuteEnabled, updateRules } from "../shared/storage";

const autoToggle = byId<HTMLInputElement>("auto-toggle");
const form = byId<HTMLFormElement>("rule-form");
const formTitle = byId("form-title");
const typeSelect = byId<HTMLSelectElement>("rule-type");
const valueInput = byId<HTMLInputElement>("rule-value");
const subdomainsRow = byId("subdomains-row");
const subdomainsInput = byId<HTMLInputElement>("rule-subdomains");
const helpDomain = byId("help-domain");
const helpPrefix = byId("help-prefix");
const preview = byId("preview");
const formError = byId("form-error");
const saveButton = byId<HTMLButtonElement>("save-button");
const cancelEditButton = byId<HTMLButtonElement>("cancel-edit");
const formFeedback = byId("form-feedback");
const ruleList = byId<HTMLUListElement>("rule-list");
const rulesEmpty = byId("rules-empty");
const testerInput = byId<HTMLInputElement>("tester-input");
const testerResult = byId("tester-result");
const tabList = byId<HTMLUListElement>("tab-list");
const tabsEmpty = byId("tabs-empty");

let rules: Rule[] = [];
let autoMuteEnabled = true;
let editingId: string | null = null;

const PLACEHOLDERS: Record<RuleType, string> = {
  domain: "example.com",
  "url-prefix": "https://example.com/news/",
};

function setFeedback(text: string, kind: "success" | "error" | "info" = "info"): void {
  formFeedback.textContent = text;
  formFeedback.className = kind === "info" ? "hint" : `hint ${kind}`;
}

function currentType(): RuleType {
  return typeSelect.value === "url-prefix" ? "url-prefix" : "domain";
}

function updateFormForType(): void {
  const type = currentType();
  const isDomain = type === "domain";
  subdomainsRow.hidden = !isDomain;
  helpDomain.hidden = !isDomain;
  helpPrefix.hidden = isDomain;
  valueInput.placeholder = PLACEHOLDERS[type];
  updatePreview();
}

/** Live normalized preview; errors are only shown on submit or for non-empty input. */
function updatePreview(): void {
  formError.textContent = "";
  preview.textContent = "";
  if (valueInput.value.trim() === "") return;
  const built = buildRuleDraft(currentType(), valueInput.value, subdomainsInput.checked);
  if (!built.ok) {
    formError.textContent = built.error;
    return;
  }
  preview.textContent = `Will be saved as: ${describeRule(built.draft)}${built.notice ? ` — ${built.notice}` : ""}`;
}

function resetForm(): void {
  editingId = null;
  form.reset();
  formTitle.textContent = "Add a rule";
  saveButton.textContent = "Add rule";
  cancelEditButton.hidden = true;
  updateFormForType();
  renderRules();
}

function startEditing(rule: Rule): void {
  editingId = rule.id;
  typeSelect.value = rule.type;
  valueInput.value = rule.value;
  subdomainsInput.checked = rule.includeSubdomains;
  formTitle.textContent = "Edit rule";
  saveButton.textContent = "Save changes";
  cancelEditButton.hidden = false;
  setFeedback("");
  updateFormForType();
  renderRules();
  valueInput.focus();
}

function renderRules(): void {
  ruleList.replaceChildren();
  rulesEmpty.hidden = rules.length > 0;
  for (const rule of rules) {
    const toggle = el("input", { attrs: { type: "checkbox", "aria-label": `Enable rule ${rule.value}` } });
    toggle.checked = rule.enabled;
    toggle.addEventListener("change", () => {
      void persist(
        (list) => list.map((r) => (r.id === rule.id ? { ...r, enabled: toggle.checked } : r)),
        toggle.checked ? "Rule enabled." : "Rule disabled.",
      );
    });

    const editButton = el("button", { text: "Edit", attrs: { type: "button" } });
    editButton.addEventListener("click", () => startEditing(rule));

    const deleteButton = el("button", { text: "Delete", className: "danger", attrs: { type: "button" } });
    deleteButton.addEventListener("click", () => {
      if (editingId === rule.id) resetForm();
      void persist((list) => list.filter((r) => r.id !== rule.id), "Rule deleted.");
    });

    const classes = ["rule", rule.enabled ? "" : "disabled", editingId === rule.id ? "editing" : ""].filter(Boolean);
    ruleList.append(
      el(
        "li",
        { className: classes.join(" ") },
        toggle,
        el("span", { className: "value mono", text: rule.value }),
        el("span", {
          className: "badge",
          text: rule.type === "domain" ? (rule.includeSubdomains ? "domain + subdomains" : "domain") : "URL prefix",
        }),
        editButton,
        deleteButton,
      ),
    );
  }
}

function renderTester(): void {
  testerResult.replaceChildren();
  const raw = testerInput.value.trim();
  if (raw === "") {
    testerResult.append(el("p", { className: "hint", text: "Enter a URL to see which rules match it." }));
    return;
  }
  if (!isSupportedUrl(raw)) {
    testerResult.append(
      el("p", { className: "error", text: "Enter a complete http:// or https:// URL. Other pages are never muted." }),
    );
    return;
  }
  const matches = rules.filter((rule) => ruleMatchesUrl(rule, raw));
  const enabledMatches = matches.filter((rule) => rule.enabled);
  const verdict =
    enabledMatches.length === 0
      ? "No matching rules — this URL would not be muted."
      : autoMuteEnabled
        ? "This URL would be muted."
        : "Rules match, but automatic muting is currently off.";
  testerResult.append(el("p", { className: enabledMatches.length > 0 ? "success" : "hint", text: verdict }));
  if (matches.length > 0) {
    const list = el("ul", { className: "list" });
    for (const rule of matches) {
      list.append(el("li", { className: "mono", text: `${describeRule(rule)}${rule.enabled ? "" : " (disabled)"}` }));
    }
    testerResult.append(list);
  }
}

let tabsRenderToken = 0;

/** Lists open http(s) tabs with their mute state, a mute toggle and "Add domain". */
async function renderTabs(): Promise<void> {
  const token = ++tabsRenderToken;
  const tabs = (await chrome.tabs.query({})).filter(
    (tab): tab is chrome.tabs.Tab & { id: number; url: string } => tab.id !== undefined && isSupportedUrl(tab.url),
  );
  const states = await Promise.all(tabs.map((tab) => loadTabState(tab.id)));
  if (token !== tabsRenderToken) return; // a newer render started meanwhile

  tabList.replaceChildren();
  tabsEmpty.hidden = tabs.length > 0;
  tabs.forEach((tab, index) => {
    const hostname = getHostname(tab.url) ?? tab.url;
    const mutedInfo = tab.mutedInfo ?? { muted: false };
    const matches = findMatchingRules(rules, tab.url);
    const status = [
      describeMuteState(mutedInfo, states[index] ?? null, chrome.runtime.id),
      matches.length > 0 ? `matches ${matches.map(describeRule).join(", ")}` : "no matching rules",
    ].join(" · ");

    const muteButton = el("button", { text: mutedInfo.muted ? "Unmute" : "Mute", attrs: { type: "button" } });
    muteButton.addEventListener("click", () => void setTabMuted(tab.id, !mutedInfo.muted));

    const draft = buildRuleDraft("domain", hostname, false);
    const exists = draft.ok && findDuplicateRule(rules, draft.draft) !== undefined;
    const addButton = el("button", { text: exists ? "Domain added" : "Add domain", attrs: { type: "button" } });
    addButton.disabled = !draft.ok || exists;
    addButton.addEventListener("click", () => {
      if (!draft.ok) return;
      void addDraft(draft.draft);
    });

    tabList.append(
      el(
        "li",
        { className: "tab" },
        el(
          "div",
          { className: "info" },
          el("span", { className: "host mono", text: hostname }),
          el("span", { className: "title", text: tab.title ?? "" }),
          el("span", { className: "hint", text: status }),
        ),
        muteButton,
        addButton,
      ),
    );
  });
}

async function setTabMuted(tabId: number, muted: boolean): Promise<void> {
  const message: SetManualMuteMessage = { type: "set-manual-mute", tabId, muted };
  try {
    const response = (await chrome.runtime.sendMessage(message)) as SetManualMuteResponse | undefined;
    if (!response?.ok) setFeedback(response?.error ?? "Could not change the mute state.", "error");
  } catch (error) {
    setFeedback(`Could not change the mute state: ${String(error)}`, "error");
  }
  await renderTabs();
}

async function addDraft(draft: RuleDraft): Promise<void> {
  let duplicate = false;
  try {
    rules = await updateRules((list) => {
      if (findDuplicateRule(list, draft)) {
        duplicate = true;
        return list;
      }
      return [...list, { id: crypto.randomUUID(), enabled: true, ...draft }];
    });
    setFeedback(duplicate ? "A rule for this domain already exists." : `Rule added: ${describeRule(draft)}.`, duplicate ? "info" : "success");
  } catch (error) {
    setFeedback(`Could not save: ${String(error)}`, "error");
  }
  renderRules();
  renderTester();
  await renderTabs();
}

async function persist(update: (list: Rule[]) => Rule[], message: string): Promise<void> {
  try {
    rules = await updateRules(update);
    setFeedback(message, "success");
  } catch (error) {
    setFeedback(`Could not save: ${String(error)}`, "error");
  }
  renderRules();
  renderTester();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const built = buildRuleDraft(currentType(), valueInput.value, subdomainsInput.checked);
  if (!built.ok) {
    formError.textContent = built.error;
    setFeedback("");
    valueInput.focus();
    return;
  }
  const id = editingId;
  void (async () => {
    // Check duplicates against the latest stored list, not just the cached one.
    let duplicate: Rule | undefined;
    rules = await updateRules((list) => {
      duplicate = findDuplicateRule(list, built.draft, id ?? undefined);
      if (duplicate) return list;
      if (id !== null && list.some((r) => r.id === id)) {
        return list.map((r) => (r.id === id ? { ...r, ...built.draft } : r));
      }
      return [...list, { id: crypto.randomUUID(), enabled: true, ...built.draft }];
    });
    if (duplicate) {
      formError.textContent = `An equivalent rule already exists: ${describeRule(duplicate)}.`;
      setFeedback("");
      renderRules();
      return;
    }
    const wasEditing = id !== null;
    resetForm();
    renderTester();
    setFeedback(wasEditing ? "Rule updated." : `Rule added: ${describeRule(built.draft)}.`, "success");
  })().catch((error: unknown) => setFeedback(`Could not save: ${String(error)}`, "error"));
});

typeSelect.addEventListener("change", updateFormForType);
valueInput.addEventListener("input", updatePreview);
subdomainsInput.addEventListener("change", updatePreview);
cancelEditButton.addEventListener("click", () => {
  resetForm();
  setFeedback("Edit cancelled.");
});
testerInput.addEventListener("input", renderTester);

autoToggle.addEventListener("change", () => {
  const enabled = autoToggle.checked;
  saveAutoMuteEnabled(enabled)
    .then(() => setFeedback(enabled ? "Automatic muting turned on." : "Automatic muting turned off.", "success"))
    .catch((error: unknown) => setFeedback(`Could not save: ${String(error)}`, "error"));
});

async function reload(): Promise<void> {
  const config = await loadConfig();
  rules = config.rules;
  autoMuteEnabled = config.autoMuteEnabled;
  autoToggle.checked = autoMuteEnabled;
  if (editingId !== null && !rules.some((r) => r.id === editingId)) resetForm();
  renderRules();
  renderTester();
  await renderTabs();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (LOCAL_KEYS.rules in changes || LOCAL_KEYS.autoMuteEnabled in changes)) void reload();
  if (area === "session") void renderTabs();
});

const refreshTabs = () => void renderTabs();
chrome.tabs.onCreated.addListener(refreshTabs);
chrome.tabs.onRemoved.addListener(refreshTabs);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url !== undefined || changeInfo.mutedInfo !== undefined || changeInfo.title !== undefined) refreshTabs();
});

updateFormForType();
reload().catch((error: unknown) => setFeedback(`Could not load rules: ${String(error)}`, "error"));
