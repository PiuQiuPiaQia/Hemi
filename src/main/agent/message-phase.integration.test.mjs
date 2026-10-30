import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHemiSession } from './hemi-session.mjs';
import { textFactOf } from '../../shared/message-phase.mjs';
import { reduceTurnParts } from '../../shared/turn-parts.mjs';

test('production Pi Responses adapter: late native phases survive display, session restore and provider history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hemi-native-phase-'));
  const requests = [], sessions = [];
  const server = http.createServer(async (req,res) => {
    let raw=''; for await (const data of req) raw+=data;
    const body=JSON.parse(raw); requests.push(body);
    res.writeHead(200,{'content-type':'text/event-stream'});
    let sequence_number=0;
    const send = event => res.write(`data: ${JSON.stringify({...event,sequence_number:sequence_number++})}\n\n`);
    const output=[];
    send({type:'response.created',response:{id:`resp-${requests.length}`,status:'in_progress',output:[]}});
    for (const [index,phase,text] of [[0,'commentary','**正在检查**'],[1,'partial_answer','中间成果'],[2,'final_answer','**可用答案**\n\n- 保留格式']]) {
      const id=`msg-${requests.length}-${index}`;
      // Phase intentionally absent at start: it is authoritative only on done.
      send({type:'response.output_item.added',output_index:index,item:{type:'message',id,role:'assistant',status:'in_progress',content:[]}});
      send({type:'response.output_text.delta',output_index:index,item_id:id,content_index:0,delta:text});
      const item={type:'message',id,role:'assistant',phase,status:'completed',content:[{type:'output_text',text,annotations:[]}]};
      send({type:'response.output_item.done',output_index:index,item});output.push(item);
    }
    send({type:'response.completed',response:{id:`resp-${requests.length}`,model:'phase-test',status:'completed',output,usage:{input_tokens:30,output_tokens:20,total_tokens:50}}});
    res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const session of sessions)session.dispose();server.closeAllConnections();server.close();fs.rmSync(root,{recursive:true,force:true});});
  const make = entries => {
    const session=createHemiSession({cwd:root,agentDir:root,model:{api:'openai-responses',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'synthetic',model:'phase-test'},tools:[],features:{desktop:false},entries,settings:{retry:{enabled:false}}});
    sessions.push(session);return session;
  };
  const session=make();let parts=[];
  session.on('stream',event=>{const fact=textFactOf(event);if(fact)parts=reduceTurnParts(parts,fact);});
  await session.prompt('测试原生用途');
  assert.deepEqual(parts.map(part=>[part.text,part.phase,part.phaseSource]),[
    ['**正在检查**','commentary','provider'],['中间成果','partial_answer','provider'],['**可用答案**\n\n- 保留格式','final_answer','provider'],
  ]);
  const entries=(await session.exportEntries()).entries;
  const restored=make(entries);
  await restored.prompt('继续测试');
  const history=requests[1].input.filter(item=>item.role==='assistant');
  assert.deepEqual(history.map(item=>item.phase),['commentary','partial_answer','final_answer']);
  assert.deepEqual(history.map(item=>item.content[0].text),parts.map(part=>part.text));
});
