// Actual renderer/preload/IPC/runtime and OS commands. Only model replies are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import {processBirth} from '../src/main/agent-runtime/owned-processes.mjs';
import {replyToGoalCheck} from './lib/goal-model-fixture.mjs';
const module=process.env.HEMI_PLAYWRIGHT_MODULE??path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {_electron}=await import(pathToFileURL(module));
const output=path.resolve('.visual/workflow/command-lifecycle');await fs.mkdir(output,{recursive:true});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read){const end=Date.now()+20000;while(!await read()){assert.ok(Date.now()<end,'Desktop lifecycle timed out');await pause(30);}}
const report={date:new Date().toISOString(),results:[]};
try {
  for(const mode of ['dev','built']){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-command-desktop-'))),work=path.join(root,'workspace/default');
    await fs.mkdir(work,{recursive:true});
    await fs.writeFile(path.join(root,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',completedAt:Date.now()}));
    const pids=[],requests=[],errors=[],checks=[];
    for(const kind of ['EXIT','STOP','ESCAPE']){
      const marker=path.join(work,kind+'.pid'),child=path.join(work,kind+'-child.cjs'),parent=path.join(work,kind+'-parent.cjs');pids.push(marker);
      await fs.writeFile(child,`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
      await fs.writeFile(parent,`require('child_process').spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(child)}],{detached:${kind==='ESCAPE'},stdio:'inherit'});setTimeout(()=>process.exit(0),${kind==='EXIT'?1000:100000});`);
    }
    const model=http.createServer(async(req,res)=>{
      let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
      if(replyToGoalCheck(body,res))return;
      const text=JSON.stringify(body.messages),last=JSON.stringify(body.messages.filter(message=>message.role==='user').at(-1));
      const kind=['EXIT','STOP','ESCAPE'].find(kind=>text.includes('LIFECYCLE_'+kind));
      const tool=body.tools?.length&&kind&&!last.includes('QUEUED_NEXT')&&!body.messages.some(message=>message.role==='tool')&&!text.includes('［后台命令完成');
      const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'call-'+requests.length,type:'function',function:{name:'bash',arguments:JSON.stringify({command:`"${process.execPath}" "${path.join(work,kind+'-parent.cjs')}"`,run_in_background:true,yield_ms:20})}}]}:{role:'assistant',content:'LIFECYCLE_RESPONSE'};
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const [value,finish]of [[delta,null],[{},tool?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:value,finish_reason:finish}],...(finish?{usage:{prompt_tokens:20,completion_tokens:10}}:{})})+'\n\n');
      res.end('data: [DONE]\n\n');
    });
    await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
    const baseUrl=`http://127.0.0.1:${model.address().port}/v1`;
    let vite,electron,page;
    const result={mode,checks,errors};report.results.push(result);
    try {
      if(mode==='dev'){vite=await createServer({cacheDir:path.join(root,'vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'});await vite.listen();}
      const env={...process.env,HEMI_USER_DATA_DIR:root,HEMI_TEST_MIC_GRANT:'1',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'fixture'};
      delete env.VITE_DEV_SERVER_URL;if(vite)env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];
      electron=await _electron.launch({executablePath:path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:['.'],env});
      await until(()=>{page=electron.windows().find(page=>/^(http|file):/.test(page.url())&&!new URL(page.url()).searchParams.has('mode'));return page;});
      await page.locator('textarea.text-composer-input').waitFor();
      result.renderer=page.url();result.environment=await electron.evaluate(()=>({node:process.version,electron:process.versions.electron,platform:process.platform,arch:process.arch}));
      page.on('pageerror',error=>errors.push(error.message));
      await page.evaluate(baseUrl=>window.hemiVoice.saveModelProfile({id:'audit',name:'Isolated command lifecycle',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',models:[{id:'main',model:'fixture',thinkingLevel:'off',supportsVision:false}],makeDefault:true}),baseUrl);
      const flow=id=>page.evaluate(id=>window.hemiVoice.flowGetSnapshot(id),id);
      const command=(id,command)=>page.evaluate(({id,command})=>window.hemiVoice.flowCommand(id,command),{id,command});
      for(const kind of ['EXIT','STOP','ESCAPE']){
        const id='conv-command-'+mode+'-'+kind.toLowerCase(),queued='queued-'+kind;
        assert.equal((await page.evaluate(id=>window.hemiVoice.saveConversation({id,turns:[],profileId:'audit/main',workspaceId:'default'}),id)).ok,true);
        assert.equal((await command(id,{type:'send',input:{inputId:'first-'+kind,text:'LIFECYCLE_'+kind,profileId:'audit/main',workspaceId:'default'}})).ok,true);
        await until(async()=>{const snapshot=await flow(id);return snapshot.runs[snapshot.activeRunId]?.activity?.jobs.length;});
        const runId=(await flow(id)).activeRunId;
        await command(id,{type:'send',input:{inputId:queued,text:'QUEUED_NEXT',profileId:'audit/main',workspaceId:'default'}});
        if(kind!=='EXIT'){
          await until(()=>fs.readFile(path.join(work,kind+'.pid'),'utf8').then(()=>true,()=>false));
          await command(id,{type:'promoteInput',inputId:queued});
        }
        await until(async()=>{const snapshot=await flow(id);return snapshot.phase==='idle'&&(kind==='ESCAPE'||snapshot.timeline.some(item=>item.id===queued));});
        const snapshot=await flow(id),deliveries=snapshot.timeline.filter(item=>item.id===queued);
        assert.equal(snapshot.runs[runId].outcome,kind==='EXIT'?'completed':kind==='STOP'?'stopped':'failed');
        if(kind==='ESCAPE'){
          assert.equal(snapshot.queuePaused,true);assert.equal(snapshot.pending[0].inputId,queued);assert.equal(snapshot.pending[0].promoteAt,null);assert.equal(deliveries.length,0);
          assert.ok(snapshot.timeline.some(item=>item.parts?.some(part=>part.kind==='notice'&&part.text.includes('命令'))));
        }else {assert.equal(deliveries.length,1);assert.equal(snapshot.pending.length,0);assert.equal(Object.keys(snapshot.runs).length,2);}
        checks.push(kind+' actual IPC lifecycle and queue result');
      }
      assert.deepEqual(errors,[]);result.modelRequests=requests.length;
    }catch(error){result.error=error.message;throw error;}
    finally {
      for(const marker of pids){const pid=Number(await fs.readFile(marker,'utf8').catch(()=>0));if(pid&&await processBirth(pid).catch(()=>null)){try{process.kill(pid,'SIGKILL');}catch{}}}
      await electron?.close();await vite?.close();model.closeAllConnections();await new Promise(resolve=>model.close(resolve));await fs.rm(root,{recursive:true,force:true});
    }
  }
}finally {await fs.writeFile(path.join(output,'desktop-report.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
