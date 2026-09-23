#!/usr/bin/env python3
"""Check the prompt sources are wired in and current.

Every prompt a model receives lives as ONE markdown file:
  backupper/prompts/*.md   -> compiled into backupper/src/prompts.generated.ts by
                              backupper/scripts/gen_prompts.mjs (part of `npm run build`)
  regretbench/prompts/*.md -> read at import by the harness through
                              regretbench/harness/prompt_md.py

This script asserts:
  1. src/prompts.generated.ts is up to date with backupper/prompts/*.md
     (node scripts/gen_prompts.mjs --check);
  2. the harness parser reads every plugin prompt exactly as the generator does;
  3. every plugin *.md is referenced from the TypeScript that renders it, and every
     section is used somewhere in src/ or self-exploration/;
  4. every harness / patch-script reader resolves its md file: the module imports
     and its RUBRIC / SYSTEM / BRIEFING constant is non-empty;
  5. no stray copy of a prompt is left in regretbench/harness/*_prompt.md;
  6. (acceptance) the rendered prompts from backupper/dist are byte-identical to the
     frozen oracle: node backupper/tests/prompts_render_equal.mjs when present (the
     appendix release ships no tests, so that step is simply skipped).
Usage: python3 scripts/check_prompts.py   (exit 1 on any failure)
"""
import glob, importlib.util, json, os, re, subprocess, sys, warnings

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BK = os.path.join(R, "backupper")
HARNESS = os.path.join(R, "regretbench", "harness")
sys.path.insert(0, HARNESS)
import prompt_md  # noqa: E402

bad = 0
def report(ok, label):
    global bad
    print(("OK   " if ok else "FAIL ") + label)
    bad += not ok

# 1. generated file current
r = subprocess.run(["node", os.path.join(BK, "scripts", "gen_prompts.mjs"), "--check"], capture_output=True, text=True)
report(r.returncode == 0, "backupper/src/prompts.generated.ts up to date with prompts/*.md" + ("" if r.returncode == 0 else "\n     " + (r.stderr or r.stdout).strip()))

# 2. python parser == node parser
node_js = ("import('%s').then(m=>{const fs=require('fs');const out={};for(const f of fs.readdirSync('%s')){if(!f.endsWith('.md')||f==='README.md')continue;"
           "const p=m.parsePromptMd('%s/'+f);out[p.name]={body:p.body,sections:p.sections};}console.log(JSON.stringify(out));})"
           % (os.path.join(BK, "scripts", "gen_prompts.mjs"), os.path.join(BK, "prompts"), os.path.join(BK, "prompts")))
r = subprocess.run(["node", "-e", node_js], capture_output=True, text=True)
node = json.loads(r.stdout) if r.returncode == 0 else {}
for name in sorted(node):
    try:
        py = prompt_md.parse_prompt_md(prompt_md.prompt_path(name, plugin=True))
        ok = py["body"] == node[name]["body"] and py["sections"] == node[name]["sections"]
    except Exception as e:  # noqa: BLE001
        ok = False; print("     " + str(e))
    report(ok, "harness prompt_md parses backupper/prompts/%s.md like gen_prompts.mjs" % name)
report(bool(node), "gen_prompts.mjs parsed %d plugin prompts" % len(node))

# 3. every plugin prompt (and every section) is referenced by the code
ts = ""
for pat in ("src/**/*.ts", "self-exploration/*.ts"):
    for f in glob.glob(os.path.join(BK, pat), recursive=True):
        if f.endswith(".ts") and ".as-run" not in f and not f.endswith("prompts.generated.ts"):
            ts += open(f, encoding="utf-8", errors="replace").read()
for name in sorted(node):
    const = re.sub(r"[^A-Z0-9]+", "_", name.upper())
    used = re.search(r"\b%s\b" % const, ts) is not None
    report(used, "backupper/prompts/%s.md is referenced as %s in src/ or self-exploration/" % (name, const))
    for sec in node[name]["sections"]:
        report(('sections["%s"]' % sec) in ts, "  section %s#%s is used" % (name, sec))

# 4. harness readers resolve their md files
def load_module(path):
    spec = importlib.util.spec_from_file_location(os.path.basename(path)[:-3], path)
    mod = importlib.util.module_from_spec(spec)
    argv = sys.argv; sys.argv = ["x"]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            spec.loader.exec_module(mod)
    finally:
        sys.argv = argv
    return mod
# The two judges this release ships. Everything else in the full harness
# (coverage, bk-stage1/2, backupper-xy, outcome/failure classifiers, seed
# generation, the briefing A/B and inverted-mode ablations) is not part of the
# appendix code release, so there is nothing else to resolve here.
READERS = [
    ("judge.py", "RUBRIC", "judge-main"),
    ("judge_subagent_quality.py", "RUBRIC", "judge-subagent-quality"),
]
mods = {}
for fn, attr, md in READERS:
    try:
        mod = mods.get(fn) or load_module(os.path.join(HARNESS, fn)); mods[fn] = mod
        val = getattr(mod, attr)
        ok = isinstance(val, str) and len(val) > 0
        if md:
            name, _, kind = md.partition(":")
            expect = prompt_md.load_prompt(name, plugin=(kind == "plugin"))
            ok = ok and val == expect
    except Exception as e:  # noqa: BLE001
        ok = False; print("     " + fn + ": " + str(e))
    report(ok, "harness/%s %s resolves %s" % (fn, attr, md or "its prompt"))

# 5. no stray copies
stray = glob.glob(os.path.join(HARNESS, "*_prompt.md"))
report(not stray, "no regretbench/harness/*_prompt.md copies left" + ("" if not stray else ": " + ", ".join(map(os.path.basename, stray))))
# every regretbench/prompts/*.md is read by something
for f in sorted(glob.glob(os.path.join(R, "regretbench", "prompts", "*.md"))):
    name = os.path.basename(f)[:-3]
    if name == "README": continue
    src = "".join(open(p, encoding="utf-8", errors="replace").read() for p in glob.glob(os.path.join(HARNESS, "*.py")))
    report(('"%s"' % name) in src, "regretbench/prompts/%s.md is read by a harness script" % name)

# 6. oracle equality
ORACLE = os.path.join(BK, "tests", "prompts_render_equal.mjs")
if "--no-oracle" not in sys.argv and os.path.exists(ORACLE):
    if os.path.isdir(os.path.join(BK, "dist")):
        r = subprocess.run(["node", os.path.join(BK, "tests", "prompts_render_equal.mjs")], capture_output=True, text=True)
        tail = (r.stdout.strip().split("\n") or [""])[-1]
        report(r.returncode == 0, "oracle: %s" % tail)
        if r.returncode != 0:
            print("\n".join(l for l in r.stdout.split("\n") if not l.startswith("OK")))
    else:
        print("WARN backupper/dist absent: oracle render check skipped (run npm run build)")

print("FAILED: %d check(s)" % bad if bad else "ALL CHECKS PASSED")
sys.exit(1 if bad else 0)
