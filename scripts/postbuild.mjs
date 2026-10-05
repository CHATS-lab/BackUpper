#!/usr/bin/env node
/** Mark the built CLI executable. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.chmodSync(path.join(ROOT, "dist", "cli.js"), 0o755);
