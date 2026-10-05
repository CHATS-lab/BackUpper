/**
 * Tier 4 and the self-improving loop: learned backup rules, reflection and generalize, and the subagent's bookkeeping.
 */

import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../../src/types.js";
import { actionView, recordGeneralizedSource, applyReflectionUpdate, emptyTable, matchLearnedRule, tryLearnedBackup, type LearnedBackupRule, canonicalAction, reflectionTransport, applyGeneralization, generalizePrompt, generalizeAfterReflection, generalizeAfterNativeRule, nativeGeneralizationSource, generalizationAccepted, flushDeferredGeneralizations } from "../../src/self-improving/learned.js";
import { buildSubagentInvocation, locateTranscript, readSubagentResultFile, repairOverEscapedQuotes, findCapturedArtifacts, reportUnregisteredCapture, runSubagentBackup, UNREGISTERED_MARKER } from "../../src/backup/subagent.js";
import { resetAction } from "../../src/backup/strategies.js";

// Each section below was a test file of its own. Its root-level hooks apply only to its
// own top-level suites (onlyIn), and a root-level before() runs once, before the first of
// them (onceIn), so a hook never runs for another section's tests.
function inSuites(suites: string[], t: unknown): boolean {
  const name = (t as { fullName: string }).fullName;
  return suites.some((s) => name === s || name.startsWith(s + " > "));
}
function onlyIn(suites: string[], fn: () => unknown): (t: unknown) => unknown {
  return (t) => (inSuites(suites, t) ? fn() : undefined);
}
function onceIn(suites: string[], fn: () => unknown): (t: unknown) => unknown {
  let done = false;
  return (t) => {
    if (done || !inSuites(suites, t)) return undefined;
    done = true;
    return fn();
  };
}

// =============================================================================
// ── learned backup ──
// =============================================================================

function fx(){const root=fs.mkdtempSync(path.join(os.tmpdir(),"generic-rule-")),table=path.join(root,"table.json");fs.writeFileSync(table,JSON.stringify(emptyTable(true)));return{root,c:{...DEFAULT_CONFIG,learnedBackupRulesPath:table,selfImproving:false}}}
function rule(root:string):LearnedBackupRule{return{id:"generic-copy",revision:1,enabled:true,testOnly:true,toolName:"Bash",matchField:"command",actionRegex:'^mutate (\\S+)$',captures:[{name:"target",group:1,type:"absolute_path"}],steps:[{program:"cp",args:[{capture:"target"},{binding:"actionDir"}]}],expectedArtifacts:[{path:[{binding:"actionDir"},{literal:"source.txt"}],kind:"file",nonEmpty:true}],inputPattern:"mutate plus absolute target",outputPattern:"copied preaction bytes",learnedFrom:{action:"fixture",actionDir:root,reflectedAt:new Date().toISOString()}}}
describe("generic learned rules",()=>{it("defaults reflection off",()=>assert.equal(DEFAULT_CONFIG.selfImproving,false));it("writes versioned rule and executes structured argv",()=>{const f=fx(),src=path.join(f.root,"source.txt");fs.writeFileSync(src,"before");assert.equal(applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"test",inputPattern:"input",outputPattern:"output",rule:rule(f.root)}).applied,true);const d=path.join(f.root,"action");fs.mkdirSync(d);const ctx:HookContext={hook_event:"PreToolUse",tool_name:"Bash",tool_input:{command:`mutate ${src}`}};const artifact=tryLearnedBackup(ctx,d,f.c);assert.equal(artifact?.strategy,"learned_rule");assert.equal(artifact?.artifactPath,path.join(d,"source.txt"));assert.equal(fs.readFileSync(path.join(d,"source.txt"),"utf8"),"before")});it("step failure falls back",()=>{const f=fx(),r=rule(f.root);r.steps[0].program="definitely-missing-program";applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"test",inputPattern:"i",outputPattern:"o",rule:r});const d=path.join(f.root,"action");fs.mkdirSync(d);assert.equal(tryLearnedBackup({hook_event:"PreToolUse",tool_name:"Bash",tool_input:{command:"mutate /missing"}},d,f.c),null)});it("UPDATE may change matcher and steps",()=>{const f=fx(),r=rule(f.root);applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"a",inputPattern:"i",outputPattern:"o",rule:r});r.actionRegex="^never$";r.steps=[{program:"true",args:[{binding:"actionDir"}]}];r.expectedArtifacts=[{path:[{binding:"actionDir"}],kind:"directory",nonEmpty:false}];assert.equal(applyReflectionUpdate(f.c,{decision:"UPDATE_EXISTING",baseVersion:1,reason:"b",inputPattern:"i2",outputPattern:"o2",rule:r}).version,2)});it("codex reflection prompt travels on stdin with the system prompt",()=>{const p="REFLECT-BODY",inv=buildSubagentInvocation(p,{...DEFAULT_CONFIG,subagentRunner:"codex"},{noTools:true,maxTurns:1,systemPrompt:"SYS"});assert.ok(inv);const t=reflectionTransport(inv!,p);assert.equal(t.args[t.args.length-1],"-");assert.ok(t.input.startsWith("SYS")&&t.input.endsWith(p))});});

