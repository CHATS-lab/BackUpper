#!/usr/bin/env node
/**
 * Chain-mode copy helper: `node capture.js <src> <dest> [<src> <dest> ...]`.
 *
 * In a non-bypass permission mode the pre-tool hook executes nothing and hands the host
 * `node capture.js ... && <original command>`. Claude Code checks each `&&` segment on its own
 * and path-checks `cp`/`mkdir` against its deny rules (BackUpper denies file tools under
 * .backupper/), so the copies run through this script, which `backupper install claude-code`
 * allows. It copies only into a trash folder the hook has just recorded: every <dest> must be
 * listed in the `deferredCopies` of that action's metadata.json and must not exist yet.
 * Exit 1 on any refusal or failure, so `&&` keeps the original command from running.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

function fail(msg: string): never {
  process.stderr.write(`[BackUpper] capture: ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) fail("expected <src> <dest> pairs");
for (let i = 0; i < args.length; i += 2) {
  const src = args[i];
  const dest = args[i + 1];
  if (!path.isAbsolute(dest) || path.resolve(dest) !== dest) fail(`not a normalized absolute path: ${dest}`);
  const trash = path.dirname(dest);
  if (path.basename(trash) !== "trash") fail(`not a trash folder: ${trash}`);
  let listed = false;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(trash), "metadata.json"), "utf-8"));
    listed = Array.isArray(meta) && meta.some((a) => Array.isArray(a?.deferredCopies) && a.deferredCopies.includes(dest));
  } catch { /* not listed */ }
  if (!listed) fail(`${dest} is not a copy the hook recorded`);
  if (fs.existsSync(dest)) fail(`${dest} already exists`);
  try {
    fs.mkdirSync(trash, { recursive: true });
    execFileSync("cp", ["-a", "--", src, dest], { stdio: ["ignore", "ignore", "inherit"] });
  } catch (e) {
    fail(`copy of ${src} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
