/**
 * Chain-mode bookkeeping: a tier-1 artifact whose copies were prepended to the command
 * (`deferredCopies`) is only real if the host ran the command. When any copy is missing (the
 * call was denied, or never ran), the artifact is dropped from the action's metadata; an
 * action left with no artifacts is removed together with its timing-ledger line.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BackupArtifact } from "../types.js";
import { readJson } from "../util/jsonfile.js";

export function settleDeferredCopies(actionDir: string | null | undefined): void {
  if (!actionDir) return;
  const metaPath = path.join(actionDir, "metadata.json");
  const artifacts = readJson<BackupArtifact[] | null>(metaPath, null);
  if (!Array.isArray(artifacts)) return;
  const kept = artifacts.filter((a) => !a.deferredCopies?.length || a.deferredCopies.every((p) => fs.existsSync(p)));
  if (kept.length === artifacts.length) return;
  if (kept.length > 0) {
    fs.writeFileSync(metaPath, JSON.stringify(kept, null, 2) + "\n", "utf-8");
    return;
  }
  const actionName = path.basename(actionDir);
  try { fs.rmSync(actionDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try {
    const ledger = path.join(path.dirname(path.dirname(actionDir)), "backup-timings.jsonl");
    if (fs.existsSync(ledger)) {
      const lines = fs.readFileSync(ledger, "utf-8").split("\n").filter((line) => {
        if (!line.trim()) return false;
        try { return (JSON.parse(line) as { action?: string }).action !== actionName; }
        catch { return true; }
      });
      fs.writeFileSync(ledger, lines.length ? lines.join("\n") + "\n" : "");
    }
  } catch { /* ignore */ }
}
