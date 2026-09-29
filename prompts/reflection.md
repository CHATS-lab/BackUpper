---
name: reflection
loaded_from: backupper/src/self-improving/reflection.ts REFLECTION_INSTRUCTIONS (main body) + reflectAfterBackup (request section) + callModel (system-prompt section); match-section / format-section are shared with generalize.md
used_in: the reflection turn after every tier-3 backup attempt, when selfImproving is on
placeholders: [ATTEMPT, EVIDENCE, FORMAT_SECTION, MATCH_FIELDS, MATCH_SECTION, TABLE, TABLE_VERSION, TEST_ONLY, TOOL_NAME, WORKDIR]
sections: [match-section, format-section, request, system-prompt]
---

# Self-reflection prompt

Reflect on exactly one completed backup-subagent attempt. You maintain a table of deterministic backup rules that will be reused on OTHER tasks and environments, not only the one this attempt came from. Use only the tool input, WORKDIR, attempt status, the backup commands and tool results in EVIDENCE, the artifact inventory, the current TABLE, and learnedRuleFailures in EVIDENCE (learned rules that matched this action and then failed). Never use later main-agent results. Always summarize a parameterized inputPattern and outputPattern, even when the attempt failed or was read-only, then choose UPDATE_EXISTING, ADD_NEW, or DO_NOTHING.

{{MATCH_SECTION}}

WHAT TO LEARN. First establish from EVIDENCE what the backup actually captured: which objects, and how much of them. Go by what the subagent did, not by what the action text mentions; a path in the action can be a script, an input or an output that is not the state at risk. Then decide where that target comes from:
(1) The action itself names the target, for example the operand of a delete, overwrite or move, the file an edit or patch is applied to, or the resource of a mutating request. Write a rule for that kind of operation. Anchor what identifies the operation and the position the target occupies; leave incidental detail open: environment assignments, wrappers, unrelated options, pipes and output formatting, commands chained before or after. Capture the target; never write it as a literal.
(2) The action does not name the target, but the target follows determinately from a known tool, its subcommand and its options, configuration or environment. Write a rule only when the steps can obtain the affected object at runtime from the action, from the environment (env parts) or from a deterministic discovery step (stdoutBinding). The tool name alone is never enough: if the same invocation could also change state these steps would not capture, choose DO_NOTHING so the backup subagent keeps handling it.
(3) The target is known only from reading a program, script or data belonging to this task. Write a rule only when a deterministic discovery step can find the target from configuration or program structure, in a way that would work on a different task; otherwise choose DO_NOTHING.
A literal path, port, host, endpoint, identifier or file name that comes from this particular task must not appear in actionRegex or in steps. A rule that needs one is the wrong rule, and DO_NOTHING is a correct outcome. Never use task names.

UPDATE OR ADD. Read TABLE before ADD_NEW. When an existing rule covers the same kind of operation with the same backup scope and the same applicability conditions, and only incidental detail kept it from matching this action, prefer UPDATE_EXISTING: keep its id and revise it so it still matches what it matched before (its matchedExamples in TABLE) and also matches this action. When the scope or the conditions differ, do not merge; widening must never make a rule that was correct capture the wrong thing. When learnedRuleFailures shows why a matched rule failed, repair that rule with UPDATE_EXISTING. UPDATE_EXISTING may revise any field while preserving the rule id.

{{FORMAT_SECTION}}

<!-- section: match-section -->
HOW A RULE IS MATCHED. A rule names toolName, matchField and actionRegex. At runtime actionRegex is tested against the raw decoded text of the tool-input field named by matchField, exactly as listed under MATCH FIELDS after JSON decoding: real newlines and quotes, not JSON escapes. It is a JavaScript RegExp constructed without flags: no Python (?P<name>...) groups, no inline flags, and use [\s\S] to cross newlines. Backup-declaration markers have already been removed from the fields. Only matchField is matched; every other field is context. WORKDIR is the directory the action runs in: rule steps run with it as their working directory, a capture of type "path" is resolved against it into an absolute path, and binding:"workdir" passes it as a value. Never write the workdir, or any other field, into actionRegex. Anchor what identifies the operation and the position the target occupies, and leave incidental detail open: environment assignments, wrappers, unrelated options and their order, pipes and output formatting, commands chained before or after. A regex that only accepts the exact spelling seen once will not match the next occurrence.
<!-- /section -->

<!-- section: format-section -->
RULE FORMAT. A rule contains toolName, matchField, actionRegex, typed capture groups, ordered structured program+argv steps, and expected artifacts. Capture group is a positive numeric regular-expression group index, even when the regex uses named groups. Capture types: string, absolute_path (must already be absolute), path (resolved against WORKDIR), http_url. Runtime invokes argv directly without a shell. Every steps.args array element renders exactly one complete argv string. A plain JSON string is shorthand for a fixed literal. An element may also be one part or an array of parts concatenated without separators, for example [{binding:"actionDir"},{literal:"/pre"}]; do not put fragments of one argv in separate outer elements. If an actual backup command needs shell syntax, use program bash with args ["-lc",SCRIPT,"backup-step",CAPTURE...] and reference values as positional parameters in SCRIPT; never interpolate captures into shell source. Each argv/path part has exactly one of literal, capture, binding ("actionDir" or "workdir"), or env (environment variable name only). stdoutBinding exposes a discovery step's stdout to later capture references; stdoutMode defaults to raw, which preserves every byte; line removes exactly one trailing newline. Expected artifact path arrays are filesystem segments resolved beneath actionDir; use segments such as literal:"pre", never leading-slash segments. Every backup product must be written beneath actionDir (pass binding:"actionDir" into the step that writes it); a rule whose steps never reference actionDir is rejected. To locate a target, read the tool's own command-line arguments and operands first, its environment variables second, its standard configuration file third; a matcher that requires an environment-variable NAME to appear in the command text only fits scripts and misses the command-line form.
<!-- /section -->

<!-- section: request -->
Return JSON only with decision,baseVersion:{{TABLE_VERSION}},reason,inputPattern,outputPattern and optional rule. rule fields: id,revision:1,enabled:true,testOnly:{{TEST_ONLY}},toolName,matchField,actionRegex,captures:[{name,group,type:"string|absolute_path|path|http_url"}],steps:[{program,args:[string|part|[parts]],stdoutBinding?,stdoutMode?:"raw|line"}],expectedArtifacts:[{path:[parts],kind:"file|directory",nonEmpty:true}],inputPattern,outputPattern,learnedFrom. Omit rule for DO_NOTHING.
TOOL NAME:{{TOOL_NAME}}
MATCH FIELDS (JSON object; each value is the raw text a rule's actionRegex is tested against once decoded):{{MATCH_FIELDS}}
WORKDIR:{{WORKDIR}}
ATTEMPT:{{ATTEMPT}}
EVIDENCE:{{EVIDENCE}}
TABLE:{{TABLE}}
<!-- /section -->

<!-- section: system-prompt -->
Return only JSON. Do not use tools.
<!-- /section -->
