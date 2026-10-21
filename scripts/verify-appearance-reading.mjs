// Focused real-window regression for static conversation scenery and animated home/startup.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import electronPath from 'electron';
import {createConversationStore} from '../src/main/history/conversation-store.mjs';
const runtime=process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {_electron}=await import(await fs.access(runtime).then(()=>pathToFileURL(runtime).href,()=> 'playwright'));
const mode=process.env.VITE_DEV_SERVER_URL?'dev':'built',out=path.resolve(`.visual/workflow/vision/appearance-reading/${mode}`),ud=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-appearance-reading-'));
await fs.mkdir(out,{recursive:true});
const report={mode,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,platform:`${process.platform}/${process.arch}`,checks:[],errors:[],screenshots:[],movies:[]};
const check=(name,ok,detail)=>{report.checks.push({name,ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);console.log('PASS',name);};
const store=createConversationStore({dir:path.join(ud,'conversations')});
for(let i=0;i<49;i++){const id=`conv-reading-${i}`;assert.ok(store.saveSession({id,workspaceId:'default',turns:[{id:`u-${i}`,author:'user',createdAt:Date.now()+i,text:`历史验证 ${i}`}]}).ok);store.renameSession(id,`历史验证 ${i}`);}
assert.ok(store.saveSession({id:'conv-reading-long',workspaceId:'default',turns:Array.from({length:18},(_,i)=>({id:`reading-${i}`,author:i%2?'hemi':'user',createdAt:Date.now()+i,text:i%2?`### 第 ${i} 轮结果\n\n${'这段回复用于检查背景题字和人物不会遮住对话正文，阅读时只有静态图片。'.repeat(8)}\n\n- 列表与正文仍可操作\n- 输入草稿保留\n\n\`\`\`js\nconst scene = 'static';\n\`\`\``:`检查第 ${i} 轮记录与界面背景。`}))}).ok);store.renameSession('conv-reading-long','优化验证长会话');
await fs.writeFile(path.join(ud,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
await fs.writeFile(path.join(ud,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'cafe-blue',mode:'light'}));
await fs.writeFile(path.join(ud,'window-state.json'),JSON.stringify({version:1,bounds:{x:30,y:30,width:1440,height:960},maximized:false}));
let app,page;
const main=source=>app.evaluate(({BrowserWindow,app},source)=>{const win=BrowserWindow.getAllWindows().find(w=>!new URL(w.webContents.getURL()).searchParams.has('mode'));return new Function('win','app',source)(win,app);},source);
const snap=async name=>{await page.screenshot({path:path.join(out,`${name}.png`)});report.screenshots.push(`${name}.png`);};
const choose=async skinId=>{const r=await page.evaluate(skinId=>window.hemiVoice.setAppearance({requestId:crypto.randomUUID(),skinId,mode:'light'}),skinId);assert.ok(r.ok);await page.waitForFunction(id=>document.documentElement.dataset.skin===id,skinId);};
const staticCheck=async name=>{await page.waitForFunction(()=>document.querySelector('.theme-home-backdrop')?.getAttribute('data-view')==='reading'&&!document.querySelector('.theme-home-actor video'));check(name,await page.locator('.theme-home-actor>img').isVisible()&&await page.locator('video').count()===0);};
try{
 app=await _electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,HEMI_USER_DATA_DIR:ud}});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>{if(r.url().includes('.webm'))report.movies.push(r.url());});await page.waitForFunction(()=>window.hemiVoice?.getAppearanceBootstrap?.()?.activity.visible);if(!await main('return win.isFocused()'))await main('app.focus({steal:true});win.focus()');
 await page.waitForFunction(()=>document.querySelector('.appearance-stage')?.dataset.startup==='intro');check('cold startup still animates both character layers',await page.locator('video').count()===2&&await page.locator('video').evaluateAll(videos=>videos.every(v=>!v.paused&&v.readyState>=2)));await page.waitForFunction(()=>document.querySelector('.appearance-stage')?.dataset.startup==='done');
 await staticCheck('restored conversation releases both movie decoders after startup');
 await page.locator('.h24-sidebar-open').filter({hasText:'优化验证长会话'}).click();
 const copy=page.locator('.theme-lettering-layer');await copy.waitFor();check('reading retains visible decorative title',await copy.locator('strong').isVisible()&&await copy.locator('strong').textContent()==='Smile'&&await copy.evaluate(el=>getComputedStyle(el).pointerEvents==='none'));
 report.readingStyles=await page.evaluate(()=>({copyOpacity:getComputedStyle(document.querySelector('.theme-lettering-layer')).opacity,copyZ:getComputedStyle(document.querySelector('.theme-lettering-layer')).zIndex,watermarkOpacity:getComputedStyle(document.querySelector('.skin-watermark>img')).opacity,sidebarBackground:getComputedStyle(document.querySelector('.h24-sidebar')).backgroundColor}));
 await snap('blue-reading');
 const beforeMovies=report.movies.length;
 for(const [id,word] of [['cafe-purple','Sister'],['cafe-orange','Suspended'],['cafe-gold','Sweet'],['cafe-red','Stupid'],['cafe-blue','Smile']]){await choose(id);await staticCheck(`${id} conversation uses a static figure`);check(`${id} reading title remains visible`,await copy.locator('strong').isVisible()&&await copy.locator('strong').textContent()===word);}
 check('switching skins during reading requests no movies',report.movies.length===beforeMovies);
 const list=page.locator('.h24-sidebar-nav'),mark=page.locator('.skin-watermark');const position=await mark.boundingBox();await list.evaluate(el=>{el.scrollTop=el.scrollHeight;});check('fainter portrait remains fixed behind 50 scrollable conversations',await page.locator('.h24-sidebar-open').count()===50&&Math.abs((await mark.boundingBox()).y-position.y)<1&&await list.evaluate(el=>el.scrollTop>0));
 const draft=page.locator('textarea.text-composer-input');await draft.fill('优化后仍保留的草稿');const input=await draft.elementHandle();await choose('cafe-purple');check('reading skin change preserves draft and input instance',await input.evaluate(el=>el.isConnected&&el.value==='优化后仍保留的草稿'));await staticCheck('editing in a conversation never recreates a movie');await draft.fill('');
 for(const width of [980,560]){await main(`win.setContentSize(${width},800)`);await page.waitForTimeout(180);await staticCheck(`static reading at ${width}px`);check(`title remains present at ${width}px`,await copy.locator('strong').isVisible());await snap(`reading-${width}`);}
 await main('win.setContentSize(1440,880)');await choose('cafe-blue');await page.getByRole('button',{name:'新建对话',exact:true}).click();await draft.evaluate(el=>el.blur());await main('app.focus({steal:true});win.focus()');await page.waitForFunction(()=>document.querySelector('.theme-home-actor>video')?.readyState>=2&&document.querySelector('.theme-home-actor>video')?.paused===false);check('new conversation restores animated home',await page.locator('video').count()===1&&await page.locator('.startup-overlay').count()===0);await snap('blue-new-conversation');
 const old=await page.locator('.theme-home-actor>video').elementHandle();await page.locator('.h24-sidebar-open').filter({hasText:'优化验证长会话'}).click();await staticCheck('entering conversation switches immediately back to static');await page.waitForTimeout(150);check('detached home movie releases its source and decoder',await old.evaluate(v=>!v.isConnected&&!v.getAttribute('src')&&v.readyState===0));await snap('blue-static-after-home');
 check('no uncaught renderer errors',report.errors.length===0,report.errors);
}catch(error){if(page&&!page.isClosed())await snap('failure').catch(()=>{});throw error;}finally{if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('EVIDENCE',out);}
