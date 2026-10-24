import type {ConversationClient} from '@hemi/conversation-flow/core';
import type {MessageAttachmentView} from '@hemi/conversation-flow/core';

export type PickedFile = {id: string; name: string; size: number; kind: 'image'|'text'; sha256: string};
export interface MobileFileSource {
  pick(kind: 'photos'|'files', limit: number): Promise<PickedFile[]>;
  read(id: string, offset: number, length: number): Promise<{base64: string; size: number}>;
  remove(id: string): Promise<void>;
}
export type MobileUpload = {id: string; conversationId: string; file: PickedFile; status: 'queued'|'uploading'|'failed'; received: number; error: string};
type Receipt = {uploadId: string; status: 'uploading'|'done'|'cancelled'; received: number; size: number; chunkSize: number; attachment?: MessageAttachmentView};
type Request = <T>(method: string, params: Record<string,unknown>, signal?: AbortSignal)=>Promise<T>;

/** The host owns byte selection; the Bot owns verified attachments; the SDK owns the draft. */
export function createMobileUploads({files, request, getClient, load, save, publish}: {
  files?: MobileFileSource; request: Request; getClient(id: string): ConversationClient;
  load(): MobileUpload[]; save(jobs: MobileUpload[]): void; publish(jobs: MobileUpload[]): void;
}) {
  let closed=false, picking=false, tail=Promise.resolve();
  let jobs: MobileUpload[]=[];
  try {jobs=load().map(job=>({...job,status:'failed',error:'上传已暂停，点重试继续。'}));} catch { /* A corrupt upload list never invalidates SDK drafts. */ }
  const active=new Map<string,{controller: AbortController; done: Promise<void>}>();
  function update() {save(jobs);if(!closed)publish([...jobs]);}
  update();
  async function transfer(job: MobileUpload, signal: AbortSignal) {
    const current=()=>!closed&&!signal.aborted&&jobs.includes(job);
    const params={id:job.conversationId,uploadId:job.id};
    const client=getClient(job.conversationId), release=client.retain();
    try {
      await client.start();signal.throwIfAborted();
      let receipt=await request<Receipt>('attachment.upload.begin',{...params,name:job.file.name,size:job.file.size,sha256:job.file.sha256},signal);
      while(current()&&receipt.status==='uploading'&&receipt.received<job.file.size) {
        job.received=receipt.received;update();
        const length=Math.min(256*1024,receipt.chunkSize,job.file.size-receipt.received);
        if(length<=0)throw new Error('Bot 返回的上传进度无效');
        const chunk=await files!.read(job.file.id,receipt.received,length);signal.throwIfAborted();
        if(chunk.size!==length)throw new Error('本机文件不完整，请移除后重新选择');
        receipt=await request<Receipt>('attachment.upload.chunk',{...params,offset:receipt.received,base64:chunk.base64},signal);
      }
      if(!current())return;
      job.received=receipt.received;update();
      if(receipt.status==='uploading')receipt=await request<Receipt>('attachment.upload.complete',params,signal);
      signal.throwIfAborted();if(!current())return;
      const attachment=receipt.attachment;
      if(receipt.status!=='done'||attachment?.status!=='ready'||attachment.conversationId!==job.conversationId)throw new Error('Bot 未返回有效的附件回执');
      const draft=client.draft.getSnapshot();
      if(!draft.attachments.some(item=>item.attachmentId===attachment.attachmentId)&&draft.attachments.length>=3)throw new Error('草稿已有 3 个附件，请先移除一个后重试');
      client.draft.setAttachments(previous=>previous.some(item=>item.attachmentId===attachment.attachmentId)?previous:[...previous,attachment]);
      await client.flushDraft();
      if(!current()){if(!closed&&!jobs.includes(job)){client.draft.setAttachments(previous=>previous.filter(item=>item.attachmentId!==attachment.attachmentId));await client.flushDraft();}return;}
      jobs=jobs.filter(item=>item!==job);update();await files!.remove(job.file.id).catch(()=>{});
    } finally {release();}
  }
  function enqueue(job: MobileUpload) {
    if(closed||active.has(job.id)||!files)return;
    const controller=new AbortController();job.status='queued';job.error='';update();
    const done=tail.then(async()=>{
      if(closed||controller.signal.aborted||!jobs.includes(job))return;
      job.status='uploading';update();
      try {await transfer(job,controller.signal);}
      catch(error){if(jobs.includes(job)){job.status='failed';job.error=controller.signal.aborted?'上传已暂停，点重试继续。':error instanceof Error?error.message:'上传失败，请重试';update();}}
    }).finally(()=>active.delete(job.id));
    active.set(job.id,{controller,done});tail=done.catch(()=>{});
  }
  return {
    available:!!files,
    async pick(conversationId: string,kind: 'photos'|'files') {
      if(!files)throw new Error('此设备尚不支持原生文件选择');
      if(closed||picking)throw new Error('文件选择器正在使用');
      const client=getClient(conversationId),release=client.retain();picking=true;
      try {
        await client.start();
        const count=()=>client.draft.getSnapshot().attachments.length+jobs.filter(job=>job.conversationId===conversationId).length;
        const limit=3-count();if(limit<=0)throw new Error('每条消息最多 3 个附件');
        const picked=await files.pick(kind,limit);
        if(closed||picked.length+count()>3){await Promise.all(picked.map(file=>files.remove(file.id)));if(!closed)throw new Error('每条消息最多 3 个附件');return;}
        for(const file of picked){
          const job: MobileUpload={id:crypto.randomUUID(),conversationId,file,status:'queued',received:0,error:''};jobs.push(job);enqueue(job);
        }
      } finally {picking=false;release();}
    },
    retry(id: string) {const job=jobs.find(job=>job.id===id);if(job)enqueue(job);},
    async cancel(id: string) {
      const job=jobs.find(job=>job.id===id);if(!job)return;
      const running=active.get(id);running?.controller.abort();jobs=jobs.filter(item=>item!==job);update();
      await running?.done;
      if(!closed)await request('attachment.upload.cancel',{id:job.conversationId,uploadId:id}).catch(()=>{});
      await files?.remove(job.file.id).catch(()=>{});
    },
    dispose(){closed=true;for(const job of jobs){job.status='failed';job.error='上传已暂停，点重试继续。';}update();for(const running of active.values())running.controller.abort();},
  };
}