describe("transferable matching",()=>{
  const r=(over:Partial<LearnedBackupRule>):LearnedBackupRule=>({...rule("/x"),...over});
  const view=(tool:string,input:Record<string,unknown>,cwd?:string)=>actionView({hook_event:"PreToolUse",tool_name:tool,tool_input:input,cwd});
  it("matches the raw field, not harness keys or the declaration marker",()=>{
    const del=r({actionRegex:"(?:^|[;&|]\\s*)rm\\s+(?:-\\w+\\s+)*(\\S+)\\s*$"});
    assert.deepEqual(matchLearnedRule(del,view("Bash",{command:"rm -rf /srv/a",workdir:"/app"})),{target:"/srv/a"});
    assert.deepEqual(matchLearnedRule(del,view("Bash",{command:"rm -rf /srv/a # [BACKUP NEEDED]"})),{target:"/srv/a"});
    assert.equal(matchLearnedRule(del,view("Bash",{command:"ls /srv/a"})),null);
    assert.equal(matchLearnedRule(del,view("Edit",{command:"rm -rf /srv/a"})),null);
  });
  it("leaves everything but the marker untouched, including multi-line patches",()=>{
    const v=view("Edit",{command:"*** Begin Patch  # [BACKUP NEEDED]\n*** Update File: /usr/local/bin/x\n@@\n-a  b\n+a   b # keep\n"});
    assert.equal(v.fields.command,"*** Begin Patch\n*** Update File: /usr/local/bin/x\n@@\n-a  b\n+a   b # keep\n");
    const patch=r({toolName:"Edit",actionRegex:"^\\*\\*\\* (?:Update|Delete) File: (\\S+)$".replace("^","(?:^|\\n)").replace("$","(?:\\n|$)")});
    assert.deepEqual(matchLearnedRule(patch,v),{target:"/usr/local/bin/x"});
  });
  it("matches a non-command field for tools that have no command",()=>{
    const w=r({toolName:"Write",matchField:"file_path",actionRegex:"^(/.+)$"});
    assert.deepEqual(matchLearnedRule(w,view("Write",{file_path:"/etc/x.conf",content:"rm /nope"})),{target:"/etc/x.conf"});
    assert.equal(matchLearnedRule(r({matchField:"file_path"}),view("Bash",{command:"mutate /x"})),null);
  });
  it("resolves path captures and runs steps in the action's workdir",()=>{
    const f=fx(),wd=path.join(f.root,"wd");fs.mkdirSync(wd);fs.writeFileSync(path.join(wd,"rel.txt"),"before");
    const rel=r({captures:[{name:"target",group:1,type:"path"}],steps:[{program:"bash",args:["-lc",'cp "$2" "$1/abs.txt" && cp rel.txt "$1/cwd.txt" && printf %s "$3" > "$1/wd.txt"',"s",{binding:"actionDir"},{capture:"target"},{binding:"workdir"}]}],expectedArtifacts:[{path:[{literal:"abs.txt"}],kind:"file",nonEmpty:true}]});
    applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"r",inputPattern:"i",outputPattern:"o",rule:rel});
    const d=path.join(f.root,"action");fs.mkdirSync(d);
    assert.ok(tryLearnedBackup({hook_event:"PreToolUse",tool_name:"Bash",tool_input:{command:"mutate rel.txt",workdir:wd}},d,f.c));
    for(const n of ["abs.txt","cwd.txt"])assert.equal(fs.readFileSync(path.join(d,n),"utf8"),"before");
    assert.equal(fs.readFileSync(path.join(d,"wd.txt"),"utf8"),wd);
  });
  it("rejects a pre-v3 table instead of matching its JSON-form regexes against raw text",()=>{
    const f=fx();fs.writeFileSync(f.c.learnedBackupRulesPath,JSON.stringify({...emptyTable(true),schemaVersion:2}));
    assert.throws(()=>applyReflectionUpdate(f.c,{decision:"DO_NOTHING",baseVersion:0,reason:"r",inputPattern:"i",outputPattern:"o"}),/bad table/);
  });
  it("keeps the examples a rule was widened from",()=>{
    const f=fx(),a=r({matchedExamples:["mutate /a"]});
    applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"r",inputPattern:"i",outputPattern:"o",rule:a});
    applyReflectionUpdate(f.c,{decision:"UPDATE_EXISTING",baseVersion:1,reason:"r",inputPattern:"i",outputPattern:"o",rule:{...a,matchedExamples:["env X=1 mutate /b"]}});
    assert.deepEqual(JSON.parse(fs.readFileSync(f.c.learnedBackupRulesPath,"utf8")).rules[0].matchedExamples,["mutate /a","env X=1 mutate /b"]);
  });
});

