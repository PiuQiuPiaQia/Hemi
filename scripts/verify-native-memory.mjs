// Isolated Electron -> original preload/IPC/runtime -> official Pi SDK/pi-memory.
// Only the external model provider is replaced by a local HTTP fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright-core';
import electronPath from 'electron';
import { createServer } from 'vite';
const repo=path.resolve(import.meta.dirname,'..');
const packaged=process.argv.includes('--packaged');
const output=path.join(repo,'.visual/workflow/memory-simplified',packaged?'electron-packaged':'electron');
await fs.mkdir(output,{recursive:true});
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-native-ui-')));
const evidence={checks:[],screenshots:[],errors:[],requests:[],environment:{node:process.version,platform:process.platform,arch:process.arch}};
let app,vite,restoreId='';
const provider=http.createServer(async(req,res)=>{
 try{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw),latest=body.messages.findLastIndex(message=>message.role==='user');
  const prompt=JSON.stringify(body.messages[latest]?.content??'');
  const marker=prompt.match(/NATIVE_(?:SAVE_A|SAVE_B|READ|FORGET|RESTORE)/)?.[0];
  assert.doesNotMatch(JSON.stringify(body.messages),/LEGACY_MEMORY_MUST_NOT_LOAD/);
  assert.ok(!(body.tools??[]).some(tool=>['memory_search','memory_status'].includes(tool.function?.name)),'qmd tools must not be declared');
  evidence.requests.push({model:body.model,marker,tools:(body.tools??[]).map(tool=>tool.function?.name)});
  const requested=marker==='NATIVE_SAVE_A'||marker==='NATIVE_SAVE_B'?{name:'memory_write',args:{target:'long_term',content:marker==='NATIVE_SAVE_A'?'#preference 默认用中文交流。NATIVE_FACT_ALPHA':'#decision 项目发版前先检查构建结果。NATIVE_FACT_BETA'}}:marker==='NATIVE_READ'?{name:'memory_read',args:{target:'long_term'}}:marker==='NATIVE_FORGET'?{name:'memory_forget',args:{match:'NATIVE_FACT_ALPHA',target:'long_term'}}:marker==='NATIVE_RESTORE'?{name:'memory_restore',args:{recoveryId:restoreId}}:null;
  const tool=requested&&body.tools?.some(item=>item.function?.name===requested.name)&&!body.messages.slice(latest).some(message=>message.role==='tool')?{index:0,id:'native-'+randomUUID(),type:'function',function:{name:requested.name,arguments:JSON.stringify(requested.args)}}:null;
  const summary=prompt.includes('Review the conversation and extract');
  const content=summary?'### Decisions\n- NATIVE_APPLICATION_EXIT_SUMMARY\n### Lessons Learned\nNone.\n### Notes\nNone.\n### Follow-ups\nNone.':'已完成原生记忆操作。';
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(`data: ${JSON.stringify({choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[tool]}:{role:'assistant',content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:10,total_tokens:40}})}\n\ndata: [DONE]\n\n`);
 }catch(error){evidence.errors.push(error.stack);res.writeHead(500);res.end('fixture failure');}
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const wait=async(read,label,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,80));}throw new Error(`Timed out: ${label}`);};
const check=(name,value)=>{assert.ok(value,name);evidence.checks.push(name);console.log('PASS',name);};
try{
 vite=await createServer({configFile:path.join(repo,'vite.config.ts'),server:{port:0,strictPort:false,host:'127.0.0.1'}});await vite.listen();
 const devUrl=vite.resolvedUrls.local[0];
 for(const mode of packaged?['packaged']:process.argv.includes('--built-only')?['built']:['dev','built']){
  const profile=path.join(root,mode);await fs.mkdir(path.join(profile,'memory'),{recursive:true});
  await fs.writeFile(path.join(profile,'memory','USER.md'),'LEGACY_MEMORY_MUST_NOT_LOAD');
  await fs.writeFile(path.join(profile,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
  await fs.writeFile(path.join(profile,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
  const env={...process.env,HEMI_USER_DATA_DIR:profile,HEMI_TEST_MIC_GRANT:'1'};
  for(const key of Object.keys(env))if(key.startsWith('HEMI_LLM_'))delete env[key];
  if(mode==='dev')env.VITE_DEV_SERVER_URL=devUrl;else delete env.VITE_DEV_SERVER_URL;
  async function launch(){
   app=await _electron.launch({executablePath:packaged?path.join(repo,'release/mac-arm64/Hemi.app/Contents/MacOS/Hemi'):electronPath,args:packaged?[]:['.'],cwd:repo,env});
   app.process().stderr?.on('data',chunk=>{evidence.mainLog=((evidence.mainLog??'')+chunk.toString()).slice(-12000);});
   const page=await wait(()=>app.windows().find(page=>/^(http|file):/.test(page.url())&&!new URL(page.url()).searchParams.has('mode')),'main window');
   page.on('pageerror',error=>evidence.errors.push(`${mode}: ${error.message}`));
   page.on('console',message=>{if(message.type()==='error')evidence.errors.push(`${mode}: ${message.text()}`);});
   await page.waitForFunction(()=>!!window.hemiVoice?.inspectAgentEnvironment);
   return page;
  }
  let page=await launch();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.locator('.h37-settings-side').getByRole('button',{name:'记忆',exact:true}).click();
  await page.getByText('暂无长期记忆',{exact:true}).waitFor();
  for(const width of [1440,768,375]) {
   await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(win=>/^(http|file):/.test(win.webContents.getURL())&&!new URL(win.webContents.getURL()).searchParams.has('mode'));win.setMinimumSize(1,1);win.setContentSize(width,900);},width);
   await page.waitForFunction(width=>innerWidth===width,width);
   check(`${mode}: empty ${width}px has no horizontal overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const file=`${mode}-empty-${width}.png`;await page.screenshot({path:path.join(output,file),animations:'disabled'});evidence.screenshots.push(file);
  }
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(win=>/^(http|file):/.test(win.webContents.getURL())&&!new URL(win.webContents.getURL()).searchParams.has('mode'));win.setContentSize(1440,900);});

  check(`${mode}: retired APIs removed`,await page.evaluate(()=>typeof window.hemiVoice.getMemoryState==='undefined'&&typeof window.hemiVoice.listMemoryEntries==='undefined'));
  const saved=await page.evaluate(async baseUrl=>window.hemiVoice.saveModelProfile({id:'native-fixture',name:'原生记忆隔离验证',baseUrl,api:'openai-completions',apiKey:'NATIVE_SYNTHETIC_KEY',models:[{id:'main',model:'native-model',thinkingLevel:'off'}]}),`http://127.0.0.1:${provider.address().port}/v1`);
  check(`${mode}: real model settings saved`,saved.ok);
  await page.evaluate(()=>window.hemiVoice.saveRoleModel({main:'native-fixture/main'}));
  let turn=0;
  async function send(cid,text){
   const receipt=await page.evaluate(({cid,text,turn})=>window.hemiVoice.submitChatTurn({conversationId:cid,turnId:turn,requestId:`native-ui-${turn}`,workspaceId:'default',profileId:'native-fixture/main',inputSource:'text',messages:[{role:'user',content:text}]}),{cid,text,turn:++turn});
   assert.equal(receipt.ok,true,JSON.stringify(receipt));
   const flow=await wait(async()=>{const value=await page.evaluate(cid=>window.hemiVoice.flowGetSnapshot(cid),cid);return value?.runs?.[receipt.runId]?.outcome&&!value.activeRunId?value:null;},text);
   assert.equal(flow.runs[receipt.runId].outcome,'completed',JSON.stringify(flow));
   return flow;
  }
  await Promise.all([send('conv-native-a','NATIVE_SAVE_A'),send('conv-native-b','NATIVE_SAVE_B')]);
  const memory=path.join(profile,'pi-memory','MEMORY.md');
  const original=await fs.readFile(memory,'utf8');
  check(`${mode}: concurrent conversations retain native writes`,original.includes('NATIVE_FACT_ALPHA')&&original.includes('NATIVE_FACT_BETA'));
  await send('conv-native-b','NATIVE_READ');
  await send('conv-native-a','NATIVE_FORGET');
  check(`${mode}: native forget modifies original file`,!(await fs.readFile(memory,'utf8')).includes('NATIVE_FACT_ALPHA'));
  const recoveries=await fs.readdir(path.join(profile,'pi-memory','recovery'));restoreId=recoveries.find(name=>name.endsWith('.json')).slice(0,-5);
  await send('conv-native-b','NATIVE_RESTORE');
  check(`${mode}: original recovery ID restores content`,(await fs.readFile(memory,'utf8')).includes('NATIVE_FACT_ALPHA'));
  check(`${mode}: legacy file untouched`,(await fs.readFile(path.join(profile,'memory','USER.md'),'utf8'))==='LEGACY_MEMORY_MUST_NOT_LOAD');
  check(`${mode}: traversal rejected by actual IPC`,await page.evaluate(async()=>{try{await window.hemiVoice.readAgentRuntimeFile({path:'../memory/USER.md'});return false;}catch{return true;}}));
  await page.getByRole('button',{name:'刷新记忆',exact:true}).click();
  await page.getByRole('region',{name:'共享记忆'}).getByText('NATIVE_FACT_ALPHA',{exact:false}).waitFor();
  await page.getByRole('button',{name:'刷新记忆',exact:true}).click();
  await page.getByRole('region',{name:'共享记忆'}).getByText('NATIVE_FACT_ALPHA',{exact:false}).waitFor();
  check(`${mode}: refresh unchanged file completes`,!(await page.getByText('正在读取文件…',{exact:true}).count()));
  await page.getByRole('button',{name:'恢复记录',exact:true}).click();
  await page.getByRole('region',{name:'共享记忆'}).locator('pre').filter({hasText:restoreId}).waitFor();
  check(`${mode}: recovery JSON can be viewed without mutation`,true);
  await page.getByRole('button',{name:'长期记忆',exact:true}).click();
  await page.getByRole('region',{name:'共享记忆'}).getByText('NATIVE_FACT_ALPHA',{exact:false}).waitFor();
  for(const width of [1440,768,375]){
   await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(win=>/^(http|file):/.test(win.webContents.getURL())&&!new URL(win.webContents.getURL()).searchParams.has('mode'));win.setMinimumSize(1,1);win.setContentSize(width,900);},width);
   await page.waitForFunction(width=>innerWidth===width,width);
   check(`${mode}: ${width}px has no horizontal overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const file=`${mode}-${width}.png`;await page.screenshot({path:path.join(output,file),animations:'disabled'});evidence.screenshots.push(file);
  }
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  await page.screenshot({path:path.join(output,`${mode}-dark-preference.png`),animations:'disabled'});
  check(`${mode}: automatic summaries have no switch or component installer`,await page.getByRole('switch',{name:'会话退出摘要'}).count()===0&&await page.getByRole('button',{name:'安装搜索组件'}).count()===0);
  await page.getByText('自动整理到每日日志',{exact:true}).waitFor();
  await page.getByRole('button',{name:'自动整理说明',exact:true}).click();
  await page.getByRole('dialog',{name:'自动整理',exact:true}).getByText(/用量暂未计入对话统计/).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog',{name:'自动整理',exact:true}).waitFor({state:'hidden'});
  await app.close();app=null;
  const daily=await fs.readdir(path.join(profile,'pi-memory','daily'));
  check(`${mode}: real application quit awaits original summaries`,(await fs.readFile(path.join(profile,'pi-memory','daily',daily[0]),'utf8')).includes('NATIVE_APPLICATION_EXIT_SUMMARY'));
  page=await launch();
  const state=await page.evaluate(()=>window.hemiVoice.inspectAgentEnvironment());
  check(`${mode}: shared library survives restart without retired preferences`,state.files.some(file=>file.path==='MEMORY.md')&&!('exitSummaryEnabled' in state)&&!('search' in state));
  check(`${mode}: restarted renderer reads persisted original file`,(await page.evaluate(()=>window.hemiVoice.readAgentRuntimeFile({path:'MEMORY.md'}))).text.includes('NATIVE_FACT_BETA'));
  await app.close();app=null;
 }
 check('renderer and provider errors',evidence.errors.length===0);
 evidence.ok=true;
}catch(error){evidence.error=error.stack;process.exitCode=1;console.error(error.stack);}
finally{
 await app?.close().catch(()=>{});await vite?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify(evidence,null,2));
 await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
