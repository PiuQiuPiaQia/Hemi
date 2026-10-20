import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sessionLoadoutRevision, roleSessionRevision} from './session-revision.mjs';
test('相同路径的Skill或项目规范内容变化及工具开关变化均作废旧装配，凭据不泄露',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'hemi-loadout-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const agentDir=path.join(dir,'agent'),skill=path.join(dir,'skill');await mkdir(agentDir);await mkdir(skill);
 await writeFile(path.join(skill,'SKILL.md'),'---\nname: local\n---\noriginal');
 await writeFile(path.join(dir,'AGENTS.md'),'PROJECT_ORIGINAL');
 const args={caps:{features:{browser:false},extensionConfig:{web:{apiKey:'TEST_SECRET'}}},placement:{cwd:dir,loadContextFiles:true},skills:[{path:skill}],agentDir,memoryEnabled:false};
 const a=await sessionLoadoutRevision(args);assert.equal(await sessionLoadoutRevision(args),a);assert.equal(a.includes('TEST_SECRET'),false);
 await writeFile(path.join(skill,'SKILL.md'),'---\nname: local\n---\nchanged');const b=await sessionLoadoutRevision(args);assert.notEqual(a,b);
 await writeFile(path.join(dir,'AGENTS.md'),'PROJECT_CHANGED');const c=await sessionLoadoutRevision(args);assert.notEqual(b,c);
 args.caps.features.browser=true;assert.notEqual(c,await sessionLoadoutRevision(args));
 const role={mode:'run',tools:['read'],systemPrompt:'prompt'};
 assert.notEqual(roleSessionRevision(role,{loadoutRevision:a}),roleSessionRevision(role,{loadoutRevision:b}));
});