describe("generalize turn",()=>{
  const sib=(id:string,over:Partial<LearnedBackupRule>={})=>({reason:"r",targetSource:"action",inputPattern:"i",outputPattern:"o",rule:{...rule("/x"),id,actionRegex:"^other (\\S+)$",...over} as LearnedBackupRule});
  const seed=(f:ReturnType<typeof fx>)=>applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"r",inputPattern:"i",outputPattern:"o",rule:{...rule(f.root),provenance:"observed"}});
  const read=(f:ReturnType<typeof fx>)=>JSON.parse(fs.readFileSync(f.c.learnedBackupRulesPath,"utf8"));
  it("is off by default and does nothing without the switch",()=>{const f=fx();seed(f);assert.equal(DEFAULT_CONFIG.selfImprovingGeneralize,false);generalizeAfterReflection({hook_event:"PreToolUse",tool_name:"Bash",tool_input:{command:"x"}},f.root,"generic-copy",{...f.c,selfImproving:true});assert.equal(fs.existsSync(path.join(f.root,"generalization.json")),false)});
  it("adds siblings as generalized rules, skips malformed ones, has no sibling cap, protects observed rules",()=>{
    const f=fx();seed(f);
    const out=applyGeneralization(f.c,"generic-copy",{siblings:[sib("sib-one"),sib("generic-copy"),sib("sib-bad",{actionRegex:"(?P<x>a)"}),sib("sib-four")]},f.root);
    assert.deepEqual(out.map(o=>o.ok),[true,false,false,true]);
    const t=read(f);assert.deepEqual(t.rules.map((r:LearnedBackupRule)=>[r.id,r.provenance,r.derivedFromRuleId??null]),[["generic-copy","observed",null],["sib-one","generalized","generic-copy"],["sib-four","generalized","generic-copy"]]);
    assert.deepEqual(t.rules[1].matchedExamples,[]);assert.equal(t.version,3);
  });
  it("lets a demonstrated rule answer before an inferred one that matches the same action",()=>{
    const f=fx(),src=path.join(f.root,"source.txt");fs.writeFileSync(src,"before");
    applyGeneralization(f.c,"x",{siblings:[sib("inferred-first",{actionRegex:"^mutate (\\S+)$",steps:[{program:"false",args:[{binding:"actionDir"}]}]})]},f.root);
    applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:1,reason:"r",inputPattern:"i",outputPattern:"o",rule:{...rule(f.root),provenance:"observed"}});
    const d=path.join(f.root,"action");fs.mkdirSync(d);
    assert.equal(tryLearnedBackup({hook_event:"PreToolUse",tool_name:"Bash",tool_input:{command:`mutate ${src}`}},d,f.c)?.policyRuleId,"generic-copy");
    assert.equal(fs.existsSync(path.join(d,"learned-rule-failures.jsonl")),false);
  });

});

describe("generalize layer over built-in rules",()=>{
  const art={id:"a",timestamp:"t",trigger:"rule" as const,toolName:"Bash",description:"Saved pip freeze snapshot (pip freeze)",strategy:"pip_freeze" as const,artifactPath:"/s/action_001/pip_freeze_x.txt"};
  const ctx:HookContext={hook_event:"PreToolUse",tool_name:"Bash",tool_input:{command:"pip install -U requests",workdir:"/app"}};

  const receiptOf=(d:string)=>path.join(d,"generalization-native_pip_freeze.json");
  const on=(c:typeof DEFAULT_CONFIG)=>({...c,selfImproving:true,selfImprovingGeneralize:true,reflectionSubagentRunner:"codex" as const});
  // No runner on PATH: the model call fails at spawn, deterministically and without a model.
  const withoutRunner=(fn:()=>void)=>{const keep=process.env.PATH;process.env.PATH=fs.mkdtempSync(path.join(os.tmpdir(),"nopath-"));try{fn()}finally{process.env.PATH=keep}};
  it("is off by default, and asks a built-in only once per table",()=>{
    const f=fx(),d=path.join(f.root,"action");fs.mkdirSync(d);
    generalizeAfterNativeRule(ctx,d,art,{...f.c,selfImproving:true});flushDeferredGeneralizations();
    assert.equal(fs.existsSync(receiptOf(d)),false);
    recordGeneralizedSource(f.c,"native:pip_freeze");
    // already recorded: returns before any model call, so no receipt and no failure mark
    withoutRunner(()=>{generalizeAfterNativeRule(ctx,d,art,on(f.c));flushDeferredGeneralizations()});
    assert.equal(fs.existsSync(receiptOf(d)),false);
    const t=JSON.parse(fs.readFileSync(f.c.learnedBackupRulesPath,"utf8"));assert.equal(t.version,0);assert.deepEqual(t.history.map((h:Record<string,unknown>)=>h.generalizedSource),["native:pip_freeze"]);
  });
  it("only queues while the tiers run, and gives up on a source after two failed turns",()=>{
    const f=fx(),d=path.join(f.root,"action");fs.mkdirSync(d);
    const failures=()=>JSON.parse(fs.readFileSync(f.c.learnedBackupRulesPath,"utf8")).history.filter((h:Record<string,unknown>)=>h.generalizeFailedSource==="native:pip_freeze").length;
    withoutRunner(()=>{
      generalizeAfterNativeRule(ctx,d,art,on(f.c));
      assert.equal(fs.existsSync(receiptOf(d)),false);assert.equal(failures(),0);   // nothing ran yet
      flushDeferredGeneralizations();
      assert.equal(JSON.parse(fs.readFileSync(receiptOf(d),"utf8")).ok,false);assert.equal(failures(),1);
      for(let i=0;i<3;i++){generalizeAfterNativeRule(ctx,d,art,on(f.c));flushDeferredGeneralizations()}
    });
    assert.equal(failures(),2);
  });
});

