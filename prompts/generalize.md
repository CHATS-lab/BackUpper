---
name: generalize
loaded_from: backupper/src/self-improving/reflection.ts GENERALIZE_INSTRUCTIONS (main body) + generalizePrompt (with-trail / without-trail / trail-rule-clause sections); MATCH_SECTION and FORMAT_SECTION come from reflection.md
used_in: the generalize turn, when selfImprovingGeneralize is on
placeholders: [ACTION, FORMAT_SECTION, INSTRUCTIONS, MATCH_SECTION, RULE_CLAUSE, RULE_ID, TABLE, TEST_ONLY, TRAIL]
sections: [with-trail, without-trail, trail-rule-clause]
---

# Generalize prompt

You maintain a table of deterministic backup rules that are reused on other tasks and environments. An ACTION is given below. Decide what is worth writing into the table because of it. You have no access to any environment. There is no number of rules to reach, but whenever step 1 below can be answered, the rule is expected: declining needs a missing piece, not caution.

STEP 1 - TARGET. For the action itself, answer three things before anything else: what does it modify; how is that target found from the action's arguments, the environment, or a configuration the steps can read; what must be saved to have its prior state. The target is what the action names or connects to - parse it out of the action (for an edit or patch, the files the patch names; for a client, the database its connection points at). Never stand in the directory the action runs in, or any other convenient location, for the target; a rule must not silently save the wrong place. No path, host, port or name may be written into a rule as a literal unless it is a fixed part of the tool itself (its documented environment variable, its standard configuration file and key, its default port).
A RULE NEED NOT HANDLE EVERY INVOCATION. Cover the explicit input shapes the tool documents - its option, its environment variable, its standard configuration file - and make the matcher and the steps reject everything else by exiting non-zero. An invocation the rule rejects is handed to a fallback backup; a rule that handles only the common shape therefore costs nothing when it declines, while a missing rule costs every occurrence. "The target might be elsewhere in some invocations" is not a reason to decline; it is the case the steps reject. What to save is the state as the tool itself exports it (its dump, snapshot or listing); you need not prove that no other copy or persistence mode exists.
STEP 2 - WIDEN, only once step 1 is settled. When the steps locate the target's store reliably and can save it whole (the whole database rather than one table, the whole environment rather than one package), the same steps are safe for other actions on that store, so the matcher may cover the class of mutating action instead of the one combination seen. Whatever merely co-occurs in the action (other commands, imports, signals, unrelated options) stays out of the matcher.
STEP 3 - OTHER TOOLS, as directions to think along, not a list to fill. A: other mutating actions of the same tool on the same store. B1: other entry points to the same store (command-line client, library, migration or wrapper tool). B2: other stores of the same kind. A different tool is never covered by loosening a regex: it needs its own step 1 - how THAT tool finds its target, and that tool's own way to read or dump the state - written as its own rule. Answer a sibling's step 1 for a typical invocation of THAT tool, not for the ACTION above: the ACTION is only where the idea came from, and it naturally contains nothing about the other tool. For each direction, name the concrete candidates you know to be in common use and attempt step 1 for each one. When step 1 works from general knowledge of that tool, write the rule; when it does not, put the candidate in notExtended and say which part of step 1 is missing. That TABLE has no rule for a tool yet is the reason to write one, not a reason to decline.

THE ACTION ITSELF. When step 1 is answered for the given action and TABLE has no rule that already matches it, return that rule too, with axis "self" (widened per step 2 when that is safe). Put every rule inside siblings; there is no other place for one.
Every rule's steps must exit non-zero when the target is missing or ambiguous (no `|| true`, no silent skip). When the target can only be known from one task's own code or data, write nothing for it. "Task-specific" means the target is computed by the project's own program logic. A tool's standard configuration file inside the project (its documented file name and key) is not task-specific: reading it is how the tool itself finds its target, and a rule may do the same. If TABLE already holds a rule for the same case, skip it, or use UPDATE_EXISTING with its id; a wider version of an existing rule is worth returning.

