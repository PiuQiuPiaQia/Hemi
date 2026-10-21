import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULT_APPEARANCE,validPreference} from '../../shared/appearance/schema.mjs';

export function createAppearanceStore({filePath,io=fs,log={warn(){}}}){
  let protectedOriginal=false;
  return {
    async load(){
      let handle;
      try{
        handle=await io.open(filePath,'r');const stat=await handle.stat();
        if(!stat.isFile()||stat.size>4096)return {preference:DEFAULT_APPEARANCE,recovery:{code:'INVALID_CONFIG',requiresBackup:true}};
        const buffer=Buffer.alloc(4097),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
        if(bytesRead>4096)return {preference:DEFAULT_APPEARANCE,recovery:{code:'INVALID_CONFIG',requiresBackup:true}};
        const text=buffer.toString('utf8',0,bytesRead);let value;
        try{value=JSON.parse(text);}catch{return {preference:DEFAULT_APPEARANCE,recovery:{code:'INVALID_CONFIG',requiresBackup:true}};}
        if(!validPreference(value))return {preference:DEFAULT_APPEARANCE,recovery:{code:value?.schemaVersion!==1?'UNSUPPORTED_CONFIG':'INVALID_CONFIG',requiresBackup:true}};
        return {preference:value,recovery:null};
      }catch(error){if(error.code==='ENOENT')return {preference:DEFAULT_APPEARANCE,recovery:null};log.warn('外观配置读取失败，保留原文件');return {preference:DEFAULT_APPEARANCE,recovery:{code:'READ_FAILED',requiresBackup:true}};}finally{await handle?.close().catch(()=>{});}
    },
    async save(preference,recovery){
      if(!validPreference(preference))throw new Error('Invalid appearance preference');
      await io.mkdir(path.dirname(filePath),{recursive:true});
      if(recovery?.requiresBackup&&!protectedOriginal){
        try{await io.copyFile(filePath,`${filePath}.backup-${Date.now()}-${randomUUID()}`,constants.COPYFILE_EXCL);protectedOriginal=true;}
        catch(error){throw Object.assign(new Error('无法备份原外观配置'),{code:'BACKUP_FAILED',cause:error});}
      }
      const temporary=`${filePath}.${process.pid}.${randomUUID()}.tmp`;let handle;
      try{
        handle=await io.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(preference,null,2)+'\n','utf8');await handle.sync();await handle.close();handle=null;
        for(let attempt=0;;attempt++){
          try{await io.rename(temporary,filePath);break;}catch(error){if(process.platform!=='win32'||attempt>=2||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,30*(attempt+1)));}
        }
      }catch(error){await handle?.close().catch(()=>{});await io.unlink(temporary).catch(()=>{});throw error;}
      // rename is the commit point. A directory sync failure cannot undo that commit.
      try{const dir=await io.open(path.dirname(filePath),'r');try{await dir.sync();}finally{await dir.close();}}catch{log.warn('外观已保存；目录同步不可用');}
      protectedOriginal=false;
    },
  };
}
