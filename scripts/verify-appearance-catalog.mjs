// Real Electron verification of catalog-driven skins and visible, distinct interaction states.
// HEMI_APPEARANCE_APP_ROOT may point at an isolated copy containing only an added config and assets.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import electronPath from 'electron';
import {createConversationStore} from '../src/main/history/conversation-store.mjs';

const root=path.resolve(process.env.HEMI_APPEARANCE_APP_ROOT||'.');
const {SKINS}=await import(pathToFileURL(path.join(root,'src/shared/appearance/skins.mjs')).href);
const runtime=process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {_electron}=await import(await fs.access(runtime).then(()=>pathToFileURL(runtime).href,()=> 'playwright'));
const mode=process.env.VITE_DEV_SERVER_URL?'dev':'built',extension=root!==process.cwd();
const out=path.resolve(`.visual/workflow/vision/appearance-catalog/${extension?'extension':'current'}-${mode}`);
const ud=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-appearance-catalog-'));
await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(ud,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
await fs.writeFile(path.join(ud,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
await fs.writeFile(path.join(ud,'window-state.json'),JSON.stringify({version:1,bounds:{x:30,y:30,width:1440,height:880},maximized:false}));
const store=createConversationStore({dir:path.join(ud,'conversations')});
for(let i=0;i<8;i++){const id=`conv-catalog-${i}`;store.saveSession({id,workspaceId:'default',turns:[{id:`u-${i}`,author:'user',createdAt:Date.now()+i,text:`主题验证对话 ${i}`} ]});store.renameSession(id,`主题验证对话 ${i}`);}
const report={mode,extension,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,platform:`${process.platform}/${process.arch}`,skinIds:SKINS.map(skin=>skin.id),checks:[],errors:[],screenshots:[],hover:{}};
const check=(name,ok,detail)=>{report.checks.push({name,ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);console.log('PASS',name);};
let app,page;
const main=source=>app.evaluate(({BrowserWindow,app},source)=>{const win=BrowserWindow.getAllWindows().find(w=>!new URL(w.webContents.getURL()).searchParams.has('mode'));return new Function('win','app',source)(win,app);},source);
const launch=async()=>{app=await _electron.launch({executablePath:electronPath,args:[root],cwd:root,env:{...process.env,HEMI_USER_DATA_DIR:ud}});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));await page.waitForFunction(()=>window.hemiVoice?.getAppearanceBootstrap?.());await main('app.focus({steal:true});win.focus()');};
const close=async()=>{if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});app=null;}};
const snap=async name=>{await page.screenshot({path:path.join(out,`${name}.png`),scale:'css'});report.screenshots.push(`${name}.png`);};
const done=()=>page.waitForFunction(()=>document.querySelector('.appearance-stage')?.dataset.startup==='done');
const choose=async skin=>{await page.getByRole('button',{name:'换肤',exact:true}).click();check(`${skin.id}: catalog card is automatically present`,await page.getByRole('radio').count()===SKINS.length);await page.getByRole('radio',{name:skin.name,exact:true}).click();await page.waitForFunction(id=>document.documentElement.dataset.skin===id,skin.id);await page.waitForTimeout(180);await page.keyboard.press('Escape');await page.locator('.skin-picker').waitFor({state:'hidden'});};
const away=async()=>{await page.mouse.move(1380,60);await page.waitForTimeout(160);};
const color=locator=>locator.evaluate(el=>{
 const ctx=document.createElement('canvas').getContext('2d');
 const rgba=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
 let node=el,bg;do{bg=rgba(getComputedStyle(node).backgroundColor);node=node.parentElement;}while(bg[3]===0&&node);
 const style=getComputedStyle(el);return {bg,text:rgba(style.color),hover:rgba(style.getPropertyValue('--bg-hover')),active:rgba(style.getPropertyValue('--bg-active')),activeHover:rgba(style.getPropertyValue('--bg-active-hover'))};
});
const distance=(a,b)=>a.slice(0,3).reduce((sum,value,i)=>sum+Math.abs(value-b[i]),0);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
try{
 await launch();await done();await page.locator('.h24-sidebar-open').first().click();
 let input=page.locator('textarea.text-composer-input');await input.fill('换肤保留的草稿');let instance=await input.elementHandle();
 for(const skin of SKINS){
  await choose(skin);await away();
  const inactive=page.locator('.h24-sidebar-item:not([data-current="true"])').first(),current=page.locator('.h24-sidebar-item[data-current="true"]');
  const base=await color(inactive);await inactive.hover();await page.waitForTimeout(160);const hover=await color(inactive);
  check(`${skin.id}: conversation hover is visible`,same(hover.bg,hover.hover)&&distance(base.bg,hover.bg)>=24,{base,hover});
  await away();const active=await color(current);await current.hover();await page.waitForTimeout(160);const activeHover=await color(current);
  check(`${skin.id}: selection and selected hover remain distinct`,same(active.bg,active.active)&&same(activeHover.bg,activeHover.activeHover)&&distance(hover.bg,active.bg)>0,{active,activeHover});
  report.hover[skin.id]={base,hover,active,activeHover};
  if(skin.assets)check(`${skin.id}: reading displays the configured static image without video`,await page.locator('.theme-home-actor>img').evaluate(el=>el.complete&&el.naturalWidth>0)&&await page.locator('video').count()===0);
  check(`${skin.id}: same input and unsaved draft survive switching`,await instance.evaluate(el=>el.isConnected&&el.value==='换肤保留的草稿'));
  await inactive.hover();await snap(`${skin.id}-reading-hover`);
  await page.getByRole('button',{name:'设置',exact:true}).click();await away();
  const category=page.getByRole('navigation',{name:'设置导航'}).getByRole('button',{name:'语音与通话',exact:true});
  const categoryBase=await color(category);await category.hover();await page.waitForTimeout(160);const categoryHover=await color(category);
  check(`${skin.id}: settings category hover is visible`,same(categoryHover.bg,categoryHover.hover)&&distance(categoryBase.bg,categoryHover.bg)>=24,{categoryBase,categoryHover});
  await snap(`${skin.id}-settings-hover`);
 const log=page.getByRole('button',{name:'日志文件',exact:true});await log.hover();await page.waitForTimeout(300);const logHover=await color(log);
  check(`${skin.id}: auxiliary buttons share the same hover token`,same(logHover.bg,logHover.hover),{logHover,hovered:await log.evaluate(el=>el.matches(':hover'))});
  await page.getByRole('button',{name:'换肤',exact:true}).click();
  const card=page.getByRole('radio').filter({hasText:SKINS.find(item=>item.id!==skin.id).name}).first();await away();
  const cardBase=await card.evaluate(el=>getComputedStyle(el).backgroundColor);await card.hover();
  check(`${skin.id}: skin-card hover changes its surface`,await card.evaluate((el,bg)=>getComputedStyle(el).backgroundColor!==bg,cardBase));
  await snap(`${skin.id}-picker-hover`);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'对话',exact:true}).click();await page.locator('textarea.text-composer-input').waitFor();
  // Opening settings unmounts the chat input by design; preserve a fresh handle for the next switch.
  await input.fill('换肤保留的草稿');await instance.dispose();
  // The next iteration obtains its own handle below.
  if(skin!==SKINS.at(-1))instance=await input.elementHandle();
 }
 const target=SKINS.find(skin=>skin.id==='trial-mint')||SKINS.find(skin=>skin.assets);
 await choose(target);await input.fill('');await page.getByRole('button',{name:'新建对话',exact:true}).click();await input.evaluate(el=>el.blur());await main('app.focus({steal:true});win.focus()');
 await page.waitForFunction(()=>document.querySelector('.theme-home-actor>video')?.readyState>=2&&!document.querySelector('.theme-home-actor>video')?.paused);
 check('configured home image, lettering and movie work together',await page.locator('.theme-home-copy strong').textContent()===target.headline);
 await snap('configured-home');
 await close();await launch();input=page.locator('textarea.text-composer-input');
 check('saved configured skin reaches the native bootstrap and first-frame selector',await page.evaluate(id=>window.hemiVoice.getAppearanceBootstrap().snapshot.preference.skinId===id&&document.documentElement.dataset.skin===id,target.id));
 await page.waitForFunction(()=>document.querySelector('.appearance-stage')?.dataset.startup==='intro');
 check('configured character supports the existing cold-start animation',await page.locator('video').count()===2);
 await page.keyboard.press('Escape');await done();
 await page.getByRole('button',{name:'新建对话',exact:true}).click();await input.evaluate(el=>el.blur());
 for(const [width,key]of [[1440,'home'],[980,'medium'],[560,'narrow']]){
  await main(`win.setContentSize(${width},800)`);await page.waitForTimeout(180);
  const sizes=await page.locator('.theme-home-copy strong').evaluate(el=>({actual:getComputedStyle(el).fontSize,configured:getComputedStyle(el).getPropertyValue(`--theme-type-${innerWidth>1179?'home':innerWidth>880?'medium':'narrow'}`).trim()}));
  check(`${width}px lettering size follows configuration`,sizes.actual===sizes.configured,sizes);await snap(`configured-home-${width}`);
 }
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.locator('.h37-settings-drawer-trigger').click();
 const drawer=page.getByRole('dialog',{name:'设置分类'});await drawer.waitFor();await drawer.getByRole('button',{name:'联网搜索',exact:true}).hover();await page.waitForTimeout(160);
 const c=await color(drawer.getByRole('button',{name:'联网搜索',exact:true}));check('narrow drawer inherits the same visible hover',same(c.bg,c.hover));await snap('configured-drawer-hover');
 check('no uncaught renderer errors',report.errors.length===0,report.errors);
}catch(error){if(page&&!page.isClosed())await snap('failure').catch(()=>{});throw error;}
finally{await close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('EVIDENCE',out);}
