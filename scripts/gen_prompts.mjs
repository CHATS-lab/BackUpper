#!/usr/bin/env node
/**
 * Generate src/prompts.generated.ts from prompts/*.md.
 *
 * Every prompt the plugin sends to a model is ONE markdown file under prompts/,
 * read the way a human reads the prompt:
 *
 *   ---
 *   name: <file basename>
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
 * The file becomes `export const <UPPER_SNAKE(name)> = { body, sections: {...} }`
 * and the code renders {{TOKEN}}s with `render(text, vars)` in a single pass: a
 * substituted value is never re-scanned.
 *
 * Bodies and sections never start or end with a newline; the code that glues a
 * block in adds any surrounding newlines. This keeps the files robust to editors
 * that trim blank lines.
 *
 *   node scripts/gen_prompts.mjs            # write src/prompts.generated.ts
 *
 * No dependencies. Run by `npm run build`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS = path.join(ROOT, "prompts");
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

export function parsePromptMd(file) {
  const text = fs.readFileSync(file, "utf-8");
  const base = path.basename(file, ".md");
  if (!text.startsWith("---\n")) throw new Error(`${base}.md: missing front-matter`);
  const fmEnd = text.indexOf("\n---\n", 4);
  if (fmEnd < 0) throw new Error(`${base}.md: unterminated front-matter`);
  const fm = {};
  for (const line of text.slice(4, fmEnd).split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2];
  }
  if (fm.name !== base) throw new Error(`${base}.md: front-matter name "${fm.name}" != file name`);
  let rest = text.slice(fmEnd + "\n---\n".length);
  if (!rest.startsWith("\n# ")) {
    throw new Error(`${base}.md: expected a blank line and a "# Title" line after the front-matter`);
  }
  const titleEnd = rest.indexOf("\n", 1);
  const title = rest.slice(3, titleEnd);
  rest = rest.slice(titleEnd + 1);
  if (!rest.startsWith("\n")) throw new Error(`${base}.md: expected a blank line after the title`);
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
  checkBody(`${base}.md body`, body);
  const sections = {};
  const order = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const m = line.match(SECTION_OPEN);
    if (!m) throw new Error(`${base}.md line ${i + 1}: text outside a section after the main body`);
    const name = m[1];
    if (name in sections) throw new Error(`${base}.md: duplicate section ${name}`);
    const start = ++i;
    while (i < lines.length && lines[i] !== SECTION_CLOSE) i++;
    if (i >= lines.length) throw new Error(`${base}.md: section ${name} is not closed`);
    sections[name] = checkBody(`${base}.md section ${name}`, lines.slice(start, i).join("\n"));
    order.push(name);
    i++;
  }
  const declaredSections = parseList(fm.sections);
  if (JSON.stringify(declaredSections) !== JSON.stringify(order)) {
    throw new Error(`${base}.md: front-matter sections [${declaredSections}] do not match the file's [${order}]`);
  }
  const all = [body, ...Object.values(sections)].join("\n");
  const found = [...new Set([...all.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))].sort();
  const declared = parseList(fm.placeholders).sort();
  if (JSON.stringify(found) !== JSON.stringify(declared)) {
    throw new Error(`${base}.md: placeholders [${declared}] do not match the text's [${found}]`);
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
  const files = fs.readdirSync(PROMPTS).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  const out = [
    "// GENERATED by scripts/gen_prompts.mjs from prompts/*.md -- DO NOT EDIT.",
    "// Edit the markdown file and run `npm run build`.",
    "",
  ];
  const seen = new Set();
  for (const f of files) {
    const p = parsePromptMd(path.join(PROMPTS, f));
    if (seen.has(p.constName)) throw new Error(`duplicate constant ${p.constName}`);
    seen.add(p.constName);
    const placeholderNote = p.placeholders.length ? ` (placeholders: ${p.placeholders.join(", ")})` : "";
    out.push(`/** prompts/${p.name}.md -- ${p.title}${placeholderNote} */`);
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const text = generate();
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf-8") : null;
  if (current !== text) fs.writeFileSync(OUT, text);
  console.log(`gen_prompts: wrote ${path.relative(ROOT, OUT)} (${(text.match(/^export const /gm) ?? []).length} prompts)`);
}
