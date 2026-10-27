import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHemiSession} from './hemi-session.mjs';

// Real SDK provider encoders/parsers and original plugin; external HTTP only is synthetic.
function stream(res,api,text){
 res.writeHead(200,{'content-type':'text/event-stream'});
 const send=(type,value)=>res.write(`${type?`event: ${type}\n`:''}data: ${JSON.stringify(value)}\n\n`);
 if(api==='anthropic-messages'){
  send('message_start',{type:'message_start',message:{id:'fixture',type:'message',role:'assistant',model:'native-fixture',content:[],usage:{input_tokens:20,output_tokens:0}}});
  send('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}});
  send('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text}});
  send('content_block_stop',{type:'content_block_stop',index:0});
  send('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}});
  send('message_stop',{type:'message_stop'});
 }else if(api==='openai-responses'){
  const item={type:'message',id:'msg-fixture',status:'completed',role:'assistant',content:[{type:'output_text',text,annotations:[]}]};
  send('response.created',{type:'response.created',response:{id:'response-fixture',model:'native-fixture',status:'in_progress',output:[]}});
  send('response.output_item.added',{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}});
  send('response.content_part.added',{type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  send('response.output_text.delta',{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text});
  send('response.output_item.done',{type:'response.output_item.done',output_index:0,item});
  send('response.completed',{type:'response.completed',response:{id:'response-fixture',model:'native-fixture',status:'completed',output:[item],usage:{input_tokens:20,output_tokens:10,total_tokens:30}}});

 }else throw Error('Unsupported test provider');
 res.end();
}
for(const api of ['openai-responses','anthropic-messages'])test(`original exit summary resolves SDK model credentials for ${api}`,{timeout:30000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-memory-provider-'));
 const values={PI_MEMORY_DIR:path.join(root,'pi-memory'),PI_MEMORY_QMD_UPDATE:'off',PI_MEMORY_EXIT_SUMMARY:'1',PI_MEMORY_NO_SEARCH:'1',PI_MEMORY_SNAPSHOT:'per-turn'};
 const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
 let summaries=0;const requests=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),summarizing=raw.includes('Review the conversation and extract');
  requests.push({path:req.url,headers:req.headers,body});if(summarizing)summaries++;
  stream(res,api,summarizing?'### Decisions\n- NATIVE_PROVIDER_SUMMARY_PROOF\n### Lessons Learned\nNone.\n### Notes\nNone.\n### Follow-ups\nNone.':'Decision acknowledged.');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const session=createHemiSession({cwd:root,agentDir:path.join(root,'agent'),nativeMemory:true,tools:[],features:{},model:{api,apiKey:'SYNTHETIC_PROVIDER_KEY',model:'native-fixture',baseUrl:`http://127.0.0.1:${server.address().port}`}});
 t.after(async()=>{await session.close('reload');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fs.rm(root,{recursive:true,force:true});});
 for(const prompt of ['First decision','Second decision'])assert.equal((await session.prompt(prompt)).modelError,null);
 await session.close();assert.equal(summaries,1);
 const daily=await fs.readdir(path.join(values.PI_MEMORY_DIR,'daily'));assert.match(await fs.readFile(path.join(values.PI_MEMORY_DIR,'daily',daily[0]),'utf8'),/NATIVE_PROVIDER_SUMMARY_PROOF/);
 const request=requests.at(-1);assert.ok(request.headers.authorization||request.headers['x-api-key']||request.headers['x-goog-api-key']||request.path.includes('key='),'original provider received configured credentials');
});
