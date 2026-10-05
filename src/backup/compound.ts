/**
 * Splits a Bash command line into the simple commands it runs, so tier 1 can capture each one
 * (copy-only) instead of standing down on anything compound. Handles `&&`, `||`, `;`, `|`, `&`
 * and newlines, follows `cd DIR` / `pushd DIR` for later segments, and unwraps `bash -c '…'`,
 * `sh -c "…"` and a heredoc fed to a shell. Anything it cannot see through (command
 * substitution, subshell groups, unknown directory) is returned marked `unparseable`, so the
 * caller can route it to tier 4 or record it as not captured.
 */

import * as os from "node:os";
import * as path from "node:path";

export interface CmdSegment {
  /** The simple command as written (keyword and `NAME=value` prefixes removed, heredoc body dropped). */
  text: string;
  /** Directory the segment runs in, or null when it cannot be known (e.g. `cd "$X"`). */
  cwd: string | null;
  /** Write-redirection targets (`>`, `>>`, `>|`, `&>`), as written. */
  redirects: string[];
  /** Set when the segment cannot be analysed; the reason. */
  unparseable?: string;
  /** True for segments that run nothing (`cd`, `fi`, assignments, loop headers). */
  noop?: boolean;
}

export interface CommandPlan {
  segments: CmdSegment[];
  /** More than one segment, a directory change, or an unwrapped shell: not a single simple command. */
  compound: boolean;
}

const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const KEYWORD_PREFIX = /^(?:!|do|then|else|elif|if|while|until|\{)\s+/;
const KEYWORD_ONLY = /^(?:done|fi|esac|do|then|else|\}|;;|\{)$/;
const FOR_HEADER = /^for\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+in(?:\s[^\n\r]*)?)?$/;
const ASSIGN_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;|&<>]*)\s*/;

interface RawSegment { text: string; heredocs: string[]; unparseable?: string }

