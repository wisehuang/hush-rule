import { describe, expect, it } from "vitest";
import { decide } from "../src/core/decide";
import { describeMuteState } from "../src/core/mute-label";
import type { Rule } from "../src/core/types";
import { FakeBrowser, SELF_ID, navigateNewDocument, navigateSameDocument } from "./fake-browser";

const RULE: Rule = { id: "r1", type: "domain", value: "loud.test", includeSubdomains: true, enabled: true };

function setup() {
  const fake = new FakeBrowser();
  fake.rules = [RULE];
  return { fake, controller: fake.controller() };
}

describe("automatic muting", () => {
  it("mutes a matching tab and records ownership", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://www.loud.test/video");
    await controller.evaluateTab(1);
    expect(fake.tab(1).mutedInfo).toEqual({ muted: true, reason: "extension", extensionId: SELF_ID });
    expect(fake.session.get(1)).toEqual({ autoMuted: true, override: null });
  });

  it("leaves non-matching and unsupported tabs alone", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://quiet.test/");
    fake.addTab(2, "chrome://settings/");
    fake.addTab(3, "file:///home/loud.test.html");
    fake.addTab(4, undefined);
    await controller.evaluateAllTabs();
    expect(fake.setMutedCalls).toEqual([]);
    expect(fake.session.size).toBe(0);
  });

  it("waits for the committed URL instead of acting on pendingUrl", async () => {
    const { fake, controller } = setup();
    const tab = fake.addTab(1, undefined);
    tab.pendingUrl = "https://loud.test/";
    await controller.evaluateTab(1);
    expect(fake.setMutedCalls).toEqual([]);
    tab.url = "https://loud.test/";
    await controller.handleNewDocument(1);
    expect(fake.tab(1).mutedInfo.muted).toBe(true);
  });

  it("does not loop: its own mutedInfo change is ignored", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    await controller.evaluateTab(1);
    await controller.handleMutedInfoChanged(1, fake.tab(1).mutedInfo);
    await controller.evaluateTab(1);
    expect(fake.setMutedCalls).toEqual([{ tabId: 1, muted: true }]);
    expect(fake.session.get(1)).toEqual({ autoMuted: true, override: null });
  });
});

describe("leaving a matching URL (test 6)", () => {
  it("restores audio when this extension owns the automatic mute", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    await controller.evaluateTab(1);
    await navigateNewDocument(fake, controller, 1, "https://quiet.test/");
    expect(fake.tab(1).mutedInfo.muted).toBe(false);
    expect(fake.session.has(1)).toBe(false);
  });

  it("restores audio on same-document (SPA) navigation out of a URL-prefix rule", async () => {
    const fake = new FakeBrowser();
    fake.rules = [{ id: "p", type: "url-prefix", value: "https://app.test/watch", includeSubdomains: false, enabled: true }];
    const controller = fake.controller();
    fake.addTab(1, "https://app.test/watch?v=1");
    await controller.evaluateTab(1);
    expect(fake.tab(1).mutedInfo.muted).toBe(true);
    await navigateSameDocument(fake, controller, 1, "https://app.test/home");
    expect(fake.tab(1).mutedInfo.muted).toBe(false);
    await navigateSameDocument(fake, controller, 1, "https://app.test/watch?v=2");
    expect(fake.tab(1).mutedInfo.muted).toBe(true);
  });

  it("does not unmute when mutedInfo no longer names this extension", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    await controller.evaluateTab(1);
    // Another extension re-mutes the tab; Chrome now reports it as the source.
    const info = fake.externalMute(1, true, "extension", "other-extension");
    await controller.handleMutedInfoChanged(1, info);
    await navigateNewDocument(fake, controller, 1, "https://quiet.test/");
    expect(fake.tab(1).mutedInfo).toEqual(info);
    expect(fake.setMutedCalls).toEqual([{ tabId: 1, muted: true }]);
  });

  it("does not unmute even without the event if ownership state disagrees with mutedInfo", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://quiet.test/", { muted: true, reason: "user" });
    fake.session.set(1, { autoMuted: true, override: null }); // stale/corrupt state
    await controller.evaluateTab(1);
    expect(fake.tab(1).mutedInfo.muted).toBe(true);
    expect(fake.session.get(1)).toMatchObject({ autoMuted: false, override: { muted: true, source: "external" } });
  });

  it("does not revert a user unmute whose onUpdated event has not been handled yet", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    await controller.evaluateTab(1);
    fake.externalMute(1, false); // event still pending
    await controller.evaluateTab(1);
    expect(fake.tab(1).mutedInfo.muted).toBe(false);
    await controller.handleMutedInfoChanged(1, fake.tab(1).mutedInfo);
    await navigateSameDocument(fake, controller, 1, "https://loud.test/next");
    expect(fake.tab(1).mutedInfo.muted).toBe(false);
  });

  it("restores on rule deletion, rule disabling and global off — only for owned mutes", async () => {
    for (const change of ["delete", "disable", "global-off"] as const) {
      const { fake, controller } = setup();
      fake.addTab(1, "https://loud.test/"); // will be auto-muted
      fake.addTab(2, "https://loud.test/", { muted: true, reason: "user" }); // user-muted
      await controller.evaluateAllTabs();
      if (change === "delete") fake.rules = [];
      if (change === "disable") fake.rules = [{ ...RULE, enabled: false }];
      if (change === "global-off") fake.autoMuteEnabled = false;
      await controller.evaluateAllTabs();
      expect(fake.tab(1).mutedInfo.muted, change).toBe(false);
      expect(fake.tab(2).mutedInfo, change).toEqual({ muted: true, reason: "user" });
    }
  });
});

