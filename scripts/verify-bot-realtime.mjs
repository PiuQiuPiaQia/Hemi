// Real Host, Unix socket/CLI, SSH runner, TLS/WSS, native Swift client and Electron renderer.
// Only the SSH executable/network and model executor are isolated fixtures.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';

const exec=promisify(execFile),repo=path.resolve(import.meta.dirname,'..'),root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-realtime-e2e-'));
const evidence=path.join(repo,'.visual/workflow/bot-realtime');await fs.mkdir(evidence,{recursive:true});
process.env.HEMI_BOT_DATA_DIR=path.join(root,'cloud/data');
process.env.HEMI_USER_DATA_DIR=path.join(root,'host-profile');
const {serve}=await import('../src/main/bot/cli.mjs');
const report={date:new Date().toISOString(),commit:(await exec('git',['rev-parse','HEAD'])).stdout.trim(),node:process.version,platform:process.platform+'/'+process.arch,commands:[],checks:[],errors:[],sources:{}};
const wait=async(fn,label)=>{const until=Date.now()+30000;while(!await fn()){if(Date.now()>until)throw new Error('Timed out: '+label);await new Promise(r=>setTimeout(r,50));}};
const read=async file=>fs.readFile(file,'utf8').then(JSON.parse,()=>null);
const check=name=>{report.checks.push(name);console.log('PASS',name);};
let service,app,vite,native,nativeError='';const running=new Map();
try {
  service=await serve({defaultDir:path.join(root,'workspace'),validateModel:async()=>{},executorFactory:()=>({
    run(spec,apply){return new Promise(resolve=>running.set(spec.conversationId,{spec,apply,resolve}));},
    async stop(id){running.get(id)?.resolve({stopped:true});},decide:()=>true,async close(){for(const run of running.values())run.resolve({stopped:true});},
  })});
  const hello=await service.host.request('handshake');
  const request=(method,params={})=>service.host.request(method,{instanceId:hello.instanceId,requestId:randomUUID(),...params},{clientId:'verification'});
  await request('model.sync',{models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fake',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'TEST_ONLY'}]});
  const port=net.createServer();await new Promise(r=>port.listen(0,'127.0.0.1',r));const endpoint=`https://127.0.0.1:${port.address().port}`;await new Promise(r=>port.close(r));
  await request('pairing.configure',{endpoint});
  const binary=path.join(root,'native-client');
  await exec('xcrun',['swiftc','-parse-as-library',path.join(repo,'apps/mobile/ios/App/App/HemiDeviceClient.swift'),path.join(repo,'apps/mobile/test/NativeRealtimeIntegration.swift'),'-o',binary],{timeout:60000});
  report.commands.push('xcrun swiftc HemiDeviceClient.swift NativeRealtimeIntegration.swift');
  const cli=path.join(repo,'src/main/bot/cli.mjs'),wrapper=path.join(root,'ssh.mjs');
  await fs.writeFile(wrapper,`#!${process.execPath}\nimport{spawn}from'node:child_process';if(process.argv.includes('-O'))process.exit(0);const command=process.argv.at(-1);if(!command.includes('cli.mjs'))process.exit(1);let body='';for await(const chunk of process.stdin)body+=chunk;const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},command.endsWith(' watch')?'watch':'rpc'],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(process.env.HEMI_BOT_DATA_DIR)}},stdio:['pipe','pipe','inherit']});child.stdin.end(body);child.stdout.pipe(process.stdout);child.on('close',code=>process.exit(code??1));`,{mode:0o700});
  if(!process.argv.includes('--native-only')){vite=await createServer({configFile:path.join(repo,'vite.config.ts'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});await vite.listen();}
  for(const mode of process.argv.includes('--native-only')?['native']:['dev','built']) {
    const {id}=await request('session.create'),folder=path.join(root,mode);await fs.mkdir(folder);
    const invitation=await request('pairing.create');await fs.writeFile(path.join(folder,'invite.json'),invitation.qr);await fs.writeFile(path.join(folder,'options.json'),JSON.stringify({id}));
    nativeError='';native=spawn(binary,[folder],{stdio:['ignore','ignore','pipe']});native.stderr.on('data',chunk=>nativeError+=chunk);
    await wait(async()=>{if(native.exitCode!==null)throw new Error(nativeError);return !!await read(path.join(folder,'request.json'));},'native pairing');
    const state=await request('pairing.status'),pending=state.invitation.request;
    await request('pairing.approve',{operationId:randomUUID(),inviteId:state.invitation.inviteId,deviceRequestId:pending.requestId,deviceId:pending.deviceId,code:pending.code});
    await fs.writeFile(path.join(folder,'approved'),'');
    await wait(async()=>{if(native.exitCode!==null)throw new Error(nativeError);return (await read(path.join(folder,'frames.json'))??[]).some(f=>f.type==='ready');},'pinned native WSS ready');
    check(mode+': native pinned TLS + ES256 WSS authentication and initial snapshot');
    const profile=path.join(folder,'profile');await fs.mkdir(path.join(profile,'bot'),{recursive:true});
    await fs.writeFile(path.join(profile,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
    await fs.writeFile(path.join(profile,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
    await fs.writeFile(path.join(profile,'bot/connection.json'),JSON.stringify({host:'isolated-realtime',instanceId:hello.instanceId,protocol:hello.protocol,version:hello.version,home:root,dataDir:process.env.HEMI_BOT_DATA_DIR,boundAt:Date.now()}));
    let page;
    async function launch() {
      const env={...process.env,HEMI_USER_DATA_DIR:profile,HEMI_SSH_BIN:wrapper,HEMI_TEST_MIC_GRANT:'1'};if(mode==='dev')env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];else delete env.VITE_DEV_SERVER_URL;
      app=await _electron.launch({executablePath:electronPath,args:['.'],cwd:repo,env});
      await wait(()=>{page=app.windows().find(p=>/^(file|http):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode'));return !!page;},'Electron window');
      page.setDefaultTimeout(15000);
      page.on('pageerror',error=>report.errors.push(mode+': '+error.message));
      await page.getByRole('button',{name:'Bot',exact:true}).click();
      await wait(async()=>(await page.evaluate(()=>window.hemiVoice.bot.getState())).online,'SSH initial refresh');
      await page.evaluate(id=>window.hemiVoice.bot.command('session.open',{id}),id);
    }
    if(mode!=='native')await launch();
    await request('flow.command',{id,command:{type:'send',input:{inputId:'first-'+mode,text:'持续运行验证'}}});await wait(()=>running.has(id),'Host executor');
    const run=running.get(id),fact=(type,extra)=>run.apply({type,runId:run.spec.runId,generation:run.spec.generation,...extra});
    fact('part-appended',{part:{partId:'output',kind:'text',content:'实时同步第一段-'+mode}});
    await wait(async()=>(await read(path.join(folder,'frames.json'))??[]).some(f=>JSON.stringify(f).includes('实时同步第一段-'+mode)),'native output');
    if(page)await page.getByText('实时同步第一段-'+mode,{exact:false}).first().waitFor();
    await fs.writeFile(path.join(folder,'send'),'');await wait(async()=>!!await read(path.join(folder,'sent.json')),'native send');
    assert.equal((await read(path.join(folder,'sent.json'))).result.ok,true);
    if(page){await page.getByText('原生手机排队消息',{exact:true}).first().waitFor();check(mode+': native queue operation reaches actual SSH/IPC renderer');}
    fact('part-updated',{partId:'output',patch:{content:'实时同步持续输出🙂-'+mode}});
    await wait(async()=>(await read(path.join(folder,'frames.json'))??[]).some(f=>JSON.stringify(f).includes('实时同步持续输出🙂-'+mode)),'native streaming update');
    if(page)await page.getByText('实时同步持续输出🙂-'+mode,{exact:false}).first().waitFor();
    check(mode+': incremental message output reaches both transports');
    await fs.writeFile(path.join(folder,'reconnect'),'');await wait(async()=>!!await read(path.join(folder,'disconnected.json')),'native disconnect');
    fact('part-updated',{partId:'output',patch:{content:'断线期间生成的完整回复-'+mode}});
    await fs.writeFile(path.join(folder,'resume'),'');await wait(async()=>(await read(path.join(folder,'frames.json'))??[]).some(f=>f.type==='reset'&&JSON.stringify(f).includes('断线期间生成的完整回复-'+mode)),'native reconnect snapshot');
    check(mode+': native disconnect/reconnect restores latest output and accepted queue');
    if(page){app.process().kill('SIGKILL');await app.close();app=null;await launch();await page.getByText('断线期间生成的完整回复-'+mode,{exact:false}).first().waitFor();await page.getByText('原生手机排队消息',{exact:true}).first().waitFor();await page.screenshot({path:path.join(evidence,mode+'.png')});check(mode+': desktop restart restores output/queue without duplicate input');app.process().kill('SIGKILL');await app.close();app=null;}
    assert.equal((await request('flow.snapshot',{id})).pending.filter(i=>i.inputId==='native-queue-'+id).length,1);
    await fs.writeFile(path.join(folder,'finish'),'');await wait(()=>native.exitCode!==null,'native exit');assert.equal(native.exitCode,0,nativeError);native=null;
    await request('flow.command',{id,command:{type:'stop',targetRunId:run.spec.runId}});
  }
  assert.deepEqual(report.errors,[]);
} finally {
  native?.kill();if(app){app.process().kill('SIGKILL');await app.close();}await vite?.close();await service?.close();
  for(const name of ['src/main/bot/event-stream.mjs','src/main/bot/host.mjs','src/main/bot/device-gateway.mjs','src/main/bot/desktop-service.mjs','src/main/bot/transport.mjs','src/main/bot/cli.mjs','apps/mobile/ios/App/App/HemiDeviceClient.swift','apps/mobile/src/bot/realtime.ts'])report.sources[name]=createHash('sha256').update(await fs.readFile(path.join(repo,name))).digest('hex');
  await fs.writeFile(path.join(evidence,'report'+(process.argv.includes('--native-only')?'-native':'')+'.json'),JSON.stringify(report,null,2));
  await fs.rm(root,{recursive:true,force:true});
}
