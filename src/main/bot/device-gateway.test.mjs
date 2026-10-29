import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import {createHash,randomUUID} from 'node:crypto';
import {SignJWT,generateKeyPair,exportJWK,calculateJwkThumbprint} from 'jose';
import WebSocket from 'ws';
import {once} from 'node:events';
import {gunzipSync} from 'node:zlib';
import {createBotHost} from './host.mjs';
import {createDeviceGateway} from './device-gateway.mjs';

const hash = value=>createHash('sha256').update(value).digest('base64url');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function fixture(t,clock) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-devices-'));
  let host=await createBotHost({dataDir:root,defaultDir:path.join(root,'workspace'),validateModel:async()=>{}});
  const hello=await host.request('handshake'), instanceId=hello.instanceId;
  let gateway=clock ? await createDeviceGateway({dataDir:path.join(root,'clock'),instanceId,request:(...args)=>host.request(...args),now:()=>clock.value,listenHost:'127.0.0.1'}) : null;
  const manage=(method,params={})=>gateway ? gateway.management(method,params) : host.request(method,{instanceId,...params});
  const endpoint=`https://127.0.0.1:${await freePort()}`;
  await manage('pairing.configure',{endpoint});
  const cert=await fs.readFile(path.join(root,clock?'clock/device-access/tls-cert.pem':'device-access/tls-cert.pem'));
  async function post(route,body,options={}) {
    return new Promise((resolve,reject)=>{
      const raw=Buffer.from(JSON.stringify(body)),{splitAt,decodeGzip=false,...requestOptions}=options;
      const request=https.request(endpoint+route,{method:'POST',ca:cert,agent:false,...requestOptions,headers:{'content-type':'application/json','content-length':raw.length,...requestOptions.headers}},response=>{
        const chunks=[];response.on('data',part=>{chunks.push(part);});response.on('end',()=>{try{const bytes=Buffer.concat(chunks);resolve(JSON.parse((decodeGzip&&response.headers['content-encoding']==='gzip'?gunzipSync(bytes):bytes).toString('utf8')));}catch{reject(new Error('Invalid JSON response'));}});
      });request.on('error',reject);
      if(Number.isInteger(splitAt))request.write(raw.subarray(0,splitAt),()=>setTimeout(()=>request.end(raw.subarray(splitAt)),100));
      else request.end(raw);
    });
  }
  const keyPair=await generateKeyPair('ES256'), jwk=await exportJWK(keyPair.publicKey), deviceId=await calculateJwkThumbprint(jwk);
  async function envelope(route,body,pair=keyPair,publicKey=jwk) {
    const challenge=await post('/v1/challenge',{}), payload=JSON.stringify(body);
    const proof=await new SignJWT({nonce:challenge.result.nonce,bodyHash:hash(payload)})
      .setProtectedHeader({alg:'ES256',typ:'hemi-device+jwt',jwk:publicKey}).setIssuedAt(Math.floor((clock?.value??Date.now())/1000)).setJti(randomUUID()).setIssuer('hemi-device-v1').setSubject(await calculateJwkThumbprint(publicKey)).setAudience(`${instanceId}:${route}`).sign(pair.privateKey);
    return {payload,proof};
  }
  const signed=async(route,body,pair,publicKey)=>post(route,await envelope(route,body,pair,publicKey));
  async function invite(){const result=await manage('pairing.create');return JSON.parse(result.qr);}
  async function apply(invite,requestId=randomUUID(),pair,publicKey){return {requestId,...await signed('/v1/pair/request',{inviteId:invite.inviteId,ticket:invite.requestTicket,requestId,name:'My iPhone'},pair,publicKey)};}
  async function approve(invite,params={}){const pending=(await manage('pairing.status',{inviteId:invite.inviteId})).invitation.request;return manage('pairing.approve',{inviteId:invite.inviteId,deviceRequestId:pending.requestId,deviceId:pending.deviceId,code:pending.code,operationId:randomUUID(),...params});}
  t.after(async()=>{await gateway?.close();await host.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,instanceId,endpoint,cert,manage,post,envelope,signed,keyPair,jwk,deviceId,invite,apply,approve,async restart(){await host.close();host=await createBotHost({dataDir:root,defaultDir:path.join(root,'workspace')});}};
}

