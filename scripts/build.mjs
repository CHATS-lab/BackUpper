#!/usr/bin/env node
/**
 * Build helpers, one subcommand each (run by the npm scripts in package.json):
 *
 *   node scripts/build.mjs prompts                 src/prompts.md -> src/prompts.generated.ts
 *   node scripts/build.mjs postbuild               mark the built CLI executable
 *   node scripts/build.mjs config-doc [--check]    the configuration table in src/config/README.md
 *
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// =============================================================================
// prompts
// =============================================================================

/**
 * `prompts`: generate src/prompts.generated.ts from src/prompts.md.
 *
 * Every prompt the plugin sends to a model is ONE section of src/prompts.md, starting
 * at a `<!-- prompt: <name> -->` line and running to the next one, read the way a
 * human reads the prompt (the text above the first such line is the file's
 * introduction):
 *
 *   <!-- prompt: <name> -->
 *   ---
 *   name: <name>
 *   loaded_from: <the TypeScript site that renders it>
 *   used_in: <where it matters>
 *   placeholders: [TOKEN, ...]        # every {{TOKEN}} in the body and its sections
 *   sections: [name, ...]             # the named sections, in file order
 *   ---
 *
 *   # <title>
 *
 *   <main body>
 *
 *   <!-- section: <name> -->
 *   <conditional / optional fragment the code glues in>
 *   <!-- /section -->
 *
 * Each prompt becomes `export const <UPPER_SNAKE(name)> = { body, sections: {...} }`
 * and the code renders {{TOKEN}}s with `render(text, vars)` in a single pass: a
 * substituted value is never re-scanned.
 *
 * Bodies and sections never start or end with a newline; the code that glues a
 * block in adds any surrounding newlines. This keeps the text robust to editors
 * that trim blank lines.
 *
 *   node scripts/build.mjs prompts           # write src/prompts.generated.ts
 *
 * No dependencies. Run by `npm run build` and `npm run typecheck`.
 */
const PROMPTS = path.join(ROOT, "src", "prompts.md");
const PROMPT_START = /^<!-- prompt: ([a-z0-9-]+) -->$/;
const OUT = path.join(ROOT, "src", "prompts.generated.ts");

const SECTION_OPEN = /^<!-- section: ([a-z0-9-]+) -->$/;
const SECTION_CLOSE = "<!-- /section -->";

function checkBody(where, body) {
  if (body.startsWith("\n") || body.endsWith("\n")) {
    throw new Error(`${where}: text must not start or end with a newline (the code adds structural newlines)`);
  }
  return body;
}

