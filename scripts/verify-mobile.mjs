// Verify the shipped connection screen in development and production builds.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer, preview} from 'vite';
import {chromium} from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), app = path.join(root, 'apps/mobile');
const output = path.join(root, '.visual/workflow/mobile-connection');
await fs.mkdir(output, {recursive: true});
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`, sources: {}, results: []};
async function sources(folder) {
 for (const item of await fs.readdir(folder, {withFileTypes: true})) {
  if (item.name.startsWith('.')) continue;
  const file = path.join(folder, item.name);
  if (item.isDirectory()) await sources(file);
  else report.sources[path.relative(root, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
 }
}
await sources(path.join(app, 'src'));
for (const name of ['package.json', 'package-lock.json', 'apps/mobile/package.json', 'scripts/verify-mobile.mjs']) report.sources[name] = createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex');
const browser = await chromium.launch({executablePath: process.env.HEMI_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
try {
 for (const mode of ['dev', 'built']) {
  const options = {configFile: path.join(app, 'vite.config.ts'), root: app, logLevel: 'error'};
  const server = mode === 'dev' ? await createServer({...options, server: {host: '127.0.0.1', port: 0}}) : await preview({...options, preview: {host: '127.0.0.1', port: 0}});
  let context;
  const result = {mode, checks: [], errors: [], external: [], screenshots: []}; report.results.push(result);
  try {
   if (mode === 'dev') await server.listen();
   const url = server.resolvedUrls.local[0];
   context = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true, reducedMotion: 'reduce'});
   const page = await context.newPage(); page.setDefaultTimeout(12000);
   page.on('pageerror', error => result.errors.push(error.message));
   page.on('console', message => {if (message.type() === 'error') result.errors.push(message.text());});
   page.on('request', request => {if (!['blob:', 'data:'].includes(new URL(request.url()).protocol) && new URL(request.url()).origin !== new URL(url).origin) result.external.push(request.url());});
   const check = name => {result.checks.push(name); console.log('PASS', mode, name);};
   const shot = async name => {const file = path.join(output, `${mode}-${name}.png`); await page.screenshot({path: file}); result.screenshots.push(file);};
   const heading = page.getByRole('heading', {name: '连接你的 Bot'});
   await page.goto(url); await heading.waitFor();
   assert.equal(await page.getByRole('button', {name: /演示|模拟/}).count(), 0);
   assert.equal(await page.getByRole('button', {name: '扫码连接 Bot', exact: true}).isDisabled(), true);
   assert.equal(await page.locator('input').count(), 0);
   assert.equal(await page.getByRole('button', {name: '手动连接', exact: true}).isEnabled(), true);
   assert.equal(await page.evaluate(() => typeof window.hemiVoice), 'undefined');
   check('Bot connection is the primary page action; configuration stays off the landing page; no sample entry or simulated connection');

   const manual = page.getByRole('button', {name: '手动连接', exact: true});
   await manual.focus(); await manual.click();
   const manualDialog = page.getByRole('dialog', {name: '手动连接 Bot', exact: true});
   await manualDialog.waitFor();
   assert.equal(await page.locator('.connection-screen').evaluate(el => el.inert), true);
   const invite = manualDialog.getByRole('textbox', {name: '配对码内容', exact: true});
   await invite.fill('invalid invite for privacy check');
   assert.equal(await manualDialog.getByRole('button', {name: '读取配对信息', exact: true}).isDisabled(), true);
   for (const viewport of [{width: 320, height: 568}, {width: 390, height: 844}, {width: 375, height: 480}]) {
    await page.setViewportSize(viewport);
    assert.equal(await manualDialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await manualDialog.getByRole('button', {name: '读取配对信息', exact: true}).scrollIntoViewIfNeeded();
    await shot(`manual-${viewport.width}-${viewport.height}`);
   }
   await page.keyboard.press('Escape'); await manualDialog.waitFor({state: 'hidden'});
   await page.waitForFunction(() => document.activeElement?.textContent === '手动连接');
   assert.equal(await page.locator('.connection-screen').evaluate(el => el.inert), false);
   await manual.click(); await manualDialog.waitFor();
   assert.equal(await invite.inputValue(), '');
   await manualDialog.getByRole('button', {name: '关闭', exact: true}).click();
   await manualDialog.waitFor({state: 'hidden'});
   check('manual sheet accepts one-time invitation text, explains native-only connection, clears closed text and restores focus on short/narrow screens');

   for (const width of [320, 375, 390, 768, 1440]) {
    await page.setViewportSize({width, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await shot(`connect-${width}`);
   }
   await page.setViewportSize({width: 375, height: 480});
   await page.getByRole('button', {name: '开源许可', exact: true}).scrollIntoViewIfNeeded(); await shot('connect-short');
   await page.setViewportSize({width: 390, height: 844});
   await page.emulateMedia({colorScheme: 'dark'});
   assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
   await shot('system-dark'); await page.emulateMedia({colorScheme: 'light'});
   check('compact layout fits 320/375/390/768/1440 and short viewports with declared light appearance');

   const licenses = page.getByRole('button', {name: '开源许可', exact: true});
   await licenses.click(); await page.getByRole('dialog', {name: '开源许可', exact: true}).waitFor();
   assert.equal(await page.locator('.mobile-content').evaluate(el => el.inert), true);
   const notices = await context.request.get(new URL('licenses/notices.txt', url).href);
   assert.equal(notices.status(), 200); assert.match(await notices.text(), /@capacitor\/ios@8\.5\.3/);
   await shot('licenses'); await page.keyboard.press('Escape');
   await page.waitForFunction(() => document.activeElement?.textContent === '开源许可');
   assert.equal(await page.locator('.mobile-content').evaluate(el => el.inert), false);
   check('bundled notices open locally, close with Escape and restore focus');

   await page.evaluate(() => {
    localStorage.setItem('hemi-mobile-demo-v3:enabled', 'true');
    localStorage.setItem('hemi-mobile-demo-v3:catalog', '{old invalid catalog');
    localStorage.setItem('hemi-mobile-demo-v2:draft', 'preserve old local text');
   });
   await page.reload(); await heading.waitFor();
   assert.equal(await page.locator('.conversation-frame, .mobile-composer').count(), 0);
   assert.equal(await page.getByRole('button', {name: /演示|模拟/}).count(), 0);
   assert.equal(await page.evaluate(() => localStorage.getItem('hemi-mobile-demo-v2:draft')), 'preserve old local text');
   check('upgrade ignores old enabled/catalog data without deleting locally entered text');
   const nativeContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
   try {
    await nativeContext.addInitScript(()=>{
     const queued=[];
     const boot=window.__hemiBoot={headings:[],cancelCalls:0,forgetCalls:0,resolveSend:null,resolve(value){queued.splice(0).forEach(item=>item.resolve(value));},reject(){queued.splice(0).forEach(item=>item.reject(new Error('locked test Keychain')));}};
     new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node instanceof Element){if(node.matches('h1'))boot.headings.push(node.textContent);for(const heading of node.querySelectorAll('h1'))boot.headings.push(heading.textContent);}}).observe(document,{childList:true,subtree:true});
     window.CapacitorCustomPlatform={name:'ios'};
     window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request','pairStatus','scan','prepare','pairRequest','cancelPairing','forgetPairing'].map(name=>({name,rtype:'promise'}))}],nativePromise(_plugin,method,options){
      if(method==='restore')return new Promise((resolve,reject)=>queued.push({resolve,reject}));
      if(method==='scan')return Promise.resolve({qr:'synthetic test invitation'});
      if(method==='prepare')return Promise.resolve({endpoint:'https://127.0.0.1:29421',botInstanceId:'11111111-1111-4111-8111-111111111111',name:'Test native bridge'});
      if(method==='pairRequest')return new Promise(resolve=>{boot.resolveSend=resolve;});
      if(method==='cancelPairing'){boot.cancelCalls++;return Promise.reject(Object.assign(new Error('Cancellation result unknown'),{code:'network'}));}
      if(method==='forgetPairing'){boot.forgetCalls++;return Promise.resolve({});}
      if(method==='pairStatus')return boot.cancelCalls?Promise.reject(new Error('Status unreachable in cancellation fixture')):Promise.resolve({status:'pending',code:'123456'});
      if(method==='request')return Promise.resolve({ok:true,result:{instanceId:options.params.instanceId,models:[],sessions:[]}});
      return Promise.reject(new Error('Unexpected test bridge call'));
     }};
    });
    const nativePage=await nativeContext.newPage();nativePage.on('pageerror',error=>result.errors.push(error.message));
    const target={endpoint:'https://127.0.0.1:29421',botInstanceId:'11111111-1111-4111-8111-111111111111',name:'Test native bridge'};
    await nativePage.goto(url);await nativePage.getByText('正在恢复 Bot 连接…',{exact:true}).waitFor();
    await nativePage.waitForTimeout(350);
    assert.equal(await nativePage.getByRole('heading',{name:'连接你的 Bot',exact:true}).count(),0);
    const restoreShot=path.join(output,`${mode}-restoring-390.png`);await nativePage.screenshot({path:restoreShot});result.screenshots.push(restoreShot);
    await nativePage.evaluate(target=>window.__hemiBoot.resolve({active:target}),target);
    await nativePage.getByRole('heading',{name:'还没有对话',exact:true}).waitFor();
    assert.ok(!(await nativePage.evaluate(()=>window.__hemiBoot.headings)).includes('连接你的 Bot'));
    await nativePage.reload();await nativePage.getByText('正在恢复 Bot 连接…',{exact:true}).waitFor();
    await nativePage.evaluate(()=>window.__hemiBoot.reject());await nativePage.getByRole('button',{name:'重试恢复连接',exact:true}).waitFor();
    assert.equal(await nativePage.getByRole('heading',{name:'连接你的 Bot',exact:true}).count(),0);
    await nativePage.getByRole('button',{name:'重试恢复连接',exact:true}).click();await nativePage.getByText('正在恢复 Bot 连接…',{exact:true}).waitFor();
    await nativePage.evaluate(target=>window.__hemiBoot.resolve({pending:target}),target);
    await nativePage.getByRole('heading',{name:'在 PC 上确认',exact:true}).waitFor();
    assert.ok(!(await nativePage.evaluate(()=>window.__hemiBoot.headings)).includes('连接你的 Bot'));
    await nativePage.reload();await nativePage.getByText('正在恢复 Bot 连接…',{exact:true}).waitFor();
    await nativePage.evaluate(()=>window.__hemiBoot.resolve({}));await nativePage.getByRole('heading',{name:'连接你的 Bot',exact:true}).waitFor();
    check('delayed native bridge restore never flashes connection landing for saved or pending identities; locked identity retries in place; empty identity opens landing (mock bridge UI regression)');
    await nativePage.getByRole('button',{name:'扫码连接 Bot',exact:true}).click();await nativePage.getByRole('heading',{name:'确认连接 Bot',exact:true}).waitFor();
    await nativePage.getByRole('button',{name:'申请连接',exact:true}).click();await nativePage.getByRole('button',{name:'正在申请…',exact:true}).waitFor();
    assert.equal(await nativePage.getByRole('button',{name:'取消配对',exact:true}).isEnabled(),true);
    await nativePage.getByRole('button',{name:'取消配对',exact:true}).click();await nativePage.getByRole('button',{name:'退出本机等待',exact:true}).waitFor();
    await nativePage.evaluate(()=>window.__hemiBoot.resolveSend({status:'pending',code:'654321'}));
    await nativePage.getByRole('heading',{name:'核对连接结果',exact:true}).waitFor();
    assert.equal(await nativePage.getByRole('heading',{name:'在 PC 上确认',exact:true}).count(),0);
    await nativePage.getByRole('button',{name:'退出本机等待',exact:true}).click();const exit=nativePage.getByRole('dialog',{name:'退出本机等待？',exact:true});await exit.waitFor();
    assert.match(await exit.innerText(),/不代表 Bot 已取消/);
    await exit.getByRole('button',{name:'移除本机申请',exact:true}).click();await nativePage.getByRole('heading',{name:'连接你的 Bot',exact:true}).waitFor();
    assert.deepEqual(await nativePage.evaluate(()=>({cancel:window.__hemiBoot.cancelCalls,forget:window.__hemiBoot.forgetCalls})),{cancel:1,forget:1});
    check('cancel remains enabled during unresolved request; late reply cannot revive it; explicit local exit explains server uncertainty (mock bridge UI regression)');
   } finally {await nativeContext.close();}
   assert.deepEqual(result.errors, []); assert.deepEqual(result.external, []);
   check('no runtime errors or external requests');
  } finally {await context?.close(); await server.close();}
 }
} finally {await browser.close(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');}
