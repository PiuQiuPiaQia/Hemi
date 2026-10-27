// Isolated provider boundary for real Linux SDK/plugin acceptance. Synthetic data only.
import http from 'node:http';
import {randomUUID} from 'node:crypto';
const traces=[];
http.createServer(async(req,res)=>{
 if(req.method==='GET'&&req.url==='/fixture-state'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(traces));return;}
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),messages=body.messages??[],index=messages.findLastIndex(item=>item.role==='user'),text=JSON.stringify(messages[index]?.content??'');
 const encoded=text.match(/NATIVE_TOOL_([A-Za-z0-9_-]+)/)?.[1],op=encoded?JSON.parse(Buffer.from(encoded,'base64url').toString()):null;
 const tools=messages.slice(index).filter(item=>item.role==='tool'),summary=raw.includes('Review the conversation and extract');
 traces.push({tool:op?.name,mode:op?.args.mode,tools:(body.tools??[]).map(item=>item.function?.name),factPresent:JSON.stringify(messages).includes('LINUX_NATIVE_ONE'),legacyPresent:JSON.stringify(messages).includes('LINUX_LEGACY_MUST_NOT_LOAD'),searchResult:op?.name==='memory_search'&&tools.length?JSON.stringify(tools):null,summary});
 if(text.includes('NATIVE_CRASH_DELAY'))await new Promise(resolve=>setTimeout(resolve,5000));
 else if(text.includes('NATIVE_DELAY'))await new Promise(resolve=>setTimeout(resolve,800));
 if(res.destroyed)return;
 const tool=op&&!summary&&!tools.length&&body.tools?.some(item=>item.function?.name===op.name)?{index:0,id:randomUUID(),type:'function',function:{name:op.name,arguments:JSON.stringify(op.args)}}:null;
 const content=summary?'### Decisions\n- LINUX_NATIVE_SHUTDOWN_SUMMARY\n### Lessons Learned\nNone.\n### Notes\nNone.\n### Follow-ups\nNone.':'OK';
 res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[tool]}:{role:'assistant',content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:10,total_tokens:40}})}\n\ndata: [DONE]\n\n`);
}).listen(3030,'0.0.0.0');
