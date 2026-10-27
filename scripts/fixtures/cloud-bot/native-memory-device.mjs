// Real signed HTTPS device client, isolated Bot fixture only. No production identity.
import fs from 'node:fs/promises';
import https from 'node:https';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const base='/home/hemi/.local/share/hemi-bot',require=createRequire(base+'/current/package.json');
const {generateKeyPair,exportJWK,importJWK,calculateJwkThumbprint,SignJWT}=await import(pathToFileURL(require.resolve('jose')).href);
const stateFile='/tmp/hemi-native-device-identity.json',mode=process.argv[2],input=JSON.parse(process.argv[3]??'{}');
if(mode==='init'){
 const keys=await generateKeyPair('ES256',{extractable:true}),privateJwk=await exportJWK(keys.privateKey),publicJwk=await exportJWK(keys.publicKey);
 await fs.writeFile(stateFile,JSON.stringify({privateJwk,publicJwk,endpoint:input.endpoint,instanceId:input.instanceId}),{mode:0o600});console.log(JSON.stringify({deviceId:await calculateJwkThumbprint(publicJwk)}));
}else{
 const state=JSON.parse(await fs.readFile(stateFile,'utf8')),ca=await fs.readFile(base+'/data/device-access/tls-cert.pem');
 async function post(route,body){return new Promise((resolve,reject)=>{const raw=Buffer.from(JSON.stringify(body)),request=https.request(state.endpoint+route,{method:'POST',ca,agent:false,headers:{'content-type':'application/json','content-length':raw.length}},response=>{const chunks=[];response.on('data',part=>chunks.push(part));response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}});});request.on('error',reject);request.end(raw);});}
 const route=mode==='apply'?'/v1/pair/request':'/v1/rpc',body=mode==='apply'?input:{method:input.method,params:{instanceId:state.instanceId,...input.params}};
 const challenge=await post('/v1/challenge',{}),payload=JSON.stringify(body),deviceId=await calculateJwkThumbprint(state.publicJwk);
 const proof=await new SignJWT({nonce:challenge.result.nonce,bodyHash:createHash('sha256').update(payload).digest('base64url')}).setProtectedHeader({alg:'ES256',typ:'hemi-device+jwt',jwk:state.publicJwk}).setIssuedAt().setJti(randomUUID()).setIssuer('hemi-device-v1').setSubject(deviceId).setAudience(state.instanceId+':'+route).sign(await importJWK(state.privateJwk,'ES256'));
 console.log(JSON.stringify(await post(route,{payload,proof})));
}