describe("generalize never rewrites observed rules",()=>{
  it("updates inferred siblings but never observed rules",()=>{
    const f=fx(); const sibling={inputPattern:"i",outputPattern:"o",rule:{...rule('/x'),id:"inferred"}};
    assert.equal(applyGeneralization(f.c,"source",{siblings:[sibling]},f.root)[0].ok,true);
    const update={...sibling,decision:"UPDATE_EXISTING" as const,rule:{...sibling.rule,actionRegex:"^changed (.*)$"}};
    assert.equal(applyGeneralization(f.c,"source",{siblings:[update]},f.root)[0].ok,true);
    let table=JSON.parse(fs.readFileSync(f.c.learnedBackupRulesPath,"utf8"));assert.equal(table.rules[0].revision,2);
    applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:table.version,reason:"observed",inputPattern:"i",outputPattern:"o",rule:{...rule('/x'),id:"observed",provenance:"observed"}});
    // an UPDATE aimed at an observed rule never rewrites it: it lands beside it as <id>-gen
    const widened=applyGeneralization(f.c,"source",{siblings:[{...update,rule:{...update.rule,id:"observed",actionRegex:"^wider"}}]},f.root)[0];
    assert.deepEqual([widened.ok,widened.id],[true,"observed-gen"]);
    table=JSON.parse(fs.readFileSync(f.c.learnedBackupRulesPath,"utf8"));
    assert.equal(table.rules.find((r:LearnedBackupRule)=>r.id==="observed").actionRegex,rule('/x').actionRegex);
    assert.equal(table.rules.find((r:LearnedBackupRule)=>r.id==="observed-gen").provenance,"generalized");
    // a plain ADD_NEW that collides with an observed id is still refused
    assert.equal(applyGeneralization(f.c,"source",{siblings:[{...update,decision:"ADD_NEW",rule:{...update.rule,id:"observed"}}]},f.root)[0].ok,false);
  });
  it("preserves all long examples through updates and generalization prompt",()=>{
    const f=fx();const examples=Array.from({length:7},(_,i)=>String(i)+"x".repeat(5000)+"END");
    applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"r",inputPattern:"i",outputPattern:"o",rule:{...rule('/x'),matchedExamples:examples}});
    const t=JSON.parse(fs.readFileSync(f.c.learnedBackupRulesPath,"utf8"));assert.deepEqual(t.rules[0].matchedExamples,examples);
    const prompt=generalizePrompt(actionView({hook_event:"PreToolUse",tool_name:"Bash",tool_input:{command:"x"}}),t);for(const e of examples)assert.ok(prompt.includes(e));
  });
  it("deduplicates snapshot by action family, retaining separate patch/write families",()=>{
    const artifact={id:"a",timestamp:"t",trigger:"rule" as const,toolName:"Edit",strategy:"git_snapshot" as const,description:"snapshot",artifactPath:"/snapshot"};
    const a:HookContext={hook_event:"PreToolUse",tool_name:"Edit",tool_input:{command:"*** Begin Patch\n*** Update File: /app/a"}};
    const b={...a,tool_input:{command:"*** Begin Patch\n*** Update File: /app/b"}};
    assert.equal(nativeGeneralizationSource(a,artifact),nativeGeneralizationSource(b,artifact));
    assert.notEqual(nativeGeneralizationSource(a,artifact),nativeGeneralizationSource({...a,tool_name:"Write"},artifact));
  });
  it("does not mark failed parsing as a successful dedup event",()=>{
    assert.equal(generalizationAccepted({siblings:[{}]},[{ok:false}]),false);
    assert.equal(generalizationAccepted({siblings:[]},[]),true);
    assert.equal(generalizationAccepted({siblings:[{},{}]},[{ok:false},{ok:true}]),true);
  });
});

describe("generalize prompt: one body, two forms",()=>{
  const v=actionView({hook_event:"PreToolUse",tool_name:"Edit",tool_input:{command:"*** Begin Patch\n*** Update File: /app/x.py\n@@\n-a\n+b\n*** End Patch"},cwd:"/app"});
  const bare=generalizePrompt(v,emptyTable(true)),withTrail=generalizePrompt(v,emptyTable(true),{evidence:{backupResult:{backup_commands:["cp -a /app/x.py PRE"]}},writtenRuleId:"r-1"});
  it("differs only by the trail block",()=>{
    const a=bare.split("\n"),b=withTrail.split("\n");assert.equal(a.length,b.length);
    const diff=a.map((l,i)=>l===b[i]?-1:i).filter(i=>i>=0);assert.equal(diff.length,1);
    assert.ok(a[diff[0]].startsWith("This action just occurred. No backup trail"));
    assert.ok(b[diff[0]].startsWith("BACKUP TRAIL")&&b[diff[0]].includes("cp -a /app/x.py PRE")&&b[diff[0]].includes('"r-1"'));
  });
  it("carries the full action, both axes and both examples",()=>{
    for(const p of [bare,withTrail]){assert.ok(p.includes("*** Update File: /app/x.py")&&p.includes('"workdir":"/app"'));
      for(const k of ["STEP 1 - TARGET","STEP 2 - WIDEN","STEP 3 - OTHER TOOLS","There is no number of rules to reach","THE ACTION ITSELF","EXAMPLE 1. Action: pip install","EXAMPLE 2. Action: DROP TABLE","NON-EXAMPLE"])assert.ok(p.includes(k),k);}
  });
  it("says nothing about how the backup system runs",()=>{
    for(const p of [bare,withTrail])assert.ok(!/built-in|workspace|tier|git snapshot|consulted|subagent|observed rule/i.test(p.split("\nTABLE:")[0]),"internals leaked");
  });
  it("records the axis a sibling came from",()=>{
    const f=fx();applyGeneralization(f.c,"src",{siblings:[{axis:"B2",reason:"r",inputPattern:"i",outputPattern:"o",rule:{...rule("/x"),id:"axis-rule"}}]},f.root);
    assert.equal(JSON.parse(fs.readFileSync(f.c.learnedBackupRulesPath,"utf8")).rules[0].generalizedAxis,"B2");
  });
});
describe("generalize answer tolerance",()=>{
  it("accepts the action's own rule returned beside siblings, and an update of a rule that does not exist",()=>{
    const f=fx();const out=applyGeneralization(f.c,"src",{siblings:[],rule:{...rule("/x"),id:"stray-self"}},f.root);
    assert.deepEqual(out.map(o=>[o.id,o.ok]),[["stray-self",true]]);
    const r=JSON.parse(fs.readFileSync(f.c.learnedBackupRulesPath,"utf8")).rules[0];assert.deepEqual([r.provenance,r.generalizedAxis],["generalized","self"]);
  });
});

