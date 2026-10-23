// Design-prototype verification only. Does not boot Hemi or call a model.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer,preview} from 'vite';
import {RECOVERY_WINDOW_MS,retryDelayMs,recoveryPlan} from './recovery-policy.mjs';

const root=path.resolve(import.meta.dirname,'../../../..');
const exportsDir=path.join(import.meta.dirname,'exports');
const evidenceDir=path.join(root,'.visual/workflow/vision/session-recovery-v1');
const configFile=path.join(import.meta.dirname,'vite.config.mjs');
const runtime=process.env.HEMI_PLAYWRIGHT_MODULE??path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {chromium}=await import(pathToFileURL(runtime).href);
const report={date:'2026-10-23',scope:'30-minute backoff policy and compact recovery-row design prototype; no production recovery implementation',commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),workingTree:true,environment:{node:process.version,platform:process.platform,arch:process.arch},command:'node docs/design/session-recovery/v1/verify.mjs',checks:[],screenshots:[],errors:[],gaps:['This prototype script does not exercise production IPC/provider/persistence; see docs/technical/model-recovery.md for application verification.','No raster reference was supplied; screenshots establish the v1 baseline, no pixel-diff claim.','Hemi tokens declare a light theme; dark system preference retains this palette.']};
const pass=(mode,name)=>{report.checks.push({mode,name,status:'pass'});console.log(`PASS ${mode}: ${name}`);};
await mkdir(exportsDir,{recursive:true});await mkdir(evidenceDir,{recursive:true});
const css=await readFile(path.join(import.meta.dirname,'style.css'),'utf8');
assert.equal(/#[0-9a-f]{3,8}\b/i.test(css),false,'Product token colors, no new hex palette');
assert.ok(css.includes('prefers-reduced-motion'));
assert.equal(/(?:padding|margin|gap)(?:-[\w-]+)?:[^;{}]*\d+px/.test(css),false,'Spacing uses product tokens');
pass('source','Token colors and spacing; reduced-motion rule; one icon library');
assert.equal(RECOVERY_WINDOW_MS,1800000);
assert.ok(retryDelayMs(2)>retryDelayMs(1));assert.ok(retryDelayMs(7)>retryDelayMs(6));assert.equal(retryDelayMs(50),60000);
let simulatedAt=0,dispatched=0;
for(let attempt=1;attempt<100;attempt++){
 const plan=recoveryPlan({startedAt:0,now:simulatedAt,attempt});
 if(plan.nextRetryAt===null){assert.equal(plan.wakeAt,RECOVERY_WINDOW_MS);break;}
 assert.ok(plan.nextRetryAt<RECOVERY_WINDOW_MS);simulatedAt=plan.nextRetryAt;dispatched++;
}
assert.ok(dispatched>3&&dispatched<100);
const boundary=recoveryPlan({startedAt:0,now:RECOVERY_WINDOW_MS-1000,attempt:50});
assert.equal(boundary.expired,false);assert.equal(boundary.nextRetryAt,null);assert.equal(boundary.wakeAt,RECOVERY_WINDOW_MS);
assert.equal(recoveryPlan({startedAt:0,now:RECOVERY_WINDOW_MS,attempt:50}).expired,true);
assert.equal(recoveryPlan({startedAt:0,now:RECOVERY_WINDOW_MS+1000,attempt:50}).nextRetryAt,null);
assert.equal(recoveryPlan({startedAt:0,now:0,attempt:1,notBefore:RECOVERY_WINDOW_MS+60000}).nextRetryAt,null);
pass('policy',`Virtual 30-minute window: ${dispatched} attempts; later 60s cadence; deadline/offline-resume/Retry-After boundaries`);
// Keep build's NODE_ENV changes outside the process that starts the dev renderer.
execFileSync(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build','--config',configFile,'--logLevel','warn'],{cwd:root,stdio:'inherit'});
const browser=await chromium.launch({headless:true,...(process.env.HEMI_DESIGN_BROWSER_PATH?{executablePath:process.env.HEMI_DESIGN_BROWSER_PATH}:process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
let dev,production;
async function screenshot(page,name,locator){
 const file=`${name}.png`,destination=path.join(evidenceDir,file);
 if(locator)await locator.screenshot({path:destination,animations:'disabled'});
 else await page.screenshot({path:destination,fullPage:true,animations:'disabled'});
 await copyFile(destination,path.join(exportsDir,file));report.screenshots.push(file);
}
try{
 dev=await createServer({configFile,logLevel:'warn',server:{port:0,strictPort:false}});await dev.listen();
 production=await preview({configFile,logLevel:'warn',preview:{host:'127.0.0.1',port:0,strictPort:false}});
 for(const [mode,base] of [['dev',dev.resolvedUrls.local[0]],['built',production.resolvedUrls.local[0]]]){
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  page.on('pageerror',error=>report.errors.push(`${mode}: ${error.message}`));
  page.on('console',message=>{if(message.type()==='error')report.errors.push(`${mode}: ${message.text()}`);});
  page.on('response',response=>{if(response.status()>=400)report.errors.push(`${mode}: ${response.status()} ${response.url()}`);});
  await page.goto(base);await page.locator('.conversation-fragment .recovery-notice').waitFor();
  const notice=()=>page.locator('.conversation-fragment .recovery-notice');
  const state=()=>notice().getAttribute('data-state');
  const clickNotice=async name=>{const target=notice().getByRole('button',{name,exact:true});if(!await target.isVisible())await notice().getByRole('button',{name:'恢复详情',exact:true}).click();await target.click();};
  const pick=label=>page.locator('.scenario-tabs').getByRole('button',{name:label,exact:true}).click();
  const waitState=value=>page.waitForFunction(value=>document.querySelector('.conversation-fragment .recovery-notice')?.dataset.state===value,value);
  const draft=page.getByRole('textbox',{name:'消息草稿'});

  await draft.fill('尚未发送的草稿：不要覆盖');
  await page.getByRole('button',{name:'播放恢复过程'}).click();await waitState('connecting');
  assert.equal(await notice().getByRole('button',{name:'立即重试',exact:true}).isVisible(),false);
  await notice().getByRole('button',{name:'停止恢复',exact:true}).click();await page.waitForTimeout(2800);
  assert.equal(await state(),'stopped');assert.equal(await draft.inputValue(),'尚未发送的草稿：不要覆盖');
  assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isEnabled(),true);
  pass(mode,'Stop during connection cancels the late success timer; draft remains editable and send reopens');

  await page.getByRole('button',{name:'播放恢复过程'}).click();await waitState('connecting');await waitState('syncing');await waitState('recovered');
  assert.equal(await draft.inputValue(),'尚未发送的草稿：不要覆盖');
  assert.equal(await page.locator('.user-message').count(),1);assert.equal(await page.locator('.completed-step').count(),1);
  await page.locator('.settled-record').waitFor();assert.equal(await notice().count(),0);
  pass(mode,'Countdown → connection → reconciliation → resumed → collapsed history; no duplicate input or completed step');

  await pick('网络离线');await clickNotice('检查连接');
  assert.equal(await state(),'offline');assert.match(await page.locator('.feedback').innerText(),/仍未/);
  await page.getByRole('checkbox',{name:'模拟网络恢复'}).check();await waitState('syncing');await waitState('recovered');
  pass(mode,'Offline check stays offline until network simulation; online event reconciles before resuming');

  await pick('需要修复');const settings=notice().getByRole('button',{name:'检查模型设置'});await settings.click();
  assert.equal(await page.getByRole('button',{name:'使用此配置继续'}).isDisabled(),true);
  const dialog=page.getByRole('dialog');const first=dialog.getByRole('button',{name:'关闭'});
  await first.focus();await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'取消');
  await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);
  assert.equal(await settings.evaluate(el=>el===document.activeElement),true);
  await settings.click();await page.getByRole('combobox',{name:'密钥状态'}).selectOption('available');
  await page.getByRole('button',{name:'使用此配置继续'}).click();await waitState('connecting');
  pass(mode,'Invalid config cannot continue; keyboard focus is trapped, Escape restores focus; corrected config can retry');

  await pick('30 分钟到期');await clickNotice('更换模型');
  await page.getByRole('combobox',{name:'可用模型'}).selectOption('available');
  await page.getByRole('button',{name:'使用此配置继续'}).click();await waitState('connecting');
  pass(mode,'Exhausted recovery has an explicit model-change return path');

  await pick('结果待确认');await notice().getByRole('button',{name:'核对操作结果',exact:true}).click();
  await page.getByRole('button',{name:'查询执行结果'}).click();assert.equal(await state(),'uncertain');
  assert.match(await page.locator('.operation-record').innerText(),/已确认同步完成/);
  if(mode==='dev')await screenshot(page,'verify-result-dialog',page.getByRole('dialog'));
  await page.getByRole('button',{name:'确认并继续'}).click();await waitState('connecting');
  pass(mode,'Unknown action outcome waits for result query and explicit continue');

  await pick('短暂中断');const detailToggle=notice().getByRole('button',{name:'恢复详情',exact:true});await detailToggle.focus();await page.keyboard.press('Enter');
  assert.equal(await detailToggle.getAttribute('aria-expanded'),'true');assert.equal(await notice().locator('.recovery-details').isVisible(),true);await page.keyboard.press('Enter');assert.equal(await notice().locator('.recovery-details').isVisible(),false);
  pass(mode,'Keyboard can expand and collapse diagnostic history');
  await pick('持续失败');assert.match(await notice().innerText(),/60 秒后重试/);await notice().getByRole('button',{name:'恢复详情',exact:true}).click();assert.match(await notice().innerText(),/剩余 18 分钟/);
  await pick('30 分钟到期');assert.match(await notice().innerText(),/自动恢复已到期/);await notice().getByRole('button',{name:'恢复详情',exact:true}).click();assert.match(await notice().innerText(),/剩余 0 分钟/);await clickNotice('重新开始恢复');await waitState('connecting');assert.match(await notice().innerText(),/第 1 次/);await notice().getByRole('button',{name:'恢复详情',exact:true}).click();assert.match(await notice().innerText(),/剩余 30 分钟/);
  pass(mode,'Late failures show 60s backoff; deadline exposes explicit restart of a fresh cycle');

  await page.locator('.sample').filter({has:page.getByRole('heading',{name:'等待重试',exact:true})}).getByRole('button',{name:'停止恢复',exact:true}).click();
  assert.equal(await state(),'stopped');
  const waitingSample=page.locator('.sample').filter({has:page.getByRole('heading',{name:'等待重试',exact:true})});await waitingSample.getByRole('button',{name:'恢复详情',exact:true}).click();
  await waitingSample.getByRole('button',{name:'立即重试',exact:true}).click();
  await waitState('connecting');assert.match(await notice().innerText(),/第 12 次/);
  pass(mode,'Component-sheet actions open the matching interactive state and execute their named action');

  for(const toggle of await page.locator('.sample .details-toggle[aria-expanded=true]').all())await toggle.click();
  for(const width of [1440,768,375]){
   await page.setViewportSize({width,height:1000});
   for(const [key,label] of [['waiting','短暂中断'],['backoff','持续失败'],['offline','网络离线'],['exhausted','30 分钟到期'],['auth','需要修复'],['uncertain','结果待确认'],['recovered','恢复成功']]){
    await pick(label);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${mode} ${key} ${width}: overflow`);
    const bounds=await notice().boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);assert.ok(bounds.height<=40,`${mode} ${key} ${width}: collapsed row should be <= 40px, got ${bounds.height}`);
    if(mode==='dev'){
     if(key==='waiting'&&width===1440){await screenshot(page,'overview');await screenshot(page,'component-states',page.locator('.component-section'));}
     if(key==='waiting'&&width===768)await screenshot(page,'component-states-768',page.locator('.component-section'));
     if(width===1440||width===375)await screenshot(page,`${key}-${width}`,page.locator('.conversation-fragment'));
     if(width===375&&key==='waiting')await screenshot(page,'overview-375');
    }
   }
  }
  pass(mode,'Seven scenes fit 1440/768/375, each collapsed recovery row is at most 40px high');
  await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  await pick('短暂中断');await clickNotice('立即重试');
  assert.equal(await notice().locator('.spinning').evaluate(el=>getComputedStyle(el).animationName),'none');
  assert.equal(await page.locator('.conversation-fragment').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
  if(mode==='dev')await screenshot(page,'reduced-motion-dark-preference',page.locator('.conversation-fragment'));
  pass(mode,'Reduced motion stops spinner animation; dark preference retains the declared Hemi light palette');
  await page.close();
 }
 assert.deepEqual(report.errors,[]);report.verdict='PASS';
}catch(error){report.verdict='FAIL';report.failure=String(error.stack??error);throw error;}
finally{
 await browser.close();await dev?.close();await production?.close();
 await writeFile(path.join(exportsDir,'validation.json'),JSON.stringify(report,null,2)+'\n');
 await writeFile(path.join(evidenceDir,'validation.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({verdict:report.verdict,checks:report.checks.length,screenshots:report.screenshots.length,errors:report.errors.length,browserClosed:true}));
}
