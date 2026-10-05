#!/usr/bin/env node
/** Compile the unit tests into a scratch directory, run them with node --test, then remove it. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Built next to the sources (tests resolve fixtures relative to the repo root) and removed afterwards.
const out = fs.mkdtempSync(path.join(ROOT, ".unit-build-"));
let code = 0;
try {
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const config = path.join(out, "tsconfig.json");
  fs.writeFileSync(config, JSON.stringify({
    extends: "../tsconfig.json",
    compilerOptions: { rootDir: "..", outDir: "." },
    include: ["../src/**/*", "../test/unit/**/*"],
  }));
  execFileSync(process.execPath, [tsc, "-p", config], { stdio: "inherit" });
  const dir = path.join(out, "test", "unit");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).map((f) => path.join(dir, f));
  execFileSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: ROOT });
} catch (e) {
  code = typeof e.status === "number" ? e.status : 1;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
process.exit(code);