// =============================================================================
// ── learned review fixes ──
// =============================================================================

{
function setup(){const root=fs.mkdtempSync(path.join(os.tmpdir(),"review-rule-")),table=path.join(root,"table.json");fs.writeFileSync(table,JSON.stringify(emptyTable(true)));return{root,c:{...DEFAULT_CONFIG,learnedBackupRulesPath:table},ctx:{hook_event:"PreToolUse",tool_name:"Bash",tool_input:{command:"change",description:"same [BACKUP NEEDED]"}} as HookContext}}
function rule(id:string,program:string):LearnedBackupRule{return{id,revision:1,enabled:true,testOnly:true,toolName:"Bash",matchField:"command",actionRegex:"^change$",captures:[],steps:[{program,args:[{binding:"actionDir"}]}],expectedArtifacts:[{path:[{binding:"actionDir"},{literal:"out"}],kind:"file",nonEmpty:true}],inputPattern:"input",outputPattern:"output",learnedFrom:{action:"x",actionDir:"x",reflectedAt:new Date().toISOString()}}}
describe("review fixes",()=>{
 it("records a failed matched rule and continues to a later good rule",()=>{const f=setup(),bad=rule("bad-rule","missing-command"),good=rule("good-rule","sh");good.steps=[{program:"sh",args:[{literal:"-c"},{literal:'printf ok > "$1/out"'},{literal:"step"},{binding:"actionDir"}]}];applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"",inputPattern:"i",outputPattern:"o",rule:bad});applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:1,reason:"",inputPattern:"i",outputPattern:"o",rule:good});const d=path.join(f.root,"a");fs.mkdirSync(d);assert.equal(tryLearnedBackup(f.ctx,d,f.c)?.policyRuleId,"good-rule");assert.match(fs.readFileSync(path.join(d,"learned-rule-failures.jsonl"),"utf8"),/bad-rule/)});
 it("rejects an actually empty expected directory",()=>{const f=setup(),r=rule("empty-dir","mkdir");r.steps=[{program:"mkdir",args:[{binding:"actionDir"},{literal:"/out"}]}];r.expectedArtifacts=[{path:[{binding:"actionDir"},{literal:"out"}],kind:"directory",nonEmpty:true}];applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"",inputPattern:"i",outputPattern:"o",rule:r});const d=path.join(f.root,"a");fs.mkdirSync(d);assert.equal(tryLearnedBackup(f.ctx,d,f.c),null)});
 it("rejects a noop that never writes beneath actionDir, already when the table is written",()=>{const f=setup(),r=rule("noop-action-root","true");r.steps=[{program:"true",args:[]}];r.expectedArtifacts=[{path:[{binding:"actionDir"}],kind:"directory",nonEmpty:true}];assert.throws(()=>applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"",inputPattern:"i",outputPattern:"o",rule:r}),/never reference actionDir/)});
 it("resolves a relative expected artifact beneath actionDir",()=>{const f=setup(),r=rule("relative-artifact","sh");r.steps=[{program:"sh",args:[{literal:"-c"},{literal:'mkdir -p "$1/pre"; printf ok > "$1/pre/data"'},{literal:"step"},{binding:"actionDir"}]}];r.expectedArtifacts=[{path:[{literal:"pre"}],kind:"directory",nonEmpty:true}];applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"",inputPattern:"i",outputPattern:"o",rule:r});const d=path.join(f.root,"a");fs.mkdirSync(d);const artifact=tryLearnedBackup(f.ctx,d,f.c);assert.equal(artifact?.strategy,"learned_rule");assert.equal(artifact?.artifactPath,path.join(d,"pre"))});
 it("composes argv parts and accepts fixed-string shorthand",()=>{const f=setup(),src=path.join(f.root,"src");fs.writeFileSync(src,"joined");const r=rule("joined-argv","cp");r.steps=[{program:"cp",args:["-a",{literal:src},[{binding:"actionDir"},{literal:"/joined"}]]}];r.expectedArtifacts=[{path:[{literal:"joined"}],kind:"file",nonEmpty:true}];applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"",inputPattern:"i",outputPattern:"o",rule:r});const d=path.join(f.root,"a");fs.mkdirSync(d);assert.equal(tryLearnedBackup(f.ctx,d,f.c)?.strategy,"learned_rule");assert.equal(fs.readFileSync(path.join(d,"joined"),"utf8"),"joined")});
 it("recovers a stale pid lock and distinguishes raw from line stdout",()=>{const f=setup();fs.writeFileSync(f.c.learnedBackupRulesPath+".lock","99999999");const r=rule("stdout-rule","sh");r.steps=[{program:"printf",args:[{literal:"value\\n"}],stdoutBinding:"raw",stdoutMode:"raw"},{program:"printf",args:[{literal:"line\\n"}],stdoutBinding:"line",stdoutMode:"line"},{program:"sh",args:[{literal:"-c"},{literal:'printf "%s|%s" "$1" "$2" > "$3/out"'},{literal:"step"},{capture:"raw"},{capture:"line"},{binding:"actionDir"}]}];applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"",inputPattern:"i",outputPattern:"o",rule:r});const d=path.join(f.root,"a");fs.mkdirSync(d);assert.ok(tryLearnedBackup(f.ctx,d,f.c));assert.equal(fs.readFileSync(path.join(d,"out"),"utf8"),"value\n|line")});
 it("normalizes only the description declaration while retaining full command",()=>{const f=setup();assert.equal(canonicalAction(f.ctx),'Bash({"command":"change","description":"same"})')});
 it("moves a prompt larger than 128 KiB to Codex stdin without truncation",()=>{const prompt="x".repeat(200000),t=reflectionTransport({runner:"codex",args:["exec",prompt]},prompt);assert.deepEqual(t.args,["exec","-"]);assert.equal(t.input,prompt)});
 it("locates Codex rollouts in the sibling subcfg home",()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-home-")),cfg=path.join(root,"cfg"),sessions=path.join(root,"subcfg","sessions","2026","09","17");fs.mkdirSync(cfg,{recursive:true});fs.mkdirSync(sessions,{recursive:true});const file=path.join(sessions,"rollout-review.jsonl");fs.writeFileSync(file,"{}\n");const found=locateTranscript({runner:"codex",since:Date.now()-1000,env:{CODEX_HOME:cfg,HOME:path.join(root,"home")},cwd:root});assert.equal(found.file,file)});
 it("uses a rule learned between two actions in the same process",()=>{const f=setup(),first=path.join(f.root,"first");fs.mkdirSync(first);assert.equal(tryLearnedBackup(f.ctx,first,f.c),null);const r=rule("learned-mid-run","sh");r.steps=[{program:"sh",args:[{literal:"-c"},{literal:'printf learned > "$1/out"'},{literal:"step"},{binding:"actionDir"}]}];applyReflectionUpdate(f.c,{decision:"ADD_NEW",baseVersion:0,reason:"learned",inputPattern:"i",outputPattern:"o",rule:r});const second=path.join(f.root,"second");fs.mkdirSync(second);assert.equal(tryLearnedBackup(f.ctx,second,f.c)?.policyRuleId,"learned-mid-run")});
});
}

