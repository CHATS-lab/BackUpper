/**
 * The Hermes plugin registers /backupper-panel as a plugin slash command, so Hermes answers it
 * without a model turn. Loads the generated plugin in Python with a stand-in ctx.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hermesAdapter } from "../../src/agents/hermes.js";

function hasPython(): boolean {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

const PROBE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("bp", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Ctx:
    def __init__(self): self.cmds = {}
    def register_hook(self, *a): pass
    def register_command(self, name, handler, description="", args_hint=""): self.cmds[name] = (handler, args_hint)
class Old:
    def register_hook(self, *a): pass
c = Ctx(); m.register(c); m.register(Old())
h, hint = c.cmds["backupper-panel"]
print(json.dumps({"names": list(c.cmds), "hint": hint, "bad": h("sideways")}))
`;

describe("Hermes /backupper-panel", { skip: !hasPython() && "python3 not available" }, () => {
  it("registers the command, rejects unknown actions, and tolerates Hermes without register_command", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bu-hermes-"));
    try {
      hermesAdapter.install(dir, "/opt/bu/dist");
      const init = path.join(dir, ".hermes", "plugins", "backupper", "__init__.py");
      assert.match(fs.readFileSync(init, "utf-8"), /^_CLI = "\/opt\/bu\/dist\/cli\.js"$/m);
      const out = JSON.parse(execFileSync("python3", ["-c", PROBE, init], { encoding: "utf-8" }));
      assert.deepEqual(out.names, ["backupper-panel"]);
      assert.equal(out.hint, "[on|off|toggle|status]");
      assert.equal(out.bad, "Usage: /backupper-panel [on|off|toggle|status]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