/** Parse a front-matter list value such as `[a, b, c]` into its trimmed, non-empty items. */
function parseList(value) {
  return (value ?? "[]")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** prompts.md -> [{ name, text }], one entry per `<!-- prompt: <name> -->` section. */
export function splitPromptsMd(file) {
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const out = [];
  for (const line of lines) {
    const m = line.match(PROMPT_START);
    if (m) out.push({ name: m[1], lines: [] });
    else if (out.length) out[out.length - 1].lines.push(line);
  }
  // Each prompt's text ends with the newline before the next marker (or the file's last one).
  return out.map((p, i) => ({
    name: p.name,
    text: p.lines.join("\n") + (i < out.length - 1 ? "\n" : ""),
  }));
}

/** Parse one prompt's text (as it appears under its prompt: line). */
export function parsePromptMd(text, base) {
  if (!text.startsWith("---\n")) throw new Error(`prompts.md ${base}: missing front-matter`);
  const fmEnd = text.indexOf("\n---\n", 4);
  if (fmEnd < 0) throw new Error(`prompts.md ${base}: unterminated front-matter`);
  const fm = {};
  for (const line of text.slice(4, fmEnd).split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2];
  }
  if (fm.name !== base) throw new Error(`prompts.md ${base}: front-matter name "${fm.name}" != its prompt: line`);
  let rest = text.slice(fmEnd + "\n---\n".length);
  if (!rest.startsWith("\n# ")) {
    throw new Error(`prompts.md ${base}: expected a blank line and a "# Title" line after the front-matter`);
  }
  const titleEnd = rest.indexOf("\n", 1);
  const title = rest.slice(3, titleEnd);
  rest = rest.slice(titleEnd + 1);
  if (!rest.startsWith("\n")) throw new Error(`prompts.md ${base}: expected a blank line after the title`);
  rest = rest.slice(1);
  if (rest.endsWith("\n")) rest = rest.slice(0, -1);   // the file's final newline only

  // Main body = everything before the first section marker line; sections follow,
  // separated by blank lines only.
  const lines = rest.split("\n");
  let i = 0;
  const bodyLines = [];
  while (i < lines.length && !SECTION_OPEN.test(lines[i])) bodyLines.push(lines[i++]);
  let body = bodyLines.join("\n");
  if (i < lines.length) body = body.replace(/\n+$/, "");   // blank line(s) before the first section
  checkBody(`prompts.md ${base} body`, body);
  const sections = {};
  const order = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const m = line.match(SECTION_OPEN);
    if (!m) throw new Error(`prompts.md ${base} line ${i + 1}: text outside a section after the main body`);
    const name = m[1];
    if (name in sections) throw new Error(`prompts.md ${base}: duplicate section ${name}`);
    const start = ++i;
    while (i < lines.length && lines[i] !== SECTION_CLOSE) i++;
    if (i >= lines.length) throw new Error(`prompts.md ${base}: section ${name} is not closed`);
    sections[name] = checkBody(`prompts.md ${base} section ${name}`, lines.slice(start, i).join("\n"));
    order.push(name);
    i++;
  }
  const declaredSections = parseList(fm.sections);
  if (JSON.stringify(declaredSections) !== JSON.stringify(order)) {
    throw new Error(`prompts.md ${base}: front-matter sections [${declaredSections}] do not match the prompt's [${order}]`);
  }
  const all = [body, ...Object.values(sections)].join("\n");
  const found = [...new Set([...all.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))].sort();
  const declared = parseList(fm.placeholders).sort();
  if (JSON.stringify(found) !== JSON.stringify(declared)) {
    throw new Error(`prompts.md ${base}: placeholders [${declared}] do not match the text's [${found}]`);
  }
  return {
    name: base,
    constName: base.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    title,
    fm,
    body,
    sections,
    order,
    placeholders: found,
  };
}

export function generate() {
  const prompts = splitPromptsMd(PROMPTS).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = [
    "// GENERATED by `scripts/build.mjs prompts` from src/prompts.md -- DO NOT EDIT.",
    "// Edit src/prompts.md and run `npm run build`.",
    "",
  ];
  const seen = new Set();
  for (const { name, text } of prompts) {
    const p = parsePromptMd(text, name);
    if (seen.has(p.constName)) throw new Error(`duplicate constant ${p.constName}`);
    seen.add(p.constName);
    const placeholderNote = p.placeholders.length ? ` (placeholders: ${p.placeholders.join(", ")})` : "";
    out.push(`/** prompts.md: ${p.name} -- ${p.title}${placeholderNote} */`);
    out.push(`export const ${p.constName} = {`);
    out.push(`  body: ${JSON.stringify(p.body)},`);
    out.push("  sections: {");
    for (const name of p.order) out.push(`    ${JSON.stringify(name)}: ${JSON.stringify(p.sections[name])},`);
    out.push("  },");
    out.push("} as const;");
    out.push("");
  }
  out.push(
    "/** Replace every {{KEY}} named in `vars`; unknown tokens are left as they are.",
    " *  Single pass, so a substituted value is never re-scanned (like template literals). */",
    "export function render(text: string, vars: Record<string, unknown>): string {",
    "  return text.replace(/\\{\\{([A-Z0-9_]+)\\}\\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));",
    "}",
    "",
  );
  return out.join("\n");
}