// =============================================================================
// ── subagent bookkeeping ──
// =============================================================================

/**
 * Tests for the subagent result-bookkeeping path: a capture the subagent wrote to disk must be
 * registered in metadata.json even when its result file is malformed (e.g. over-escaped quotes)
 * or stdout holds prose instead of JSON, since restore finds artifacts only through metadata.json.
 */

{
const SUITES_SUBAGENT_BOOKKEEPING = ["subagent bookkeeping: malformed canonical result file", "subagent bookkeeping: unregistered capture is made visible", "subagent bookkeeping: runSubagentBackup end to end"];
// ── Fixtures ─────────────────────────────────────────────────────────

/** An over-escape shape seen in practice: `\\"` inside the
 *  recovery_commands strings, which closes the JSON string early. */
const OVER_ESCAPED_RESULT = `{"description":"Captured /var/lib/appdata allotment store before 'bin/capctl allot release --apply'.",
"backup_commands":["cp -rn /var/lib/appdata/allotments -> store/"],
"recovery_commands":["restore=$(ls -d /srv/x/store*)","for n in *.jsonl; do [ -f \\\\"$restore/allotments/$n\\\\" ] && cp \\\\"$restore/allotments/$n\\\\" /var/lib/appdata/allotments/$n; done"],
"recovery_mcp_calls":[],
"artifact_paths":["ARTIFACT_PATH_PLACEHOLDER"],
"live_restore":false,
"no_backup_needed":false}`;

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

function tmpActionDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "backupper-bk-"));
}

/** Write a small captured tree (what the subagent's `cp` produced). */
function writeCapturedStore(actionDir: string): string {
  const store = path.join(actionDir, "store", "allotments");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "2026-07.jsonl"), '{"id":1}\n{"id":2}\n');
  fs.writeFileSync(path.join(store, "index.tsv"), "1\theld\n2\treleased\n");
  return path.join(actionDir, "store");
}

// ── 1. The malformed canonical file ──────────────────────────────────