describe("tabs that were already muted (test 7)", () => {
  it("stays muted and is not claimed", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/", { muted: true, reason: "user" });
    await controller.evaluateTab(1);
    expect(fake.setMutedCalls).toEqual([]);
    expect(fake.session.has(1)).toBe(false);
    await navigateNewDocument(fake, controller, 1, "https://quiet.test/");
    expect(fake.tab(1).mutedInfo).toEqual({ muted: true, reason: "user" });
  });

  it("a mute left over from this extension without recorded ownership is not claimed", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://quiet.test/", { muted: true, reason: "extension", extensionId: SELF_ID });
    await controller.evaluateTab(1);
    expect(fake.tab(1).mutedInfo.muted).toBe(true);
  });
});

describe("manual overrides (test 8)", () => {
  it("manual unmute on a matching page is not reversed by tab events or SPA navigation", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/a");
    await controller.evaluateTab(1);
    expect(await controller.setManualMute(1, false)).toBe(true);
    await controller.evaluateTab(1); // e.g. status/title update
    await navigateSameDocument(fake, controller, 1, "https://loud.test/b");
    await controller.evaluateAllTabs(); // e.g. a rule change elsewhere
    expect(fake.tab(1).mutedInfo.muted).toBe(false);
  });

  it("is cleared by a reload or a new document", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    await controller.evaluateTab(1);
    await controller.setManualMute(1, false);
    await navigateNewDocument(fake, controller, 1, "https://loud.test/"); // reload
    expect(fake.tab(1).mutedInfo.muted).toBe(true);
    expect(fake.session.get(1)).toEqual({ autoMuted: true, override: null });
  });

  it("is cleared when only the documentId changed (missed commit event)", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    await controller.setManualMute(1, false);
    await controller.evaluateTab(1);
    expect(fake.tab(1).mutedInfo.muted).toBe(false);
    fake.tab(1).documentId = fake.newDocumentId();
    await controller.evaluateTab(1);
    expect(fake.tab(1).mutedInfo.muted).toBe(true);
  });

  it("manual mute is not treated as automatic: global off and leaving the match keep it muted", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://quiet.test/");
    await controller.setManualMute(1, true);
    fake.autoMuteEnabled = false;
    await controller.evaluateAllTabs();
    expect(fake.tab(1).mutedInfo.muted).toBe(true);
    // Even after the override expires, the mute is not owned, so it stays.
    await navigateNewDocument(fake, controller, 1, "https://other.test/");
    expect(fake.tab(1).mutedInfo.muted).toBe(true);
    expect(describeMuteState(fake.tab(1).mutedInfo, fake.session.get(1) ?? null, SELF_ID)).toBe(
      "Muted manually (via Hush Rules)",
    );
  });

  it("manual mute over an automatic mute drops ownership", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    await controller.evaluateTab(1);
    await controller.setManualMute(1, true);
    await navigateNewDocument(fake, controller, 1, "https://quiet.test/");
    expect(fake.tab(1).mutedInfo.muted).toBe(true);
  });

  it("user unmute via the tab strip is not immediately reverted", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    await controller.evaluateTab(1);
    await controller.handleMutedInfoChanged(1, fake.externalMute(1, false));
    await navigateSameDocument(fake, controller, 1, "https://loud.test/next");
    expect(fake.tab(1).mutedInfo.muted).toBe(false);
    await navigateNewDocument(fake, controller, 1, "https://loud.test/other");
    expect(fake.tab(1).mutedInfo.muted).toBe(true);
  });
});

