// Focused regression for the live cold-start handoff. Run against both renderers.
// Each case uses a fresh profile; no personal data or model credentials are loaded.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import electronPath from 'electron';

const runtime=process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {_electron}=await import(await fs.access(runtime).then(()=>pathToFileURL(runtime).href,()=> 'playwright'));
const mode=process.env.VITE_DEV_SERVER_URL?'dev':'built';
// Optional geometry-only capture when another desktop app keeps taking focus.
// This does not validate native focus cancellation; normal runs keep real focus.
const holdFocus=process.env.HEMI_STARTUP_HOLD_FOCUS==='1';
const cases=[
  {name:'blue-wide',skin:'cafe-blue',width:1440},
  {name:'purple-mid',skin:'cafe-purple',width:980},
  {name:'orange-breakpoint',skin:'cafe-orange',width:880},
  {name:'gold-narrow',skin:'cafe-gold',width:768},
  {name:'red-compact',skin:'cafe-red',width:560},
];
const requested=process.argv.slice(2);
assert.ok(requested.every(name=>cases.some(test=>test.name===name)),'Unknown startup case');
const selected=cases.filter(test=>!requested.length||requested.includes(test.name));
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();

for(const test of selected){
  const out=path.resolve(`.visual/workflow/vision/startup-handoff/${mode}/${test.name}`);
  const userData=await fs.mkdtemp(path.join(os.tmpdir(),`hemi-startup-${mode}-`));
  await fs.mkdir(out,{recursive:true});
  await fs.writeFile(path.join(userData,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
  await fs.writeFile(path.join(userData,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:test.skin,mode:'light'}));
  await fs.writeFile(path.join(userData,'window-state.json'),JSON.stringify({version:1,bounds:{x:40,y:40,width:test.width,height:960},maximized:false}));
  const report={mode,commit,node:process.version,platform:`${process.platform}/${process.arch}`,holdFocus,case:test,userData,checks:[],errors:[],screenshots:[]};
  const check=(name,ok,detail)=>{report.checks.push({name,ok,detail});assert.ok(ok,`${test.name}: ${name}: ${JSON.stringify(detail)}`);};
  let app,page;
  try{
    app=await _electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,HEMI_USER_DATA_DIR:userData}});
    page=await app.firstWindow();page.setDefaultTimeout(15000);
    if(holdFocus)await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].isFocused=()=>true;});
    page.on('pageerror',error=>report.errors.push(error.message));
    // Releasing the foreground video intentionally aborts any remaining media request.
    page.on('requestfailed',request=>{const error=request.failure()?.errorText;if(error!=='net::ERR_ABORTED'&&['script','stylesheet','image','media'].includes(request.resourceType()))report.errors.push(`${request.resourceType()}: ${request.url()}: ${error}`);});
    await page.waitForFunction(()=>window.hemiVoice?.getAppearanceBootstrap?.()?.activity.visible);
    await app.evaluate(({BrowserWindow,app},holdFocus)=>{const win=BrowserWindow.getAllWindows()[0];if(holdFocus)win.emit('focus');else if(!win.isFocused()){app.focus({steal:true});win.focus();}},holdFocus);
    await page.waitForFunction(()=>document.querySelector('.appearance-stage')?.dataset.startup==='intro');
    check('real cold bootstrap uses saved skin',await page.evaluate(skin=>window.hemiVoice.getAppearanceBootstrap().coldStart&&document.documentElement.dataset.skin===skin,test.skin));
    await page.evaluate(()=>{
      const start=performance.now(),samples=[],activity=[];window.__startupHandoffSamples=samples;window.__startupHandoffActivity=activity;
      window.hemiVoice.onAppearanceActivity(value=>activity.push({ms:performance.now()-start,...value}));
      const selectors=['.appearance-app-surface','.app-bar','.text-composer','.theme-home-actor'];
      const frame=()=>{
        const ms=performance.now()-start;
        samples.push({ms,phase:document.querySelector('.appearance-stage')?.dataset.startup,viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],scroll:[scrollX,scrollY],layoutWidth:document.querySelector('.appearance-app-surface').clientWidth,transform:document.querySelector('.appearance-app-surface').style.transform,boxes:selectors.map(selector=>{const r=document.querySelector(selector)?.getBoundingClientRect();return r?[r.x,r.y,r.width,r.height]:null;})});
        if(ms<6600)requestAnimationFrame(frame);
      };requestAnimationFrame(frame);
    });
    for(const [name,ms]of [['expanded',5250],['before-handoff',5800],['after-handoff',6350]]){
      await page.waitForFunction(ms=>window.__startupHandoffSamples.at(-1)?.ms>=ms,ms);
      const file=`${name}.png`;await page.screenshot({path:path.join(out,file),scale:'css'});report.screenshots.push(file);
    }
    await page.waitForFunction(()=>window.__startupHandoffSamples.at(-1)?.ms>=6600);
    const samples=await page.evaluate(()=>window.__startupHandoffSamples);report.samples=samples;
    report.activity=await page.evaluate(()=>window.__startupHandoffActivity);
    check('intro completes naturally',samples.find(sample=>sample.phase==='done')?.ms>=5500,report.activity);
    check('no document overflow throughout intro and handoff',samples.every(sample=>sample.document.every((size,i)=>size<=sample.viewport[i]+1)&&sample.scroll.every(offset=>offset===0)),samples.filter(sample=>sample.document.some((size,i)=>size>sample.viewport[i]+1)).slice(0,2));
    check('layout width stays equal to viewport',samples.every(sample=>sample.layoutWidth===sample.viewport[0]));
    const settled=samples.filter(sample=>sample.transform==='none');
    check('settled UI sampled on both sides of handoff',settled.some(sample=>sample.phase==='intro')&&settled.some(sample=>sample.phase==='done'));
    const final=settled.at(-1);
    const maxShift=Math.max(...settled.flatMap(sample=>sample.boxes.flatMap((box,i)=>box?box.map((value,j)=>Math.abs(value-final.boxes[i][j])):[Infinity])));
    check('expanded UI and character do not jump at handoff',maxShift<.1,{maxShift});
    check('overlay and foreground decoder released',await page.locator('.startup-overlay').count()===0&&await page.locator('video').count()===1);
    check('startup clipping is removed after handoff',await page.locator('.appearance-stage').evaluate(stage=>getComputedStyle(stage).overflow==='visible'));
    await page.locator('textarea.text-composer-input').fill('冷启动交接验证');
    check('real composer accepts input after handoff',await page.locator('textarea.text-composer-input').inputValue()==='冷启动交接验证');
    check('no renderer or asset errors',report.errors.length===0,report.errors);
    console.log('PASS',mode,test.name,`handoff shift ${maxShift}px`);
  }catch(error){report.failure=error.message;if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png'),scale:'css'}).catch(()=>{});throw error;
  }finally{
    if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
    await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  }
}
