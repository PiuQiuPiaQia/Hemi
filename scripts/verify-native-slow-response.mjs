import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,X509Certificate} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createDeviceCertificate} from '../src/main/bot/device-certificate.mjs';

const exec=promisify(execFile),root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-native-slow-'));
const sourceIndex=process.argv.indexOf('--source');
const source=sourceIndex>=0?process.argv[sourceIndex+1]:'apps/mobile/ios/App/App/HemiDeviceClient.swift';
const certificate=await createDeviceCertificate('127.0.0.1');
const pin=createHash('sha256').update(new X509Certificate(certificate.cert).raw).digest('base64url');
const slow=gzipSync(JSON.stringify({ok:true,result:{text:'大'.repeat(900000)}}));
const oversize=gzipSync(JSON.stringify({ok:true,result:{text:'x'.repeat(41*1024*1024)}}));
let negotiated=true;
const server=https.createServer(certificate,async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  negotiated&&=req.headers['accept-encoding']==='gzip';
  const scenario=JSON.parse(raw).scenario,body=scenario==='slow'?slow:scenario==='oversize'?oversize:Buffer.from('invalid gzip');
  res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip','content-length':body.length});
  if(scenario!=='slow'){res.end(body);return;}
  let offset=0;const size=Math.ceil(body.length/40),timer=setInterval(()=>{const end=Math.min(body.length,offset+size);res.write(body.subarray(offset,end));offset=end;if(offset===body.length){clearInterval(timer);res.end();}},350);
  res.once('close',()=>clearInterval(timer));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const report={date:new Date().toISOString(),node:process.version,source,expectedOldFailure:process.argv.includes('--expect-old-timeout')};
try{
  const binary=path.join(root,'client');
  await exec('xcrun',['swiftc','-parse-as-library',source,'apps/mobile/test/NativeSlowResponseIntegration.swift','-o',binary],{timeout:60000});
  const start=Date.now();
  try{const result=await exec(binary,[`https://127.0.0.1:${server.address().port}`,pin],{timeout:25000,maxBuffer:1024*1024});report.passed=!report.expectedOldFailure&&negotiated;report.ms=Date.now()-start;console.log(result.stdout.trim());}
  catch(error){report.ms=Date.now()-start;report.oldTimeoutReproduced=String(error.stderr).includes('Bot 连接超时');report.passed=report.expectedOldFailure&&report.oldTimeoutReproduced;}
  if(!report.passed)process.exitCode=1;
  console.log(JSON.stringify(report));
}finally{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});
  await fs.mkdir('.visual/workflow/bot-connection-diagnosis',{recursive:true});
  await fs.writeFile('.visual/workflow/bot-connection-diagnosis/native-slow'+(report.expectedOldFailure?'-baseline':'')+'.json',JSON.stringify(report,null,2));
}
