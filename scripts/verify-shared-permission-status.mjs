// Shared permission/status lifecycle checks through public APIs in development and built renderers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createServer, build, preview} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/postcss';
import {chromium} from 'playwright-core';
const repo=path.resolve(import.meta.dirname,'..'),out=path.join(repo,'.visual/workflow/shared-permission-status/components'),root=path.join(out,'consumer');
await fs.mkdir(root,{recursive:true});
await fs.writeFile(path.join(root,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
await fs.writeFile(path.join(root,'main.tsx'),String.raw`
import {StrictMode,useState} from 'react';import {createRoot} from 'react-dom/client';
import {PermissionCard,PermissionRequestCard} from '@hemi/conversation-flow/parts';
import {StatusNotice,Toast,TimedToast,useTransientMessage} from '@hemi/ui';
import ${JSON.stringify(path.join(repo,'src/renderer/src/globals.css'))};
import ${JSON.stringify(path.join(repo,'src/renderer/src/styles/index.css'))};
import '@hemi/ui/styles/touch.css';import '@hemi/conversation-flow/styles/touch.css';
const state=window.__permissionStatus={choices:[],stops:0,expires:[],reconnects:0,reviews:0};
function App(){
 const [layout,setLayout]=useState('desktop'),[legacy,setLegacy]=useState(false),[remaining,setRemaining]=useState(30000),[disabled,setDisabled]=useState(false),[persistent,setPersistent]=useState(false),[overlay,setOverlay]=useState(false),[receipt,setReceipt]=useState('first'),[toast,showToast]=useTransientMessage();
 Object.assign(state,{setLayout,setLegacy,setRemaining,setDisabled,setPersistent,setOverlay,setReceipt,showToast});
 const request={id:'raw',title:'允许 Hemi 读取指定目录？',kind:'grant',options:['允许这次','拒绝','本任务允许','持续允许','自定义选项'],args:{command:'cat /isolated/example.txt'},note:'仅访问所选目录。'};
 return <main className={'compact-shell '+(layout==='touch'?'touch-fixture':'')}>
  <StatusNotice layout={layout} title="Bot 连接已断开" detail="草稿会保留。" actions={<button onClick={()=>state.reconnects++}>恢复连接</button>}/>
  <StatusNotice layout={layout} actions={<button onClick={()=>state.reviews++}>核对结果</button>}>操作结果待核对</StatusNotice>
  <StatusNotice layout={layout} variant="inline">未能完成操作，请重试。</StatusNotice>
  {persistent ? <PermissionRequestCard layout={layout} request={request} taskText="隔离验证任务" disabled={disabled} onChooseOption={value=>state.choices.push(value)} onStop={()=>state.stops++}/> : <PermissionCard snap={{taskText:'隔离验证任务',permission:{...request,summary:'允许 Hemi 读取指定目录？',tool:'bash',kind:legacy?undefined:'grant',remainingMs:remaining}}} disabled={disabled} queuedTitles={['下一个任务']} onDecide={value=>state.choices.push(value)} onStop={()=>state.stops++}/>}
  {overlay?<div role="dialog" aria-modal="true" aria-label="覆盖弹窗">覆盖弹窗</div>:null}
  {toast?<Toast layout={layout}>{toast}</Toast>:null}
  <div data-receipt><TimedToast key={receipt} duration={2600} onExpire={()=>state.expires.push(receipt)}>模型已保存 {receipt}</TimedToast></div>
 </main>;
}
createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>);
`);
await fs.writeFile(path.join(root,'fixture.css'),'.touch-fixture{--m-line:#e9e9e7;--m-white:#fff;--m-subtle:#f2f2f1;--m-warning:#a2701c;--m-warning-bg:#faf3e6;--m-muted:#696966;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:20px;--s6:24px;--s11:44px;--s12:48px;--s16:64px;--r-control:12px;--text-small:12px;--text-label:13px;--text-ui:14px}.compact-shell{padding:24px;max-width:900px;margin:auto;min-height:100vh}.touch-fixture{padding:8px}.touch-fixture p{margin:0}.touch-fixture button{border:0;background:none;color:inherit}.touch-fixture .secondary-button{background:var(--m-subtle)}.touch-fixture strong{font-weight:500}');
await fs.appendFile(path.join(root,'main.tsx'),"\nimport './fixture.css';\n");
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-permission-status-ui-'));
const common={configFile:false,root,cacheDir:path.join(temporary,'vite-cache'),logLevel:'error',css:{postcss:{plugins:[tailwind()]}},resolve:{dedupe:['react','react-dom']},build:{outDir:path.join(root,'dist'),emptyOutDir:true}};

const browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,results:[]};
try{for(const mode of ['dev','built']){
 if(mode==='built')await build({...common,plugins:[react()]});
 const aliases={'@hemi/conversation-flow/parts':path.join(repo,'packages/conversation-flow/src/parts.ts')};
 const server=mode==='dev'?await createServer({...common,plugins:[react()],resolve:{...common.resolve,alias:[{find:/^@hemi\/conversation-flow\/parts$/,replacement:aliases['@hemi/conversation-flow/parts']}]},server:{host:'127.0.0.1',port:0,fs:{allow:[repo]}}}):await preview({...common,preview:{host:'127.0.0.1',port:0}});
 const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(10000);
 const result={mode,checks:[],errors:[],screenshots:[]};report.results.push(result);const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());});
 const set=async(name,value)=>{await page.evaluate(({name,value})=>window.__permissionStatus[name](value),{name,value});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));};
 const choices=()=>page.evaluate(()=>window.__permissionStatus.choices);
 try{
  if(mode==='dev')await server.listen();await page.goto(server.resolvedUrls.local[0]);const card=page.getByRole('alertdialog',{name:'操作授权请求'});await card.waitFor();
  assert.deepEqual(await card.locator('.permission-actions button').allTextContents(),['拒绝','本任务允许','允许这次','持续允许','自定义选项']);await page.keyboard.press('Escape');assert.deepEqual(await choices(),[]);await card.getByText('查看完整命令与路径').click();assert.equal(await card.locator('details').getAttribute('open'),'');await card.getByRole('button',{name:'持续允许',exact:true}).click();assert.deepEqual(await choices(),['persistent']);check('modern task labels, sorted options, full command and Escape semantics');
  await set('setLegacy',true);await set('setOverlay',true);await page.keyboard.press('Escape');assert.equal((await choices()).length,1);await set('setOverlay',false);await page.keyboard.press('Escape');assert.deepEqual(await choices(),['persistent','deny']);await card.getByRole('button',{name:'自定义选项'}).click();assert.equal((await choices()).at(-1),'deny');check('legacy Escape yields to modal overlays; unknown labels cannot grant access');
  await set('setDisabled',true);await page.waitForFunction(()=>document.querySelector('.permission-actions button')?.disabled);await page.keyboard.press('Escape');assert.equal((await choices()).length,3);assert.equal(await card.getByRole('button',{name:'允许这次',exact:true}).isDisabled(),true);assert.equal(await card.getByRole('button',{name:'停止任务'}).isDisabled(),true);await set('setDisabled',false);await set('setRemaining',0);assert.equal(await card.getByRole('button',{name:'允许这次',exact:true}).isDisabled(),true);await page.keyboard.press('Escape');assert.equal((await choices()).length,3);assert.equal(await card.locator('[data-count]').textContent(),'0');check('disabled and expired requests cannot decide, including keyboard input');
  await set('setPersistent',true);await page.getByText('等待确认',{exact:true}).waitFor();assert.equal(await card.locator('.countdown-track').count(),0);await card.getByRole('button',{name:'自定义选项'}).click();assert.equal((await choices()).at(-1),'自定义选项');await card.getByRole('button',{name:'停止任务'}).click();assert.equal(await page.evaluate(()=>window.__permissionStatus.stops),1);check('persistent Bot requests round-trip raw options and preserve stop');
  await page.getByRole('button',{name:'恢复连接',exact:true}).click();await page.getByRole('button',{name:'核对结果',exact:true}).click();assert.equal(await page.evaluate(()=>window.__permissionStatus.reconnects+window.__permissionStatus.reviews),2);check('shared status actions and live regions remain usable');
  await page.clock.install();await set('setReceipt','clock-start');await page.evaluate(()=>{window.__permissionStatus.expires=[];});
  // Replacing a toast with the same text restarts its lifetime; old receipt expiry is cancelled.
  await set('showToast','重复提示');await page.clock.fastForward(2000);await set('showToast','重复提示');await set('setReceipt','second');await page.clock.fastForward(1000);assert.equal(await page.getByRole('status').filter({hasText:'重复提示'}).count(),1);assert.deepEqual(await page.evaluate(()=>window.__permissionStatus.expires),[]);await page.clock.fastForward(1601);assert.equal(await page.getByRole('status').filter({hasText:'重复提示'}).count(),0);assert.deepEqual(await page.evaluate(()=>window.__permissionStatus.expires),['second']);check('same-text toast replacement, timer cleanup and scoped receipt acknowledgement');
  for(const width of [375,768,1440]){await page.setViewportSize({width,height:900});await set('setLayout',width<1000?'touch':'desktop');const file=path.join(out,`${mode}-${width}.png`);await page.screenshot({path:file});result.screenshots.push(file);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);if(width<1000){const touch=page.getByRole('group',{name:'Bot 操作确认'});assert.deepEqual(await touch.getByRole('button').allTextContents(),['允许这次','拒绝','本任务允许','持续允许','自定义选项']);const boxes=await touch.getByRole('button').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height));assert.ok(boxes.every(h=>h>=44));}}
  await page.emulateMedia({colorScheme:'dark'});const dark=path.join(out,`${mode}-dark-preference.png`);await page.screenshot({path:dark});result.screenshots.push(dark);check('375/768/1440 fit, touch option order and tap areas, dark system preference');assert.deepEqual(result.errors,[]);check('no renderer errors');
 }catch(e){result.error=e.stack;await page.screenshot({path:path.join(out,mode+'-failure.png')});throw e;}finally{await context.close();await server.close();}
}}finally{await browser.close();await fs.rm(temporary,{recursive:true,force:true});await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
