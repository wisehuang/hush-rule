/** Messages sent from extension pages to the service worker. */
export interface SetManualMuteMessage {
  type: "set-manual-mute";
  tabId: number;
  muted: boolean;
}

export interface SetManualMuteResponse {
  ok: boolean;
  error?: string;
}

export type ExtensionMessage = SetManualMuteMessage;

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === "set-manual-mute" && Number.isInteger(v.tabId) && typeof v.muted === "boolean";
}
