import { isMutedBySelf } from "./decide";
import type { MutedInfoLike, TabState } from "./types";

/** Human-readable description of a tab's actual mute state. */
export function describeMuteState(mutedInfo: MutedInfoLike, state: TabState | null, selfId: string): string {
  if (!mutedInfo.muted) return "Not muted";
  if (isMutedBySelf(mutedInfo, selfId)) {
    if (state?.autoMuted) return "Muted automatically by Hush Rules";
    return "Muted manually (via Hush Rules)";
  }
  if (mutedInfo.reason === "user") return "Muted by you";
  if (mutedInfo.reason === "extension") return "Muted by another extension";
  if (mutedInfo.reason === "capture") return "Muted by tab capture";
  return "Muted";
}
