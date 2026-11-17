import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { actionAppearance } from "../src/core/action-icon";

describe("actionAppearance", () => {
  it.each([true, false])("points to existing icon files (muted=%s)", (muted) => {
    const { path, title } = actionAppearance(muted);
    for (const file of Object.values(path)) expect(existsSync(resolve(__dirname, "../public", file))).toBe(true);
    expect(title).toMatch(muted ? /muted\. Click to unmute/ : /not muted\. Click to mute/);
  });

  it("uses different icons for muted and unmuted", () => {
    expect(actionAppearance(true).path["16"]).not.toBe(actionAppearance(false).path["16"]);
  });
});
