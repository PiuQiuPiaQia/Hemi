import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {createBotHost} from '../../../src/main/bot/host.mjs';
export const wait=async predicate=>{for(let i=0;i<300;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Resource condition timed out');};
export async function resourceFixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-resource-'))),work=path.join(root,'work');
 const files={'交付说明.md':Buffer.from('# MOBILE_DELIVERY\n\n来自真实 Bot 的交付文件。\n\n```js\nconst safe = true;\n```'),'预览图片.png':Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'),'大文件.zip':Buffer.alloc(1200000,72),'空文件.txt':Buffer.alloc(0)};
 const host=await createBotHost({dataDir:path.join(root,'data'),defaultDir:work,validateModel:async()=>{},executorFactory:services=>({run:async(spec,apply)=>{apply({type:'part-appended',runId:spec.runId,generation:spec.generation,part:{partId:'fixture-reply',kind:'text',content:'已生成交付文件。\n\n[正文文件](./普通正文.md)'}});await services.onDelivery(spec,Object.keys(files).map(name=>({path:path.join(work,name)})));return{stopped:false};},stop:async()=>{},close:async()=>{}})});
 for(const[name,bytes]of Object.entries(files))await fs.writeFile(path.join(work,name),bytes);await fs.writeFile(path.join(work,'普通正文.md'),'# BODY_PREVIEW');
 const {instanceId}=await host.request('handshake'),call=(method,params={})=>host.request(method,{instanceId,requestId:randomUUID(),...params});
 await call('model.sync',{models:[{modelKey:'fixture/main',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:'https://example.invalid',apiKey:'NOT_A_CREDENTIAL'}]});
 const {id}=await call('session.create'),other=(await call('session.create')).id;
 await call('flow.command',{id,command:{type:'send',input:{inputId:randomUUID(),text:'登记真实交付文件',attachmentIds:[]}}});await wait(async()=>Object.keys((await call('flow.snapshot',{id})).artifacts).length===4&&(await call('flow.snapshot',{id})).phase==='idle');
 const artifacts=Object.values((await call('flow.snapshot',{id})).artifacts),byName=Object.fromEntries(artifacts.map(item=>[item.name,item.artifactId]));
 return{root,work,host,instanceId,id,other,call,files,byName,async close(){await host.close();await fs.rm(root,{recursive:true,force:true});}};
}
