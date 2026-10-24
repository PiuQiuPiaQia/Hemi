// Public state/boundary/list APIs in development and built consumers; no platform services.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {build,createServer,preview} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/postcss';
import {chromium} from 'playwright-core';
const repo=path.resolve(import.meta.dirname,'..'),out=path.join(repo,'.visual/workflow/shared-states-lists/components'),root=path.join(out,'consumer');await fs.mkdir(root,{recursive:true});
await fs.writeFile(path.join(root,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
await fs.writeFile(path.join(root,'main.tsx'),String.raw`
import {StrictMode,useState} from 'react';import{createRoot}from'react-dom/client';
import{EmptyState,LoadingState,ErrorState,ErrorBoundary}from'@hemi/ui';
import{AppBoundary}from ${JSON.stringify(path.join(repo,'apps/mobile/src/components/app-boundary.tsx'))};
import{ConversationList,ConversationRow}from'@hemi/conversation-flow/navigation';
import ${JSON.stringify(path.join(repo,'src/renderer/src/globals.css'))};import ${JSON.stringify(path.join(repo,'src/renderer/src/styles/index.css'))};
const state=window.__statesLists={reports:[],resets:0,renames:[],opens:[],attempts:0,mobileReturns:0};
function Fault(){if(state.fault)throw Error('ISOLATED_BOUNDARY_FAILURE');return <p>内容已恢复</p>;}
function MobileFault(){if(state.mobileFault)throw Error('ISOLATED_BOUNDARY_FAILURE');return <p>移动连接内容已恢复</p>;}
function App(){
 const [mobileFault,setMobileFault]=useState(false),[failed,setFailed]=useState(false),[scope,setScope]=useState('one'),[empty,setEmpty]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(false),[editing,setEditing]=useState(null),[draft,setDraft]=useState(''),[reversed,setReversed]=useState(false);
 state.fault=failed;state.mobileFault=mobileFault;Object.assign(state,{setMobileFault,setFailed,setScope,setEmpty,setLoading,setError,setReversed});
 const items=[{id:'one',title:'第一个会话',updatedAt:Date.now(),turnCount:2,status:'waiting'},{id:'bad',title:'损坏的会话',corrupt:true,turnCount:4},{id:'busy',title:'正在打开的会话',turnCount:3}];
 const row=item=><ConversationRow item={item} presentation="history" current={item.id==='one'} disabled={item.id==='busy'} onOpen={()=>state.opens.push(item.id)} editing={editing===item.id} draft={draft} onDraftChange={setDraft} onCancelEdit={()=>setEditing(null)} onCommitEdit={title=>{state.renames.push(title);setEditing(null);}}/>;
 return <main className="compact-shell" style={{maxWidth:720,padding:24,margin:'auto'}}>
  <label>边界外草稿<input aria-label="边界外草稿" defaultValue="保留输入"/></label>
  <section aria-label="错误边界测试"><ErrorBoundary resetKey={scope} onError={(error,info)=>state.reports.push({message:error.message,stack:!!info.componentStack})} onReset={()=>{state.resets++;}} fallback={(error,reset)=><ErrorState title="暂时无法显示" description={error.message} actions={[{label:'重试内容',onAction:()=>{setFailed(false);reset();}}]}/> }><Fault/></ErrorBoundary></section>
  <section aria-label="移动边界测试"><AppBoundary onReturn={()=>{state.mobileReturns++;setMobileFault(false);}}><MobileFault/></AppBoundary></section>
  <button onClick={()=>{setEditing('one');setDraft('第一个会话');}}>重命名</button>
  <div className="history-dialog"><ConversationList className="history-list" label="共享历史列表" items={empty?[]:items} empty={<EmptyState description="还没有会话"/>} renderItem={item=><div className="history-item">{row(item)}</div>}/></div>
  <ConversationList as="nav" label="共享分组" groups={(reversed?[items.slice(1),items.slice(0,1)]:[items.slice(0,1),items.slice(1)]).map((items,index)=>({key:String(index),label:'分组 '+index,items}))} wrapGroupItems={(_group,content)=><div data-host-wrapper>{content}</div>} renderItem={item=><ConversationRow item={item} onOpen={()=>state.opens.push(item.id)}/>}/>
  {loading?<LoadingState description="正在读取内容…"/>:error?<ErrorState description="读取失败，旧数据保留" actions={[{label:'重新读取',onAction:()=>{state.attempts++;setError(false);}}]}/>:<EmptyState title="今天想做什么？" description="继续使用原有输入栏"/>}
 </main>;
}
createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>);
`);
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-states-lists-'));
const common={configFile:false,root,cacheDir:path.join(temporary,'cache'),logLevel:'error',css:{postcss:{plugins:[tailwind()]}},resolve:{dedupe:['react','react-dom']},build:{outDir:path.join(root,'dist'),emptyOutDir:true}};
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,results:[]};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{for(const mode of ['dev','built']){
 if(mode==='built')await build({...common,plugins:[react()]});
 const aliases={'@hemi/conversation-flow/navigation':path.join(repo,'packages/conversation-flow/src/navigation.ts')};
 const server=mode==='dev'?await createServer({...common,plugins:[react()],resolve:{...common.resolve,alias:aliases},server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[repo]}}}):await preview({...common,preview:{host:'127.0.0.1',port:0}});
 const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(10000);
 const result={mode,checks:[],errors:[],screenshots:[]};report.results.push(result);const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
 page.on('pageerror',e=>{if(!e.message.includes('ISOLATED_BOUNDARY_FAILURE'))result.errors.push(e.message);});
 const set=async(name,value)=>{await page.evaluate(({name,value})=>window.__statesLists[name](value),{name,value});};
 try{
  if(mode==='dev')await server.listen();await page.goto(server.resolvedUrls.local[0]);const history=page.getByLabel('共享历史列表',{exact:true});await history.waitFor();
  assert.ok((await history.textContent()).includes('2 条'));assert.equal(await history.getByRole('button').filter({hasText:'损坏的会话'}).isDisabled(),true);assert.equal(await history.getByRole('button').filter({hasText:'正在打开的会话'}).isDisabled(),true);await history.getByRole('button').filter({hasText:'第一个会话'}).click();assert.deepEqual(await page.evaluate(()=>window.__statesLists.opens),['one']);check('history metadata, current item, controlled selection, corrupt and busy gating');
  await page.getByRole('button',{name:'重命名',exact:true}).click();let input=page.getByRole('textbox',{name:'重命名会话',exact:true});await input.fill('取消这次修改');await input.press('Escape');await input.waitFor({state:'hidden'});assert.deepEqual(await page.evaluate(()=>window.__statesLists.renames),[]);
  await page.getByRole('button',{name:'重命名',exact:true}).click();input=page.getByRole('textbox',{name:'重命名会话',exact:true});await input.fill('共享历史重命名');await input.evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true})));assert.deepEqual(await page.evaluate(()=>window.__statesLists.renames),[]);await input.press('Enter');await input.waitFor({state:'hidden'});assert.deepEqual(await page.evaluate(()=>window.__statesLists.renames),['共享历史重命名']);
  await page.getByRole('button',{name:'重命名',exact:true}).click();input=page.getByRole('textbox',{name:'重命名会话',exact:true});await input.fill('失焦保存一次');await page.getByRole('textbox',{name:'边界外草稿'}).click();await input.waitFor({state:'hidden'});assert.deepEqual(await page.evaluate(()=>window.__statesLists.renames),['共享历史重命名','失焦保存一次']);check('shared rename: Escape cancels, IME Enter does not submit, Enter/blur commit once');
  const groups=page.getByRole('navigation',{name:'共享分组'});assert.equal(await groups.locator('[data-host-wrapper]').count(),2);await set('setReversed',true);await page.waitForFunction(()=>document.querySelector('nav button').textContent.includes('损坏'));assert.equal(await groups.getByRole('button').count(),3);check('group wrappers preserve host context and controlled ordering');
  await set('setEmpty',true);await history.getByText('还没有会话',{exact:true}).waitFor();assert.equal(await history.getByRole('button').count(),0);await set('setEmpty',false);await history.getByRole('button').first().waitFor();await set('setLoading',true);await page.getByRole('status').filter({hasText:'正在读取内容…'}).waitFor();await set('setLoading',false);await set('setError',true);await page.getByRole('alert').filter({hasText:'读取失败，旧数据保留'}).waitFor();assert.equal(await history.getByRole('button').count(),3);await page.getByRole('button',{name:'重新读取',exact:true}).click();assert.equal(await page.evaluate(()=>window.__statesLists.attempts),1);check('loading/empty/error transitions preserve controlled data and retry actions');
  const outside=page.getByRole('textbox',{name:'边界外草稿'});await outside.fill('边界外内容保留');await set('setFailed',true);await page.getByRole('alert').filter({hasText:'暂时无法显示'}).waitFor();assert.equal(await outside.inputValue(),'边界外内容保留');assert.ok((await page.evaluate(()=>window.__statesLists.reports)).every(report=>report.message==='ISOLATED_BOUNDARY_FAILURE'&&report.stack));await page.getByRole('button',{name:'重试内容'}).click();await page.getByText('内容已恢复',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__statesLists.resets),1);
  await set('setFailed',true);await page.getByRole('button',{name:'重试内容'}).waitFor();await set('setFailed',false);await set('setScope','two');await page.getByText('内容已恢复',{exact:true}).waitFor();assert.equal(await outside.inputValue(),'边界外内容保留');check('error boundary isolates failure, reports diagnostics, retries and resets on scope change');
  await set('setMobileFault',true);const mobileBoundary=page.getByRole('region',{name:'移动边界测试'});await mobileBoundary.getByRole('heading',{name:'暂时无法打开对话',exact:true}).waitFor();await mobileBoundary.getByRole('button',{name:'返回连接页',exact:true}).click();await page.getByText('移动连接内容已恢复',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__statesLists.mobileReturns),1);check('mobile host boundary retains the return callback and resets the failed surface');
  for(const width of [375,768,1440]){await page.setViewportSize({width,height:900});await page.waitForTimeout(150);const file=path.join(out,`${mode}-${width}.png`);await page.screenshot({path:file});result.screenshots.push(file);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.emulateMedia({colorScheme:'dark'});const file=path.join(out,mode+'-dark.png');await page.screenshot({path:file});result.screenshots.push(file);assert.deepEqual(result.errors,[]);check('375/768/1440, system dark preference and no unexpected renderer errors');
 }catch(error){result.error=error.stack;await page.screenshot({path:path.join(out,mode+'-failure.png')});throw error;}finally{await context.close();await server.close();}
}}finally{await browser.close();await fs.rm(temporary,{recursive:true,force:true});await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
