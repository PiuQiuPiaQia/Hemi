// Real SSH -> Windows Task Scheduler -> Host -> SDK -> cmd.exe -> files.
// Requires a disposable test account with SSH already configured. No model keys.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID, createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createSshRunner} from '../src/main/remote/ssh-runner.mjs';
import {createBotTransport} from '../src/main/bot/transport.mjs';
import {powershellCommand} from '../src/main/bot/windows-transport.mjs';
import {buildBotRuntime} from './build-bot-runtime.mjs';

const target = process.env.HEMI_BOT_TEST_HOST;
if (!target) throw new Error('Set HEMI_BOT_TEST_HOST to a disposable Windows SSH account');
const output = path.resolve('.visual/workflow/windows-bot');
await fs.mkdir(output, {recursive:true});
const local = await fs.mkdtemp(path.join(os.tmpdir(),'hemi-win-verify-'));
const sshBin = process.env.HEMI_BOT_TEST_SSH_BIN || 'ssh';
const runner = createSshRunner({controlDir:path.join(local,'ssh'),sshBin,strictHostKeyChecking:true});
const checks = [], report = {commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,date:new Date().toISOString(),local:`${os.platform()}/${os.arch()}`,node:process.version,checks,sources:{}};
for(const file of ['src/main/bot/transport.mjs','src/main/bot/windows-transport.mjs','src/main/bot/cli.mjs','src/main/bot/host.mjs','src/main/bot/runtime.mjs','src/main/agent/gate/command-execution.mjs','src/main/agent/gate/windows-command-entry.mjs']) report.sources[file]=createHash('sha256').update(await fs.readFile(file)).digest('hex');
const note = name => {checks.push(name);console.log('PASS',name);};
const wait = async (read, timeout=60000) => {const until=Date.now()+timeout;let last;do{try{const value=await read();if(value)return value;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,300));}while(Date.now()<until);throw last??new Error('Windows verification timed out');};
let tunnel, server, transport, hello;
const traces=[];
try {
  const archivePath=await buildBotRuntime();
  transport=createBotTransport({runner,archivePath});
  const info=await transport.probe(target);
  assert.equal(info.platform,'win32');assert.equal(info.arch,'x64');
  if(info.existing && process.env.HEMI_BOT_TEST_REUSE!=='1')throw new Error('Existing Bot found: use a disposable account, or explicitly set HEMI_BOT_TEST_REUSE=1 for an earlier test installation');
  note('真实 Windows SSH、x64、Node 和计划任务环境探测');
  const before=await transport.directory(target,info.home);
  assert.equal(before.path.toLowerCase(),info.home.toLowerCase());
  note('安装前 PowerShell 目录浏览');
  const manifest=JSON.parse(await fs.readFile(archivePath+'.manifest.json','utf8'));
  hello=info.bot?.componentVersion?.build===manifest.build ? info.bot : await transport.install(target,info);
  report.remote={platform:hello.platform,arch:hello.arch,node:hello.node,componentVersion:hello.componentVersion};
  assert.equal(hello.platform,'win32');
  note('真实部署包、Node、npm ci、计划任务与命名管道握手');
  const call=(method,params={})=>transport.rpc(target,method,{instanceId:hello.instanceId,requestId:randomUUID(),...params},{clientId:'windows-verification'});

  server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),messages=body.messages??[],latest=messages.findLastIndex(m=>m.role==='user');
    const text=JSON.stringify(messages[latest]?.content??''),tools=messages.slice(latest+1).filter(m=>m.role==='tool');
    let tool=null,content='OK';
    if(text.includes('WINDOWS_BOT_PROOF')){
      if(!tools.some(m=>m.tool_call_id==='windows-proof-command'))tool={id:'windows-proof-command',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'node -e "setTimeout(()=>require(\'fs\').writeFileSync(\'windows-proof.md\',\'WINDOWS_PROOF_中文\'),1500)"'})}};
      else if(!tools.some(m=>m.tool_call_id==='windows-proof-delivery'))tool={id:'windows-proof-delivery',type:'function',function:{name:'register_delivery',arguments:JSON.stringify({files:[{path:'windows-proof.md',description:'Windows proof'}]})}};
      else content='已完成 Windows 文件交付。';
    }
    traces.push({tool:tool?.function.name,system:messages.filter(m=>m.role==='system').map(m=>m.content)});
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(`data: ${JSON.stringify({id:'windows-fixture',choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[{...tool,index:0}]}:{role:'assistant',content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:10,total_tokens:40}})}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const remotePort=43000+Math.floor(Math.random()*10000);
  tunnel=spawn(sshBin,['-N','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ExitOnForwardFailure=yes','-R',`127.0.0.1:${remotePort}:127.0.0.1:${server.address().port}`,target],{stdio:['ignore','ignore','pipe']});
  let tunnelError='';tunnel.stderr.on('data',chunk=>tunnelError+=chunk);
  await wait(async()=>{if(tunnel.exitCode!==null)throw new Error(tunnelError);const r=await runner.exec({host:target,command:powershellCommand(`$client=New-Object Net.Sockets.TcpClient;try{$client.Connect('127.0.0.1',${remotePort});[Console]::WriteLine('ready')}finally{$client.Dispose()}`),timeoutMs:10000});return r.code===0;});
  const model={modelKey:'windows-test/fixture',providerId:'windows-test',name:'Windows verification fixture',model:'fixture-model',baseUrl:`http://127.0.0.1:${remotePort}/v1`,api:'openai-completions',apiKey:'TEST_ONLY',thinkingLevel:'off'};
  const modelResult=await call('model.sync',{source:'manual',models:[model]});assert.equal(modelResult.results[0].ok,true);
  await call('configure',{defaultModel:model.modelKey});await call('initialize.verify');
  note('真实 SDK 模型请求、工作目录读写与初始化验证');
  const session=await call('session.create');
  const control=await call('session.control',{id:session.id,action:'acquire'});
  let controlEpoch=control.control.epoch;
  const watchAbort=new AbortController(),frames=[];
  const watching=transport.watch(target,{instanceId:hello.instanceId,id:session.id},{signal:watchAbort.signal,clientId:'windows-verification',onEvent:frame=>frames.push(frame)});
  await call('flow.command',{id:session.id,controlEpoch,command:{type:'send',input:{inputId:'windows-input-'+randomUUID(),text:'WINDOWS_BOT_PROOF'}}});
  await wait(()=>frames.length>0);watchAbort.abort();await watching;
  note('命名管道、PowerShell 与 SSH 实时事件订阅');
  runner.close();
  const complete=await wait(async()=>{
    const detail=await call('session.open',{id:session.id});
    for(const permission of Object.values(detail.permissions??{}).filter(p=>p.status==='pending'))await call('permission.decide',{id:session.id,controlEpoch,permissionId:permission.id,value:permission.options[0]});
    return detail.flow.phase==='idle' && Object.keys(detail.flow.artifacts).length?detail:null;
  });
  const artifact=Object.values(complete.flow.artifacts)[0];
  const file=await call('file.download',{id:session.id,artifactId:artifact.artifactId});
  assert.equal(Buffer.from(file.base64,'base64').toString(),'WINDOWS_PROOF_中文');
  assert.ok(traces.some(t=>JSON.stringify(t.system).includes('Windows')));
  note('真实 Windows 命令、中文交付文件及控制 SSH 断开后继续工作');

  // A large draft traverses the same staged request path as attachment bytes.
  controlEpoch=(await call('session.control',{id:session.id,action:'acquire'})).control.epoch;
  const large='中文🙂'.repeat(24000);
  await call('session.draft',{id:session.id,controlEpoch,text:large,revision:1,references:[],skills:[],attachmentIds:[]});
  const received=(await call('session.open',{id:session.id})).draft.text;
  assert.equal(received.length,large.length);
  assert.equal(createHash('sha256').update(received).digest('hex'),createHash('sha256').update(large).digest('hex'));
  note('超过 SSH 窗口大小的 UTF-8 请求完整往返');
  const beforeStop=await call('handshake');
  await transport.control(target,'stop');
  await assert.rejects(()=>call('handshake'));
  await transport.control(target,'start');
  const restarted=await call('handshake');assert.equal(restarted.instanceId,beforeStop.instanceId);assert.notEqual(restarted.bootId,beforeStop.bootId);
  assert.ok((await call('session.open',{id:session.id})).flow.timeline.length);
  note('计划任务停止、禁用、重新启用及会话持久化');
  // Remove only the synthetic test session and model; leave the installed Bot stopped.
  const remaining=await call('snapshot');
  for(const item of remaining.sessions.filter(item=>item.modelKey===model.modelKey&&item.title==='WINDOWS_BOT_PROOF'))await call('session.remove',{id:item.id});
  const snapshot=await call('snapshot');
  await call('model.configure',{expectedModelRevision:snapshot.modelConfigRevision,models:[],removeKeys:[model.modelKey],roleModels:{}});
  await runner.exec({host:target,command:powershellCommand("$file=Join-Path $env:USERPROFILE 'hemi-workspace\\windows-proof.md';Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue;[Console]::WriteLine('test file removed')"),timeoutMs:10000});
  await transport.control(target,'stop');
  report.result='passed';
} catch(error){report.result='failed';report.error=error.stack;throw error;}
finally {
  tunnel?.kill('SIGTERM');server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());
  runner.close();await fs.rm(local,{recursive:true,force:true});
  await fs.writeFile(path.join(output,'windows-validation.json'),JSON.stringify(report,null,2));
}
