// 064 产品边界验证。Node 父进程只提供外部模型端点、观察文件和启动/重启真实 Electron。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import electron from 'electron';
const dir = await mkdtemp(path.join(os.homedir(), 'Library/Caches/hemi-064-lifecycle-'));
const out = path.resolve('.visual/workflow/vision'); await mkdir(out, {recursive:true});
const evidence = {dir, checks:[], requests:[], phases:[]};
const check = (name, ok) => {evidence.checks.push({name,pass:!!ok}); console.log(`${ok?'PASS':'FAIL'} ${name}`); assert.ok(ok,name);};
const pause = ms => new Promise(r=>setTimeout(r,ms));
const wait = async (fn, label, ms=15000) => {const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await pause(40);}throw Error(label);};
const work = path.join(dir,'workspace/default'), file = name=>path.join(work,name);
let sessionRef,loadoutRef;
const suite=process.env.HEMI_064_SUITE??'lifecycle';
const crashHeld = new Set();
const textOf = m => typeof m.content==='string'?m.content:JSON.stringify(m.content);
const server=http.createServer(async(req,res)=>{try{
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
 const users=body.messages.filter(m=>m.role==='user').map(textOf);
 const marker=[...users].reverse().map(t=>t.match(/EDGE_[A-Z_0-9]+/)?.[0]).find(Boolean);
 let pending=new Set(), historyPairsValid=true;
 for (const message of body.messages) {
  if(message.role==='tool'){if(!pending.delete(message.tool_call_id))historyPairsValid=false;}
  else {if(pending.size)historyPairsValid=false;pending=new Set((message.tool_calls??[]).map(call=>call.id));}
 }
 historyPairsValid &&= pending.size===0;
 const main=(body.tools??[]).some(t=>t.function.name==='task');
 const tools=body.messages.slice(body.messages.findLastIndex(m=>m.role==='user')+1).filter(m=>m.role==='tool');
 evidence.requests.push({marker,historyPairsValid,model:body.model,url:req.url,main,declaredTools:(body.tools??[]).map(t=>t.function.name),tools:tools.map(m=>({id:m.tool_call_id,text:textOf(m).slice(0,1000)})),hasOldChildMemory:JSON.stringify(body.messages).includes('REMEMBER_64_FIRST'),auth:req.headers.authorization==='Bearer ROTATED_64'?'rotated':'original'});
 if(!historyPairsValid){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'unpaired historical tool calls'}}));return;}
 if(marker==='EDGE_AUTH'&&body.model==='main'){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'controlled invalid credential'}}));return;}
 if(marker==='EDGE_FALLBACK'&&body.model==='main'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'controlled outage'}}));return;}
 let text='已完成。',calls=[];
 const tool=(name,args)=>({index:calls.length,id:main&&['EDGE_RESUME_FIRST','EDGE_RESUME_SECOND'].includes(marker)?'call-0':`call-${marker}-${calls.length}`,type:'function',function:{name,arguments:JSON.stringify(args)}});
 const add=(name,args)=>calls.push(tool(name,args));
 if(!(body.tools??[]).length) text='生命周期验证';
 else if(main&&textOf(body.messages.findLast(m=>m.role==='user')).includes('子任务完成')) {
  if(marker==='EDGE_CRASH_INJECTED'){crashHeld.add('injected');res.writeHead(200,{'content-type':'text/event-stream'});res.write(': held before acknowledgement\n\n');return;}
  text='所属子任务已收口。';
 }
 else if(main){
  if(marker==='EDGE_EMPTY_FOLLOW'&&!tools.length)add('task',{agent:'explorer',description:'未配置跟随主模型',prompt:'EDGE_EMPTY_CHILD 只回答已核对'});
  else if(marker==='EDGE_READONLY'&&!tools.length)add('task',{agent:'explorer',description:'验证只读边界',prompt:'EDGE_READONLY_CHILD 验证工具边界'});
  else if(marker==='EDGE_CAPABILITY'&&!tools.length)add('task',{agent:'oracle',description:'拒绝缺少图像能力',requirements:{imageInput:true},prompt:'不得启动不具备能力的模型'});
  else if(marker==='EDGE_LOADOUT_FIRST'&&!tools.length)add('task',{agent:'fixer',description:'规范变化前的子会话',prompt:'EDGE_LOADOUT_CHILD 只回答已记录'});
  else if(marker==='EDGE_LOADOUT_FIRST'&&tools.length){loadoutRef=JSON.parse(tools[0].content).session_id;assert.ok(loadoutRef);}
  else if(marker==='EDGE_LOADOUT_SECOND'&&!tools.length)add('task',{agent:'fixer',description:'拒绝旧规范会话',session_id:loadoutRef,prompt:'不得沿用过期项目规范'});
  else if(marker==='EDGE_BUDGET')add('read',{path:file('resume.txt')});
  else if(marker==='EDGE_CONCURRENCY'&&!tools.length){for(let index=0;index<6;index++)add('task',{agent:'explorer',description:`并发角色 ${index}`,prompt:`EDGE_CONCURRENT_CHILD_${index} 只返回完成`});}
  else if(marker==='EDGE_CRASH_BEFORE') {crashHeld.add('before');res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'partial',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'partial-call',type:'function',function:{name:'write',arguments:'{"path":'}}]},finish_reason:null}]})}\n\n`);return;}
  else if(marker==='EDGE_CRASH_EFFECT'&&!tools.length)add('bash',{command:`printf 'once\n' >> ${JSON.stringify(file('crash-effect-count'))}; sleep 3; printf late > ${JSON.stringify(file('crash-effect-late'))}`});
  else if(['EDGE_CRASH_TERMINAL','EDGE_CRASH_INJECTED'].includes(marker)&&!tools.length)add('task',{agent:'fixer',background:true,description:'崩溃窗口子任务',prompt:`${marker==='EDGE_CRASH_TERMINAL'?'EDGE_CRASH_CHILD_TERMINAL':'EDGE_CRASH_CHILD_INJECTED'} 只追加本次一次计数`});
  else if(marker==='EDGE_CRASH_TERMINAL'&&tools.length){crashHeld.add('terminal');res.writeHead(200,{'content-type':'text/event-stream'});res.write(': parent model held\n\n');return;}
  else if(marker==='EDGE_RESUME_FIRST'&&!tools.length)add('task',{agent:'fixer',description:'首次子会话',prompt:'EDGE_CHILD_FIRST 写入本次文件并记住标记'});
  else if(marker==='EDGE_RESUME_SECOND'&&!tools.length)add('task',{agent:'fixer',description:'跨重启续用',session_id:sessionRef,prompt:'EDGE_CHILD_SECOND 沿原文件继续，只追加一次'});
  else if(['EDGE_FOREIGN','EDGE_WRONG_ROLE'].includes(marker)&&!tools.length)add('task',{agent:marker==='EDGE_WRONG_ROLE'?'oracle':'fixer',description:'拒绝错误续用',session_id:sessionRef,prompt:'不得执行任何新动作'});
  else if(marker==='EDGE_CROSS_CONTROL'&&!tools.length){add('task_status',{id:sessionRef,wait:true,timeout_s:1});add('task_message',{id:sessionRef,message:'不得越界送达'});add('task_cancel',{id:sessionRef});}
  else if(marker==='EDGE_DIRECT'&&!tools.length)add('write',{path:file('direct.txt'),content:'HEMI_064_AUTO_DIRECT'});
  else if(marker==='EDGE_HOLDER'&&!tools.length)add('task',{agent:'fixer',background:true,description:'等待中的旧目标',prompt:'EDGE_HOLD_CHILD 开始后等待外部释放'});
  else if(marker==='EDGE_PROMOTE_OLD'&&!tools.length)add('task',{agent:'fixer',background:true,description:'被优先任务取代的子任务',prompt:'EDGE_PROMOTE_CHILD 启动命令等待结束'});
  else if(marker==='EDGE_CANCEL_ONE'&&!tools.length){add('task',{agent:'fixer',background:true,description:'应取消',prompt:'EDGE_CANCEL_CHILD 等待中的子任务'});add('task',{agent:'fixer',background:true,description:'应保留',prompt:'EDGE_KEEP_CHILD 保留兄弟成果'});}
  else if(marker==='EDGE_CANCEL_ONE'&&!tools.some(m=>textOf(m).includes('已请求停止'))){
   const receipt=tools.map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).find(x=>x?.taskId);
   if(receipt){await wait(()=>readFile(file('cancel-started'),'utf8').catch(()=>false),'取消前工具未开始');add('task_cancel',{id:receipt.taskId});}
  }
  else if(marker==='EDGE_QUEUED'&&!tools.length)add('write',{path:file('queued.txt'),content:'HEMI_064_FROZEN_QUEUE'});
  else if(marker==='EDGE_PROMOTE_NEW'&&!tools.length)add('write',{path:file('priority.txt'),content:'HEMI_064_PRIORITY'});
 }else{
  if(marker==='EDGE_READONLY_CHILD'&&!tools.length){add('write',{path:file('readonly-forbidden.txt'),content:'SHOULD_NOT_EXIST'});add('bash',{command:'printf forbidden > '+JSON.stringify(file('readonly-command-forbidden.txt'))});add('task',{agent:'fixer',description:'禁止递归',prompt:'不得创建'});}
  else if(marker?.startsWith('EDGE_CONCURRENT_CHILD_')){await wait(()=>readFile(file('release-concurrency'),'utf8').catch(()=>false),'并发端点未释放');text='已完成并发任务。';}
  else if(['EDGE_CRASH_CHILD_TERMINAL','EDGE_CRASH_CHILD_INJECTED'].includes(marker)&&!tools.length)add('bash',{command:`printf 'once\n' >> ${JSON.stringify(file(marker==='EDGE_CRASH_CHILD_TERMINAL'?'crash-terminal-count':'crash-injected-count'))}`});
  else if(marker==='EDGE_CHILD_FIRST'&&!tools.length)add('write',{path:file('resume.txt'),content:'HEMI_064_FIRST'});
  else if(marker==='EDGE_CHILD_FIRST'&&!tools.some(m=>textOf(m).includes('交付文件已声明')))add('register_delivery',{files:[{path:file('resume.txt'),description:'续用文件'}]});
  else if(marker==='EDGE_CHILD_FIRST')text='REMEMBER_64_FIRST';
  else if(marker==='EDGE_CHILD_SECOND'&&!tools.length){assert.ok(JSON.stringify(body.messages).includes('REMEMBER_64_FIRST'),'恢复后的子会话丢失原始上下文');add('edit',{path:file('resume.txt'),old_string:'HEMI_064_FIRST',new_string:'HEMI_064_FIRST\nHEMI_064_SECOND'});}
  else if(marker==='EDGE_CHILD_SECOND'&&!tools.some(m=>textOf(m).includes('交付文件已声明')))add('register_delivery',{files:[{path:file('resume.txt'),description:'续用文件'}]});
  else if(marker==='EDGE_HOLD_CHILD'&&!tools.length)add('bash',{command:`printf started > ${JSON.stringify(file('holder-started'))}; while [ ! -f ${JSON.stringify(file('release-holder'))} ]; do sleep 0.1; done`});
  else if(marker==='EDGE_PROMOTE_CHILD'&&!tools.length)add('bash',{command:`printf started > ${JSON.stringify(file('promote-started'))}; sleep 6; printf late > ${JSON.stringify(file('promote-late'))}`});
  else if(marker==='EDGE_CANCEL_CHILD'&&!tools.length)add('bash',{command:`printf started > ${JSON.stringify(file('cancel-started'))}; sleep 6; printf late > ${JSON.stringify(file('cancel-late'))}`});
  else if(marker==='EDGE_KEEP_CHILD'&&!tools.length)add('write',{path:file('keep.txt'),content:'HEMI_064_SIBLING_OK'});
 }
 res.writeHead(200,{'content-type':'text/event-stream'});
 const chunk=data=>res.write(`data: ${JSON.stringify({id:'edge',object:'chat.completion.chunk',created:0,model:body.model,choices:[{index:0,...data}]})}\n\n`);
 chunk({delta:{role:'assistant',...(calls.length?{tool_calls:calls}:{content:text})},finish_reason:null});
 res.write(`data: ${JSON.stringify({id:'edge',object:'chat.completion.chunk',created:0,model:body.model,choices:[{index:0,delta:{},finish_reason:calls.length?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:50}}})}\n\n`);res.end('data: [DONE]\n\n');
}catch(error){console.error(error);if(!res.headersSent)res.writeHead(500);res.end(JSON.stringify({error:{message:error.message}}));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const phase=async name=>{
 const log=[];const child=spawn(electron,['scripts/lib/verify-064-lifecycle-child.mjs'],{env:{...process.env,HEMI_SMOKE_TEST:'1',HEMI_USER_DATA_DIR:dir,HEMI_EDGE_PHASE:name,HEMI_EDGE_URL:`http://127.0.0.1:${server.address().port}/old/v1`},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>log.push(x));child.stderr.on('data',x=>log.push(x));
 const timer=setTimeout(()=>child.kill('SIGKILL'),90000);
 const code=await new Promise(r=>child.once('exit',r));clearTimeout(timer);await writeFile(path.join(out,`064-lifecycle-${name}.log`),Buffer.concat(log));
 const result=JSON.parse(await readFile(path.join(dir,`${name}.json`),'utf8'));evidence.phases.push(result);check(`产品阶段 ${name}`,code===0&&result.ok);return result;
};
async function crashAt(kind) {
 const log=[];const child=spawn(electron,['scripts/lib/verify-064-lifecycle-child.mjs'],{env:{...process.env,HEMI_SMOKE_TEST:'1',HEMI_USER_DATA_DIR:dir,HEMI_EDGE_PHASE:`crash-${kind}`,HEMI_EDGE_URL:`http://127.0.0.1:${server.address().port}/old/v1`},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>log.push(x));child.stderr.on('data',x=>log.push(x));
 try{
  await wait(async()=>{
   const j=await readFile(path.join(dir,'runtime-v2/run-journal.json'),'utf8').then(JSON.parse);
   if(kind==='before')return crashHeld.has(kind);
   if(kind==='effect')return await readFile(file('crash-effect-count'),'utf8').catch(()=>false)&&Object.values(j.processes).some(p=>p.owner.conversationId==='conv-edge-crash-effect'&&p.state==='active');
   const events=Object.values(j.inbox).filter(e=>e.owner.conversationId===`conv-edge-crash-${kind}`&&e.state==='pending');
   return crashHeld.has(kind)&&events.length===1;
  },`没有进入 ${kind} 崩溃窗口`);
  const ended=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await ended;
  check(`实际在 ${kind} 窗口终止宿主`,true);
 }finally{if(!child.killed)child.kill('SIGKILL');await writeFile(path.join(out,`064-crash-${kind}.log`),Buffer.concat(log));}
 await phase(`recover-${kind}`);
 const j=JSON.parse(await readFile(path.join(dir,'runtime-v2/run-journal.json'),'utf8'));
 const roots=Object.values(j.roots).filter(r=>r.owner.conversationId===`conv-edge-crash-${kind}`&&r.kind!=='auxiliary');
 check(`${kind} 旧目标中断、新目标完成且不自动续跑`,roots.length===2&&roots[0].status==='interrupted'&&roots[1].status==='completed');
 check(`${kind} 无未消费的旧完成通知`,Object.values(j.inbox).filter(e=>e.owner.conversationId===`conv-edge-crash-${kind}`).every(e=>e.state==='obsolete'));
}
try{
 await phase('first');
 const journal=()=>readFile(path.join(dir,'runtime-v2/run-journal.json'),'utf8').then(JSON.parse);
 const first=Object.values((await journal()).tasks).find(t=>t.owner.conversationId==='conv-edge-resume');sessionRef=first.result.sessionRef;
 check('首次子会话完成且实际写入',first.result.outcome==='complete'&&await readFile(file('resume.txt'),'utf8')==='HEMI_064_FIRST');
 if(suite==='boundaries'){
  await phase('boundaries');
  check('自动路由下主agent直接执行小修改',await readFile(file('direct.txt'),'utf8')==='HEMI_064_AUTO_DIRECT'&&!evidence.requests.some(r=>r.marker==='EDGE_DIRECT'&&!r.main&&r.declaredTools.length));
  const follows=evidence.requests.filter(r=>r.marker==='EDGE_EMPTY_CHILD');
  check('空角色槽实际请求跟随主模型',follows.length===1&&follows[0].model==='main'&&!follows[0].main);
  const readonly=evidence.requests.filter(r=>r.marker==='EDGE_READONLY_CHILD');
  check('只读角色不持有写工具和派单，违规请求均未执行',readonly.length===2&&readonly.every(r=>!r.declaredTools.includes('write')&&!r.declaredTools.includes('bash')&&!r.declaredTools.includes('task'))&&readonly.at(-1).tools.length===3&&readonly.at(-1).tools.every(t=>/not found|不存在|Unknown tool/i.test(t.text))&&!await readFile(file('readonly-forbidden.txt'),'utf8').catch(()=>false)&&!await readFile(file('readonly-command-forbidden.txt'),'utf8').catch(()=>false));
  check('能力不足和项目规范变化时拒绝派单，不启动子模型',evidence.requests.filter(r=>['EDGE_CAPABILITY','EDGE_LOADOUT_SECOND'].includes(r.marker)&&r.main).every(r=>!r.tools.length||r.tools.some(t=>/没有满足任务能力|角色／工具／提示词版本不兼容/.test(t.text)))&&!evidence.requests.some(r=>['EDGE_CAPABILITY','EDGE_LOADOUT_SECOND'].includes(r.marker)&&!r.main&&r.declaredTools.length));
 }else{
 await phase('resume');
 const tasks=Object.values((await journal()).tasks).filter(t=>t.owner.conversationId==='conv-edge-resume');
 check('重启后续用原会话并创建新任务，旧记录不变',tasks.length===2&&tasks[1].result.sessionRef===sessionRef&&tasks[1].result.resumesTaskId===first.result.taskId&&JSON.stringify(tasks[0])===JSON.stringify(first));
 check('续用不重跑原副作用且追加正确',await readFile(file('resume.txt'),'utf8')==='HEMI_064_FIRST\nHEMI_064_SECOND');
 const before=evidence.requests.length;await phase('controls');
 check('越界及跨角色续用未启动子模型',evidence.requests.slice(before).filter(r=>['EDGE_FOREIGN','EDGE_WRONG_ROLE','EDGE_CROSS_CONTROL'].includes(r.marker)).every(r=>r.main||!r.declaredTools.length));
 await phase('queue');
 const q=evidence.requests.filter(r=>r.marker==='EDGE_QUEUED'&&r.main);
 check('队列使用受理时模型与原端点，但刷新同身份凭据',q.length>0&&q.every(r=>r.model==='main'&&r.url.startsWith('/old/')&&r.auth==='rotated'));
 check('下一新目标使用新模型和新端点',evidence.requests.some(r=>r.marker==='EDGE_NEW_CONFIG'&&r.model==='alternate'&&r.url.startsWith('/new/')));
 await phase('cancel');await pause(6500);
 check('取消后无迟到动作且兄弟任务完成',!(await readFile(file('cancel-late'),'utf8').catch(()=>null))&&await readFile(file('keep.txt'),'utf8')==='HEMI_064_SIBLING_OK');
 await phase('promote');await pause(6500);
 check('优先目标正确执行，旧子任务未迟到写入',await readFile(file('priority.txt'),'utf8')==='HEMI_064_PRIORITY'&&!(await readFile(file('promote-late'),'utf8').catch(()=>null)));
 await phase('auth');
 check('认证错误不走备用',!evidence.requests.some(r=>r.marker==='EDGE_AUTH'&&r.model==='backup'));
 await phase('limits');
 const limited=await journal(),budgetRoot=Object.values(limited.roots).find(r=>r.owner.conversationId==='conv-edge-budget'&&r.kind!=='auxiliary');
 const used=Object.values(limited.requests).filter(r=>(limited.roots[r.owner.rootRunId]?.sourceRootRunId??r.owner.rootRunId)===budgetRoot.owner.rootRunId);
 check('执行上限60次加一次无工具总结，如实失败且未偷偷切备用',used.filter(r=>r.purpose!=='budget-summary').length===60&&used.filter(r=>r.purpose==='budget-summary').length===1&&used.length===61&&budgetRoot.status==='failed'&&budgetRoot.reason.includes('上限')&&!evidence.requests.some(r=>r.marker==='EDGE_BUDGET'&&r.model==='backup'));
 for(const kind of ['before','effect','terminal','injected'])await crashAt(kind);
 await pause(3200);
 check('崩溃后副作用计数保持一次，旧命令没有迟到写入',await readFile(file('crash-effect-count'),'utf8')==='once\n'&&await readFile(file('crash-terminal-count'),'utf8')==='once\n'&&await readFile(file('crash-injected-count'),'utf8')==='once\n'&&!await readFile(file('crash-effect-late'),'utf8').catch(()=>null));
 for(const p of evidence.phases)check(`${p.phase} 根目标最终均收口`,p.terminal===true);
 check('恢复后实际请求的工具调用与结果配对完整',evidence.requests.every(r=>r.historyPairsValid));
 }
 evidence.passed=true;
}catch(error){evidence.error=error.stack;evidence.passed=false;console.error(error.stack);}finally{
 server.closeAllConnections();server.close();await writeFile(path.join(out,suite==='boundaries'?'064-lifecycle-boundaries.json':'064-lifecycle.json'),JSON.stringify(evidence,null,2));console.log('HEMI_064_LIFECYCLE='+JSON.stringify({passed:evidence.passed,dir,checks:evidence.checks,error:evidence.error}));process.exitCode=evidence.passed?0:1;
}
