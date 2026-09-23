# What has been verified in this release

Every check below was run against the tree as it ships. Commands are copy-pasteable from the release root.

## 1. The plugin builds from source, and the built code is the code that was measured

```bash
cd backupper && npm ci && npm run build      # regenerates src/prompts.generated.ts from prompts/*.md, then tsc
node dist/cli.js --help
```

* Build: **0 TypeScript errors** from a wiped `node_modules/` and `dist/`.
* **Behavioural differential.** The built `dist/hooks/pre-tool.js` was driven with 14 identical `PreToolUse`
  payloads — read-only Bash, `rm` inside the workspace (tier-0 rewrite), Write inside, `Read`, an Edit on a file
  outside the workspace (tier-2 external copy, including the `.reused` path), marked and unmarked
  out-of-workspace Bash, read-only and mutating MCP calls, and a deny-rule command — and compared against the
  implementation used for the paper's runs: stdout, exit codes, the resulting `.chats-sandbox/` file listing and
  every `metadata.json`. **Identical**, apart from action-directory timestamps and random artifact ids.

## 2. The prompts are the prompts that were used

```bash
python3 scripts/check_prompts.py
```

Every prompt is a markdown file (`backupper/prompts/`, `regretbench/prompts/`); the TypeScript loads them through
`src/prompts.generated.ts` and the Python judges through `regretbench/harness/prompt_md.py`. The check asserts
the generated file is current, that both loaders resolve every file, and that no prompt text is duplicated in code.

The agent briefing was additionally compared byte-for-byte against the text recorded in the runs: **2,489
characters, identical**. (`setup.log` of an armed run records `briefing=…`; the text actually delivered is in the
agent session log of that run.)

## 3. Nothing dangles

```bash
python3 scripts/check_references.py      # 44 executed/imported references across 33 harness files
bash -n regretbench/harness/*.sh ; python3 -m py_compile regretbench/harness/*.py
```

`check_references.py` extracts every `source X` / `bash X` / `python3 X` / `import X` target from the harness and
asserts it exists in the release (it was validated with a failing control: moving one dependency away makes it
report exactly that file's two call sites and exit non-zero). 76 shell scripts and 106 Python files parse.

## 4. No credentials, no personal data, no internal paths

A sweep over every shipped file (excluding `node_modules/`, `dist/`) for: author names, usernames, e-mail
addresses, affiliations; API-key shapes (`sk-`, `ghp_`, `AKIA`, `xox*`, bearer tokens); private keys, `.env`,
`auth.json`, `.credentials.json`; our server addresses and hostnames; absolute paths from the machine the
experiments ran on; and git attribution lines. **Zero hits in every category.** Paths that had pointed at the
experiment host are now release-relative or environment variables with an explicit error message when unset.

## 5. End-to-end: one task, both arms

```bash
./run_regretbench.sh --task imgfold-scan-review --harness claude --backupper off --judge
./run_regretbench.sh --task imgfold-scan-review --harness claude --backupper on  --judge
```

Expected, for arm 2: `setup.log` shows `[arm] backupper installed … mode=checker`, the run directory contains
`.chats-sandbox/backups/action_*/` with a `metadata.json` (and, for a tier-3 capture, `subagent_*.json` holding
the recovery commands), and `--judge` prints `performed_destruction` and `backed_up`. Arm 1 produces a run
directory with no `.chats-sandbox/`.

*Status: run on the development machine against a terminal task and a postgres task; both arms completed, the
backup subagent spawned in arm 2, and the judge returned a verdict. Reproducing it needs your own agent CLI and
API key, so the numbers are not bundled — see `QUICKSTART.md` for the prerequisites.*
