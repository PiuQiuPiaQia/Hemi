import fs from 'node:fs';
import {readJsonForUpdate, prepareJsonWrite} from '../agent-runtime/journal-storage.mjs';
import {retryingRenameSync} from './rename-retry.mjs';

const rename = retryingRenameSync((from,to)=>fs.renameSync(from,to));
export function jsonFileStamp(file) {
  try {const s=fs.statSync(file);return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
/** Worker prepares bytes; the short compare/rename runs without an await, so
 * synchronous archive writers cannot interleave and lose turns/flow metadata. */
export async function updateJsonRecord(file, apply) {
  for(let attempt=0;attempt<32;attempt++){
    const {record,stamp}=await readJsonForUpdate(file);
    const next=apply(record);
    const tmp=await prepareJsonWrite(file,next);
    try{
      if(jsonFileStamp(file)!==stamp)continue;
      rename(tmp,file);
      return next;
    }finally{try{fs.unlinkSync(tmp);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
  throw Object.assign(new Error('会话档案持续变化，保存将在稍后重试'),{code:'storage-conflict'});
}