describe("subagent bookkeeping: malformed canonical result file", () => {
  it("recovers an over-escaped result via the narrow repair", () => {
    const dir = tmpActionDir();
    try {
      const artifact = writeCapturedStore(dir);
      fs.writeFileSync(
        path.join(dir, "subagent_result.json"),
        OVER_ESCAPED_RESULT.replace("ARTIFACT_PATH_PLACEHOLDER", artifact),
      );

      // Pre-condition: it really is malformed.
      assert.throws(() =>
        JSON.parse(fs.readFileSync(path.join(dir, "subagent_result.json"), "utf-8")));

      const notes: string[] = [];
      const r = readSubagentResultFile(dir, (m) => notes.push(m));
      assert.ok(r, "malformed-but-repairable result file must still be read");
      assert.match(r.description, /Captured \/var\/lib\/appdata/);
      assert.equal(r.recovery_commands.length, 2);
      // The repair must produce USABLE shell — real quotes, not backslashes.
      assert.match(r.recovery_commands[1], /\[ -f "\$restore\/allotments\/\$n" \]/);
      assert.ok(notes.some((n) => /over-escape/.test(n)), "must announce the repair");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the fallback scan even when the canonical file is malformed", () => {
    // A parse error in the canonical file must not skip the fallback scan.
    const dir = tmpActionDir();
    try {
      fs.writeFileSync(path.join(dir, "subagent_result.json"), "{ this is not json at all ,,,");
      fs.writeFileSync(
        path.join(dir, "backlog_manifest.json"),
        JSON.stringify({
          description: "wrong filename but right shape",
          backup_commands: ["cp a b"],
          recovery_commands: ["cp b a"],
        }),
      );

      const notes: string[] = [];
      const r = readSubagentResultFile(dir, (m) => notes.push(m));
      assert.ok(r, "fallback scan must run despite the malformed canonical file");
      assert.equal(r.description, "wrong filename but right shape");
      assert.ok(notes.some((n) => /backlog_manifest\.json/.test(n)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when neither the repair nor the scan finds our shape", () => {
    const dir = tmpActionDir();
    try {
      fs.writeFileSync(path.join(dir, "subagent_result.json"), '{"description": "no recovery an');
      fs.writeFileSync(path.join(dir, "other.json"), '{"unrelated": true}');
      assert.equal(readSubagentResultFile(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the repair narrow — it is not a general JSON fixer", () => {
    // No `\\"` sequence → nothing to try.
    assert.equal(repairOverEscapedQuotes('{"a": 1,,}'), null);
    assert.equal(repairOverEscapedQuotes('{"a": "plain"}'), null);
    // Only the `\\"` sequence is rewritten; other content is untouched.
    assert.equal(repairOverEscapedQuotes('{"a":"x \\\\" y"}'), '{"a":"x \\" y"}');

    // A VALID document whose value legitimately ends in a backslash parses
    // on the first attempt, so the repair (which would corrupt it) is
    // never reached.
    const dir = tmpActionDir();
    try {
      fs.writeFileSync(
        path.join(dir, "subagent_result.json"),
        '{"description":"trailing backslash C:\\\\","recovery_commands":["echo ok"]}',
      );
      const r = readSubagentResultFile(dir);
      assert.ok(r);
      assert.equal(r.description, "trailing backslash C:\\");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 2. Captured-but-unregistered detection ───────────────────────────

describe("subagent bookkeeping: unregistered capture is made visible", () => {
  it("findCapturedArtifacts ignores our own bookkeeping files", () => {
    const dir = tmpActionDir();
    try {
      fs.writeFileSync(path.join(dir, "metadata.json"), "[]");
      fs.writeFileSync(path.join(dir, "instruction.txt"), "do the thing");
      fs.writeFileSync(path.join(dir, "subagent_result.json"), "{}");
      fs.writeFileSync(path.join(dir, "subagent_a1b2c3d4.json"), "{}");
      assert.equal(findCapturedArtifacts(dir), null,
        "a dir with only bookkeeping files holds no capture");

      writeCapturedStore(dir);
      const cap = findCapturedArtifacts(dir);
      assert.ok(cap);
      assert.equal(cap.files, 2);
      assert.ok(cap.bytes > 0);
      assert.ok(cap.sample.some((s) => s.includes("2026-07.jsonl")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reportUnregisteredCapture stays silent when nothing was captured", () => {
    const dir = tmpActionDir();
    try {
      fs.writeFileSync(path.join(dir, "metadata.json"), "[]");
      const logs: string[] = [];
      reportUnregisteredCapture(dir, "test", (m) => logs.push(m));
      assert.equal(fs.existsSync(path.join(dir, UNREGISTERED_MARKER)), false,
        "'no backup was needed' must not raise a false alarm");
      assert.equal(logs.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reportUnregisteredCapture drops a marker file naming the orphaned bytes", () => {
    const dir = tmpActionDir();
    try {
      writeCapturedStore(dir);
      const logs: string[] = [];
      reportUnregisteredCapture(dir, "result file malformed", (m) => logs.push(m));

      const marker = path.join(dir, UNREGISTERED_MARKER);
      assert.ok(fs.existsSync(marker), "a discarded capture must leave a marker");
      const text = fs.readFileSync(marker, "utf-8");
      assert.match(text, /UNREGISTERED CAPTURE/);
      assert.match(text, /result file malformed/);
      assert.match(text, /metadata\.json/);
      assert.match(text, /2026-07\.jsonl/);
      assert.ok(logs.some((l) => /UNREGISTERED CAPTURE/.test(l)), "must also hit the debug log");

      // The marker itself must not be mistaken for a captured artifact.
      const cap = findCapturedArtifacts(dir);
      assert.ok(cap);
      assert.equal(cap.files, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 3. End-to-end through runSubagentBackup, with a mock claude ──────

const MOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-bk-claude-"));
const MOCK_CLAUDE = path.join(MOCK_DIR, "claude");
let originalPath = "";

/** A typical stdout: a claude -p JSON wrapper whose `result` is
 *  PROSE (not our JSON) and which — as every claude -p run does — carries
 *  an EMPTY "permission_denials" array. */
const APPDATA_STDOUT = JSON.stringify({
  is_error: false,
  permission_denials: [],
  subtype: "success",
  result:
    "Backup complete. Captured the appdata allotment store before " +
    "`capctl allot release --apply` rewrites held→released state.",
  type: "result",
});

/** The mock must WRITE the result file itself: subagent_watch.js deletes
 *  any stale subagent_result.json before starting the run, so a file
 *  pre-planted by the test would never survive to be read. */
function installMockClaude(stdout: string, resultFile?: string, resultBody?: string): void {
  const responseFile = path.join(MOCK_DIR, "response.txt");
  fs.writeFileSync(responseFile, stdout, "utf-8");
  let script = `#!/bin/sh\ncat > /dev/null\n`;
  if (resultFile !== undefined && resultBody !== undefined) {
    const bodyFile = path.join(MOCK_DIR, "result_body.txt");
    fs.writeFileSync(bodyFile, resultBody, "utf-8");
    script += `cp "${bodyFile}" "${resultFile}"\n`;
  }
  script += `cat "${responseFile}"\n`;
  fs.writeFileSync(MOCK_CLAUDE, script);
  fs.chmodSync(MOCK_CLAUDE, 0o755);
}

beforeEach(onceIn(SUITES_SUBAGENT_BOOKKEEPING, () => {
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${MOCK_DIR}:${originalPath}`;
}));

after(() => {
  process.env.PATH = originalPath;
  try { fs.rmSync(MOCK_DIR, { recursive: true, force: true }); } catch { /* */ }
});

function setup(): { workspace: string; config: SandboxConfig; originalCwd: string } {
  const originalCwd = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-bk-ws-"));
  process.chdir(workspace);
  const config: SandboxConfig = {
    ...DEFAULT_CONFIG,
    backupDir: path.join(workspace, ".backupper", "backups"),
    maxActions: 10,
    subagentEnabled: true,
    subagentTimeoutSeconds: 10,
  };
  fs.mkdirSync(config.backupDir, { recursive: true });
  return { workspace, config, originalCwd };
}

describe("subagent bookkeeping: runSubagentBackup end to end", () => {
  beforeEach(() => resetAction());

  it("registers a capture whose result file is malformed", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      const actionDir = path.join(config.backupDir, "action_001");
      fs.mkdirSync(actionDir, { recursive: true });
      const artifactPath = writeCapturedStore(actionDir);
      installMockClaude(
        APPDATA_STDOUT,
        path.join(actionDir, "subagent_result.json"),
        OVER_ESCAPED_RESULT.replace("ARTIFACT_PATH_PLACEHOLDER", artifactPath),
      );

      const outcome = runSubagentBackup(
        makeCtx("Bash", { command: "bin/capctl allot release --apply" }),
        actionDir,
        config,
      );

      assert.ok(outcome && outcome !== "read_only",
        "a correctly-captured backup must be registered, not dropped");
      assert.equal(outcome.strategy, "subagent");
      assert.equal(outcome.subagentCommands?.length, 2);
      // Nothing was orphaned, so no alarm.
      assert.equal(fs.existsSync(path.join(actionDir, UNREGISTERED_MARKER)), false);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("marks the capture when the result is unrecoverable, and does not misdiagnose", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      const actionDir = path.join(config.backupDir, "action_001");
      fs.mkdirSync(actionDir, { recursive: true });
      writeCapturedStore(actionDir);
      // Beyond any narrow repair, and no sibling file has our shape.
      installMockClaude(APPDATA_STDOUT, path.join(actionDir, "subagent_result.json"), "<<<garbage>>>");

      const outcome = runSubagentBackup(
        makeCtx("Bash", { command: "bin/capctl allot release --apply" }),
        actionDir,
        config,
      );

      assert.equal(outcome, null, "an unreadable result still yields no artifact");
      const marker = path.join(actionDir, UNREGISTERED_MARKER);
      assert.ok(fs.existsSync(marker),
        "a discarded 6.5 MB capture must not look identical to 'no backup needed'");
      assert.match(fs.readFileSync(marker, "utf-8"), /2026-07\.jsonl/);

      // An EMPTY "permission_denials":[] must not be read as a denial —
      // that misdiagnosis told the user to upgrade their CLI while the
      // real problem was the result file.
      const log = fs.readFileSync(
        path.join(path.dirname(path.resolve(config.backupDir)), "subagent.log"),
        "utf-8",
      );
      assert.doesNotMatch(log, /denied tool permissions/,
        "empty permission_denials must not trigger the permission diagnosis");
      assert.match(log, /UNREGISTERED CAPTURE/);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("a read-only verdict is a clean skip, not a BACKUP UNVERIFIED alarm", () => {
    // A read-only verdict legitimately has empty recovery arrays; flagging it UNVERIFIED would
    // bury real warnings among false ones.
    const { workspace, config, originalCwd } = setup();
    try {
      const actionDir = path.join(config.backupDir, "action_001");
      fs.mkdirSync(actionDir, { recursive: true });
      installMockClaude(
        APPDATA_STDOUT,
        path.join(actionDir, "subagent_result.json"),
        JSON.stringify({
          description: "Action bin/capctl status is read-only.",
          backup_commands: [],
          recovery_commands: [],
          no_backup_needed: true,
        }),
      );

      const outcome = runSubagentBackup(
        makeCtx("Bash", { command: "bin/capctl status" }),
        actionDir,
        config,
      );

      assert.equal(outcome, "read_only");
      const log = fs.readFileSync(
        path.join(path.dirname(path.resolve(config.backupDir)), "subagent.log"),
        "utf-8",
      );
      assert.doesNotMatch(log, /BACKUP UNVERIFIED/,
        "a clean read-only skip must not raise the unverified alarm");
      assert.match(log, /verdict: read-only/);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
}

describe("custom personalization", () => {
  it("uses the user's own preference text, and setting it turns custom on", async () => {
    const { personalizationPrompt, captureScope } = await import("../../src/backup/personalization.js");
    const { loadConfig } = await import("../../src/config/load.js");
    const own = "Only back up the customer database and anything under docs/.";
    assert.match(personalizationPrompt("custom", own), /USER BACKUP PREFERENCE: Only back up the customer database/);
    assert.match(captureScope("custom", { protect: true, targets: ["docs/a.md"], why: "w" } as never, own), /^Only back up the customer database/);
    assert.throws(() => personalizationPrompt("custom", "  "), /personalizationPolicy is empty/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bu-custom-pref-"));
    try {
      fs.mkdirSync(path.join(dir, ".backupper"));
      fs.writeFileSync(path.join(dir, ".backupper", "config.json"), JSON.stringify({ personalizationPolicy: own }));
      const c = loadConfig(dir);
      assert.equal(c.personalization, "custom");
      assert.equal(c.personalizationPolicy, own);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
