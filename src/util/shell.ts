/**
 * Shell helpers shared by the rules, the restore path and the CLI.
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * POSIX single-quote one argument. By default a word made only of safe characters is
 * returned unquoted; `always` quotes every word (used where stored recovery commands
 * must keep their historical form).
 */
export function quote(s: string, opts: { always?: boolean } = {}): string {
  if (!opts.always) {
    if (s === "") return "''";
    if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Expand a leading `~` or `~/` to the home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** True for device paths that keep no state: /dev/null, the std streams, the tty and /dev/fd/N. */
export function isNullDevice(target: string): boolean {
  return /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(target);
}
