// Real Bot files/controller, synthetic native transport and generated sample video.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer, preview} from 'vite';
import {chromium} from 'playwright-core';
import {resourceFixture, wait} from '../apps/mobile/test/resource-fixture.mjs';
import {pdfFixture,xlsxFixture} from './lib/document-fixtures.mjs';
import {installMobileBotEvents} from './lib/mobile-bot-events-fixture.mjs';

const repo=path.resolve(import.meta.dirname,'..'),app=path.join(repo,'apps/mobile'),out=path.join(repo,'.visual/workflow/mobile-preview-drawer');
await fs.mkdir(out,{recursive:true});
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(),workingTree:true,date:new Date().toISOString(),node:process.version,platform:process.platform,command:'node scripts/verify-mobile-preview-drawer.mjs',results:[],gaps:['Physical iOS touch, native system viewers and codecs are not exercised. Workflow cards supply existing summaries, not a new Bot workflow runner.']};
report.sources={};
for(const file of ['apps/mobile/src/app.tsx','apps/mobile/src/preview.ts','apps/mobile/src/components/preview-drawer.tsx','apps/mobile/src/components/task-details-panel.tsx','apps/mobile/src/components/resource-preview.tsx','apps/mobile/src/bot/resource-host.ts','packages/conversation-flow/src/resources/resource-preview.tsx','src/shared/components/document-preview.tsx','src/main/bot/host.mjs'])report.sources[file]=createHash('sha256').update(await fs.readFile(path.join(repo,file))).digest('hex');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
  const media=await browser.newPage();
  const video=Buffer.from(await media.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
    const stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
    const done=new Promise(resolve=>{recorder.ondataavailable=event=>chunks.push(event.data);recorder.onstop=resolve;});
    recorder.start();const ctx=canvas.getContext('2d');ctx.fillStyle='green';ctx.fillRect(0,0,160,90);
    await new Promise(resolve=>setTimeout(resolve,250));recorder.stop();await done;stream.getTracks().forEach(track=>track.stop());
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  }));
  await media.close();
  for(const mode of ['dev','built']) {
    let hold=false,releaseChunk;
    const f=await resourceFixture({additionalFiles:{'扫描件.pdf':await fs.readFile(new URL('./fixtures/documents/scan.pdf',import.meta.url)),'抽屉说明.md':Buffer.from('# 文件内链接\n\n[继续查看空文件](./空文件.txt)'),'预览.pdf':Buffer.from(pdfFixture()),'预览.docx':await fs.readFile(new URL('./fixtures/documents/chinese.docx',import.meta.url)),'预览.xlsx':Buffer.from(xlsxFixture()),'预览.pptx':await fs.readFile(new URL('./fixtures/documents/chinese.pptx',import.meta.url)),'预览.webm':video},onRun:async({spec,apply,work})=>{
      apply({type:'part-appended',runId:spec.runId,generation:spec.generation,part:{partId:'delegation',kind:'delegation',taskId:'drawer-child',toolCallId:'drawer-call',status:'done',args:{agent:'fixer',description:'抽屉子任务'}}});
      apply({type:'task-updated',generation:spec.generation,task:{taskId:'drawer-child',key:'drawer-child',rootRunId:spec.runId,conversationId:spec.conversationId,toolCallId:'drawer-call',agent:'fixer',agentTitle:'执行',taskText:'抽屉子任务',phase:'terminal',outcome:'complete',resultText:'## 手机子任务报告\n\n[报告里的说明](./交付说明.md)',artifacts:[{id:'legacy-file',kind:'file',name:'交付说明.md',path:path.join(work,'交付说明.md')}],conversation:{revision:1,messages:[{id:'child-message',author:'hemi',text:'子任务独立记录',parts:[{type:'text',text:'子任务独立记录'}],createdAt:Date.now()}]}}});
      apply({type:'workflow-card-upserted',generation:spec.generation,at:Date.now(),card:{invocationId:'drawer-workflow',title:'抽屉工作流',status:'completed',values:{subject:'预览测试'},outputs:{result:'流程记录已确认'},nodes:{step:{status:'succeeded',outputs:{proof:'真实卡片步骤输出'}}},completedCount:1,totalCount:1}});
    }});
    await f.call('session.order',{ids:[f.id,f.other]});
    const config={configFile:path.join(app,'vite.config.ts'),root:app,logLevel:'error'},server=mode==='dev'?await createServer({...config,server:{host:'127.0.0.1',port:0}}):await preview({...config,preview:{host:'127.0.0.1',port:0}});
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    const result={mode,checks:[],errors:[],screenshots:[]};report.results.push(result);
    const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};
    try {
      if(mode==='dev')await server.listen();await installMobileBotEvents(context,f.host);
      await context.exposeBinding('__drawerRpc',async(_,{method,params})=>{
        if(hold&&method==='resource.chunk')await new Promise(resolve=>{releaseChunk=resolve;});
        try{return{ok:true,result:await f.host.request(method,params,{clientId:'browser-verification'})};}catch(error){return{ok:false,code:error.code??'failed',message:error.message};}
      });
      await context.addInitScript(target=>{
        window.CapacitorCustomPlatform={name:'ios'};
        window.Capacitor={PluginHeaders:[{name:'HemiBot',methods:['restore','request'].map(name=>({name,rtype:'promise'}))}],async nativePromise(_plugin,method,params){if(method==='restore')return{active:target};const response=await window.__drawerRpc(params);if(!response.ok)throw Object.assign(new Error(response.message),{code:response.code});return response;}};
      },{endpoint:'https://fixture.invalid',botInstanceId:f.instanceId,name:'Drawer verification'});
      const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>result.errors.push(error.message));
      const shot=async name=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const file=path.join(out,mode+'-'+name+'.png');await page.screenshot({path:file,animations:'disabled'});result.screenshots.push(file);};
      const one=async()=>{assert.equal(await page.getByRole('dialog').count(),1);assert.equal(await page.locator('[role="tablist"]:not([aria-label="工作表"])').count(),0);};
      const open=async name=>{await page.locator('.h62-deliverable-card').getByRole('button',{name:'预览 '+name,exact:true}).click();const dialog=page.getByRole('dialog',{name,exact:true});await dialog.waitFor();await one();return dialog;};
      const close=async()=>{await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});};
      await page.goto(server.resolvedUrls.local[0]);await page.getByRole('textbox',{name:'消息',exact:true}).waitFor();
      let dialog=await open('预览.pdf');await dialog.locator('.h-doc-surface[data-ready="true"] canvas').waitFor();await dialog.getByRole('button',{name:'下一页',exact:true}).click();await dialog.getByText('2 / 2',{exact:true}).waitFor();await shot('pdf');await close();
      dialog=await open('预览.docx');await dialog.locator('.h-doc-surface[data-ready="true"] iframe').waitFor();await dialog.frameLocator('iframe').getByText('真实 Word 中文测试',{exact:true}).waitFor();await shot('word');await close();
      dialog=await open('预览.xlsx');await dialog.getByRole('table').waitFor();assert.ok(await dialog.getByRole('cell').count()>0);await shot('spreadsheet');await close();
      dialog=await open('预览.pptx');await dialog.locator('.h-doc-surface[data-ready="true"] iframe').waitFor();await shot('slides');await close();
      check('PDF pages, Word original layout, spreadsheet cells and slides share the PC renderer');
      dialog=await open('扫描件.pdf');await dialog.locator('.h-doc-surface[data-ready="true"] canvas').waitFor();await dialog.getByRole('button',{name:'提取文字',exact:true}).click();await dialog.getByText(/PDF 没有可提取的文字/).waitFor();await close();check('a scan-only PDF still renders its original page when text extraction fails');
      dialog=await open('预览.webm');await wait(()=>dialog.locator('video').evaluate(node=>node.readyState>=1));await shot('video');await close();check('a real generated video plays inline and closes cleanly');
      await page.getByRole('button',{name:/查看执行过程：.*抽屉子任务/}).click();await page.getByRole('dialog',{name:'子任务详情',exact:true}).getByText('子任务独立记录',{exact:true}).waitFor();
      await page.getByRole('button',{name:'查看报告',exact:true}).click();await one();await page.getByRole('dialog',{name:'子任务报告',exact:true}).getByRole('heading',{name:'手机子任务报告',exact:true}).waitFor();await shot('report');
      await page.getByRole('link',{name:'报告里的说明',exact:true}).click();await one();await page.getByRole('dialog').getByRole('heading',{name:'MOBILE_DELIVERY',exact:true}).waitFor();await close();
      await page.getByRole('button',{name:/查看执行过程：.*抽屉子任务/}).click();await page.getByRole('dialog').getByRole('button',{name:'交付说明.md',exact:true}).click();await one();await page.getByRole('dialog').getByRole('heading',{name:'MOBILE_DELIVERY',exact:true}).waitFor();await close();check('task → report → file and task → artifact replace the same drawer without stacked dialogs or tabs');
      dialog=await open('抽屉说明.md');await dialog.getByRole('link',{name:'继续查看空文件',exact:true}).click();await one();await page.getByRole('dialog').getByText('（空文件）',{exact:true}).waitFor();await close();check('local links inside a preview replace its content through the same authorized file path');
      await page.getByRole('button',{name:'查看过程',exact:true}).click();await page.getByRole('dialog',{name:'工作流过程',exact:true}).getByText('真实卡片步骤输出',{exact:true}).waitFor();await one();await shot('workflow');await close();check('workflow summary, inputs, step facts and outputs come from the current conversation card');
      dialog=await open('预览图片.png');await dialog.locator('img.resource-preview-image').waitFor();hold=true;releaseChunk=null;await dialog.getByRole('button',{name:'刷新',exact:true}).click();await wait(()=>!!releaseChunk);await close();dialog=await open('空文件.txt');await dialog.getByText('（空文件）',{exact:true}).waitFor();hold=false;releaseChunk();await page.waitForTimeout(100);await one();assert.equal(await page.getByRole('dialog',{name:'空文件.txt',exact:true}).count(),1);await close();check('a late file read cannot overwrite the next selection');
      for(const width of [375,768,1440]){await page.setViewportSize({width,height:844});dialog=await open('预览.docx');await dialog.locator('.h-doc-surface[data-ready="true"]').waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await shot('drawer-'+width);await close();}
      check('single drawer remains usable at 375, 768 and 1440 widths');assert.deepEqual(result.errors,[]);
    }catch(error){result.error=error.stack;await context.pages()[0]?.screenshot({path:path.join(out,mode+'-failure.png')});throw error;}
    finally{releaseChunk?.();await context.close();await server.close();await f.close();}
  }
}finally{await browser.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
