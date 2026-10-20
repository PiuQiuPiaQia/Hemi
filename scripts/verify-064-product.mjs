// 隔离产品验证：仅 provider 是本机可控端点；真实 renderer/preload/IPC/模型解析/Pi/工具/交付/停止/持久化。
import { app, safeStorage, nativeTheme, Menu } from 'electron';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createMainWindow } from '../src/main/windows/main-window.mjs';
import { state } from '../src/main/state.mjs';
import { installNativeShell } from '../src/main/windows/native-shell.mjs';
import { getAgentRuntime } from '../src/main/ipc/llm.ipc.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ud = process.env.HEMI_USER_DATA_DIR || await mkdtemp(path.join(os.homedir(),'Library/Caches/hemi-064-product-'));
const output = path.resolve('.visual/workflow/vision'); await mkdir(output,{recursive:true});
const variant = process.env.HEMI_064_VARIANT ?? (process.env.VITE_DEV_SERVER_URL ? 'dev' : 'build');
const evidence = {variant,userData:ud,checks:[],requests:[],consoleErrors:[],screenshots:[]};
const check = (name,condition,detail=null) => { evidence.checks.push({name,pass:Boolean(condition),detail}); console.log(`${condition?'PASS':'FAIL'} ${name}`); assert.ok(condition,name); };
const exec = code => state.mainWindow.webContents.executeJavaScript(code);
const wait = async (fn,label,ms=30000) => { const end=Date.now()+ms; while(Date.now()<end){const value=await fn();if(value)return value;await sleep(100);}throw new Error(`等待超时：${label}`); };
const jsText = value => JSON.stringify(value);
const click = async (selector) => { check(`点击 ${selector}`,await exec(`(()=>{const e=document.querySelector(${jsText(selector)});if(!e||e.disabled)return false;e.click();return true})()`)); await sleep(180); };
const clickText = async text => { check(`点击 ${text}`,await exec(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${jsText(text)});if(!e||e.disabled)return false;e.click();return true})()`));await sleep(200); };
async function screenshot(name,width=1440,dark=false,prepareWindow=true){
  const win=state.mainWindow;
  // 菜单已打开时只捕获当前窗口；主动 resize 按产品契约会关闭菜单。
  if(prepareWindow){nativeTheme.themeSource=dark?'dark':'light';win.setMinimumSize(300,400);win.setContentSize(width,900);win.show();}
  await sleep(600);
  const file=path.join(output,`064-${variant}-${name}-${width}${dark?'-dark':''}.png`);await writeFile(file,(await win.webContents.capturePage()).toPNG());evidence.screenshots.push(file);
  const geometry=await exec(`({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,dialog:(()=>{const d=document.querySelector('.h64-route-dialog');const f=d?.querySelector('.h37-dialog-foot');if(!d)return null;const r=f?.getBoundingClientRect();return {scroll:d.scrollHeight,client:d.clientHeight,footerVisible:!!r&&r.top>=0&&r.bottom<=innerHeight,shadowSpace:(()=>{const c=d.querySelector('.h64-route-content'),r=c.getBoundingClientRect();return [...c.querySelectorAll('.h37-group')].map(g=>{const b=g.getBoundingClientRect();return {left:b.left-r.left,right:r.right-b.right};});})(),controlsVisible:[...d.querySelectorAll('[data-route-slot] select')].length===6&&[...d.querySelectorAll('[data-route-slot] select')].every(e=>{const a=e.getBoundingClientRect(),b=d.getBoundingClientRect();return a.left>=b.left&&a.right<=b.right}),rect:d.getBoundingClientRect().toJSON()}})()})`);
  check(`${name} ${width} 无横向溢出`,!geometry.overflow,geometry);if(geometry.dialog){check(`${name} ${width} 保存按钮可见`,geometry.dialog.footerVisible,geometry);check(`${name} ${width} 角色选择控件不被横向裁切`,geometry.dialog.controlsVisible,geometry);check(`${name} ${width} 三组边框保留绘制空间`,geometry.dialog.shadowSpace.length===3&&geometry.dialog.shadowSpace.every(space=>space.left>=1&&space.right>=1),geometry);}
}
const send = async (cid,text,profileId='mp-test/m-main',inputId=`input-${Date.now()}-${Math.random().toString(36).slice(2)}`) => exec(`window.hemiVoice.submitChatTurn(${jsText({conversationId:cid,turnId:Date.now(),requestId:inputId,profileId,workspaceId:'default',inputSource:'text',messages:[{role:'user',content:text}]})})`);
const flow = cid => exec(`window.hemiVoice.flowGetSnapshot(${jsText(cid)})`);
const settled = cid => wait(async()=>{const f=await flow(cid);return f?.phase==='idle'&&Object.keys(f.runs).length?f:null;},`${cid} 收口`,60000);
const counterFile=path.join(ud,'background-count.txt');
const wfFile=path.join(ud,'workspace/default/workflow-064.txt');
const taskFile=path.join(ud,'background.txt'), started=path.join(ud,'started.txt'), late=path.join(ud,'late.txt');
let fallbackFail=false;
const server=http.createServer(async(req,res)=>{
  try {
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw);evidence.requests.push({model:body.model,tools:(body.tools??[]).map(t=>t.function?.name),messages:body.messages,authorization:req.headers.authorization});
    const texts=body.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content));
    const current=[...texts].reverse().find(text=>/ROOT_[A-Z]+/.test(text))??'';
    const marker=current.match(/ROOT_[A-Z]+/)?.[0];
    const last=body.messages.at(-1);
    const startIndex=body.messages.findLastIndex(m=>m.role==='user'&&JSON.stringify(m.content).includes(marker));
    const scoped=body.messages.slice(Math.max(0,startIndex));
    const toolMessages=scoped.filter(m=>m.role==='tool');
    const isMain=(body.tools??[]).some(t=>t.function?.name==='task');

    const afterTask=toolMessages.some(m=>JSON.stringify(m.content).includes('taskId'));
    let text='已完成。',calls=[];
    const tool=(name,args)=>({index:calls.length,id:`call-${calls.length}`,type:'function',function:{name,arguments:JSON.stringify(args)}});
    if(!body.tools?.length)text='验证对话';
    else if(body.model==='main-fail'&&fallbackFail){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'controlled outage'}}));return;}
    else if(marker==='ROOT_STOP'){
      if(!toolMessages.length)calls.push(tool('bash',{command:`node -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(late)},'LATE'),12000)`)}`}));
      else text='命令已结束。';
    }else if(marker==='ROOT_BACKGROUND' && !isMain){
      if(!toolMessages.length)calls.push(tool('bash',{command:`printf 'run\n' >> ${JSON.stringify(counterFile)}; sleep 4; printf 'HEMI_064_PRODUCT_OK' > ${JSON.stringify(taskFile)}`}));
      else if(!toolMessages.some(m=>JSON.stringify(m.content).includes('交付文件已声明')))calls.push(tool('register_delivery',{files:[{path:taskFile,description:'验证文件'}]}));
      else text='已创建 background.txt，内容 HEMI_064_PRODUCT_OK。';
    }else if(marker==='ROOT_BACKGROUND'){
      if(!afterTask&&!JSON.stringify(last).includes('子任务完成'))calls.push(tool('task',{agent:'fixer',description:'创建验证文件',prompt:'ROOT_BACKGROUND 使用 bash 创建约定文件并登记交付，只做一次。',background:true}));
      else if(JSON.stringify(last).includes('子任务完成')||toolMessages.some(m=>JSON.stringify(m.content).includes('HEMI_064_PRODUCT_OK')))text='文件已生成，内容验证通过。';
      else text='文件正在生成。';
    }else if(marker==='ROOT_WFCHILD'){
      if(!toolMessages.length)calls.push(tool('write',{path:wfFile,content:'HEMI_064_WORKFLOW_OK'}));
      else if(!toolMessages.some(m=>JSON.stringify(m.content).includes('交付文件已声明')))calls.push(tool('register_delivery',{files:[{path:wfFile,description:'工作流产物'}]}));
      else text='工作流产物已写入并登记。';
    }else if(marker==='ROOT_WORKFLOW'){
      if(!afterTask)calls.push(tool('task',{agent:'fixer',description:'工作流文件交付',prompt:'ROOT_WFCHILD 创建并登记约定工作流文件。',background:true}));
      else text='```json\n'+JSON.stringify({result:wfFile})+'\n```';
    }else if(marker==='ROOT_LONG'){
      if(!toolMessages.length)calls.push(tool('bash',{command:`node -e "process.stdout.write('START'+ 'x'.repeat(20000)+'TAIL_ERROR');process.exitCode=7"`}));
      else text='命令退出码为 7，长输出末尾包含 TAIL_ERROR。';
    }else if(marker==='ROOT_ROLES'){
      const system=JSON.stringify(body.messages.filter(m=>m.role==='system'));
      const role=['explorer','oracle','designer','fixer'].find(r=>body.model===`role-${r}`);
      if(role)text=`${role} 已核对任务边界。`;
      else if(!afterTask)for(const agent of ['explorer','oracle','fixer','designer'])calls.push(tool('task',{agent,description:`核对 ${agent}`,prompt:`ROOT_ROLES 只回答 ${agent} 的职责，不执行工具。`}));
      else text='四个角色均已完成。';
    }else text=marker==='ROOT_QUEUED'?'队列消息已按顺序处理。':'主 agent 可以直接回答并执行任务。';
    res.writeHead(200,{'content-type':'text/event-stream'});
    const write=chunk=>res.write(`data: ${JSON.stringify({id:'mock',object:'chat.completion.chunk',created:0,model:body.model,...chunk})}\n\n`);
    write({choices:[{index:0,delta:{role:'assistant',...(calls.length?{tool_calls:calls}:{content:text})},finish_reason:null}]});
    write({choices:[{index:0,delta:{},finish_reason:calls.length?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:80}}});res.end('data: [DONE]\n\n');
  }catch(error){console.error(error);if(!res.headersSent)res.writeHead(500);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
app.setName('hemi');app.setPath('userData',ud);
app.whenReady().then(async()=>{
 try{
  initializeStableSafeStorageIdentity();await mkdir(ud,{recursive:true});
  const modelIds=['main','fail','backup','explorer','oracle','fixer','designer'];
  await writeFile(path.join(ud,'text-model-profiles.json'),JSON.stringify({version:3,defaultModelId:'mp-test/m-main',roleModels:{main:'mp-test/m-main',explorer:'mp-test/m-explorer',oracle:'mp-test/m-oracle',fixer:'mp-test/m-fixer',designer:'mp-test/m-designer',fallback:'mp-test/m-backup'},providers:[{id:'mp-test',name:'隔离验证端点',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,encryptedApiKey:safeStorage.encryptString('TEST_ONLY').toString('base64'),models:modelIds.map(id=>({id:`m-${id}`,model:id==='main'?'main':id==='fail'?'main-fail':id==='backup'?'main-backup':`role-${id}`,supportsVision:id!=='explorer',thinkingLevel:'off'}))}]}));
  await writeFile(path.join(ud,'onboarding.json'),JSON.stringify({version:1,phase:'complete',step:'done',completedAt:Date.now()}));
  await registerAllIpcHandlers();installNativeShell({app,Menu,platform:process.platform,appName:'Hemi',devTools:true});
  app.on('web-contents-created',(_event,contents)=>contents.on('console-message',event=>{if(event.level==='error')evidence.consoleErrors.push(event.message);}));
  await createMainWindow();evidence.rendererUrl=state.mainWindow.webContents.getURL();state.mainWindow.show();
  await wait(()=>exec(`!!document.querySelector('textarea[aria-label="输入消息"]')`),'输入框');
  evidence.rendererUrl=state.mainWindow.webContents.getURL();
  check('原角色配置迁入后直接就绪，无须重新配置',await exec(`window.hemiVoice.getRoleModels().then(view=>view.ready&&view.slots.designer.modelKey==='mp-test/m-designer')`));
  // 第一次从真实输入框键盘发送，后续用同一 renderer preload 公共入口。
  await exec(`document.querySelector('textarea[aria-label="输入消息"]').focus()`);await state.mainWindow.webContents.insertText('ROOT_DIRECT 主 agent 是否可以直接处理小任务？');
  state.mainWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});state.mainWindow.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
  const cid=await wait(async()=>{const rows=await exec('window.hemiVoice.listConversations()');return (rows.sessions??rows.conversations??[])[0]?.id;},'新对话');evidence.conversationId=cid;
  await settled(cid);check('真实输入框发送、主回复可见',await exec(`document.body.innerText.includes('主 agent 可以直接回答')`));await screenshot('conversation');
  await exec(`document.querySelector('textarea[aria-label="输入消息"]').focus()`);await state.mainWindow.webContents.insertText('原草稿_064');
  const [receipt,duplicate]=await Promise.all([send(cid,'ROOT_BACKGROUND 委派 fixer 创建并登记文件。','mp-test/m-main','background-request'),send(cid,'ROOT_BACKGROUND 委派 fixer 创建并登记文件。','mp-test/m-main','background-request')]);check('后台目标已受理',receipt.ok);
  check('相同请求身份重复提交只有一次受理',duplicate.ok && duplicate.inputId===receipt.inputId && Object.values((await flow(cid)).runs).filter(run=>run.inputIds.includes(receipt.inputId)).length===1);
  await wait(async()=>{const j=await getAgentRuntime().journal.snapshot();return Object.values(j.observations).some(o=>o.tool==='bash'&&o.phase==='started');},'子 bash 确实开始');
  const queued=await send(cid,'ROOT_QUEUED 等前一目标结束再处理。');check('后台未完成时新输入排队',queued.disposition==='queued',queued);
  await screenshot('queued');
  await click('button[aria-label="编辑这条"]');await wait(()=>exec(`document.querySelector('textarea[aria-label="输入消息"]').value.includes('ROOT_QUEUED')`),'队列编辑进入主输入框');
  await exec(`(()=>{const input=document.querySelector('textarea[aria-label="输入消息"]');input.focus();input.select();})()`);
  await state.mainWindow.webContents.insertText('ROOT_QUEUED 编辑后仍按原顺序处理。');
  check('队列编辑替换全文',await exec(`document.querySelector('textarea[aria-label="输入消息"]').value==='ROOT_QUEUED 编辑后仍按原顺序处理。'`));
  await click('button[aria-label="保存修改"]');check('队列保存后恢复原草稿',await exec(`document.querySelector('textarea[aria-label="输入消息"]').value==='原草稿_064'`));
  const completed=await wait(async()=>{const f=await flow(cid);return f.phase==='idle'&&f.pending.length===0&&Object.values(f.runs).length>=3?f:null;},'队列按序完成',60000);
  check('重复请求仅一次实际副作用',await readFile(counterFile,'utf8')==='run\n');
  check('子任务真实产物内容',await readFile(taskFile,'utf8')==='HEMI_064_PRODUCT_OK');
  const journal=await getAgentRuntime().journal.snapshot();check('后台完成事件恰好消费一次',Object.values(journal.inbox).length===1&&Object.values(journal.inbox).every(e=>e.state==='consumed'));
  check('目标收口后才开始队列项',Object.values(completed.runs).slice(-2)[0].closedAt<=Object.values(completed.runs).at(-1).startedAt);
  await screenshot('completed');await screenshot('completed',375);await screenshot('completed',768);
  await screenshot('completed',1440);
  check('进度与收口有段落边界',completed.timeline.some(item=>item.parts?.some(part=>part.kind==='text'&&part.content.includes('文件正在生成。\n\n文件已生成'))));
  check('点击真实成果',await exec(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('background.txt'));if(!e)return false;e.click();return true})()`));
  await wait(()=>exec(`document.querySelector('.h24-preview-content')?.textContent.includes('HEMI_064_PRODUCT_OK') || document.querySelector('[role="tabpanel"]')?.textContent.includes('HEMI_064_PRODUCT_OK')`),'成果预览');
  await screenshot('preview');await screenshot('preview',375);await click('button[aria-label="关闭 background.txt"]');await screenshot('completed',1440);
  await send(cid,'ROOT_LONG 检查长输出和退出错误。');await settled(cid);
  const archive=JSON.parse(await readFile(path.join(ud,'runtime-v2/conversations',`${cid}.json`),'utf8'));
  const longResults=archive.agentSession.entries.filter(e=>e.message?.role==='toolResult').filter(e=>JSON.stringify(e).includes('TAIL_ERROR'));
  check('首次入史保留错误且长输出投影',longResults.some(e=>JSON.stringify(e).includes('省略')&&JSON.stringify(e).length<12000));
  await send(cid,'ROOT_STOP 启动一个等待 12 秒的命令。');await wait(()=>readFile(started,'utf8').catch(()=>null),'停止前确实开始');
  await click('button[aria-label="停止当前任务"]');await settled(cid);await sleep(12500);
  check('停止后无迟到文件',await readFile(late,'utf8').then(()=>false,()=>true));await screenshot('stopped');
  // 模型路由从实际设置入口打开，反复挂载、保存并重开。
  await click('[title="设置"]');await clickText('模型与路由');await wait(()=>exec(`document.body.innerText.includes('模型路由')`),'模型设置');
  await click('[data-role-models] button');
  await exec(`(()=>{const s=document.querySelector('select[aria-label="主 agent"]');s.value='mp-test/m-main';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(()=>exec(`!document.querySelector('select[aria-label="主 agent"]').disabled`),'主模型即时保存');
  await exec(`(()=>{const s=document.querySelector('select[aria-label="备用模型"]');s.value='mp-test/m-backup';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(()=>exec(`!document.querySelector('select[aria-label="备用模型"]').disabled`),'备用即时保存');
  check('弹窗恢复角色槽位且没有质量档', await exec(`(()=>{const slots=[...document.querySelectorAll('[data-route-slot]')].map(e=>e.dataset.routeSlot);return JSON.stringify(slots)===JSON.stringify(['main','explorer','oracle','fixer','designer','fallback'])&&!document.querySelector('.h64-route-dialog').innerText.match(/快速|标准|深度|候选模型/)})()`));
  await screenshot('routing');await screenshot('routing',375);await screenshot('routing',768);await screenshot('routing',1440,true);
  await clickText('完成');await click('[data-role-models] button');check('角色路由即时保存再打开',await exec(`document.querySelector('select[aria-label="主 agent"]').value==='mp-test/m-main'&&document.querySelector('select[aria-label="备用模型"]').value==='mp-test/m-backup'`));await clickText('完成');
  await click('button[aria-label="返回主窗口"]');await click('.h24-model-chip');
  check('保存角色配置后菜单自动路由可选',await exec(`(()=>{const e=[...document.querySelectorAll('[role="menuitemradio"]')].find(e=>e.textContent.includes('自动路由'));return !!e&&!e.disabled})()`));
  await screenshot('model-menu',1440,false,false);
  await exec(`[...document.querySelectorAll('[role="menuitemradio"]')].find(e=>e.textContent.includes('自动路由')).click()`);
  await wait(()=>exec(`document.querySelector('.h24-model-chip')?.getAttribute('data-auto')==='true'`),'模型菜单实际选择自动');
  check('切换模型保留草稿',await exec(`document.querySelector('textarea[aria-label="输入消息"]').value==='原草稿_064'`));
  await exec(`document.querySelector('textarea[aria-label="输入消息"]').focus()`);
  state.mainWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['meta']});state.mainWindow.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['meta']});await state.mainWindow.webContents.insertText('/model');
  await wait(()=>exec(`!![...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('/model'))`),'斜杠命令候选');
  await exec(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('/model')).click()`);
  check('/model 同样识别角色配置为可选',await exec(`(()=>{const e=[...document.querySelectorAll('.h24-command-menu [role="menuitemradio"]')].find(e=>e.textContent.includes('自动路由'));return !!e&&!e.disabled})()`));
  await screenshot('slash-model-menu',1440,false,false);
  state.mainWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});state.mainWindow.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});state.mainWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});state.mainWindow.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await exec(`document.querySelector('textarea[aria-label="输入消息"]').focus()`);state.mainWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['meta']});state.mainWindow.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['meta']});await state.mainWindow.webContents.insertText('原草稿_064');
  await click('.h48-usage-entry');await wait(()=>exec(`!!document.querySelector('.h48-usage-panel [aria-label="各角色用量"]')`),'实际用量表格');check('用量详情展示真实角色且未把未知金额标零',await exec(`(()=>{const p=document.querySelector('.h48-usage-panel');return p.textContent.includes('主助手')&&p.textContent.includes('执行')&&!/(?:¥|￥|\\$)\\s*0(?:[.]00)?/.test(p.textContent)})()`));
  await screenshot('usage');await screenshot('usage',375);state.mainWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});state.mainWindow.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});state.mainWindow.setContentSize(1440,900);
  const roleModels={main:'mp-test/m-main',explorer:'mp-test/m-explorer',fixer:'mp-test/m-fixer',designer:'mp-test/m-designer',oracle:'mp-test/m-oracle',fallback:'mp-test/m-backup'};
  for (const [slot,key] of Object.entries(roleModels)) {
    const saved=await exec(`window.hemiVoice.saveRoleModel(${jsText({[slot]:key})})`);check(`角色模型保存 ${slot}`,saved.ok);
  }
  await send('conv-064-roles','ROOT_ROLES 调用四种角色。','auto');await settled('conv-064-roles');
  const roleRequests=evidence.requests.filter(r=>r.messages.some(m=>JSON.stringify(m.content).includes('ROOT_ROLES'))&&r.tools.length);
  check('各角色实际请求到各自配置的模型', ['main','role-explorer','role-oracle','role-fixer','role-designer'].every(model=>roleRequests.some(r=>r.model===model)));
  check('只读角色无写工具',roleRequests.filter(r=>['role-explorer','role-oracle'].includes(r.model)).every(r=>!r.tools.some(name=>['write','edit','task','ui_click'].includes(name))));
  // 工作流仍经同一运行内核，子任务结果在节点所属根内消费。
  const graph={nodes:[{id:'in',type:'hemi-input',data:{title:'输入',parameters:[{key:'topic',label:'主题',type:'string',required:false}]}},
    {id:'execute',type:'hemi-agent',data:{title:'执行',goal:'ROOT_WORKFLOW 委派 fixer 创建本次文件',inputBindings:[],outputSchema:{type:'object',properties:{result:{type:'file'}}}}},
    {id:'deliver',type:'hemi-deliver',data:{title:'交付',summary:'本次结果',artifacts:[{label:'文件',binding:{kind:'node-output',nodeId:'execute',key:'result',type:'file'}}]}}],edges:[{sourceNodeID:'in',targetNodeID:'execute'},{sourceNodeID:'execute',targetNodeID:'deliver'}]};
  const draft=await exec(`window.hemiVoice.workflowSaveDraft('workflow-064',${jsText(graph)},'064 工作流验证')`);
  await exec(`window.hemiVoice.workflowPublish('workflow-064',${draft.draftRevision})`);
  const invocation=await exec(`window.hemiVoice.workflowPrepare(${jsText({workflowId:'workflow-064',conversationId:'conv-064-workflow',entryMode:'chat',executionModel:{mode:'auto'},workspaceId:'default'})})`);
  const invId=invocation.invocationId??invocation.invocation?.invocationId;
  check('工作流准备返回真实身份',!!invId,invocation);
  const start=await exec(`window.hemiVoice.workflowStartPrepared(${jsText({invocationId:invId,conversationId:'conv-064-workflow',requestId:'workflow-start-064'})})`);check('工作流已受理',start.ok,start);
  const finished=await wait(async()=>{const value=await exec(`window.hemiVoice.workflowGetInvocation(${jsText(invId)})`);return ['completed','failed','stopped'].includes(value.run?.status)?value:null;},'工作流执行收口',60000);
  check('真实工作流与后台角色复用运行内核',finished.run.status==='completed',finished.run);
  check('工作流真实文件内容',await readFile(wfFile,'utf8')==='HEMI_064_WORKFLOW_OK');
  // 正常附件入口传真实图像块；固定文本模型不能借全局视觉模型绕过选择。
  const tiny='iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4ryDwHxkzkC4AAKLAIuEUh8J9AAAAAElFTkSuQmCC';
  const attach=async cid=>exec(`window.hemiVoice.attachPasteImage(${jsText({conversationId:cid,dataUrl:'data:image/png;base64,'+tiny})})`);
  const imageCid='conv-064-image',image=await attach(imageCid);check('真实图片附件已登记',image.ok,image);
  await exec(`window.hemiVoice.submitChatTurn(${jsText({conversationId:imageCid,turnId:Date.now(),requestId:'image-064',profileId:'mp-test/m-main',workspaceId:'default',inputSource:'text',attachmentIds:[image.attachment.attachmentId],messages:[{role:'user',content:'ROOT_IMAGE 查看本次唯一图片'}]})})`);await settled(imageCid);
  check('实际 provider 收到原生图像',evidence.requests.some(request=>JSON.stringify(request.messages).includes(tiny)));
  const textCid='conv-064-image-text',textImage=await attach(textCid),beforeImage=evidence.requests.length;
  await exec(`window.hemiVoice.submitChatTurn(${jsText({conversationId:textCid,turnId:Date.now(),requestId:'image-text-064',profileId:'mp-test/m-explorer',workspaceId:'default',inputSource:'text',attachmentIds:[textImage.attachment.attachmentId],messages:[{role:'user',content:'ROOT_IMAGE 文本模型不允许删图或换模型'}]})})`);const imageFailed=await settled(textCid);
  check('固定文本模型明确拒绝图像且不发请求',Object.values(imageFailed.runs).at(-1).outcome==='failed'&&!evidence.requests.slice(beforeImage).some(request=>JSON.stringify(request.messages).includes('文本模型不允许删图或换模型')));
  // 真正服务故障前进到允许的备用；固定模式不借用全局备用。
  await exec(`window.hemiVoice.saveRoleModel(${jsText({main:'mp-test/m-fail'})})`);fallbackFail=true;
  await send('conv-064-fallback','ROOT_FALLBACK 验证候选切换。','auto');const fall=await settled('conv-064-fallback');
  check('服务故障按冻结候选切换',Object.values(fall.runs).at(-1).outcome==='completed'&&evidence.requests.some(r=>r.model==='main-backup'));
  const before=evidence.requests.length;await send('conv-064-fixed-fail','ROOT_FIXED 固定模型失败。','mp-test/m-fail');const fixed=await settled('conv-064-fixed-fail');
  check('固定模型不偷换备用',Object.values(fixed.runs).at(-1).outcome==='failed'&&!evidence.requests.slice(before).some(r=>r.model==='main-backup'));
  const finalJournal=await getAgentRuntime().journal.snapshot();check('每次实际请求有账本记录',Object.keys(finalJournal.requests).length===evidence.requests.length,{ledger:Object.keys(finalJournal.requests).length,http:evidence.requests.length});
  check('账本不保存 Key',!JSON.stringify(finalJournal).includes('TEST_ONLY'));
  check('无 renderer console error',!evidence.consoleErrors.length,evidence.consoleErrors);
 }catch(error){evidence.error=error.stack;console.error(error.stack);evidence.pageDiagnostics=state.mainWindow?await exec('({url:location.href,ready:document.readyState,body:document.body.innerText,resources:performance.getEntriesByType("resource").slice(-20).map(entry=>({name:entry.name,status:entry.responseStatus}))})'):null;if(state.mainWindow)await screenshot('failure').catch(()=>{});}
 finally{
  evidence.passed=!evidence.error&&evidence.checks.every(c=>c.pass);for(const r of evidence.requests){delete r.authorization;delete r.messages;}
  await writeFile(path.join(output,`064-${variant}-product.json`),JSON.stringify(evidence,null,2));console.log(`HEMI_064_PRODUCT_RESULT=${JSON.stringify(evidence)}`);
  disposeTaskManager();getAgentRuntime().disposeAll();server.closeAllConnections();server.close();state.isQuitting=true;setTimeout(()=>app.exit(evidence.passed?0:1),300);
 }
});
