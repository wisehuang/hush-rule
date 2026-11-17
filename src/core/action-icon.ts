/** Toolbar button appearance for a tab, based on its actual mute state. */
export interface ActionAppearance {
  path: Record<"16" | "32", string>;
  title: string;
}

export function actionAppearance(muted: boolean): ActionAppearance {
  const variant = muted ? "muted" : "unmuted";
  return {
    path: { "16": `icons/action-${variant}-16.png`, "32": `icons/action-${variant}-32.png` },
    title: muted ? "Hush Rules – tab is muted. Click to unmute." : "Hush Rules – tab is not muted. Click to mute.",
  };
}