describe("external change racing a navigation", () => {
  it("drops ownership on commit instead of carrying an old-document unmute over", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/a");
    await controller.evaluateTab(1);
    fake.externalMute(1, false); // user unmuted document A; its event is not handled yet
    await navigateNewDocument(fake, controller, 1, "https://loud.test/b");
    expect(fake.tab(1).mutedInfo.muted).toBe(true); // rules apply to the new document
    expect(fake.session.get(1)).toEqual({ autoMuted: true, override: null });
  });
});

describe("unsupported pages", () => {
  it("navigating to an unsupported page ends overrides", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    await controller.setManualMute(1, false);
    fake.tab(1).url = "chrome://settings/";
    await controller.evaluateTab(1);
    expect(fake.session.has(1)).toBe(false);
  });
});

describe("service worker restart (test 9)", () => {
  it("ownership and overrides survive a new controller instance", async () => {
    const fake = new FakeBrowser();
    fake.rules = [RULE];
    fake.addTab(1, "https://loud.test/");
    fake.addTab(2, "https://loud.test/");
    const first = fake.controller();
    await first.evaluateAllTabs();
    await first.setManualMute(2, false);

    const second = fake.controller(); // module-level state is gone
    await navigateNewDocument(fake, second, 1, "https://quiet.test/");
    expect(fake.tab(1).mutedInfo.muted).toBe(false); // ownership remembered → restored
    await second.evaluateTab(2);
    expect(fake.tab(2).mutedInfo.muted).toBe(false); // override remembered → not re-muted
  });
});

describe("closed tabs and races (test 10)", () => {
  it("closed or invalid tabs produce no unhandled errors", async () => {
    const { fake, controller } = setup();
    await expect(controller.evaluateTab(999)).resolves.toBeUndefined();
    await expect(controller.handleMutedInfoChanged(999, { muted: true, reason: "user" })).resolves.toBeUndefined();
    await expect(controller.handleNewDocument(999)).resolves.toBeUndefined();
    await expect(controller.handleTabRemoved(999)).resolves.toBeUndefined();
    await expect(controller.setManualMute(999, true)).resolves.toBe(false);
    expect(fake.session.size).toBe(0);
  });

  it("tab closing between decision and update is handled", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    let calls = 0;
    fake.onGetTab = (id) => {
      if (++calls === 2) fake.tabs.delete(id); // closes right before the re-check
    };
    await expect(controller.evaluateTab(1)).resolves.toBeUndefined();
    expect(fake.setMutedCalls).toEqual([]);
    expect(fake.session.has(1)).toBe(false);
  });

  it("setMuted failing (tab gone) does not record ownership", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    fake.api.setMuted = async () => {
      fake.tabs.delete(1);
      throw new Error("No tab with id: 1.");
    };
    await expect(controller.evaluateTab(1)).resolves.toBeUndefined();
    expect(fake.session.has(1)).toBe(false);
  });

  it("re-decides when the URL changes during evaluation (navigation race)", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    let calls = 0;
    fake.onGetTab = (id) => {
      if (++calls === 2) fake.tab(id).url = "https://quiet.test/"; // navigated away mid-evaluation
    };
    await controller.evaluateTab(1);
    expect(fake.setMutedCalls).toEqual([]);
    expect(fake.tab(1).mutedInfo.muted).toBe(false);
  });

  it("concurrent events for one tab are serialized", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    await Promise.all([
      controller.evaluateTab(1),
      controller.evaluateTab(1),
      controller.handleNewDocument(1),
      controller.evaluateAllTabs(),
    ]);
    expect(fake.setMutedCalls).toEqual([{ tabId: 1, muted: true }]);
  });

  it("removes state on tab close and prunes stale state on re-evaluation", async () => {
    const { fake, controller } = setup();
    fake.addTab(1, "https://loud.test/");
    await controller.evaluateTab(1);
    await controller.handleTabRemoved(1);
    expect(fake.session.has(1)).toBe(false);
    fake.session.set(42, { autoMuted: true, override: null });
    await controller.evaluateAllTabs();
    expect(fake.session.has(42)).toBe(false);
  });
});

describe("decide (pure)", () => {
  it("does nothing until a URL is known", () => {
    const d = decide({
      tab: { url: undefined, mutedInfo: { muted: false }, documentId: null },
      state: { autoMuted: false, override: null },
      rules: [RULE],
      autoMuteEnabled: true,
      selfId: SELF_ID,
    });
    expect(d.action).toBe("none");
  });

  it("keeps an override recorded without documentId until a commit clears it", () => {
    const d = decide({
      tab: { url: "https://loud.test/", mutedInfo: { muted: false }, documentId: "doc-9" },
      state: { autoMuted: false, override: { muted: false, documentId: null, source: "popup" } },
      rules: [RULE],
      autoMuteEnabled: true,
      selfId: SELF_ID,
    });
    expect(d.action).toBe("none");
    expect(d.reason).toBe("override");
  });
});