test('actual TLS gateway: request has no access until exact PC approval, then reads real Host sessions; consumed ticket cannot enroll another key',async t=>{
  const f=await fixture(t), invite=await f.invite();
  assert.equal(invite.endpoint,f.endpoint);assert.equal(invite.expiresAt>Date.now(),true);assert.equal(invite.requestTicket.length,43);
  assert.equal((await f.signed('/v1/rpc',{method:'snapshot',params:{}})).code,'permission');
  const apply=await f.apply(invite);assert.equal(apply.ok,true);assert.match(apply.result.code,/^\d{6}$/);
  await assert.rejects(f.approve(invite,{code:'wrong'}),/变化/);
  assert.equal((await f.signed('/v1/rpc',{method:'snapshot',params:{}})).code,'permission');
  await f.approve(invite);
  assert.equal((await f.signed('/v1/pair/status',{inviteId:invite.inviteId,requestId:apply.requestId})).result.status,'approved');
  const snapshot=await f.signed('/v1/rpc',{method:'snapshot',params:{}});assert.equal(snapshot.result.instanceId,f.instanceId);assert.deepEqual(snapshot.result.sessions,[]);
  assert.equal((await f.signed('/v1/rpc',{method:'models.sync',params:{}})).code,'permission');
  for (const method of ['oauth.prepare','oauth.import','oauth.logout','model.import-newapi','model.import-receipt','model.account-config'])
    assert.equal((await f.signed('/v1/rpc',{method,params:{provider:'openai',credential:{access:'UNTRUSTED'}}})).code,'permission');
  assert.equal((await f.signed('/v1/rpc',{method:'pairing.approve',params:{}})).code,'permission');
  const other=await generateKeyPair('ES256'), otherJwk=await exportJWK(other.publicKey);
  assert.equal((await f.apply(invite,randomUUID(),other,otherJwk)).ok,false);
  const disk=await fs.readFile(path.join(f.root,'device-access/state.json'),'utf8');assert.equal(disk.includes(invite.requestTicket),false);
});

