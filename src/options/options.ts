import { buildRuleDraft, findDuplicateRule, isSupportedUrl, ruleMatchesUrl } from "../core/rules";
import type { Rule, RuleType } from "../core/types";
import { byId, describeRule, el } from "../shared/dom";
import { LOCAL_KEYS, loadConfig, saveAutoMuteEnabled, updateRules } from "../shared/storage";

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
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (LOCAL_KEYS.rules in changes || LOCAL_KEYS.autoMuteEnabled in changes)) void reload();
});

updateFormForType();
reload().catch((error: unknown) => setFeedback(`Could not load rules: ${String(error)}`, "error"));
