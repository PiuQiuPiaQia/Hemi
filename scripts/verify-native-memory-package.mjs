// Unpack the actual Bot distribution, npm ci from its lock, and exercise the real Unix RPC service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {buildBotRuntime} from './build-bot-runtime.mjs';
import {rpc} from '../src/main/bot/cli.mjs';
const exec=promisify(execFile),repo=path.resolve(import.meta.dirname,'..');
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-native-package-'))),folder=path.join(root,'bot'),out=path.join(repo,'.visual/workflow/memory-simplified/package');await fs.mkdir(out,{recursive:true});
const report={checks:[],requests:0,errors:[]},children=new Set();let pendingCrash=false;
const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);console.log('PASS',name);};
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);report.requests++;
 const i=body.messages.findLastIndex(message=>message.role==='user'),text=JSON.stringify(body.messages[i]);
 const writing=text.includes('PACKAGE_SAVE')&&!text.includes('Review the conversation and extract'),crashing=text.includes('PACKAGE_CRASH');if(crashing){pendingCrash=true;await new Promise(resolve=>setTimeout(resolve,1500));}
 if(res.destroyed)return;
 const tool=writing&&!body.messages.slice(i).some(message=>message.role==='tool')?{index:0,id:randomUUID(),type:'function',function:{name:'memory_write',arguments:JSON.stringify({target:'long_term',content:'PACKAGE_SHARED_NATIVE_FACT'})}}:null;
 res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[tool]}:{role:'assistant',content:'OK'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const until=async(fn,label)=>{for(let i=0;i<300;i++){const value=await fn().catch(()=>null);if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out '+label);};
async function launch(data){
 const entry=`const {serve}=await import(${JSON.stringify(pathToFileURL(path.join(folder,'src/main/bot/cli.mjs')).href)});const service=await serve({defaultDir:${JSON.stringify(path.join(root,path.basename(data)+'-workspace'))},allowLoopbackModels:true});for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void service.close().then(()=>process.exit(0));});`;
 const child=spawn(process.execPath,['--input-type=module','-e',entry],{cwd:folder,env:{...process.env,HEMI_BOT_DATA_DIR:data,HEMI_BOT_ISOLATED_TEST:'1'},stdio:['ignore','pipe','pipe']});children.add(child);child.once('exit',()=>children.delete(child));
 child.stderr.on('data',chunk=>{report.errors.push(chunk.toString().slice(-1000));});child.stdout.resume();
 const socket=path.join(data,'control.sock');const hello=await until(()=>rpc({method:'handshake'},{socket,timeoutMs:1000}),'packaged Host start');
 const call=(method,params={})=>rpc({method,params:{instanceId:hello.instanceId,requestId:randomUUID(),...params}},{socket,timeoutMs:10000});
 return {child,hello,call,async stop(signal='SIGTERM'){if(child.exitCode!==null||child.signalCode)return;child.kill(signal);await new Promise(resolve=>child.once('exit',resolve));}};
}
try{
 await fs.mkdir(folder);const archive=await buildBotRuntime();await exec('tar',['-xzf',archive,'-C',folder]);
 await exec('npm',['ci','--omit=dev','--no-audit','--no-fund','--workspaces=false'],{cwd:folder,timeout:180000,maxBuffer:1024*1024});check('actual Bot distribution installs only locked production dependencies',true);
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 for(const name of ['index.ts','LICENSE','scripts/postinstall.cjs','package.json','README.md','CHANGELOG.md'])check('packaged official pi-memory byte equality: '+name,hash(await fs.readFile(path.join(folder,'node_modules/pi-memory',name)))===hash(await fs.readFile(path.join(repo,'node_modules/pi-memory',name))));
 check('qmd installer is absent from the Bot distribution',!await fs.stat(path.join(folder,'src/main/agent-runtime/dependencies.mjs')).then(()=>true,()=>false));
 const data=path.join(root,'data');let bot=await launch(data);
 await bot.call('model.sync',{models:[{modelKey:'package/native',providerId:'package',name:'Package',api:'openai-completions',model:'native',apiKey:'SYNTHETIC',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,thinkingLevel:'off'}]});
 const a=await bot.call('session.create'),b=await bot.call('session.create');
 async function send(id,text){return bot.call('flow.command',{id,command:{type:'send',input:{inputId:randomUUID(),text}}});}
 await send(a.id,'PACKAGE_SAVE');
 // Each RPC socket has disconnected after acceptance, while the server continues the model/tool run.
 await until(async()=>{const value=await bot.call('session.open',{id:a.id});return !value.flow.activeRunId&&Object.values(value.flow.runs).length?value:null;},'native packaged write');
 check('server continues accepted native tool run after client socket closes',(await bot.call('agent-environment.read-file',{path:'MEMORY.md'})).text.includes('PACKAGE_SHARED_NATIVE_FACT'));
 await send(b.id,'PACKAGE_CRASH');await until(async()=>pendingCrash,'model inflight');const requests=report.requests;await bot.stop('SIGKILL');
 bot=await launch(data);const recovered=await bot.call('session.open',{id:b.id});
 check('crashed Host recovers interrupted run without automatic replay',!recovered.flow.activeRunId&&report.requests===requests);
 check('native memory survives crash/restart',(await bot.call('agent-environment.read-file',{path:'MEMORY.md'})).text.includes('PACKAGE_SHARED_NATIVE_FACT'));
 await assert.rejects(bot.call('agent-environment.read-file',{path:'../state.json'}));check('packaged RPC rejects arbitrary path',true);
 await bot.stop();
 const separate=await launch(path.join(root,'b'));check('different Bot has an independent empty library',(await separate.call('agent-environment.inspect')).files.length===0);await separate.stop();
 report.ok=true;
}catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
finally{for(const child of children)child.kill('SIGKILL');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
