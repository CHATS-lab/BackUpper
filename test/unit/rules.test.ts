/**
 * Tests for the rule engine (engine/rules.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../src/engine/rules.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../../src/types.js";

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

function cfg(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ── Deny rules ───────────────────────────────────────────────────────

describe("deny rules", () => {
  it("default config blocks the operations that have no inverse", () => {
    // Tier 0 deliberately refuses to rewrite dangerous paths, so without
    // a default deny list the LEAST recoverable operation had the LEAST
    // protection. `rm -rf /` is the canonical case.
    const r = evaluate(makeCtx("Bash", { command: "rm -rf /" }), cfg());
    assert.equal(r.decision, "deny");
    assert.equal(r.trigger, "deny_rule");
  });

  it("an empty denyPatterns list disables the gate entirely", () => {
    const r = evaluate(
      makeCtx("Bash", { command: "rm -rf /" }),
      cfg({ denyPatterns: [] }),
    );
    assert.notEqual(r.decision, "deny");
  });

  it("mechanism still works when user configures deny patterns", () => {
    const r = evaluate(
      makeCtx("Bash", { command: "rm -rf /" }),
      cfg({ denyPatterns: ["rm\\s+-rf\\s+/(?!tmp)"] })
    );
    assert.equal(r.decision, "deny");
    assert.equal(r.trigger, "deny_rule");
  });

  it("user-configured deny pattern for fork bombs", () => {
    const r = evaluate(
      makeCtx("Bash", { command: ":(){ :|:& };:" }),
      cfg({ denyPatterns: [":(\\)\\{\\s*:|\\(\\)\\s*\\{)"] })
    );
    assert.equal(r.decision, "deny");
  });

  it("user-configured pattern allows /tmp exception", () => {
    const r = evaluate(
      makeCtx("Bash", { command: "rm -rf /tmp/junk" }),
      cfg({ denyPatterns: ["rm\\s+-rf\\s+/(?!tmp)"] })
    );
    assert.notEqual(r.decision, "deny");
  });
});

// ── Shipped default deny list ────────────────────────────────────────
//
// Two halves, and the second matters as much as the first: a deny rule
// that over-fires blocks legitimate work, which is worse than the tier-0
// escalation it was meant to replace.

describe("default deny list: blocks operations with no inverse", () => {
  const blocked: Array<[string, string]> = [
    ["mkfs", "mkfs.ext4 /dev/sdb1"],
    ["mkfs via -t", "mkfs -t xfs /dev/sdb1"],
    ["mkfs under sudo", "sudo mkfs.ext4 /dev/sdb1"],
    ["wipefs --all", "wipefs --all /dev/sdb"],
    ["wipefs -a", "sudo wipefs -a /dev/nvme0n1"],
    ["dd to a block device", "dd if=/tmp/img.bin of=/dev/sda bs=4M"],
    ["shred", "shred -u -z secrets.env"],
    ["lvremove", "lvremove /dev/vg0/data"],
    ["vgremove", "sudo vgremove vg0"],
    ["pvremove", "pvremove /dev/sdb1"],
    ["rm -rf /", "rm -rf /"],
    ["rm -fr /*", "rm -fr /*"],
    ["rm -rf --no-preserve-root /", "rm -rf --no-preserve-root /"],
    ["rm -rf ~", "rm -rf ~"],
    ["rm -rf ~/*", "rm -rf ~/*"],
    ["rm -rf $HOME", "rm -rf $HOME"],
    ["rm -rf ${HOME}", 'rm -rf "${HOME}"'],
    ["a destructive second segment", "cd /srv && mkfs.ext4 /dev/sdb1"],
  ];

  for (const [label, command] of blocked) {
    it(`blocks ${label}`, () => {
      const r = evaluate(makeCtx("Bash", { command }), cfg());
      assert.equal(r.decision, "deny", `expected ${command} to be denied`);
      assert.equal(r.trigger, "deny_rule");
      // The reason must say what was blocked and why, not just echo a regex.
      assert.ok(
        r.reason.length > 40 && !r.reason.includes("\\s"),
        `deny reason should be a neutral explanation, got: ${r.reason}`,
      );
    });
  }
});

describe("default deny list: leaves near-miss legitimate work alone", () => {
  const allowed: Array<[string, string]> = [
    ["rm -rf ./build", "rm -rf ./build"],
    ["rm -rf a relative dir", "rm -rf build/cache"],
    ["rm -rf under /tmp", "rm -rf /tmp/scratch"],
    ["rm -rf a path inside $HOME", "rm -rf $HOME/projects/old"],
    ["rm -rf a path inside ~", "rm -rf ~/projects/old"],
    ["dd to an image file", "dd if=/dev/zero of=./file.img bs=1M count=10"],
    ["dd to /dev/null", "cat big.bin | dd of=/dev/null"],
    ["wipefs listing (no -a)", "wipefs /dev/sdb"],
    ["a wipefs dry run", "wipefs -n -a /dev/sdb"],
    ["an lvremove dry run", "lvremove --test /dev/vg0/data"],
    ["mkfs mentioned as an argument", "grep -r mkfs docs/"],
    ["a filename containing shred", "cat notes/shred-policy.md"],
    ["shred --help", "shred --help"],
    ["a package named mkfs", "npm install mkfs-utils"],
  ];

  for (const [label, command] of allowed) {
    it(`allows ${label}`, () => {
      const r = evaluate(makeCtx("Bash", { command }), cfg());
      assert.notEqual(
        r.decision,
        "deny",
        `expected ${command} to pass the deny gate, blocked by: ${r.reason}`,
      );
    });
  }
});

// ── Precaution field ─────────────────────────────────────────────────

describe("precaution field", () => {
  it("triggers backup when precaution=true", () => {
    const r = evaluate(makeCtx("Bash", { command: "make deploy", precaution: true }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "precaution_field");
  });

  it("triggers backup when precaution='true' (string)", () => {
    const r = evaluate(makeCtx("Bash", { command: "make deploy", precaution: "true" }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "precaution_field");
  });

  it("does not trigger on precaution=false", () => {
    const r = evaluate(makeCtx("Bash", { command: "ls" }), cfg());
    assert.notEqual(r.trigger, "precaution_field");
  });
});

// ── Read-only tools ──────────────────────────────────────────────────

describe("read-only tools", () => {
  for (const tool of ["Read", "read_file", "Glob", "Grep", "WebSearch", "WebFetch"]) {
    it(`passes through ${tool}`, () => {
      const r = evaluate(makeCtx(tool, {}), cfg());
      assert.equal(r.decision, "pass");
    });
  }
});

// ── backupper CLI commands ────────────────────────────────────────

describe("backupper CLI commands", () => {
  for (const cmd of [
    "backupper status",
    "backupper restore 1",
    "backupper restore_direct 2",
    "backupper history",
    "backupper clear",
    "backupper diff 1",
    "backupper config",
  ]) {
    it(`passes through "${cmd}"`, () => {
      const r = evaluate(makeCtx("Bash", { command: cmd }), cfg());
      assert.equal(r.decision, "pass", `Expected pass for "${cmd}", got ${r.decision}: ${r.reason}`);
    });
  }
});

// ── File-mutating tools ──────────────────────────────────────────────

describe("file-mutating tools", () => {
  for (const tool of ["FileEdit", "Write", "write_file", "patch", "NotebookEdit"]) {
    it(`backs up ${tool}`, () => {
      const r = evaluate(makeCtx(tool, { path: "/some/file.py" }), cfg());
      assert.equal(r.decision, "backup");
      assert.equal(r.trigger, "backup_rule");
    });
  }
});

// ── Rule-based patterns ──────────────────────────────────────────────

describe("backup patterns", () => {
  const cases: Array<[string, string]> = [
    ["rm file.txt", "rm\\s"],
    ["git push origin main", "git\\s+push"],
    ["git rebase main", "git\\s+rebase"],
    ["pip install flask", "pip\\s+install"],
    ["npm uninstall lodash", "npm\\s+uninstall"],
    ["apt install curl", "apt\\s+install"],
    ["DROP TABLE users", "DROP\\s+TABLE"],
  ];

  for (const [cmd, pattern] of cases) {
    it(`backs up "${cmd}" (matched ${pattern})`, () => {
      const r = evaluate(makeCtx("Bash", { command: cmd }), cfg());
      assert.equal(r.decision, "backup");
      assert.equal(r.trigger, "backup_rule");
    });
  }
});

// ── Default backup ───────────────────────────────────────────────────

describe("default backup", () => {
  it("backs up unknown commands in checker mode", () => {
    const r = evaluate(makeCtx("Bash", { command: "some-unknown-tool --do-stuff" }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "default_backup");
  });

  it("backs up unknown tools", () => {
    const r = evaluate(makeCtx("SomeNewTool", { data: "foo" }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "default_backup");
  });
});

// ── mode off ─────────────────────────────────────────────────────────

describe('mode="off"', () => {
  it("passes everything when off", () => {
    const r = evaluate(makeCtx("Bash", { command: "rm important.txt" }), cfg({ mode: "off" }));
    assert.equal(r.decision, "pass");
  });

  it('mode="off" short-circuits before deny rules', () => {
    // Even if the user configures deny patterns, mode="off" passes
    // everything through. Off means off. (This is the ONE gate that the
    // deny rules do not outrank — they run before the backup gate but
    // after this one.)
    const r = evaluate(
      makeCtx("Bash", { command: "rm -rf /" }),
      cfg({ mode: "off", denyPatterns: ["rm\\s+-rf\\s+/"] })
    );
    assert.equal(r.decision, "pass");
  });
});
