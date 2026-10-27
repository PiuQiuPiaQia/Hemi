// Actual renderer -> preload/IPC -> updater service -> MacUpdater -> local HTTP.
// Only the final OS handoff is intercepted; signed payloads and staging stay private.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { _electron } from 'playwright-core';
import electronPath from 'electron';

if (process.platform !== 'darwin') throw new Error('This verification needs macOS codesign and MacUpdater.');
const repo = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-updater-rail-'));
const output = path.join(repo, '.visual/workflow/updater-rail');
await fs.mkdir(output, { recursive: true });
const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`, sources: {}, results: [],
  gaps: ['Final detached installer spawn and app.quit are intercepted; no personal installation is replaced.',
    'The current appearance schema supports light mode only. Physical Windows installation is outside this macOS UI check.'] };
for (const name of ['src/renderer/src/windows/voice/update-button.tsx', 'src/renderer/src/windows/voice/lib/use-updater.ts',
  'src/renderer/src/windows/voice/nav-rail.tsx', 'src/renderer/src/windows/voice/about-update-section.tsx', 'src/renderer/src/styles/037-shell.css'])
  report.sources[name] = createHash('sha256').update(await fs.readFile(path.join(repo, name))).digest('hex');
const wait = async (read, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (!await read()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 40)); }
};

const payload = path.join(root, 'payload/Hemi.app/Contents');
await fs.mkdir(path.join(payload, 'MacOS'), { recursive: true });
await fs.mkdir(path.join(payload, 'Resources'), { recursive: true });
await fs.copyFile('/usr/bin/true', path.join(payload, 'MacOS/Hemi'));
await fs.chmod(path.join(payload, 'MacOS/Hemi'), 0o755);
await fs.writeFile(path.join(payload, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.hemi.updater-rail-fixture</string>
<key>CFBundleExecutable</key><string>Hemi</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>99.0.1</string></dict></plist>`);
await fs.writeFile(path.join(payload, 'Resources/download-fixture.bin'), randomBytes(12 * 1024 * 1024));
execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', path.dirname(payload)], { stdio: 'pipe' });
const archive = path.join(root, 'Hemi-99.0.1-arm64-mac.zip');
execFileSync('ditto', ['-c', '-k', '--keepParent', path.dirname(payload), archive]);
const bytes = await fs.readFile(archive), sha512 = createHash('sha512').update(bytes).digest('base64');
let version = '99.0.1', broken = false, downloads = 0, releaseDownload;
let gate = Promise.resolve();
const server = http.createServer(async (request, response) => {
  if (request.url.startsWith('/latest-mac.yml')) {
    if (broken) { response.writeHead(503); response.end('synthetic unavailable'); return; }
    response.end(`version: ${version}\nfiles:\n  - url: Hemi-99.0.1-arm64-mac.zip\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: Hemi-99.0.1-arm64-mac.zip\nsha512: ${sha512}\nreleaseDate: '2026-10-27T00:00:00Z'\n`);
  } else if (request.url.includes('.zip')) {
    downloads++;
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.length });
    for (let offset = 0; offset < bytes.length && !response.destroyed; offset += 256 * 1024) {
      if (offset >= bytes.length / 2) await gate;
      response.write(bytes.subarray(offset, offset + 256 * 1024));
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    response.end();
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let app, vite;
try {
  vite = await createServer({ configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen();
  for (const mode of ['dev', 'built']) {
    version = '99.0.1'; broken = false;
    const work = path.join(root, mode), profile = path.join(work, 'profile');
    await fs.mkdir(profile, { recursive: true });
    await fs.mkdir(path.join(work, 'current'), { recursive: true });
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
    await fs.writeFile(path.join(profile, 'doubao-asr.json'), JSON.stringify({ globalPushToTalkEnabled: false }));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'classic', mode: 'light' }));
    const cacheName = 'hemi-updater-rail-' + randomUUID();
    const config = path.join(work, 'app-update.yml');
    await fs.writeFile(config, `updaterCacheDirName: ${cacheName}\n`);
    const entry = path.join(work, 'entry.mjs');
    await fs.writeFile(entry, `
import {app} from 'electron';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createUpdaterService} from ${JSON.stringify(pathToFileURL(path.join(repo, 'src/main/services/updater.mjs')).href)};
import {getUpdaterService} from ${JSON.stringify(pathToFileURL(path.join(repo, 'src/main/services/update-instance.mjs')).href)};
app.setPath('userData', ${JSON.stringify(profile)});
app.whenReady().then(() => {
  const require = createRequire(${JSON.stringify(path.join(repo, 'package.json'))});
  const {MacUpdater} = require('electron-updater');
  const updater = new MacUpdater(); updater.forceDevUpdateConfig = true; updater.updateConfigPath = ${JSON.stringify(config)};
  const facts = globalThis.__updaterRail = {quits:0,spawns:[],updater};
  const service = createUpdaterService({app:{isPackaged:true,getVersion:()=> '0.2.19',quit:()=>{facts.quits++;}},platform:'darwin',
    feedUrl:${JSON.stringify(origin)},updaterFactory:async()=>updater,homeDir:${JSON.stringify(work)},appBundlePath:${JSON.stringify(path.join(work, 'current/Hemi.app'))},
    execFn:(file,args,options)=>file==='codesign'&&args[0]==='-dv'?'TeamIdentifier=not set':execFileSync(file,args,options),
    spawnFn:(file,args)=>{facts.spawns.push({file,args});return {unref(){}};}});
  facts.service = getUpdaterService();
  Object.assign(facts.service,service,{scheduleStartupCheck:()=>service.scheduleStartupCheck({delayMs:50})});
});
await import(${JSON.stringify(pathToFileURL(path.join(repo, 'src/main/index.mjs')).href)});
`);
    const env = { ...process.env, HEMI_USER_DATA_DIR: profile, HEMI_BOT_AUTO_UPDATE: '0', HEMI_TEST_MIC_GRANT: '1' };
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    const result = { mode, checks: [], errors: [], screenshots: [] }; report.results.push(result);
    const check = name => { result.checks.push(name); console.log('PASS', mode, name); };
    try {
      app = await _electron.launch({ executablePath: electronPath, args: [entry], cwd: repo, env });
      let page;
      await wait(() => { page = app.windows().find(page => /^(http|file):/.test(page.url()) && !new URL(page.url()).searchParams.has('mode')); return !!page; }, 'main window');
      page.on('pageerror', error => result.errors.push(error.message));
      page.setDefaultTimeout(15000);
      const rail = () => page.locator('nav.h24-navrail');
      const update = () => rail().locator('.h24-update-button');
      await rail().getByRole('button', { name: '下载更新', exact: true }).waitFor();
      const before = downloads;
      await page.waitForTimeout(150);
      assert.equal(downloads, before, 'announcing an update must not start a download');
      check('real startup check offers download above skin without downloading automatically');
      const layout = async name => {
        await wait(()=>update().evaluate(button=>{
          const r=button.getBoundingClientRect();
          return [r.x+2,r.right-2].every(x=>button.contains(document.elementFromPoint(x,r.y+r.height/2)));
        }),'update button is not obscured by a moving drawer');
        const geometry = await rail().evaluate(nav => {
          const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom }; };
          return { update:rect(nav.querySelector('.h24-update-button')),skin:rect(nav.querySelector('[aria-label="换肤"]')),
            settings:rect(nav.querySelector('[aria-label="设置"]')),overflow:document.documentElement.scrollWidth>innerWidth,height:innerHeight };
        });
        assert.equal(geometry.update.width,32); assert.equal(geometry.update.height,32);
        assert.ok(geometry.update.bottom<=geometry.skin.y); assert.ok(geometry.skin.bottom<=geometry.settings.y);
        assert.ok(geometry.settings.bottom<=geometry.height); assert.equal(geometry.overflow,false);
        const progress=rail().getByRole('progressbar');
        if(await progress.count())assert.equal(await progress.evaluate(node=>getComputedStyle(node).fontSize),'12px');
        const file=path.join(output,`${mode}-${name}.png`); await page.screenshot({path:file,animations:'disabled'}); result.screenshots.push(file);
        if(name.endsWith('1440')) {
          const corner=path.join(output,`${mode}-${name}-corner.png`);
          const height=await page.evaluate(()=>innerHeight);
          await page.screenshot({path:corner,clip:{x:0,y:height-180,width:240,height:180},animations:'disabled'});
          result.screenshots.push(corner);
        }
      };
      const resize = async width => {
        await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(win=>/^(http|file):/.test(win.webContents.getURL())&&!new URL(win.webContents.getURL()).searchParams.has('mode'));win.setMinimumSize(1,1);win.setContentSize(width,900);},width);
        await page.waitForFunction(width=>innerWidth===width,width);
      };
      await resize(1440); await layout('available-1440');
      broken=true; assert.equal((await page.evaluate(()=>window.hemiVoice.updaterCheck())).ok,false);
      await rail().getByRole('button',{name:'重新检查更新',exact:true}).waitFor();
      assert.match(await update().getAttribute('title'),/更新服务暂时不可用/);
      broken=false; await update().click(); await rail().getByRole('button',{name:'下载更新',exact:true}).waitFor();
      check('real HTTP failure is recoverable from the same rail entry');
      version='0.0.1'; await page.evaluate(()=>window.hemiVoice.updaterCheck());
      await wait(async()=>await update().count()===0,'no-update hides rail entry');
      version='99.0.1'; await page.evaluate(()=>window.hemiVoice.updaterCheck());
      await rail().getByRole('button',{name:'下载更新',exact:true}).waitFor();
      gate=new Promise(resolve=>{releaseDownload=resolve;});
      await update().evaluate(button=>{button.click();button.click();});
      await rail().locator('.h24-update-spinner').waitFor();
      await page.emulateMedia({reducedMotion:'reduce'});
      assert.equal(await rail().locator('.h24-update-spinner').evaluate(node=>getComputedStyle(node).animationName),'none');
      await page.emulateMedia({reducedMotion:'no-preference'});
      await rail().getByRole('progressbar').waitFor();
      assert.equal(downloads,before+1);
      for(const width of [1440,768,375]) {await resize(width);await layout(`downloading-${width}`);}
      check('real MacUpdater download deduplicates clicks; progress is readable and unobscured at all widths, with reduced-motion support');
      await page.emulateMedia({reducedMotion:'reduce'});
      await resize(1440);
      await rail().getByRole('button',{name:'设置',exact:true}).click();
      await page.locator('#settings-about').waitFor();
      await wait(async()=> (await page.locator('#settings-about').innerText()).includes('正在下载'),'settings shares download');
      await rail().getByRole('button',{name:'Bot',exact:true}).click();
      await rail().getByRole('progressbar').waitFor();
      assert.equal(downloads,before+1);
      check('settings and Bot navigation retain the same in-flight download');
      await app.evaluate(()=>{
        const facts=globalThis.__updaterRail,service=facts.service;
        const original=service.getState;
        service.getState=()=>{const captured=original();return new Promise(resolve=>{facts.releaseRead=()=>resolve(captured);});};
        Object.assign(facts,{restoreRead:()=>{service.getState=original;}});
      });
      await page.reload();
      await wait(()=>app.evaluate(()=>typeof globalThis.__updaterRail.releaseRead==='function'),'delayed initial updater read');
      releaseDownload();
      await rail().getByRole('button',{name:'待重启应用更新',exact:true}).waitFor();
      await app.evaluate(()=>{globalThis.__updaterRail.releaseRead();globalThis.__updaterRail.restoreRead();});
      await page.waitForTimeout(100);
      assert.equal(await rail().getByRole('button',{name:'待重启应用更新',exact:true}).count(),1);
      assert.equal(await app.evaluate(()=>globalThis.__updaterRail.quits),0);
      check('completed download survives reload and late initial state, without automatically restarting');
      await layout('downloaded-1440');
      await page.keyboard.press('Tab');
      await update().focus(); await page.keyboard.press('Enter');
      await wait(()=>app.evaluate(()=>globalThis.__updaterRail.quits===1),'explicit install handoff');
      const handoff=await app.evaluate(()=>({quits:globalThis.__updaterRail.quits,spawns:globalThis.__updaterRail.spawns}));
      assert.equal(handoff.spawns.length,1);assert.equal(handoff.spawns[0].file,'/bin/sh');
      assert.ok(handoff.spawns[0].args.every(value=>typeof value==='string'));
      const staged=handoff.spawns[0].args[2];
      assert.match(await fs.readFile(path.join(staged,'Hemi.app/Contents/Info.plist'),'utf8'),/99\.0\.1/);
      await rail().getByRole('button',{name:'正在重启应用更新',exact:true}).waitFor();
      assert.equal(await update().getAttribute('aria-disabled'),'true');
      check('keyboard restart runs actual checksum, extraction and codesign staging once; final OS handoff stays isolated');
      assert.deepEqual(result.errors,[]);
    } finally {
      releaseDownload?.(); await app?.close(); app=null;
      await fs.rm(path.join(os.homedir(),'Library/Caches',cacheName),{recursive:true,force:true});
    }
  }
} finally {
  releaseDownload?.(); await app?.close(); await vite?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  await fs.rm(root,{recursive:true,force:true});
}
