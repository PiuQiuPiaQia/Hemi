// Production Host/SDK and native Windows driver; only the model and test app are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startWindowsDesktopWorker,createWindowsDesktopClient,desktopEndpoint} from '../src/main/bot/windows-desktop.mjs';
import {controlToken} from '../src/main/bot/control-endpoint.mjs';
import {powershellCommand} from '../src/main/bot/windows-transport.mjs';

if(process.platform!=='win32')throw new Error('Run on Windows');
const root=path.resolve(process.argv[2]),dataDir=path.join(root,'host/data'),exe=path.join(root,'fixture.exe'),stateFile=path.join(root,'fixture-state.txt');
const appName='HemiScenario-'+path.basename(root),title='HEMI '+appName,exec=promisify(execFile),literal=v=>"'"+v.replaceAll("'","''")+"'";
const report={node:process.version,platform:process.platform,mode:'host-sdk-scenarios',execArgv:process.execArgv,cases:[],checks:[],error:null};
const ps=s=>exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',powershellCommand(s).split(' -EncodedCommand ')[1]],{timeout:30000,windowsHide:true});
const wait=async(read,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await read();if(v)return v;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out: '+label);};
if(process.argv.includes('--desktop-worker')){
 const helper=await startWindowsDesktopWorker({dataDir});
 await fs.writeFile(path.join(root,'helper-ready.json'),JSON.stringify({pid:process.pid}));
 await new Promise(resolve=>{const timer=setInterval(async()=>{if(await fs.access(path.join(root,'helper-stop')).then(()=>true,()=>false)){clearInterval(timer);resolve();}},200);});
 await helper.close();await fs.writeFile(path.join(root,'helper-done'),'done');process.exit(0);
}
const split=process.argv.includes('--split-desktop'),helperTask=path.basename(root)+'-ScenarioHelper';
async function startTestWorker(){
 if(!split)return startWindowsDesktopWorker({dataDir});
 for(const name of ['helper-ready.json','helper-done','helper-stop'])await fs.rm(path.join(root,name),{force:true});
 const args=['--max-old-space-size=128','--max-semi-space-size=1','"'+path.join(import.meta.dirname,'verify-bot-windows-scenarios-local.mjs')+'"','"'+root+'"','--desktop-worker'].join(' ');
 await ps(`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$s=New-Object -ComObject Schedule.Service;$s.Connect();$d=$s.NewTask(0);$d.Principal.UserId=$sid;$d.Principal.LogonType=3;$d.Settings.Priority=4;$d.Settings.ExecutionTimeLimit='PT20M';$d.Settings.MultipleInstances=2;$a=$d.Actions.Create(0);$a.Path=${literal(process.execPath)};$a.Arguments=${literal(args)};$a.WorkingDirectory=${literal(path.resolve(import.meta.dirname,'..'))};$t=$s.GetFolder('\\').RegisterTaskDefinition(${literal(helperTask)},$d,6,$sid,$null,3,$null);$t.Run($null)|Out-Null`);
 await wait(()=>fs.readFile(path.join(root,'helper-ready.json'),'utf8').then(JSON.parse,()=>null),'interactive helper startup',30000);
 return {async close(){
  await fs.writeFile(path.join(root,'helper-stop'),'stop');
  try{await wait(()=>fs.access(path.join(root,'helper-done')).then(()=>true,()=>false),'interactive helper shutdown',20000);}
  finally{await ps(`$s=New-Object -ComObject Schedule.Service;$s.Connect();$f=$s.GetFolder('\\');$t=$f.GetTask(${literal(helperTask)});if($t.State -eq 4){$t.Stop(0)};$f.DeleteTask(${literal(helperTask)},0)`);}
 }};
}
const text=m=>Array.isArray(m?.content)?m.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'):String(m?.content??'');
const ref=(message,label)=>{const line=text(message).split('\n').find(line=>line.includes('「'+label+'」'));const value=line?.match(/^\[(t\d+)\]/)?.[1];assert.ok(value,'UI tree contains '+label);return value;};
const readState=async()=>Object.fromEntries((await fs.readFile(stateFile+'.details','utf8')).trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),Buffer.from(line.slice(at+1),'base64').toString('utf8')];}));
let worker,client,fixture,shortcut,target,current,mainSession,captures=0;
const pass=async(name,fn)=>{const item={name,status:'running'};report.cases.push(item);await fs.writeFile(path.join(root,'progress.json'),JSON.stringify(report));try{await fn();item.status='passed';report.checks.push(name);console.log('PASS '+name);}catch(error){item.status='failed';item.error=error.message;throw error;}finally{item.memoryMB=Math.round(process.memoryUsage().rss/1048576);await fs.writeFile(path.join(root,'progress.json'),JSON.stringify(report));global.gc?.();}};
const approve=p=>{assert.ok(p.title.includes(appName)||p.title.includes('fixture'),'only the isolated app may receive a grant');return p.options[0];};
const step=(name,args={},extra={})=>({name,args,...extra});
const tree=(extra={})=>step('ui_tree',()=>({target,...extra}));
async function discover(suffix=''){
 const apps=await client.listAppWindows();const app=apps.find(app=>app.windows.some(w=>w.title===title+suffix));assert.ok(app,'fixture window '+suffix);
 return {pid:app.pid,windowId:app.windows.find(w=>w.title===title+suffix).windowId,bundleId:app.bundleId};
}
async function sdk(name,steps,{session=mainSession,decision=approve,check=async()=>{}}={}){
 current={name,steps};
 const detail=await fixture.send(session.id,'SCENARIO:'+name,{},decision);
 assert.equal(Object.values(detail.flow.runs).at(-1).outcome,'completed','SDK scenario completed');await check(detail);fixture.requests.length=0;
}
try{
 await exec(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:winexe','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/out:'+exe,path.join(import.meta.dirname,'lib/windows-desktop-fixture.cs')]);
 const link=await ps(`$p=Join-Path ([Environment]::GetFolderPath('StartMenu')) ('Programs\\'+${literal(appName+'.lnk')});$s=New-Object -ComObject WScript.Shell;$l=$s.CreateShortcut($p);$l.TargetPath=${literal(exe)};$l.Arguments=${literal('"'+title+'" "'+stateFile+'"')};$l.Save();[Console]::WriteLine($p)`);shortcut=link.stdout.trim();
 worker=await startTestWorker();client=createWindowsDesktopClient({dataDir});
 const status=await client.status();assert.equal(status.available,true);assert.equal(status.sessionConnected,true);report.desktop=status;
 if(split){const own=await ps(`(Get-Process -Id ${process.pid}).SessionId`);report.hostSessionId=Number(own.stdout.trim());assert.equal(report.hostSessionId,0);assert.ok(status.sessionId>0);report.checks.push('Real S4U Host session 0 calls a separate interactive desktop helper');}
 const {createBotCapabilityFixture,untilBot}=await import('./lib/bot-capability-fixture.mjs');
 const observed=new Proxy(client,{get(object,key){if(key==='windowState')return async args=>{captures++;return object.windowState(args);};return object[key];}});
 fixture=await createBotCapabilityFixture(async body=>{
  const start=body.messages.findLastIndex(m=>m.role==='user'&&text(m).includes('SCENARIO:'+current.name));
  if(start<0)report.unexpectedRequest={scenario:current.name,messages:body.messages.map(m=>({role:m.role,text:text(m).slice(-1800)}))};
  assert.ok(start>=0,'scenario input reaches model');
  const results=body.messages.slice(start+1).filter(m=>m.role==='tool');
  const previous=current.steps[results.length-1];
  if(previous){const content=text(results.at(-1));if(previous.error)assert.match(content,previous.error);else if(!previous.allowFailure)assert.doesNotMatch(content,/✗|未执行|参数无效|ui_tree 失败|没找到可用窗口|用户拒绝|未获授权/);await previous.check?.(results.at(-1),body.messages.slice(start+1));}
  if(results.length>=current.steps.length)return {content:'SCENARIO_COMPLETE:'+current.name};
  const action=current.steps[results.length],args=typeof action.args==='function'?await action.args({last:results.at(-1),results}):action.args;
  return {tool:{name:action.name,args}};
 },{root:path.join(root,'host'),capabilityOptions:{desktop:observed}});
 mainSession=await fixture.call('session.create');
 await pass('Host/SDK app launch, identity, window list and idempotent launch',async()=>{
  await sdk('launch',[step('app_open',{app:appName}),step('ui_list',{}, {check:async()=>{target=await discover();}}),step('app_open',{app:appName})],{check:async()=>{const apps=await client.listAppWindows();assert.equal(apps.flatMap(a=>a.windows).filter(w=>w.title===title).length,1);}});
 });
 await pass('Target screenshot, UI tree values and empty value clearing',async()=>{
  await sdk('clear',[step('screen_view',()=>({target})),tree(),step('ui_act',({last})=>({actions:[{op:'set_value',ref:ref(last,'HemiInput'),value:''}]})),tree(),step('ui_act',({last})=>({actions:[{op:'set_value',ref:ref(last,'HemiInput'),value:'ANCHOR'}]})),tree({},)],{check:async()=>assert.equal((await readState()).input,'ANCHOR')});
 });
 await pass('Element-specific background text never lands in the other focused field',async()=>{
  await sdk('element-input',[tree(),step('ui_act',({last})=>({actions:[{op:'set_value',ref:ref(last,'HemiSecondary'),value:''}]})),step('ui_click',()=>({target,x:100,y:100,delivery:'foreground'})),tree(),step('ui_act',({last})=>({actions:[{op:'type',ref:ref(last,'HemiSecondary'),text:'FIELD_中文🙂'}]}))],{check:async()=>{const s=await readState();assert.equal(s.secondary,'FIELD_中文🙂');assert.equal(s.input,'ANCHOR');}});
 });
 await pass('Element-addressed Ctrl+A, Unicode foreground text, button invocation and toggle',async()=>{
  await sdk('keyboard',[tree(),step('ui_act',({last})=>({delivery:'foreground',actions:[{op:'press',ref:ref(last,'HemiInput'),combo:'ctrl+a'}]})),step('ui_type',()=>({target,text:'完整 Windows\r\n中文🙂',delivery:'foreground'})),tree(),step('ui_act',({last})=>({actions:[{op:'click',ref:ref(last,'HemiApply')},{op:'toggle',ref:ref(last,'HemiCheck')}]}))],{check:async()=>{const s=await readState();assert.equal(s.input,'完整 Windows\r\n中文🙂');assert.equal(s.applied,s.input);assert.equal(s.checked,'1');}});
 });
 await pass('Coordinate scrolling and element scrolling change the intended list',async()=>{
  await sdk('scroll',[step('screen_view',()=>({target})),step('ui_scroll',()=>({target,deltaY:-8,x:300,y:420,delivery:'foreground'})),tree(),step('ui_act',({last})=>({delivery:'foreground',actions:[{op:'scroll',ref:ref(last,'HemiScrollList'),direction:'down',amount:6}]}))],{check:async()=>{await wait(async()=>Number((await readState()).topIndex)>0,'list scroll');}});
 });
 await pass('Window-level key tool replaces the selected text through the complete SDK route',async()=>{
  const before=await readState();
  await sdk('window-key',[step('screen_view',()=>({target})),step('ui_click',()=>({target,x:100,y:100,delivery:'foreground'})),step('ui_key',()=>({target,combo:'ctrl+a',delivery:'foreground'})),step('ui_type',()=>({target,text:'WINDOW_KEY_中文🙂',delivery:'foreground'}),{check:async()=>assert.equal((await readState()).input,'WINDOW_KEY_中文🙂')}),tree(),step('ui_act',({last})=>({actions:[{op:'set_value',ref:ref(last,'HemiInput'),value:before.input}]}))]);
 });
 await pass('Read-only input refuses mutation and keeps its original value',async()=>{
  await sdk('read-only',[tree(),step('ui_act',({last})=>({actions:[{op:'set_value',ref:ref(last,'HemiReadOnly'),value:'MUST_NOT_WRITE'}]}),{error:/✗|未执行|拒绝|不支持|read.only/i})],{check:async()=>assert.equal((await readState()).readOnly,'READ_ONLY')});
 });
 await pass('Unsupported value writes stop a batch before the following button',async()=>{
  const before=await readState();
  await sdk('unsupported',[tree(),step('ui_act',({last})=>({actions:[{op:'set_value',ref:ref(last,'HemiApply'),value:'unsupported'},{op:'click',ref:ref(last,'HemiApply')}]}),{error:/✗|未执行|拒绝|不支持/})],{check:async()=>assert.equal((await readState()).applyCount,before.applyCount)});
 });
 await pass('Invalid target and failed tree invalidate the old element aliases',async()=>{
  const before=await readState();
  await sdk('bad-target',[tree(),step('ui_tree',()=>({target:{pid:target.pid,windowId:'1'}}),{error:/目标窗口|不可用|不存在|失败/}),step('ui_act',{actions:[{op:'set_value',ref:'t1',value:'MUST_NOT_WRITE'}]},{error:/快照|归属|授权|目标/})],{check:async()=>assert.equal((await readState()).input,before.input)});
 });
 await pass('Multi-window targeting stays bound to the requested HWND',async()=>{
  await sdk('open-window',[tree(),step('ui_act',({last})=>({actions:[{op:'click',ref:ref(last,'HemiOpenWindow')}]}))]);
  const second=await discover(' SECONDARY'),before=await readState();
  await sdk('second-window',[step('ui_tree',{target:second}),step('ui_act',({last})=>({actions:[{op:'set_value',ref:ref(last,'HemiWindowInput'),value:'OTHER_WINDOW_中文'}]})),step('screen_view',{target:second})],{check:async()=>{const s=await readState();assert.equal(s.otherValue,'OTHER_WINDOW_中文');assert.equal(s.input,before.input);}});
 });
 await pass('Owned modal dialog is selected and closed through its own UI tree',async()=>{
  await sdk('open-dialog',[tree(),step('ui_act',({last})=>({actions:[{op:'click',ref:ref(last,'HemiOpenDialog')}]}))]);
  const dialog=await wait(()=>discover(' DIALOG').catch(()=>null),'dialog');
  await sdk('dialog',[step('ui_tree',{target:dialog}),step('ui_act',({last})=>({actions:[{op:'click',ref:ref(last,'HemiDialogOK')}]}),{allowFailure:true})],{check:async()=>{await wait(async()=>(await readState()).dialogResult==='OK','dialog result');}});
 });
 await pass('Denied app permission prevents UI capture and mutation',async()=>{
  const denied=await fixture.call('session.create'),before=await readState(),count=captures;
  await sdk('deny',[{...tree(),error:/用户拒绝|拒绝|未获授权/}],{session:denied,decision:p=>p.options.at(-1)});
  assert.equal(captures,count);assert.equal((await readState()).input,before.input);
 });
 await pass('Stopping a pending permission expires the card without desktop execution',async()=>{
  const session=await fixture.call('session.create'),count=captures;current={name:'permission-stop',steps:[tree()]};
  await fixture.call('flow.command',{id:session.id,command:{type:'send',input:{inputId:'stop-permission-input',text:'SCENARIO:permission-stop'}}});
  const waiting=await untilBot(async()=>{const d=await fixture.call('session.open',{id:session.id});return Object.values(d.permissions).some(p=>p.status==='pending')&&d;});
  await fixture.call('flow.command',{id:session.id,command:{type:'stop',targetRunId:waiting.flow.activeRunId}});
  const stopped=await untilBot(async()=>{const d=await fixture.call('session.open',{id:session.id});return d.flow.phase==='idle'&&d;});
  assert.equal(Object.values(stopped.flow.runs).at(-1).outcome,'stopped');assert.equal(Object.values(stopped.permissions).some(p=>p.status==='pending'),false);assert.equal(captures,count);
 });
 await pass('Selected-window context is session-bound and rejects a changed application identity',async()=>{
  const count=captures;await assert.rejects(fixture.call('context.capture',{id:mainSession.id,target:{...target,bundleId:'wrong-owner'}}),/身份|关闭/);assert.equal(captures,count);
  const capture=await fixture.call('context.capture',{id:mainSession.id,target});assert.equal(capture.attachment.kind,'image');
 });
 await pass('The real Windows named pipe rejects an unauthenticated action',async()=>{
  const before=await readState(),socket=net.createConnection(desktopEndpoint(dataDir,controlToken(dataDir,{platform:'win32'})));let body='';
  socket.on('data',chunk=>body+=chunk);socket.on('connect',()=>socket.write(JSON.stringify({method:'typeText',controlToken:'0'.repeat(64),params:{...target,text:'UNAUTHORIZED'}})+'\n'));
  await new Promise(resolve=>socket.on('close',resolve));assert.equal(JSON.parse(body).ok,false);assert.equal((await readState()).input,before.input);
 });
 await pass('A cancelled queued desktop request is not replayed after the owner action completes',async()=>{
  const state=await client.windowState({...target,includeTree:true}),button=state.elements.find(e=>e.label==='HemiSlow');assert.ok(button?.elementToken);
  const before=await readState(),slow=client.click({...target,elementToken:button.elementToken});
  await new Promise(r=>setTimeout(r,100));const controller=new AbortController(),queued=client.typeText({...target,text:'MUST_NOT_REPLAY',signal:controller.signal});
  await new Promise(r=>setTimeout(r,150));controller.abort();await assert.rejects(queued,/停止/);await slow;
  await wait(async()=>Number((await readState()).slowCount)===Number(before.slowCount)+1,'slow action once');assert.equal((await readState()).input,before.input);
 });
 await pass('Desktop helper loss fails clearly and the same client reconnects after restart',async()=>{
  await worker.close();worker=null;await assert.rejects(client.windowState({...target,includeTree:true}),/助手|通道/);
  worker=await startTestWorker();assert.equal((await client.status()).available,true);
  await sdk('helper-restart',[tree(),step('ui_act',({last})=>({actions:[{op:'set_value',ref:ref(last,'HemiSecondary'),value:'RECONNECTED'}]}))],{check:async()=>assert.equal((await readState()).secondary,'RECONNECTED')});
 });
 await pass('Host restart rebuilds desktop tool bindings and restores the same session',async()=>{
  await fixture.restart();await sdk('host-restart',[tree(),step('ui_act',({last})=>({actions:[{op:'set_value',ref:ref(last,'HemiSecondary'),value:'HOST_RESTARTED'}]}))],{check:async()=>assert.equal((await readState()).secondary,'HOST_RESTARTED')});
 });
 await pass('Closed windows are refused without a whole-desktop screenshot',async()=>{
  const screenshot=await client.windowState({...target,includeScreenshot:true});
  assert.ok(screenshot.images?.[0]?.dataBase64,'fixture screenshot');await fs.writeFile(path.join(root,'fixture.png'),Buffer.from(screenshot.images[0].dataBase64,'base64'));
  await ps(`$p=Get-Process -Id ${target.pid};if($p.Path -ne ${literal(exe)}){throw 'Unexpected process identity'};Stop-Process -Id $p.Id`);
  await sdk('closed',[step('screen_view',()=>({target}),{error:/不存在|找不到|没能确认|不可用|失败|window|目标/,check:async(_message,messages)=>assert.equal(messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='image'||c.type==='image_url')),false)}),step('ui_tree',()=>({target}),{error:/不存在|没找到|不可用|失败|目标/})]);
 });
 report.memoryMB=Object.fromEntries(Object.entries(process.memoryUsage()).map(([k,v])=>[k,Math.round(v/1048576)]));
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
 if(target?.pid)await ps(`$p=Get-Process -Id ${target.pid} -ErrorAction SilentlyContinue;if($p -and $p.Path -eq ${literal(exe)}){Stop-Process -Id $p.Id};exit 0`).catch(()=>{});
 if(shortcut)await fs.rm(shortcut,{force:true});
 const closed=await Promise.allSettled([fixture?.host.close()]);closed.push(...await Promise.allSettled([worker?.close()]));closed.push(...await Promise.allSettled([fixture?.close()]));
 const failure=closed.find(r=>r.status==='rejected');if(failure&&!report.error){report.error=failure.reason.stack;process.exitCode=1;}
 await fs.writeFile(path.join(root,'result.json.tmp'),JSON.stringify(report,null,2)+'\n');await fs.rename(path.join(root,'result.json.tmp'),path.join(root,'result.json'));
}
