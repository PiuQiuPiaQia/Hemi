// SDK presentation test: discontinuous heads and continuous user-driven history reads.
// Actual Host paging and native recovery are covered by the companion verification scripts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer,build,preview} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright-core';
const repo=path.resolve(import.meta.dirname,'..'),root=path.join(repo,'.visual/workflow/architecture-refactor/gap-harness');
await fs.mkdir(root,{recursive:true});
await fs.writeFile(path.join(root,'index.html'),'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
await fs.writeFile(path.join(root,'main.tsx'),`
import React,{useMemo,useRef} from 'react';import {createRoot} from 'react-dom/client';
import {ConversationFlow} from '${repo}/packages/conversation-flow/src/components/conversation-flow.tsx';
import {createConversation,createConversationPresenter,projectFlowWindow,flowHistoryPage} from '${repo}/packages/conversation-flow/src/core.ts';
import {useConversation} from '${repo}/packages/conversation-flow/src/react.ts';
import '@hemi/conversation-flow/styles.css';
const style=document.createElement('style');style.textContent='html,body,#root{margin:0;height:100%;overflow:hidden}#root{display:flex;flex-direction:column}.hemi-conversation-flow{min-height:0;flex:1;display:flex;flex-direction:column}';document.head.append(style);
const canonical={schemaVersion:1,conversationId:'gap',generation:1,revision:1,phase:'idle',activeRunId:null,queuePaused:false,pending:[],timeline:Array.from({length:500},(_,i)=>({kind:'user',id:'u'+i,runId:'r'+i,text:'Question '+i+' — '+('Long reading content. '.repeat(i%7===0?35:4)),inputSource:'text',attachmentIds:[],acceptedAt:1,deliveredAt:1})),runs:{},tasks:{},permissions:{},artifacts:{},pendingReports:[]};
let receive,reads=0,release,gate;
const head=(length,revision)=>projectFlowWindow({...canonical,timeline:canonical.timeline.slice(0,length),revision});
const client=createConversation({scope:{environmentId:'qa',conversationId:'gap'},transport:{async fetchSnapshot(){return head(100,0)},subscribe(_s,change,_off,online){receive=change;change({kind:'snapshot',snapshot:head(100,0),epoch:'same-host'});online();return()=>{}},async fetchHistory(_s,cursor){reads++;if(gate)await gate;return flowHistoryPage(canonical,cursor)},async command(){return {ok:true}}}});
function App(){const state=useConversation(client),present=useMemo(createConversationPresenter,[]),flow=useRef(null);window.gap={get:()=>({reads,history:client.getSnapshot().history,snapshot:client.getSnapshot().snapshot}),next:length=>receive({kind:'snapshot',snapshot:head(length,length),epoch:'same-host'}),hold:()=>{gate=new Promise(resolve=>release=resolve)},release:()=>{release?.();gate=undefined},seekId:id=>flow.current.scrollToMessage(id,{align:'start'}),seek:()=>flow.current.scrollToMessage(client.getSnapshot().history.gap.beforeId,{align:'center'})};return <ConversationFlow ref={flow} scope={{environmentId:'qa',conversationId:'gap',generation:'1'}} messages={present(state.snapshot)} state={{history:state.history?{...state.history,load:()=>void client.loadHistory(),gap:state.history.gap?{...state.history.gap,load:()=>void client.loadHistory('gap')}:undefined}:undefined}}/>}
createRoot(document.getElementById('root')).render(<App/>);
`);
const config={root,cacheDir:path.join(root,'vite-cache'),configFile:false,plugins:[react({exclude:/\/dist\//})],resolve:{dedupe:['react','react-dom']},logLevel:'error',server:{hmr:false,host:'127.0.0.1',port:0,fs:{allow:[repo]}},build:{outDir:path.join(root,'dist'),emptyOutDir:true}};
await build(config);
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const report={at:new Date().toISOString(),results:[]};
const wait=async(fn)=>{const until=Date.now()+10000;while(!await fn()){assert.ok(Date.now()<until,'gap condition timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
try {for(const mode of ['dev','built']){
 const server=mode==='dev'?await createServer(config):await preview({...config,preview:{host:'127.0.0.1',port:0}});if(mode==='dev')await server.listen();
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'}),page=await context.newPage();
 const result={mode,errors:[]};report.results.push(result);page.on('pageerror',error=>{if(!error.message.includes('ResizeObserver loop'))result.errors.push(error.message)});
 const pending=new Set();page.on('request',request=>pending.add(request.url()));page.on('requestfinished',request=>pending.delete(request.url()));page.on('requestfailed',request=>{pending.delete(request.url());result.errors.push(request.url()+': '+request.failure()?.errorText)});
 try {
  await page.goto(server.resolvedUrls.local[0]);await page.locator('[data-virtual-row]').first().waitFor();
  const viewport=page.locator('[data-slot=scroll-area-viewport]');
  assert.equal(await page.evaluate(()=>window.gap.get().snapshot.timeline.length),10);
  await page.evaluate(()=>window.gap.seekId('u93'));await page.waitForTimeout(100);
  await viewport.evaluate(v=>v.dispatchEvent(new WheelEvent('wheel',{deltaY:-80,bubbles:true})));
  await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.gap.get().reads),0,'fourth-oldest QA does not prefetch yet');
  await page.evaluate(()=>window.gap.seekId('u92'));await page.waitForTimeout(100);
  await page.evaluate(()=>window.gap.hold());
  await viewport.evaluate(v=>{const t=new Touch({identifier:1,target:v,clientX:160,clientY:150});v.dispatchEvent(new TouchEvent('touchstart',{touches:[t],bubbles:true}));});
  // A long drag must not expire at the old 1200ms threshold.
  await page.waitForTimeout(1400);
  await viewport.evaluate(v=>v.dispatchEvent(new TouchEvent('touchmove',{touches:[new Touch({identifier:1,target:v,clientX:160,clientY:220})],bubbles:true})));
  await wait(()=>page.evaluate(()=>window.gap.get().reads===1));await page.locator('.h24-history-progress').waitFor();
  await page.evaluate(()=>window.gap.release());await wait(()=>page.evaluate(()=>!window.gap.get().history.loading));await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.gap.get().snapshot.timeline.length),20,'third-oldest QA prefetches ten whole QAs');
  await viewport.evaluate(v=>{v.scrollTop=0;v.dispatchEvent(new TouchEvent('touchmove',{touches:[new Touch({identifier:1,target:v,clientX:160,clientY:260})],bubbles:true}));});
  await wait(()=>page.evaluate(()=>window.gap.get().reads===2&&!window.gap.get().history.loading));
  assert.equal(await page.evaluate(()=>window.gap.get().reads),2,'continued upward input can read another page in the same gesture');
  const firstId=await page.evaluate(()=>window.gap.get().snapshot.timeline[0].id);
  const anchor=()=>viewport.evaluate(v=>{const top=v.getBoundingClientRect().top;const row=[...v.querySelectorAll('[data-virtual-row]')].find(e=>e.getBoundingClientRect().bottom>top);return {id:row.dataset.virtualRow,offset:row.getBoundingClientRect().top-top}});
  const before=await anchor();await page.evaluate(()=>{window.gap.next(300);window.gap.next(500)});await page.waitForTimeout(200);
  const after=await viewport.evaluate((v,id)=>{const row=[...v.querySelectorAll('[data-virtual-row]')].find(e=>e.dataset.virtualRow===id);return row?{offset:row.getBoundingClientRect().top-v.getBoundingClientRect().top}:null},before.id);
  assert.ok(after,'reading anchor survived discontinuous head');assert.ok(Math.abs(after.offset-before.offset)<4,JSON.stringify({before,after}));assert.equal(await page.evaluate(()=>window.gap.get().reads),2,'heads never drain missing history automatically');result.anchor={before,after};
  let filled=0;
  while(await page.evaluate(()=>Boolean(window.gap.get().history.gap))){assert.ok(filled++<60);await page.evaluate(()=>window.gap.seek());const button=page.getByRole('button',{name:'加载中间消息',exact:true});await button.waitFor();const reads=await page.evaluate(()=>window.gap.get().reads);await viewport.evaluate(v=>v.dispatchEvent(new WheelEvent('wheel',{deltaY:-80,bubbles:true})));await wait(()=>page.evaluate(reads=>window.gap.get().reads===reads+1&&!window.gap.get().history.loading,reads));assert.equal(await page.evaluate(()=>window.gap.get().reads),reads+1);}
  const state=await page.evaluate(()=>window.gap.get());assert.equal(new Set(state.snapshot.timeline.map(x=>x.id)).size,state.snapshot.timeline.length);assert.equal(state.snapshot.timeline.at(-1).id,'u499');assert.equal(state.snapshot.timeline[0].id,firstId);result.pages=filled;
  assert.deepEqual(result.errors,[]);await page.screenshot({path:path.join(root,mode+'.png')});console.log('PASS',mode,JSON.stringify(result));
 }catch(error){result.error=error.stack;result.url=page.url();result.pending=[...pending];result.body=(await page.locator('body').innerText()).slice(0,1000);result.state=await page.evaluate(()=>{const s=window.gap?.get();return s?{reads:s.reads,history:s.history,rows:s.snapshot?.timeline.length}:null});console.error(JSON.stringify(result));throw error;}finally{await context.close();await server.close();}
}}finally{await browser.close();await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));}
