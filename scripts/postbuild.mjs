#!/usr/bin/env node
/** Copy the dashboard's static assets into dist/ and mark the CLI executable. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(ROOT, "src", "dashboard", "static");
const to = path.join(ROOT, "dist", "dashboard", "static");
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
fs.chmodSync(path.join(ROOT, "dist", "cli.js"), 0o755);
