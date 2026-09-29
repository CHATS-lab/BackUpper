import {describe,it} from "node:test";import assert from "node:assert/strict";import * as fs from "node:fs";import * as os from "node:os";import * as path from "node:path";
import {DEFAULT_CONFIG,type HookContext} from "../../src/types.js";import {actionView,recordGeneralizedSource,applyReflectionUpdate,emptyTable,matchLearnedRule,tryLearnedBackup,type LearnedBackupRule} from "../../src/self-improving/learned_backup.js";
import {reflectionTransport,applyGeneralization,generalizePrompt,generalizeAfterReflection,generalizeAfterNativeRule,nativeGeneralizationSource,generalizationAccepted,flushDeferredGeneralizations} from "../../src/self-improving/reflection.js";import {buildSubagentInvocation} from "../../src/backup/subagent.js";
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