test('actual TLS gateway pins sessions through authenticated RPC and preserves pins after Host restart', async t => {
  const f = await fixture(t), invite = await f.invite(); await f.apply(invite); await f.approve(invite);
  await f.manage('model.sync', {requestId: randomUUID(), models: [{modelKey: 'f/m', providerId: 'f', name: 'Fixture', model: 'fake', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
  const {id} = await f.manage('session.create', {requestId: randomUUID()});
  const rpc = (method, params = {}) => f.signed('/v1/rpc', {method, params: {id, requestId: randomUUID(), ...params}});
  const control = await rpc('session.control', {action: 'takeover'});
  const result = await rpc('session.pin', {pinned: true, controlEpoch: control.result.control.epoch});
  assert.equal(result.result?.session.pinned, true);
  assert.equal((await rpc('snapshot')).result.sessions.find(s => s.id === id).pinned, true);
  await f.restart();
  assert.equal((await rpc('snapshot')).result.sessions.find(s => s.id === id).pinned, true);
  const acquired = await rpc('session.control', {action: 'takeover'});
  assert.equal((await rpc('session.pin', {pinned: false, controlEpoch: acquired.result.control.epoch})).result?.session.pinned, false);
});

test('a fresh gateway creates its certificate and serves verified HTTPS with no external programs on PATH', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-no-openssl-'));
  const gateway = await createDeviceGateway({dataDir:root, instanceId:randomUUID(), request:async()=>({}), listenHost:'127.0.0.1'});
  t.after(async () => {await gateway.close(); await fs.rm(root, {recursive:true, force:true});});
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = path.join(root, 'no-programs');
    const endpoint = `https://127.0.0.1:${await freePort()}`;
    const configured = await gateway.management('pairing.configure', {endpoint});
    assert.equal(configured.enabled, true);
    const cert = await fs.readFile(path.join(root, 'device-access/tls-cert.pem'));
    const response = await new Promise((resolve, reject) => {
      const req = https.request(endpoint + '/v1/challenge', {method:'POST', ca:cert, agent:false, headers:{'content-type':'application/json'}}, res => {
        let body=''; res.on('data', bytes=>{body+=bytes;}); res.on('end',()=>resolve(JSON.parse(body)));
      });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(response.ok, true);
    assert.match(response.result.nonce, /^[A-Za-z0-9_-]+$/);
    if (process.platform !== 'win32') for (const file of ['tls-cert.pem', 'tls-key.pem'])
      assert.equal((await fs.stat(path.join(root, 'device-access', file))).mode & 0o777, 0o600);
  } finally {if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;}
});

test('reconfiguration and restart preserve the certificate and approved device identity', async t => {
  const f = await fixture(t), invite = await f.invite(); await f.apply(invite); await f.approve(invite);
  const dir = path.join(f.root, 'device-access');
  const key = await fs.readFile(path.join(dir, 'tls-key.pem'));
  const before = await f.manage('pairing.status');
  const configured = await f.manage('pairing.configure', {endpoint:f.endpoint});
  assert.equal(configured.fingerprint, before.fingerprint);
  assert.deepEqual(await fs.readFile(path.join(dir, 'tls-cert.pem')), f.cert);
  assert.deepEqual(await fs.readFile(path.join(dir, 'tls-key.pem')), key);
  await f.restart();
  assert.equal((await f.signed('/v1/rpc', {method:'snapshot', params:{}})).ok, true);
  assert.equal((await f.manage('pairing.status')).fingerprint, before.fingerprint);
});

test('actual TLS gateway preserves signed Chinese and emoji across UTF-8 chunk boundaries',async t=>{
  const f=await fixture(t),invite=await f.invite(),requestId=randomUUID();
  const body={inviteId:invite.inviteId,ticket:invite.requestTicket,requestId,name:'手机🙂'};
  const first=await f.signed('/v1/pair/request',body);assert.equal(first.ok,true);
  for(const [text,offset] of [['手',1],['手',2],['🙂',1],['🙂',3]]){
    const envelope=await f.envelope('/v1/pair/request',body),raw=Buffer.from(JSON.stringify(envelope));
    const index=raw.indexOf(Buffer.from(text));assert.ok(index>=0);
    const result=await f.post('/v1/pair/request',envelope,{splitAt:index+offset});
    assert.equal(result.ok,true);assert.equal(result.result.code,first.result.code);
  }
  assert.equal((await f.manage('pairing.status',{inviteId:invite.inviteId})).invitation.request.name,body.name);
});

test('approved mobile device browses actual server directories and updates session thinking, model and workspace through signed TLS RPC',async t=>{
  const f=await fixture(t), workspace=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-device-workspace-')));
  t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
  const project=path.join(workspace,'项目');await fs.mkdir(project);
  await f.manage('model.sync',{requestId:randomUUID(),models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:'https://example.invalid',apiKey:'NOT_A_CREDENTIAL'}]});
  const {id}=await f.manage('session.create',{requestId:randomUUID()});
  const invite=await f.invite();await f.apply(invite);await f.approve(invite);
  const list=await f.signed('/v1/rpc',{method:'directory.list',params:{path:workspace}});assert.equal(list.ok,true);assert.ok(list.result.folders.some(folder=>folder.path===project));
  const update=await f.signed('/v1/rpc',{method:'session.update',params:{id,modelKey:'fixture/model',thinking:'high',dir:project,requestId:randomUUID()}});assert.equal(update.ok,true);
  const opened=await f.signed('/v1/rpc',{method:'session.open',params:{id,activate:false}});assert.equal(opened.result.dir,project);assert.equal(opened.result.thinking,'high');assert.equal(opened.result.modelKey,'fixture/model');
  const snapshot=await f.signed('/v1/rpc',{method:'snapshot',params:{}});assert.ok(snapshot.result.recentDirs.includes(project));assert.equal(snapshot.result.sessions.find(session=>session.id===id).thinking,'high');
  assert.equal((await f.signed('/v1/rpc',{method:'directory.list',params:{path:path.join(workspace,'missing')}})).code,'missing');
  assert.equal((await f.signed('/v1/rpc',{method:'directory.list',params:{path:f.root}})).code,'permission');
});

test('proof rejects replay, changed body, wrong route/audience, origin and unrelated keys; no automatic first-scanner approval',async t=>{
  const f=await fixture(t), invite=await f.invite();
  const body={inviteId:invite.inviteId,ticket:invite.requestTicket,requestId:randomUUID(),name:'iPhone'};
  const envelope=await f.envelope('/v1/pair/request',body);
  assert.equal((await f.post('/v1/pair/request',envelope)).ok,true);
  assert.equal((await f.post('/v1/pair/request',envelope)).code,'permission');
  const changed=await f.envelope('/v1/pair/request',body);changed.payload=JSON.stringify({...body,name:'tampered'});
  assert.equal((await f.post('/v1/pair/request',changed)).code,'permission');
  assert.equal((await f.post('/v1/rpc',await f.envelope('/v1/pair/status',{}))).ok,false);
  assert.equal((await f.post('/v1/challenge',{}, {headers:{origin:'https://attacker.invalid','content-type':'application/json'}})).code,'permission');
  const other=await generateKeyPair('ES256'), jwk=await exportJWK(other.publicKey);
  assert.equal((await f.apply(invite,randomUUID(),other,jwk)).code,'conflict');
  assert.equal((await f.signed('/v1/rpc',{method:'snapshot',params:{}})).code,'permission');
  assert.equal((await f.signed('/v1/pair/status',{inviteId:invite.inviteId,requestId:body.requestId},other,jwk)).code,'permission');
});

test('approval/revocation receipts survive restart; concurrent approval consumes once and revoke blocks reconnect',async t=>{
  const f=await fixture(t), invite=await f.invite();await f.apply(invite);
  const operationId=randomUUID(), result=await Promise.allSettled([f.approve(invite,{operationId}),f.approve(invite,{operationId})]);
  assert.equal(result.every(x=>x.status==='fulfilled'),true);
  assert.deepEqual(result[0].value,result[1].value);
  assert.deepEqual(await f.approve(invite,{operationId,requestId:'new-ssh-transport-id'}),result[0].value);
  await assert.rejects(f.approve(invite),/失效/);
  await f.restart();
  assert.equal((await f.signed('/v1/rpc',{method:'snapshot',params:{}})).ok,true);
  const revoke={deviceId:f.deviceId,operationId:randomUUID()};
  assert.deepEqual(await f.manage('devices.revoke',revoke),await f.manage('devices.revoke',revoke));
  assert.equal((await f.signed('/v1/rpc',{method:'snapshot',params:{}})).code,'permission');
  await f.restart();assert.equal((await f.signed('/v1/rpc',{method:'snapshot',params:{}})).code,'permission');
});

test('server deadline and cancellation invalidate invitations; altered endpoint and malformed identifiers fail safely',async t=>{
  const clock={value:Date.now()}, f=await fixture(t,clock), invite=await f.invite();await f.apply(invite);
  clock.value+=120001;
  await assert.rejects(f.approve(invite),/过期/);
  const next=await f.invite();await f.manage('pairing.cancel',{inviteId:next.inviteId,operationId:randomUUID()});
  assert.equal((await f.apply(next)).code,'permission');
  await assert.rejects(f.manage('pairing.configure',{endpoint:'http://127.0.0.1:3000'}),/HTTPS/);
  await assert.rejects(f.manage('devices.revoke',{deviceId:'__proto__',operationId:randomUUID()}),/不存在/);
  await assert.rejects(f.manage('pairing.cancel',{inviteId:'constructor',operationId:randomUUID()}),/不存在/);
});

test('approved device uploads >1MB through actual signed TLS chunks; completed attachment is registered on Host and revoked devices lose access',async t=>{
  const f=await fixture(t);
  await f.manage('model.sync',{requestId:randomUUID(),models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:'https://example.invalid',apiKey:'NOT_A_CREDENTIAL'}]});
  const {id}=await f.manage('session.create',{requestId:randomUUID()});
  const bytes=Buffer.alloc(1200000,65),uploadId=randomUUID(),params={id,uploadId,name:'mobile-upload.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  const rpc=(operation,extra={})=>f.signed('/v1/rpc',{method:'attachment.upload.'+operation,params:{...params,...extra}});
  assert.equal((await rpc('begin')).code,'permission');
  const invite=await f.invite();await f.apply(invite);await f.approve(invite);
  const begin=await rpc('begin');assert.equal(begin.ok,true);assert.equal(begin.result.chunkSize,256*1024);
  for(let offset=0;offset<bytes.length;offset+=begin.result.chunkSize){const part=await rpc('chunk',{offset,base64:bytes.subarray(offset,offset+begin.result.chunkSize).toString('base64')});assert.equal(part.ok,true);}
  const result=await rpc('complete');assert.equal(result.ok,true);assert.equal(result.result.attachment.name,params.name);
  assert.deepEqual((await rpc('complete')).result,result.result);
  const session=await f.manage('session.open',{id});assert.equal(session.attachments.length,1);
  const stored=JSON.parse(await fs.readFile(path.join(f.root,'state.json'),'utf8'));
  const attachment=stored.sessions[id].attachments[result.result.attachment.attachmentId];assert.deepEqual(await fs.readFile(attachment.path),bytes);
  await f.manage('devices.revoke',{deviceId:f.deviceId,operationId:randomUUID()});assert.equal((await rpc('status')).code,'permission');
});

test('resource stat/chunks use actual signed device TLS, exact attachment bytes and original approval/revocation gates',async t=>{
 const f=await fixture(t);await f.manage('model.sync',{requestId:randomUUID(),models:[{modelKey:'fixture/model',providerId:'fixture',name:'Fixture',model:'fixture',api:'openai-completions',baseUrl:'https://example.invalid',apiKey:'NOT_A_CREDENTIAL'}]});
 const {id}=await f.manage('session.create',{requestId:randomUUID()}),bytes=Buffer.alloc(300000,72),attachment=(await f.manage('attachment.add',{id,requestId:randomUUID(),name:'device-resource.txt',base64:bytes.toString('base64')})).attachment;
 const params={id,kind:'attachment',attachmentId:attachment.attachmentId};const rpc=(method,extra={})=>f.signed('/v1/rpc',{method,params:{...params,...extra}});
 assert.equal((await rpc('resource.stat')).code,'permission');const invite=await f.invite();await f.apply(invite);await f.approve(invite);
 const stat=await rpc('resource.stat');assert.equal(stat.ok,true);assert.equal(stat.result.size,bytes.length);const parts=[];
 for(let offset=0;offset<bytes.length;offset+=stat.result.chunkSize){const chunk=await rpc('resource.chunk',{version:stat.result.version,offset,length:stat.result.chunkSize});assert.equal(chunk.ok,true);parts.push(Buffer.from(chunk.result.base64,'base64'));}
 assert.deepEqual(Buffer.concat(parts),bytes);assert.equal(stat.result.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal((await rpc('resource.chunk',{version:'stale',offset:0,length:1})).code,'conflict');
 await f.manage('devices.revoke',{deviceId:f.deviceId,operationId:randomUUID()});assert.equal((await rpc('resource.stat')).code,'permission');
});


test('actual WSS authenticates device proofs, replays cursors, isolates subscriptions and closes revoked connections',async t=>{
  const f=await fixture(t), invite=await f.invite();await f.apply(invite);await f.approve(invite);
  await f.manage('model.sync',{requestId:randomUUID(),models:[{modelKey:'f/m',providerId:'f',name:'Fixture',model:'fake',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'TEST_ONLY'}]});
  const {id}=await f.manage('session.create',{requestId:randomUUID()});
  const workspace=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hemi-wss-work-')));t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
  await f.manage('session.update',{id,dir:workspace,requestId:randomUUID()});
  const wait=async predicate=>{const end=Date.now()+3000;while(!predicate()){assert.ok(Date.now()<end,'WSS event timed out');await new Promise(r=>setTimeout(r,10));}};
  async function connect(options={}) {
    const envelope=await f.envelope('/v1/events',options), ws=new WebSocket(f.endpoint.replace('https:','wss:')+'/v1/events',{ca:f.cert}),frames=[];
    ws.on('message',data=>frames.push(JSON.parse(data.toString())));ws.on('error',()=>{});t.after(()=>ws.terminate());
    await once(ws,'open');ws.send(JSON.stringify(envelope));await wait(()=>frames.some(f=>f.type==='ready'||f.ok===false));
    return{ws,frames};
  }
  const first=await connect({id});assert.equal(first.frames[0].type,'reset');assert.equal(first.frames[0].snapshot.detail.id,id);assert.equal(JSON.stringify(first.frames).includes('TEST_ONLY'),false);
  const cursor={bootId:first.frames.at(-1).bootId,sequence:first.frames.at(-1).sequence,id};
  first.ws.terminate();await once(first.ws,'close');
  await f.manage('session.rename',{id,title:'断线期间更新',requestId:randomUUID()});
  const second=await connect({id,cursor});assert.ok(second.frames.some(f=>f.type==='catalog'));assert.ok(!second.frames.some(f=>f.type==='reset'));
  const control=await f.signed('/v1/rpc',{method:'session.control',params:{id,action:'takeover'}});assert.equal(control.result?.ok,true);
  const sent=await f.signed('/v1/rpc',{method:'flow.command',params:{id,requestId:randomUUID(),command:{type:'send',input:{inputId:'wss-input',text:'真实推送'}}}});assert.equal(sent.result?.ok,true,JSON.stringify(sent));
  await wait(()=>second.frames.some(f=>f.type==='flow'));assert.ok(second.frames.filter(f=>f.type==='flow').every(f=>f.id===id));
  const closed=once(second.ws,'close');await f.manage('devices.revoke',{deviceId:f.deviceId,operationId:randomUUID()});await closed;
  const rejected=await connect({id});assert.equal(rejected.frames[0].code,'permission');
});


test('large initial WSS snapshots reach ready and remain subscribed', {timeout: 10000}, async t => {
  const f = await fixture(t), invite = await f.invite(); await f.apply(invite); await f.approve(invite);
  await f.manage('model.sync', {requestId: randomUUID(), models: [{modelKey: 'f/m', providerId: 'f', name: 'Fixture', model: 'fake', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
  const {id} = await f.manage('session.create', {requestId: randomUUID()});
  const content = '大'.repeat(800000);
  await f.manage('session.draft', {id, requestId: randomUUID(), revision: 1, references: [{key: 'large-history', title: content}]});
  const proof = await f.envelope('/v1/events', {id});
  const ws = new WebSocket(f.endpoint.replace('https:', 'wss:') + '/v1/events', {ca: f.cert}), frames = [];
  ws.on('error', () => {}); t.after(() => ws.terminate());
  const ready = new Promise((resolve, reject) => {
    ws.on('message', data => {const frame = JSON.parse(data.toString()); frames.push(frame); if (frame.type === 'ready') resolve();});
    ws.once('close', () => reject(new Error('Large snapshot disconnected before ready')));
  });
  await once(ws, 'open'); ws._socket.pause(); ws.send(JSON.stringify(proof));
  const resume = setTimeout(() => ws._socket.resume(), 200); t.after(() => clearTimeout(resume));
  await ready;
  assert.equal(frames[0].snapshot.detail.draft.references[0].title, content);
  await f.manage('session.rename', {id, title: 'still-connected', requestId: randomUUID()});
  const end = Date.now() + 3000;
  while (!frames.some(frame => frame.type === 'catalog')) {assert.ok(Date.now() < end, 'subscription did not remain live'); await new Promise(resolve => setTimeout(resolve, 10));}
  assert.equal(ws.readyState, WebSocket.OPEN);
});

test('gzip is negotiated for authenticated HTTP and WSS snapshots while legacy clients retain JSON', {timeout: 10000}, async t => {
  const f=await fixture(t),invite=await f.invite();await f.apply(invite);await f.approve(invite);
  await f.manage('model.sync',{requestId:randomUUID(),models:[{modelKey:'f/m',providerId:'f',name:'Fixture',model:'fake',api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'TEST_ONLY'}]});
  const {id}=await f.manage('session.create',{requestId:randomUUID()}),content='压缩传输🙂'.repeat(80000);
  await f.manage('session.draft',{id,requestId:randomUUID(),revision:1,references:[{key:'compressed-history',title:content}]});
  const request=await f.envelope('/v1/rpc',{method:'snapshot',params:{id}});
  const response=await f.post('/v1/rpc',request,{headers:{'accept-encoding':'gzip'},decodeGzip:true});
  assert.equal(response.result.detail.draft.references[0].title,content);
  assert.equal((await f.signed('/v1/rpc',{method:'snapshot',params:{id}})).result.detail.draft.references[0].title,content);
  const proof=await f.envelope('/v1/events',{id,compression:'gzip'}),ws=new WebSocket(f.endpoint.replace('https:','wss:')+'/v1/events',{ca:f.cert});
  t.after(()=>ws.terminate());const frames=[];let compressed=false;
  const ready=new Promise((resolve,reject)=>{ws.on('error',reject);ws.on('close',()=>reject(Error('compressed stream closed')));ws.on('message',(bytes,binary)=>{if(binary)compressed=true;const frame=JSON.parse((binary?gunzipSync(bytes):bytes).toString());frames.push(frame);if(frame.type==='ready')resolve();});});
  await once(ws,'open');ws.send(JSON.stringify(proof));await ready;
  assert.equal(compressed,true);assert.equal(frames[0].snapshot.detail.draft.references[0].title,content);
});

test('paired mobile reads only original files from its authenticated Bot',async t=>{
 const f=await fixture(t),invite=await f.invite();await f.apply(invite);await f.approve(invite);
 await fs.mkdir(path.join(f.root,'pi-memory','recovery'),{recursive:true});
 await fs.writeFile(path.join(f.root,'pi-memory','MEMORY.md'),'NATIVE_BOT_SHARED_FILE');
 const inspection=await f.signed('/v1/rpc',{method:'agent-environment.inspect',params:{instanceId:f.instanceId}});
 assert.equal(inspection.ok,true);assert.equal(inspection.result.owner,'Bot');assert.ok(inspection.result.files.some(file=>file.path==='MEMORY.md'));
 const read=await f.signed('/v1/rpc',{method:'agent-environment.read-file',params:{instanceId:f.instanceId,path:'MEMORY.md'}});
 assert.equal(read.result.text,'NATIVE_BOT_SHARED_FILE');
 for(const params of [{instanceId:'foreign-bot',path:'MEMORY.md'},{instanceId:f.instanceId,path:'../state.json'}]){
  assert.equal((await f.signed('/v1/rpc',{method:'agent-environment.read-file',params})).ok,false);
 }
 assert.equal((await f.signed('/v1/rpc',{method:'agent-environment.configure',params:{exitSummaryEnabled:false}})).code,'permission');
});