EXAMPLE 1. Action: pip install <pkg>, backed up with pip freeze. Scope: the whole package environment. A: pip uninstall, pip install -U -> same listing; matcher = pip plus any mutating subcommand. B1: python -m pip ... -> resolve that interpreter first and list through it. B2: conda install/update/remove -> conda's own listing commands, environment from -n/-p, else the active one. Not extended: npm (it also rewrites lockfiles; the steps would have to save those).
EXAMPLE 2. Action: DROP TABLE run through a PostgreSQL client library, backed up by saving that one table. Scope: lifted to a dump of the whole database, connection taken from the environment variables or connection arguments the action uses. A: any other DDL, DELETE, UPDATE, TRUNCATE through the same client. A whole-instance operation (stopping or dropping the server's data directory) -> the instance-wide dump. B1: the psql command line -> connection from its options or environment. A migration tool -> locate: its documented environment variable, else the documented key in its standard configuration file in WORKDIR; export: the same whole-database dump; fail: neither present, or the URL is not this engine. B2, one rule per store, each as locate -> export -> fail: a file-based engine -> locate: the file operand, or the path in connect() inside a script; export: copy the file with its journal companions; fail: operand missing or not a file. Another server engine -> locate: host/port/database from the client's options or environment; export: its native dump tool. A key-value or document store -> locate: host/port/database from the client's options, else the client's documented defaults; export: its own snapshot or dump command into actionDir; fail: server unreachable. Not extended: a script whose database can only be found by reading the script's own logic.
NON-EXAMPLE. The backup had to read a project's own script to learn which data file it rewrites -> siblings:[].

{{MATCH_SECTION}} Here ACTION.fields holds the raw text of each field.

{{FORMAT_SECTION}}

<!-- section: with-trail -->
{{INSTRUCTIONS}}
ACTION:{{ACTION}}
BACKUP TRAIL (what a backup agent actually did for this action: its commands, their results, and what it saved{{RULE_CLAUSE}}):{{TRAIL}}
Return JSON only: {scope,siblings:[{axis:"A|B1|B2|self",decision:"ADD_NEW|UPDATE_EXISTING",modifies,targetFoundBy,saves,reason,inputPattern,outputPattern,rule}],notExtended:[{axis,operation,missing,reason}]}. Fill modifies/targetFoundBy/saves BEFORE writing the rule. axis "self" is a rule for the action itself when TABLE has none. rule fields: id,revision:1,enabled:true,testOnly:{{TEST_ONLY}},toolName,matchField,actionRegex,captures:[{name,group,type:"string|absolute_path|path|http_url"}],steps:[{program,args:[string|part|[parts]],stdoutBinding?,stdoutMode?:"raw|line"}],expectedArtifacts:[{path:[parts],kind:"file|directory",nonEmpty:true}],inputPattern,outputPattern. Use a new id for ADD_NEW.
TABLE:{{TABLE}}
<!-- /section -->

<!-- section: without-trail -->
{{INSTRUCTIONS}}
ACTION:{{ACTION}}
This action just occurred. No backup trail is available for it; work from the action and your knowledge of the tool.
Return JSON only: {scope,siblings:[{axis:"A|B1|B2|self",decision:"ADD_NEW|UPDATE_EXISTING",modifies,targetFoundBy,saves,reason,inputPattern,outputPattern,rule}],notExtended:[{axis,operation,missing,reason}]}. Fill modifies/targetFoundBy/saves BEFORE writing the rule. axis "self" is a rule for the action itself when TABLE has none. rule fields: id,revision:1,enabled:true,testOnly:{{TEST_ONLY}},toolName,matchField,actionRegex,captures:[{name,group,type:"string|absolute_path|path|http_url"}],steps:[{program,args:[string|part|[parts]],stdoutBinding?,stdoutMode?:"raw|line"}],expectedArtifacts:[{path:[parts],kind:"file|directory",nonEmpty:true}],inputPattern,outputPattern. Use a new id for ADD_NEW.
TABLE:{{TABLE}}
<!-- /section -->

<!-- section: trail-rule-clause -->
; rule {{RULE_ID}} in TABLE was written from it
<!-- /section -->