/** Split at top-level separators, collecting heredoc bodies. Never throws. */
function splitRaw(command: string): RawSegment[] {
  const out: RawSegment[] = [];
  let buf = "";
  let heredocs: string[] = [];
  let unparseable: string | undefined;
  const pending: Array<{ delim: string; strip: boolean }> = [];
  const push = (): void => {
    if (buf.trim() || heredocs.length) out.push({ text: buf.trim(), heredocs, unparseable });
    buf = "";
    heredocs = [];
    unparseable = undefined;
  };
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i];
    if (c === "\\" && i + 1 < n) {
      // A backslash-newline continues the line.
      if (command[i + 1] === "\n") { i += 2; continue; }
      buf += c + command[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) { buf += command.slice(i); unparseable = "unterminated quote"; i = n; break; }
      buf += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < n; j++) {
        if (command[j] === "\\") { j++; continue; }
        if (command[j] === '"') break;
      }
      const seg = command.slice(i, Math.min(j + 1, n));
      if (/\$\(|`/.test(seg)) unparseable = "command substitution";
      if (j >= n) unparseable = "unterminated quote";
      buf += seg;
      i = j + 1;
      continue;
    }
    if (c === "`" || (c === "$" && command[i + 1] === "(")) {
      // Copy the substitution through its matching closer; its value is unknowable here.
      unparseable = "command substitution";
      if (c === "`") {
        const end = command.indexOf("`", i + 1);
        const stop = end === -1 ? n : end + 1;
        buf += command.slice(i, stop);
        i = stop;
      } else {
        let depth = 0;
        let j = i + 1;
        for (; j < n; j++) {
          if (command[j] === "(") depth++;
          else if (command[j] === ")") { depth--; if (depth === 0) break; }
        }
        buf += command.slice(i, Math.min(j + 1, n));
        i = j + 1;
      }
      continue;
    }
    if (c === "#" && (buf === "" || /\s$/.test(buf))) {
      // A comment runs to the end of the line.
      while (i < n && command[i] !== "\n") i++;
      continue;
    }
    if (c === "(" || c === ")") {
      if (!(c === "(" && command[i - 1] === "$")) unparseable = unparseable ?? "subshell group";
      buf += c;
      i++;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      // Heredoc: read the delimiter; the body starts after the next newline.
      let j = i + 2;
      let strip = false;
      if (command[j] === "-") { strip = true; j++; }
      while (j < n && (command[j] === " " || command[j] === "\t")) j++;
      let delim = "";
      for (; j < n && !/[\s;&|<>()]/.test(command[j]); j++) {
        if (command[j] === "'" || command[j] === '"') continue;
        if (command[j] === "\\") continue;
        delim += command[j];
      }
      if (!delim) { unparseable = "heredoc"; }
      else pending.push({ delim, strip });
      buf += command.slice(i, j);
      i = j;
      continue;
    }
    if (c === "\n" || c === "\r") {
      // Consume the bodies of heredocs opened on this line.
      i++;
      while (pending.length) {
        const h = pending.shift() as { delim: string; strip: boolean };
        const lines: string[] = [];
        let found = false;
        while (i < n) {
          let e = command.indexOf("\n", i);
          if (e === -1) e = n;
          const line = command.slice(i, e);
          i = e + 1;
          const cmp = h.strip ? line.replace(/^\t+/, "") : line;
          if (cmp === h.delim) { found = true; break; }
          lines.push(cmp);
        }
        if (!found) unparseable = unparseable ?? "unterminated heredoc";
        heredocs.push(lines.join("\n"));
      }
      push();
      continue;
    }
    if (c === "&" && command[i + 1] === ">") { buf += "&>"; i += 2; continue; }   // redirect
    if (c === ">" && command[i + 1] === "&") { buf += ">&"; i += 2; continue; }   // fd duplication
    if (c === ";" || c === "|" || c === "&") {
      push();
      i++;
      if (command[i] === c || (c === "|" && command[i] === "&")) i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (pending.length) unparseable = unparseable ?? "unterminated heredoc";
  push();
  return out;
}

/** Shell words of one simple command with write-redirect targets pulled out; null when unbalanced. */
export function wordsAndRedirects(text: string): { words: string[]; redirects: string[] } | null {
  const words: string[] = [];
  const redirects: string[] = [];
  let cur = "";
  let has = false;
  let pendingRedirect: "write" | "read" | "dup" | null = null;
  const flush = (): void => {
    if (!has) return;
    if (pendingRedirect === "write") redirects.push(cur);
    else if (pendingRedirect === null) words.push(cur);
    pendingRedirect = null;
    cur = "";
    has = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) { cur += text[++i]; has = true; continue; }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += text.slice(i + 1, end); has = true; i = end; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = "";
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length && /["\\$`]/.test(text[j + 1])) { v += text[++j]; continue; }
        v += text[j];
      }
      if (j >= text.length) return null;
      cur += v; has = true; i = j; continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    if (c === ">" || (c === "<") || (c === "&" && text[i + 1] === ">")) {
      // An fd number glued to the operator belongs to it (`2>`).
      if (has && /^\d+$/.test(cur) && c !== "&") { cur = ""; has = false; }
      else flush();
      if (c === "<") {
        let j = i + 1;
        while (text[j] === "<") j++;
        // A heredoc delimiter or input file: read-only.
        pendingRedirect = "read";
        i = j - 1;
        continue;
      }
      let j = i + 1;
      if (c === "&") j++;                    // `&>`
      if (text[j] === ">") j++;              // `>>`
      if (text[j] === "|") j++;              // `>|`
      if (text[j] === "&") { pendingRedirect = "dup"; i = j; continue; }
      pendingRedirect = "write";
      i = j - 1;
      continue;
    }
    cur += c;
    has = true;
  }
  flush();
  return { words, redirects };
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Strip keyword and assignment prefixes; returns the remaining command text. */
function stripPrefixes(text: string): string {
  let seg = text.trim();
  for (let k = 0; k < 8; k++) {
    const s = seg.replace(KEYWORD_PREFIX, "");
    if (s === seg) break;
    seg = s.trim();
  }
  for (let k = 0; k < 16; k++) {
    const m = ASSIGN_PREFIX.exec(seg);
    if (!m) break;
    seg = seg.slice(m[0].length).trim();
  }
  return seg;
}

const isNullDevice = (t: string): boolean => /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(t);

function planInto(command: string, cwd: string | null, depth: number, out: CmdSegment[], state: { unwrapped: boolean; cwdChanged: boolean }): void {
  if (depth > 4) {
    out.push({ text: command.trim(), cwd, redirects: [], unparseable: "nested shell too deep" });
    return;
  }
  for (const raw of splitRaw(command)) {
    const text = stripPrefixes(raw.text);
    if (!text && raw.heredocs.length === 0) continue;
    if (KEYWORD_ONLY.test(text) || FOR_HEADER.test(text) || text === "") {
      out.push({ text, cwd, redirects: [], noop: true });
      continue;
    }
    if (raw.unparseable) {
      out.push({ text, cwd, redirects: [], unparseable: raw.unparseable });
      continue;
    }
    const parsed = wordsAndRedirects(text);
    if (!parsed) {
      out.push({ text, cwd, redirects: [], unparseable: "unbalanced quoting" });
      continue;
    }
    const { words } = parsed;
    const redirects = parsed.redirects.filter((t) => !isNullDevice(t));
    if (words.length === 0) {
      // Only redirections (`> file`): the bare-truncate form.
      out.push({ text, cwd, redirects });
      continue;
    }
    const verb = words[0];
    if (verb === "cd" || verb === "pushd") {
      state.cwdChanged = true;
      const arg = words.slice(1).find((w) => !w.startsWith("-") || w === "-");
      if (arg === undefined) cwd = os.homedir();
      else if (arg === "-" || /[$`*?]/.test(arg)) cwd = null;
      else if (path.isAbsolute(expandHome(arg))) cwd = path.resolve(expandHome(arg));
      else cwd = cwd === null ? null : path.resolve(cwd, arg);
      out.push({ text, cwd, redirects: [], noop: true });
      continue;
    }
    if (verb === "popd") {
      state.cwdChanged = true;
      cwd = null;
      out.push({ text, cwd, redirects: [], noop: true });
      continue;
    }
    const base = verb.split("/").pop() ?? verb;
    if (SHELLS.has(base)) {
      // `bash -c 'script'` (flags may be clustered, e.g. -lc, -ec).
      const ci = words.findIndex((w, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (ci > 0 && words[ci + 1] !== undefined) {
        state.unwrapped = true;
        planInto(words[ci + 1], cwd, depth + 1, out, state);
        continue;
      }
      // `bash <<'EOF' … EOF`: the heredoc is the script.
      const operands = words.slice(1).filter((w) => !w.startsWith("-"));
      if (operands.length === 0 && raw.heredocs.length > 0) {
        state.unwrapped = true;
        for (const body of raw.heredocs) planInto(body, cwd, depth + 1, out, state);
        continue;
      }
      out.push({ text, cwd, redirects, unparseable: "runs a shell script" });
      continue;
    }
    out.push({ text, cwd, redirects });
  }
}

/** Plan a Bash command: its simple commands, each with the directory it runs in. */
export function planCommand(command: string, cwd: string): CommandPlan {
  const segments: CmdSegment[] = [];
  const state = { unwrapped: false, cwdChanged: false };
  planInto(command, cwd, 0, segments, state);
  const real = segments.filter((s) => !s.noop);
  return {
    segments,
    compound: real.length > 1 || state.unwrapped || state.cwdChanged,
  };
}
