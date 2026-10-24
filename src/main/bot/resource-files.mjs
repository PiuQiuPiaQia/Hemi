import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fail} from './storage.mjs';
const CHUNK=1024*1024, MAX=20*1024*1024;
const MIME={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.md':'text/markdown','.txt':'text/plain'};
const version=stat=>createHash('sha256').update(JSON.stringify([stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs])).digest('hex');
/** Authorization is rechecked for every chunk; paths are never accepted as download authority. */
export function createResourceFiles({resolve}) {
  return async function request(method,p) {
    if(!['resource.stat','resource.chunk'].includes(method))fail('不支持的资源操作。','unsupported');
    const file=await resolve(p);
    let handle;
    try {
      handle=await fs.open(file.real,constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=await handle.stat();
      if(!stat.isFile()||stat.size>MAX)fail('文件不可读或超过 20 MB 限制。');
      if(version(stat)!==version(file.stat))fail('文件已变化，请重新打开。','conflict');
      const currentVersion=version(stat);
      if(method==='resource.stat') {
        const digest=createHash('sha256'),buffer=Buffer.alloc(CHUNK);let offset=0;
        while(offset<stat.size){const {bytesRead}=await handle.read(buffer,0,Math.min(CHUNK,stat.size-offset),offset);if(!bytesRead)fail('文件已变化，请重新打开。','conflict');digest.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
        if(version(await handle.stat())!==currentVersion)fail('文件已变化，请重新打开。','conflict');
        const extension=path.extname(file.name).toLowerCase(),mimeType=MIME[extension]??'application/octet-stream';
        return{ok:true,name:file.name,size:stat.size,version:currentVersion,sha256:digest.digest('hex'),mimeType,chunkSize:CHUNK};
      }
      if(p.version!==currentVersion)fail('文件已变化，请重新打开。','conflict');
      if(!Number.isSafeInteger(p.offset)||p.offset<0||p.offset>stat.size||!Number.isSafeInteger(p.length)||p.length<1||p.length>CHUNK)fail('文件分片范围无效。');
      const bytes=Buffer.alloc(Math.min(p.length,stat.size-p.offset));
      const {bytesRead}=await handle.read(bytes,0,bytes.length,p.offset);
      if(bytesRead!==bytes.length||version(await handle.stat())!==currentVersion)fail('文件已变化，请重新打开。','conflict');
      return{ok:true,offset:p.offset,size:bytes.length,version:currentVersion,base64:bytes.toString('base64')};
    }catch(error){if(error.code==='ENOENT')fail('云端文件不存在，可能已被移动或删除。','missing');if(error.code==='ELOOP')fail('文件路径已变化，请重新打开。','conflict');throw error;}
    finally{await handle?.close();}
  };
}
