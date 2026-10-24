import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {guessAttachmentKind} from '../composer/attachments.mjs';
import {atomicJson,readJson,privateDirectory,fail} from './storage.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CHUNK=256*1024, HOUR=3600000;

/** Bounded, resumable uploads. Only completed, verified bytes become attachments. */
export function createAttachmentUploads({dataDir,requireSession,register,now=Date.now}) {
  const dir=path.join(dataDir,'attachment-uploads');privateDirectory(dir);
  const index=path.join(dir,'state.json'),state=readJson(index,{uploads:{}});
  const save=()=>atomicJson(index,state);
  const binary=id=>path.join(dir,id+'.part');
  const view=item=>({uploadId:item.uploadId,status:item.status,received:item.received,size:item.size,chunkSize:CHUNK,...(item.attachment?{attachment:item.attachment}:{})});
  function prune() {
    let changed=false;
    for(const [id,item] of Object.entries(state.uploads))if(item.expiresAt<=now()){
      fs.rmSync(binary(id),{force:true});delete state.uploads[id];changed=true;
    }
    if(changed)save();
  }
  return function request(method,p) {
    if(!['begin','chunk','status','complete','cancel'].some(operation=>method==='attachment.upload.'+operation))fail('不支持的附件上传操作。','unsupported');
    requireSession(p.id);prune();
    if(!UUID.test(p.uploadId??''))fail('上传身份无效。');
    let item=state.uploads[p.uploadId];
    if(item&&item.conversationId!==p.id)fail('上传不属于当前会话。','permission');
    if(method==='attachment.upload.begin') {
      const name=path.basename(String(p.name??'')),kind=guessAttachmentKind(name);
      if(!kind||!name||name.length>180||!Number.isSafeInteger(p.size)||p.size<=0||p.size>(kind==='image'?10:20)*1024*1024||!/^[a-f0-9]{64}$/.test(p.sha256??''))fail('文件类型不支持，或超过附件大小限制。');
      if(item){if(item.name!==name||item.size!==p.size||item.sha256!==p.sha256)fail('上传身份已用于其他文件。','conflict');return view(item);}
      const pending=Object.values(state.uploads).filter(x=>x.status==='uploading');
      if(pending.length>=12||pending.filter(x=>x.conversationId===p.id).length>=3)fail('待上传文件过多，请先完成或移除。','busy');
      if(Object.keys(state.uploads).length>=512)fail('上传回执暂满，请稍后重试。','busy');
      item={uploadId:p.uploadId,conversationId:p.id,name,kind,size:p.size,sha256:p.sha256,received:0,status:'uploading',expiresAt:now()+HOUR};
      fs.writeFileSync(binary(p.uploadId),Buffer.alloc(0),{mode:0o600});state.uploads[p.uploadId]=item;save();return view(item);
    }
    if(!item)fail('上传已过期，请重新选择文件。','missing');
    if(method==='attachment.upload.status')return view(item);
    if(method==='attachment.upload.cancel') {
      if(item.status==='done')return view(item);
      item.status='cancelled';item.expiresAt=now()+HOUR;save();fs.rmSync(binary(item.uploadId),{force:true});return view(item);
    }
    if(item.status==='cancelled')fail('上传已取消。','conflict');
    if(item.status==='done')return view(item);
    if(method==='attachment.upload.chunk') {
      if(!Number.isSafeInteger(p.offset)||p.offset<0||typeof p.base64!=='string'||p.base64.length>Math.ceil(CHUNK/3)*4||!p.base64.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(p.base64))fail('上传分片无效。');
      const bytes=Buffer.from(p.base64,'base64');
      if(!bytes.length||bytes.length>CHUNK||bytes.toString('base64')!==p.base64||p.offset+bytes.length>item.size)fail('上传分片大小或编码无效。');
      if(p.offset>item.received)fail('上传进度不一致，请核对后继续。','conflict');
      const fd=fs.openSync(binary(item.uploadId),'r+');
      try {
        // A crash after bytes were written but before metadata commit must not append them twice.
        if(fs.fstatSync(fd).size<item.received)fail('上传暂存文件不完整，请重新上传。','missing');
        fs.ftruncateSync(fd,item.received);
        if(p.offset<item.received){
          if(p.offset+bytes.length>item.received)fail('上传分片范围不一致。','conflict');
          const previous=Buffer.alloc(bytes.length);fs.readSync(fd,previous,0,previous.length,p.offset);
          if(!previous.equals(bytes))fail('已上传分片内容不同。','conflict');
        }else{let written=0;while(written<bytes.length)written+=fs.writeSync(fd,bytes,written,bytes.length-written,item.received+written);fs.fsyncSync(fd);const previous=item.received;item.received+=bytes.length;try{save();}catch(error){item.received=previous;throw error;}}
      }finally{fs.closeSync(fd);}
      return view(item);
    }
    if(method==='attachment.upload.complete') {
      if(item.received!==item.size)fail('文件尚未上传完整。','conflict');
      const bytes=fs.readFileSync(binary(item.uploadId));
      if(bytes.length!==item.size||createHash('sha256').update(bytes).digest('hex')!==item.sha256)fail('文件校验失败，请重新上传。');
      const attachment=register(item,bytes);
      item.attachment=attachment;item.status='done';item.expiresAt=now()+24*HOUR;save();fs.rmSync(binary(item.uploadId),{force:true});return view(item);
    }
    fail('不支持的附件上传操作。','unsupported');
  };
}
