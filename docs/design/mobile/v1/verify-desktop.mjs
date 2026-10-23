import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer,preview} from 'vite';
import {chromium} from 'playwright-core';

const root=import.meta.dirname,repo=path.resolve(root,'../../../..'),output=path.join(repo,'.visual/workflow/desktop-pairing-design');
await fs.mkdir(output,{recursive:true});await fs.mkdir(path.join(root,'exports/desktop'),{recursive:true});
const report={date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:`${process.platform}/${process.arch}`,sources:{},modes:[]};
for(const name of ['desktop.jsx','desktop.css','desktop.html','pairing.jsx','pairing-demo.js','session.js','vite.config.mjs','../../../../src/renderer/src/tokens.css','../../../../src/renderer/src/windows/bot/styles.css'])report.sources[name]=createHash('sha256').update(await fs.readFile(path.resolve(root,name))).digest('hex');
const browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 for(const mode of ['dev','built']){
  const options={configFile:path.join(root,'vite.config.mjs'),logLevel:'error'};
  const server=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});
  if(mode==='dev')await server.listen();
  const url=server.resolvedUrls.local[0],context=await browser.newContext({viewport:{width:1440,height:1040},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']}),page=await context.newPage();
  page.setDefaultTimeout(10000);
  const result={mode,url,checks:[],errors:[],external:[],screenshots:[]};report.modes.push(result);
  page.on('pageerror',error=>result.errors.push(error.message));page.on('console',message=>{if(message.type()==='error')result.errors.push(message.text());});page.on('request',request=>{if(!['data:','blob:'].includes(new URL(request.url()).protocol)&&new URL(request.url()).origin!==new URL(url).origin)result.external.push(request.url());});
  const check=text=>{result.checks.push(text);console.log('PASS',mode,text);};
  const go=async scene=>{await page.goto(url+'desktop.html?scene='+scene);await page.locator('.pc-window').waitFor();await page.locator('.h24-hemi-message').first().waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
  const product=page.locator('.pc-window'),dialog=page.getByRole('dialog');
  const layout=async()=>{
   const dimensions=await page.evaluate(()=>{const frame=document.querySelector('.pc-window').getBoundingClientRect(),modal=document.querySelector('.pc-dialog')?.getBoundingClientRect();return{overflow:document.documentElement.scrollWidth>innerWidth,frame:frame.toJSON(),modal:modal?.toJSON()};});
   assert.equal(dimensions.overflow,false);if(dimensions.modal){assert.ok(dimensions.modal.top>=dimensions.frame.top&&dimensions.modal.bottom<=dimensions.frame.bottom+1);assert.ok(dimensions.modal.left>=dimensions.frame.left&&dimensions.modal.right<=dimensions.frame.right+1);}
  };
  try{
   for(const scene of ['settings','pair-share','request','pair-confirm','devices','offline','unsupported','limited']){await go(scene);await layout();const filename=mode==='built'?path.join(root,`exports/desktop/${scene}.png`):path.join(output,`${mode}-${scene}.png`);await product.screenshot({path:filename});result.screenshots.push(filename);}
   await go('settings');assert.equal(await dialog.getByRole('heading',{name:'Bot 设置',exact:true}).evaluate(el=>getComputedStyle(el).fontSize),'16px');assert.equal(await dialog.locator('.pc-setting-row strong').first().evaluate(el=>getComputedStyle(el).fontSize),'13px');
   check('8 desktop scenes use actual PC tokens and Bot dialog styles; settings title 16px, device rows 13px');

   for(const width of [375,768,1180,1440]){await page.setViewportSize({width,height:width===375?812:1040});for(const scene of ['settings','pair-share','pair-confirm','devices']){await go(scene);await layout();}await page.screenshot({path:path.join(output,`${mode}-${width}.png`)});}
   await page.emulateMedia({colorScheme:'dark'});assert.equal(await product.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');await page.emulateMedia({colorScheme:'light'});await page.setViewportSize({width:1440,height:1040});
   check('375/768/1180/1440 fit without horizontal overflow or clipped dialogs; explicit light mode under dark preference');

   await go('settings');await dialog.getByRole('button',{name:'完成',exact:true}).click();await product.getByRole('button',{name:'Bot 设置',exact:true}).click();await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Bot 设置');
   await product.getByRole('textbox',{name:'桌面对话消息',exact:true}).fill('PC 配对期间保留的草稿');await product.getByRole('button',{name:'Bot 设置',exact:true}).click();await dialog.getByRole('button',{name:/连接新设备/}).click();await dialog.getByRole('heading',{name:'用新设备扫描这个码',exact:true}).waitFor();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);
   await page.getByRole('button',{name:'模拟手机扫码申请',exact:true}).click();await dialog.getByRole('heading',{name:'是你正在配对的设备吗？',exact:true}).waitFor();await dialog.getByRole('button',{name:'关闭弹窗',exact:true}).click();await product.getByRole('button',{name:'新设备请求 1',exact:true}).waitFor();assert.equal(await product.getByRole('textbox',{name:'桌面对话消息',exact:true}).inputValue(),'PC 配对期间保留的草稿');await product.getByRole('button',{name:'新设备请求 1',exact:true}).click();assert.equal(await dialog.getByRole('button',{name:'允许连接',exact:true}).isDisabled(),true);
   check('PC settings → QR → request notification; modal focus lifecycle; dismissing pending details keeps request and chat draft');

   await dialog.getByRole('checkbox',{name:'两台设备的验证码一致',exact:true}).check();await dialog.getByRole('button',{name:'允许连接',exact:true}).click();await dialog.getByRole('heading',{name:'已允许连接',exact:true}).waitFor();assert.equal(await dialog.getByRole('heading',{name:'新设备已连接',exact:true}).count(),0);await dialog.getByRole('button',{name:'查看已连接设备',exact:true}).click();assert.equal(await dialog.getByText('我的新 iPhone',{exact:true}).count(),1);await dialog.getByText('等待首次连接',{exact:true}).waitFor();await page.getByRole('button',{name:'模拟手机完成连接',exact:true}).click();assert.equal(await dialog.getByText('等待首次连接',{exact:true}).count(),0);
   check('explicit code match grants only one device; approval and actual first connection remain separate states');

   await go('pair-share');await page.getByRole('button',{name:'模拟手机扫码申请',exact:true}).click();await dialog.getByRole('checkbox',{name:'两台设备的验证码一致',exact:true}).check();await page.getByRole('button',{name:'模拟邀请过期',exact:true}).click();await dialog.getByRole('heading',{name:'配对码已过期',exact:true}).waitFor();assert.equal(await dialog.getByRole('button',{name:'允许连接',exact:true}).count(),0);await dialog.getByRole('button',{name:'重新生成配对码',exact:true}).click();await page.getByRole('button',{name:'模拟手机扫码申请',exact:true}).click();assert.equal(await dialog.getByRole('checkbox',{name:'两台设备的验证码一致',exact:true}).isChecked(),false);await dialog.getByRole('button',{name:'拒绝',exact:true}).click();await dialog.getByRole('heading',{name:'已拒绝连接',exact:true}).waitFor();
   check('expired request cannot be approved; regenerated invitation clears prior confirmation; rejection has an explicit outcome');

   await go('pair-share');await page.getByRole('button',{name:'模拟 PC 断线',exact:true}).click();await dialog.getByRole('button',{name:'取消本次配对',exact:true}).click();await dialog.getByRole('heading',{name:'取消结果待核对',exact:true}).waitFor();assert.equal(await dialog.locator('.pairing-qr').count(),0);assert.equal(await dialog.getByRole('button',{name:'核对结果',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'恢复演示连接',exact:true}).click();await dialog.getByRole('button',{name:'核对结果',exact:true}).click();await dialog.getByRole('heading',{name:'Bot 设置',exact:true}).waitFor();
   check('offline cancel hides QR and stays uncertain until reconnection and explicit reconciliation');

   await go('devices');await page.getByRole('checkbox',{name:'模拟撤销回执丢失',exact:true}).check();await dialog.getByRole('button',{name:'撤销 我的 iPhone',exact:true}).click();await dialog.getByRole('button',{name:'撤销访问',exact:true}).click();await dialog.getByText('“我的 iPhone”的撤销结果待核对',{exact:true}).waitFor();assert.equal(await dialog.getByText('访问已撤销',{exact:true}).count(),0);await dialog.getByRole('button',{name:'核对结果',exact:true}).click();await dialog.getByText('访问已撤销',{exact:true}).waitFor();assert.equal(await dialog.getByText('当前设备',{exact:true}).count(),1);
   check('revoke confirms target; unknown receipt keeps the row pending; reconciliation revokes only that device and retains current Mac');

   for(const scene of ['offline','unsupported','limited']){await go(scene);assert.equal(await dialog.getByRole('button',{name:/连接新设备/}).isDisabled(),true);await dialog.getByRole('button',{name:/已连接设备/}).click();assert.equal(await dialog.getByRole('button',{name:'撤销 我的 iPhone',exact:true}).isDisabled(),true);}
   check('offline, old Bot and missing management permission disable pairing and revocation');

   for(const scene of ['pair-share','pair-confirm','devices']){await page.goto(url+'?scene='+scene);await page.locator('.device').waitFor();await page.getByRole('dialog').waitFor();assert.equal(await page.locator('.pc-window').count(),0);}
   check('shared pairing content retains mobile sheet defaults after desktop container injection');
   assert.deepEqual(result.errors,[]);assert.deepEqual(result.external,[]);check('no console errors or external requests; no production IPC or credentials');
  }finally{await context.close();await server.close();}
 }
}finally{await browser.close();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report.modes.map(result=>({mode:result.mode,checks:result.checks.length,errors:result.errors})),null,2));
