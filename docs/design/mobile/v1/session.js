import {createConversation} from '@hemi/conversation-flow/core';
import {seedSnapshot} from './data';

// Explicit in-page Bot simulator. No SSH, model calls, credentials or real files.
export function createPrototypeSession(id,{storageNamespace='hemi-mobile-design-v1'}={}) {
  let snapshot=seedSnapshot(id,id==='audit'?'running':'conversation'), offline=false, timer=null;
  const receivers=new Set(), lifecycle=new Set(), receipts=new Map();
  const storageKey=`${storageNamespace}:${id}`;
  const publish=()=>{
    snapshot={...snapshot,revision:snapshot.revision+1};
    if(!offline)for(const receive of receivers)receive({kind:'snapshot',snapshot});
  };
  const clear=()=>{if(timer)clearInterval(timer);timer=null;};
  const finish=()=>{
    clear();const runId=snapshot.activeRunId;
    if(!runId)return;
    snapshot={...snapshot,phase:'idle',activeRunId:null,
      runs:{...snapshot.runs,[runId]:{...snapshot.runs[runId],closedAt:Date.now()}},
      timeline:snapshot.timeline.map(item=>item.kind==='assistant'&&item.runId===runId?{...item,parts:item.parts.map(part=>
        part.kind==='thinking'?{...part,endedAt:Date.now()}:part.kind==='tool'?{...part,status:'done'}:part)}:item)};
    publish();drain();
  };
  function begin(input) {
    clear();const runId=crypto.randomUUID(), itemId=`${runId}:answer`;
    snapshot={...snapshot,phase:'running',activeRunId:runId,queuePaused:false,
      pending:snapshot.pending.filter(item=>item.inputId!==input.inputId),
      runs:{...snapshot.runs,[runId]:{startedAt:Date.now(),closedAt:null,inputIds:[input.inputId]}},
      timeline:[...snapshot.timeline,{kind:'user',id:input.inputId,runId,text:input.text,inputSource:'text',attachmentIds:input.attachmentIds??[],acceptedAt:Date.now(),deliveredAt:Date.now()},
        {kind:'assistant',itemId,runId,afterInputId:input.inputId,parts:[{kind:'thinking',partId:`${itemId}-thinking`,content:'正在核对这条任务的上下文。',startedAt:Date.now(),endedAt:null}]}]};
    publish();let cursor=0;
    const answer='收到。我会按这条补充继续整理。\n\n你可以先写下一条消息；当前任务完成后，待发送的内容会依次继续。';
    timer=setInterval(()=>{
      cursor=Math.min(cursor+3,answer.length);
      snapshot={...snapshot,timeline:snapshot.timeline.map(item=>item.kind==='assistant'&&item.itemId===itemId?{...item,parts:[
        {...item.parts[0],endedAt:Date.now()}, {kind:'text',partId:`${itemId}-text`,content:answer.slice(0,cursor)}]}:item)};
      publish();if(cursor===answer.length)finish();
    },100);
  }
  function drain() {if(snapshot.phase==='idle'&&!snapshot.queuePaused&&snapshot.pending[0]?.state==='pending')begin(snapshot.pending[0]);}
  const client=createConversation({scope:{environmentId:'bot:mobile-design',conversationId:id},
    transport:{
      fetchSnapshot:async()=>{if(offline)throw Error('演示连接已断开');return snapshot;},
      subscribe:(_scope,receive)=>{receivers.add(receive);return()=>receivers.delete(receive);},
      lookupOperation:async(_scope,requestId)=>receipts.get(requestId)??null,
      command:async({command,requestId})=>{
        if(offline)throw Error('演示连接已断开');
        if(receipts.has(requestId))return receipts.get(requestId);
        let result={ok:true};
        if(command.type==='send'){
          const input={...command.input,inputId:command.input?.inputId??crypto.randomUUID(),state:'pending',inputSource:'text',editRevision:0,attachmentIds:command.input?.attachmentIds??[]};
          if(snapshot.phase==='idle'&&!snapshot.queuePaused)begin(input);else{snapshot={...snapshot,pending:[...snapshot.pending,input]};publish();}
          result={ok:true,inputId:input.inputId};
        }else if(command.type==='stop'){
          clear();const runId=snapshot.activeRunId;
          snapshot={...snapshot,phase:'idle',activeRunId:null,queuePaused:true,runs:runId?{...snapshot.runs,[runId]:{...snapshot.runs[runId],closedAt:Date.now(),outcome:'stopped'}}:snapshot.runs};publish();
        }else if(command.type==='resumeQueue'){snapshot={...snapshot,queuePaused:false};publish();drain();
        }else if(command.type==='withdrawInput'){snapshot={...snapshot,pending:snapshot.pending.filter(item=>item.inputId!==command.inputId)};publish();
        }else if(command.type==='designEditInput'){snapshot={...snapshot,pending:snapshot.pending.map(item=>item.inputId===command.inputId?{...item,text:command.text,editRevision:item.editRevision+1}:item)};publish();
        }else if(command.type==='rewind'){
          const index=snapshot.timeline.findIndex(item=>item.kind==='user'&&item.id===command.targetInputId);
          if(index<0)return{ok:false,code:'not-found'};
          snapshot={...snapshot,timeline:snapshot.timeline.slice(0,index),generation:snapshot.generation+1,pending:[],phase:'idle',activeRunId:null};begin({...command.input,inputId:crypto.randomUUID()});
        }else return{ok:false,code:'unsupported',message:'本交互稿未展开此操作'};
        receipts.set(requestId,result);return result;
      },
    },
    lifecycle:{subscribe(receive){lifecycle.add(receive);return()=>lifecycle.delete(receive);}},
    storage:{drafts:{load:async()=>JSON.parse(localStorage.getItem(storageKey)??'null'),save:async(_scope,value)=>{localStorage.setItem(storageKey,JSON.stringify(value));return{ok:true};}},
      operations:{load:async()=>JSON.parse(sessionStorage.getItem(storageKey+':operations')??'null'),save:async(_scope,value)=>{sessionStorage.setItem(storageKey+':operations',JSON.stringify(value));}}},
  });
  return {client,finish,dispose(){clear();client.dispose();},setOffline(value){offline=value;for(const receive of lifecycle)receive(value?'offline':'online');},
    async preset(mode){
      clear();offline=false;for(const receive of lifecycle)receive('online');
      snapshot={...seedSnapshot(id,mode),revision:snapshot.revision+1};publish();await client.refresh();
      if(mode==='offline')this.setOffline(true);
    },
    reconcile(){snapshot={...snapshot,pending:snapshot.pending.map(item=>({...item,state:'pending'}))};publish();},
  };
}
