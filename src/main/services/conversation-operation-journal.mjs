import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

/** Durable receipts are separate from the large history file. Pending never authorizes replay. */
export function createConversationOperationJournal({dir}) {
  const active=new Map();
  const file=(id,requestId)=>path.join(dir,createHash('sha256').update(JSON.stringify([id,requestId])).digest('hex')+'.json');
  const read=target=>{try{return JSON.parse(fs.readFileSync(target,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const write=(target,value)=>{fs.mkdirSync(dir,{recursive:true});const tmp=target+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,target);}finally{fs.rmSync(tmp,{force:true});}};
  const unknown={ok:false,code:'unknown',message:'正在核对操作结果，请勿重复提交。'};
  return {
    lookup(id,requestId){const receipt=read(file(id,requestId));return receipt?.state==='done'?receipt.result:null;},
    execute(id,operation,command,run) {
      if(!operation?.requestId)return run();
      const target=file(id,operation.requestId),hash=createHash('sha256').update(JSON.stringify([operation.generation,command])).digest('hex');
      const running=active.get(target);
      if(running)return running.hash===hash?running.work:Promise.resolve({ok:false,code:'conflict'});
      const work=(async()=>{
        const previous=read(target);
        if(previous)return previous.hash!==hash?{ok:false,code:'conflict'}:previous.state==='done'?previous.result:unknown;
        try{write(target,{hash,state:'pending'});}catch{return {ok:false,code:'storage-failed',message:'操作记录未能保存，请重试。'};}
        let result;try{result=await run();}catch{return unknown;}
        try{write(target,{hash,state:'done',result});return result;}catch{return unknown;}
      })().finally(()=>active.delete(target));
      active.set(target,{hash,work});return work;
    },
  };
}
