/**
 * Recovery awareness: a one-line notice telling the main agent that a
 * restore rewound the workspace since its last action — so it doesn't
 * silently lose track of state that changed underneath it.
 *
 * Backups stay silent-ish (the agent doesn't need a play-by-play of
 * every snapshot); the RECOVERY direction is what surprises an agent,
 * because files it already read can revert without it knowing.
 *
 * Shown once per restore: a marker file records the last restore ts we
 * already surfaced, so the notice doesn't repeat on every later action.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxConfig } from "../types.js";
import { readRestoreHistory } from "../restore/restore.js";

function markerPath(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), ".restore-seen");
}

/**
 * Returns a concise notice if a restore happened that the agent hasn't
 * been told about yet, else null. Updates the marker as a side effect
 * so each restore is announced exactly once. Best-effort: never throws.
 */
export function pendingRecoveryNotice(config: SandboxConfig): string | null {
  try {
    const history = readRestoreHistory(config, 5); // newest first
    if (history.length === 0) return null;
    const latest = history[0];

    const marker = markerPath(config);
    let lastSeen = "";
    try { lastSeen = fs.readFileSync(marker, "utf-8").trim(); } catch { /* none */ }
    if (latest.ts === lastSeen) return null; // already announced

    fs.writeFileSync(marker, latest.ts, "utf-8");

    const where = latest.seq !== null ? `action ${String(latest.seq).padStart(3, "0")}` : latest.action;
    const what = latest.fileOnly
      ? `\`${latest.fileOnly}\` restored`
      : `${latest.ok} file(s) restored`;
    const failed = latest.failed > 0 ? `, ${latest.failed} failed` : "";
    // No "[CHATS-Sandbox]" prefix — the hook's contextMsg wrapper adds it.
    return `↩ Recovery: workspace rewound to ${where} (${what}${failed}). ` +
      `Re-read open files before editing — their contents may have changed.`;
  } catch {
    return null;
  }
}