function promptsMain() {
  const text = generate();
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf-8") : null;
  if (current !== text) fs.writeFileSync(OUT, text);
  console.log(`build prompts: wrote ${path.relative(ROOT, OUT)} (${(text.match(/^export const /gm) ?? []).length} prompts)`);
}

// =============================================================================
// postbuild
// =============================================================================

/** Mark the built CLI executable. */
function postbuildMain() {
  fs.chmodSync(path.join(ROOT, "dist", "cli.js"), 0o755);
}

// =============================================================================
// config-doc
// =============================================================================

/**
 * `config-doc`: generate the configuration table in src/config/README.md from the built schema (dist/config/schema.js) and
 * defaults (dist/types.js), between the `config-table` markers.
 *
 *   node scripts/build.mjs config-doc           rewrite src/config/README.md
 *   node scripts/build.mjs config-doc --check   exit 1 when src/config/README.md is out of date
 */
/** Keys left out of the README table (still settable and validated). */
const OMIT = new Set(["denyPatterns"]);
const START = "<!-- config-table:start (generated by `npm run docs` from src/config/schema.ts; do not edit) -->";
const END = "<!-- config-table:end -->";

function kindText(kind) {
  switch (kind.type) {
    case "enum": return kind.values.map((v) => (v === "" ? '`""`' : `\`${v}\``)).join(", ");
    case "json": return `JSON ${kind.shape}`;
    default: return kind.type;
  }
}

function defaultText(v) {
  if (v === undefined) return "unset";
  if (Array.isArray(v)) return `${v.length} pattern${v.length === 1 ? "" : "s"}`;
  return `\`${JSON.stringify(v)}\``;
}

function configDocMain() {
  const require = createRequire(import.meta.url);
  const { CONFIG_SCHEMA, CONFIG_DOCS } = require(path.join(ROOT, "dist", "config", "schema.js"));
  const { DEFAULT_CONFIG } = require(path.join(ROOT, "dist", "types.js"));

  const keys = Object.keys(CONFIG_SCHEMA);
  const undocumented = keys.filter((k) => !CONFIG_DOCS[k]);
  const stale = Object.keys(CONFIG_DOCS).filter((k) => !(k in CONFIG_SCHEMA));
  if (undocumented.length || stale.length) {
    console.error(`CONFIG_DOCS out of step with CONFIG_SCHEMA: missing [${undocumented}] extra [${stale}]`);
    process.exit(1);
  }

  const rows = keys
    .filter((k) => !OMIT.has(k))
    .map((k) => `| \`${k}\` | ${kindText(CONFIG_SCHEMA[k])} | ${defaultText(DEFAULT_CONFIG[k])} | ${CONFIG_DOCS[k]} |`);
  const table = [START, "", "| key | values | default | meaning |", "|---|---|---|---|", ...rows, "", END].join("\n");

  const readmePath = path.join(ROOT, "src", "config", "README.md");
  const readme = fs.readFileSync(readmePath, "utf-8");
  const i = readme.indexOf(START);
  const j = readme.indexOf(END);
  if (i < 0 || j < i) {
    console.error("src/config/README.md has no config-table markers");
    process.exit(1);
  }
  const next = readme.slice(0, i) + table + readme.slice(j + END.length);

  if (process.argv.includes("--check")) {
    if (next !== readme) {
      console.error("src/config/README.md configuration table is out of date: run `npm run docs`");
      process.exit(1);
    }
    console.log(`README configuration table is current (${rows.length} keys)`);
  } else {
    fs.writeFileSync(readmePath, next);
    console.log(`README configuration table written (${rows.length} keys)`);
  }
}

// =============================================================================
// dispatch
// =============================================================================

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const sub = process.argv[2];
  if (sub === "prompts") promptsMain();
  else if (sub === "postbuild") postbuildMain();
  else if (sub === "config-doc") configDocMain();
  else {
    console.error("usage: node scripts/build.mjs prompts | postbuild | config-doc [--check]");
    process.exit(2);
  }
}
