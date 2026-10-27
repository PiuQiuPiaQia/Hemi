import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import {createHash, randomBytes, randomInt, randomUUID, timingSafeEqual, X509Certificate} from 'node:crypto';
import {calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify} from 'jose';
import {atomicJson, readJson, privateDirectory, fail, errorView} from './storage.mjs';
import {createDeviceCertificate} from './device-certificate.mjs';

const hash = value => createHash('sha256').update(value).digest('base64url');
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const RPC = new Set(['snapshot','session.open','session.control','session.create','session.update','session.rename','session.remove','session.order','session.draft','flow.snapshot','flow.command','operation.get','permission.decide','directory.list','attachment.read','attachment.document','file.read','file.resolve','references','skills','agent-environment.inspect','agent-environment.read-file']);
RPC.add('resource.stat');RPC.add('resource.chunk');
for (const method of ['capabilities.inspect', 'context.windows', 'context.capture']) RPC.add(method);
for(const operation of ['begin','chunk','status','complete','cancel'])RPC.add('attachment.upload.'+operation);

export function deviceEndpoint(value) {
  let url;
  try {url = new URL(value);} catch {fail('请输入手机可访问的 HTTPS 地址，例如 https://服务器IP:29421。');}
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname || value.length > 300) fail('配对地址必须是 HTTPS 源地址，不能包含账号、路径或查询参数。');
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(url.hostname)) fail('配对地址中的主机名无效。');
  return url.origin;
}

/** Trusted SSH management and the public TLS boundary are deliberately separate. */
export async function createDeviceGateway({dataDir, instanceId, request, watch, now = Date.now, listenHost}) {
  const dir = path.join(dataDir, 'device-access');
  privateDirectory(dir);
  const file = path.join(dir, 'state.json');
  let state = readJson(file, {schema:1, instanceId, config:null, invitations:{}, devices:{}, operations:{}});
  if (state.schema !== 1 || state.instanceId !== instanceId) fail('设备访问数据与 Bot 身份不匹配。', 'conflict');
  let webSockets = null, server = null, fault = '', configuring = false;
  const nonces = new Map(), rates = new Map(), sockets = new Map();
  const commit = next => {atomicJson(file, next); state = next;};
  const expires = invite => invite.expiresAt <= now() && invite.status === 'waiting';
  const publicInvite = invite => invite ? {...invite, ticketHash:undefined, status:expires(invite) ? 'expired' : invite.status} : null;
  const activeInvite = () => Object.values(state.invitations).find(invite => invite.status === 'waiting' && !expires(invite));
  const publicDevice = device => ({id:device.id, name:device.name, createdAt:device.createdAt, lastConnectedAt:device.lastConnectedAt ?? null, revokedAt:device.revokedAt ?? null});
  function summary() {
    return {supported:true, enabled:!!server, endpoint:state.config?.endpoint ?? '', fingerprint:state.config?.fingerprint ?? '', error:fault, pendingCount:Object.values(state.invitations).filter(i=>i.status==='waiting'&&!expires(i)&&i.request?.status==='pending').length};
  }
  function status(params = {}) {return {...summary(), invitation:publicInvite(params.inviteId && Object.hasOwn(state.invitations,params.inviteId) ? state.invitations[params.inviteId] : activeInvite()), devices:Object.values(state.devices).map(publicDevice)};}
  function operation(method, params, change) {
    if (!id(params.operationId)) fail('缺少稳定的设备操作 ID。');
    const identity = Object.fromEntries(['operationId','inviteId','deviceRequestId','deviceId','code'].filter(key=>Object.hasOwn(params,key)).map(key=>[key,params[key]]));
    const digest = hash(JSON.stringify({method,...identity})), old = Object.hasOwn(state.operations,params.operationId) ? state.operations[params.operationId] : null;
    if (old) {if (old.digest !== digest) fail('操作 ID 已用于其他设备操作。', 'conflict'); return old.result;}
    const next = structuredClone(state), result = change(next);
    next.operations[params.operationId] = {digest,result,at:now()};
    // Retain recent receipts; replay after pruning still cannot reopen a consumed invitation.
    const records = Object.entries(next.operations);
    for (const [key] of records.slice(0,Math.max(0,records.length-1000))) delete next.operations[key];
    commit(next); return result;
  }
  function invitation(params, next = state) {
    const invite = id(params.inviteId) && Object.hasOwn(next.invitations,params.inviteId) ? next.invitations[params.inviteId] : null;
    if (!invite) fail('配对邀请不存在。', 'missing');
    return invite;
  }
  function destroyDevice(deviceId) {for (const socket of sockets.get(deviceId) ?? []) socket.destroy(); sockets.delete(deviceId);}
  async function management(method, params = {}) {
    if (method === 'pairing.status' || method === 'devices.list') return status(params);
    if (method === 'pairing.operation') return Object.hasOwn(state.operations,params.operationId) ? {status:'done',result:state.operations[params.operationId].result} : {status:'missing'};
    if (configuring && method !== 'pairing.configure') fail('正在配置设备连接，请稍候。','busy');
    if (method === 'pairing.configure') {
      if (configuring) fail('正在配置设备连接，请稍候。','busy');
      configuring = true;
      try {
        const endpoint = deviceEndpoint(params.endpoint);
        const hasDevices=Object.values(state.devices).some(d=>!d.revokedAt);
        if (state.config && endpoint !== state.config.endpoint && hasDevices) fail('请先撤销现有设备，再修改设备连接地址。','conflict');
        const host = new URL(endpoint).hostname.replace(/^\[|\]$/g,'');
        const keyFile = path.join(dir,'tls-key.pem'), certFile = path.join(dir,'tls-cert.pem');
        const oldCert=await fs.readFile(certFile).then(value=>new X509Certificate(value),()=>null);
        const renew=!oldCert || Date.parse(oldCert.validTo)<=now();
        if(hasDevices && (renew || oldCert && hash(oldCert.raw)!==state.config?.fingerprint))fail('设备证书已过期或变化，请先撤销现有设备再重新启用。','conflict');
        await stop();
        if (endpoint !== state.config?.endpoint || renew) {
          const tempKey = keyFile+'.tmp', tempCert = certFile+'.tmp';
          try {
            try {
              const identity = await createDeviceCertificate(host, {now: now()});
              await Promise.all([
                fs.writeFile(tempKey, identity.key, {mode:0o600}),
                fs.writeFile(tempCert, identity.cert, {mode:0o600}),
              ]);
            } catch {fail('无法生成设备证书，请检查 Bot 数据目录的写入权限。','unsupported');}
            await fs.chmod(tempKey,0o600); await fs.chmod(tempCert,0o600);
            await fs.rename(tempKey,keyFile); await fs.rename(tempCert,certFile);
          } finally {await fs.rm(tempKey,{force:true}); await fs.rm(tempCert,{force:true});}
        }
        const cert = new X509Certificate(await fs.readFile(certFile));
        if (Date.parse(cert.validTo) <= now()) fail('设备连接证书已过期，请撤销设备后重新配置。','conflict');
        const config = {endpoint, fingerprint:hash(cert.raw)};
        await start(config);
        try {commit({...state,config});} catch (error) {await stop(); throw error;}
        fault = ''; return status();
      } finally {configuring = false;}
    }
    if (method === 'pairing.disable') {await stop(); commit({...state,config:state.config ? {...state.config,disabled:true} : null}); return status();}
    if (method === 'pairing.create') {
      if (!server) fail('请先启用 Bot 的设备连接入口。','unsupported');
      if (activeInvite()) fail('已有有效邀请，请先取消或处理当前申请。','conflict');
      const ticket = randomBytes(32).toString('base64url'), inviteId = randomUUID();
      const invite = {inviteId,ticketHash:hash(ticket),expiresAt:now()+120000,status:'waiting',request:null};
      const next = structuredClone(state); next.invitations[inviteId] = invite;
      for (const old of Object.values(next.invitations)) if(old.inviteId!==inviteId && old.expiresAt < now()-86400000) delete next.invitations[old.inviteId];
      commit(next);
      return {...publicInvite(invite), qr:JSON.stringify({type:'hemi-bot-pair',version:1,endpoint:state.config.endpoint,botInstanceId:instanceId,inviteId,requestTicket:ticket,expiresAt:invite.expiresAt,certificatePin:state.config.fingerprint})};
    }
    if (['pairing.cancel','pairing.reject','pairing.approve'].includes(method)) return operation(method,params,next=>{
      const invite = invitation(params,next);
      if (method !== 'pairing.approve') {
        if (invite.status === 'used') fail('设备已登记，请从设备列表撤销访问。','conflict');
        invite.status = method === 'pairing.reject' ? 'rejected' : 'cancelled';
        if (invite.request) invite.request.status = invite.status;
        return {ok:true,status:invite.status};
      }
      if (invite.status !== 'waiting' || expires(invite)) fail('邀请已过期或失效。','conflict');
      const pending = invite.request;
      if (!pending || pending.status !== 'pending' || pending.requestId !== params.deviceRequestId || pending.deviceId !== params.deviceId || pending.code !== params.code) fail('新设备申请已变化，请重新核对。','conflict');
      const old = next.devices[pending.deviceId];
      if (old && !old.revokedAt) fail('这台设备已连接。','conflict');
      next.devices[pending.deviceId] = {id:pending.deviceId,name:pending.name,publicKey:pending.publicKey,createdAt:now(),revokedAt:null};
      invite.status = 'used'; pending.status = 'approved';
      return {ok:true,device:publicDevice(next.devices[pending.deviceId])};
    });
    if (method === 'devices.revoke') {
      const result = operation(method,params,next=>{
        const device = Object.hasOwn(next.devices,params.deviceId) ? next.devices[params.deviceId] : null;
        if (!device) fail('设备不存在。','missing');
        device.revokedAt ??= now(); return {ok:true,device:publicDevice(device)};
      });
      destroyDevice(params.deviceId); return result;
    }
    fail('不支持的设备管理操作。','unsupported');
  }
  function rate(ip) {
    const minute = Math.floor(now()/60000);
    for (const [key,value] of rates) if(value.minute!==minute) rates.delete(key);
    for (const [key,limit] of [[ip,240],['*',2400]]) {
      const value = rates.get(key) ?? {minute,count:0}; value.count++; rates.set(key,value);
      if (value.count > limit || rates.size > 4096) fail('请求过于频繁，请稍后重试。','busy');
    }
  }
  async function proof(envelope, route) {
    if (typeof envelope.payload !== 'string' || Buffer.byteLength(envelope.payload)>1024*1024 || typeof envelope.proof !== 'string' || envelope.proof.length>4096) fail('设备请求格式无效。');
    const header = decodeProtectedHeader(envelope.proof), jwk = header.jwk;
    if (header.alg !== 'ES256' || header.typ !== 'hemi-device+jwt' || !jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !/^[\w-]{43}$/.test(jwk.x) || !/^[\w-]{43}$/.test(jwk.y) || Object.keys(jwk).some(k=>!['kty','crv','x','y'].includes(k))) fail('设备公钥无效。');
    const deviceId = await calculateJwkThumbprint(jwk);
    const {payload} = await jwtVerify(envelope.proof,await importJWK(jwk,'ES256'),{algorithms:['ES256'],typ:'hemi-device+jwt',issuer:'hemi-device-v1',audience:`${instanceId}:${route}`,subject:deviceId,maxTokenAge:60,clockTolerance:5,currentDate:new Date(now())});
    const challenge = nonces.get(payload.nonce);
    if (!challenge || challenge <= now() || payload.bodyHash !== hash(envelope.payload) || !id(payload.jti)) fail('设备证明已过期、重放或内容不匹配。','permission');
    nonces.delete(payload.nonce);
    let body;
    try {body = JSON.parse(envelope.payload);} catch {fail('设备请求内容无效。');}
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('设备请求内容无效。');
    return {body,deviceId,publicKey:jwk};
  }
  async function publicRequest(route, envelope, socket) {
    if (route === '/v1/challenge') {
      for (const [key,expiry] of nonces) if(expiry<=now())nonces.delete(key);
      if (nonces.size>=2048) fail('设备连接繁忙，请稍后重试。','busy');
      const nonce = randomBytes(32).toString('base64url'); nonces.set(nonce,now()+30000);
      return {nonce,instanceId};
    }
    const {body,deviceId,publicKey} = await proof(envelope,route);
    if (route === '/v1/pair/request') {
      const invite = invitation(body);
      if (invite.status!=='waiting' || expires(invite) || !equal(hash(String(body.ticket??'')),invite.ticketHash)) fail('配对邀请已过期或无效。','permission');
      if (!id(body.requestId)) fail('新设备请求 ID 无效。');
      if (invite.request) {
        if (invite.request.deviceId!==deviceId || invite.request.requestId!==body.requestId) fail('已有设备申请，请在原设备拒绝后重新生成邀请。','conflict');
        return {status:'pending',code:invite.request.code,expiresAt:invite.expiresAt,deviceId};
      }
      const name = typeof body.name==='string' ? body.name.trim().replace(/[\x00-\x1f\x7f]/g,'').slice(0,60) : '';
      const next = structuredClone(state);
      next.invitations[invite.inviteId].request = {requestId:body.requestId,deviceId,publicKey,name:name||'新手机',code:String(randomInt(1000000)).padStart(6,'0'),status:'pending'};
      commit(next);
      return {status:'pending',code:next.invitations[invite.inviteId].request.code,expiresAt:invite.expiresAt,deviceId};
    }
    if (route === '/v1/pair/status' || route === '/v1/pair/cancel') {
      const invite = invitation(body), pending = invite.request;
      if (!pending) {
        if (expires(invite) || invite.status!=='waiting') return {status:expires(invite)?'expired':invite.status};
        if (route.endsWith('/cancel') && equal(hash(String(body.ticket??'')),invite.ticketHash)) {const next=structuredClone(state);next.invitations[invite.inviteId].status='cancelled';commit(next);return {status:'cancelled'};}
        return {status:'not-received'};
      }
      if (!pending || pending.deviceId!==deviceId || pending.requestId!==body.requestId) fail('这不是本机的配对申请。','permission');
      if (route.endsWith('/cancel') && invite.status==='waiting') {
        const next = structuredClone(state); next.invitations[invite.inviteId].status='cancelled'; next.invitations[invite.inviteId].request.status='cancelled'; commit(next);
        return {status:'cancelled'};
      }
      return {status:state.devices[deviceId]?.revokedAt ? 'revoked' : expires(invite) ? 'expired' : invite.status==='waiting' ? pending.status : invite.status==='used' ? 'approved' : invite.status,code:pending.code,deviceId,expiresAt:invite.expiresAt};
    }
    if (route !== '/v1/rpc') fail('设备接口不存在。','missing');
    const device = state.devices[deviceId];
    if (!device || device.revokedAt) fail('本设备尚未获准或访问已被撤销。','permission');
    if (!RPC.has(body.method) || !body.params || typeof body.params!=='object' || Array.isArray(body.params)) fail('该接口不允许设备调用。','permission');
    if (body.params.instanceId && body.params.instanceId!==instanceId) fail('Bot 身份不匹配。','conflict');
    const owned = sockets.get(deviceId) ?? new Set();
    if (!owned.has(socket)) {owned.add(socket); sockets.set(deviceId,owned); socket.once('close',()=>owned.delete(socket));}
    const result = await request(body.method,{...body.params,instanceId},{clientId:deviceId});
    if (state.devices[deviceId]?.revokedAt) fail('设备访问已被撤销。','permission');
    if (!device.lastConnectedAt || now()-device.lastConnectedAt>30000) {const next=structuredClone(state); next.devices[deviceId].lastConnectedAt=now();commit(next);}
    return result;
  }
  async function start(config) {
    const cert = await fs.readFile(path.join(dir,'tls-cert.pem'));
    if (Date.parse(new X509Certificate(cert).validTo) <= now()) fail('设备连接证书已过期。','conflict');
    if(hash(new X509Certificate(cert).raw)!==config.fingerprint)fail('设备连接证书已变化。','conflict');
    const tls = {key:await fs.readFile(path.join(dir,'tls-key.pem')),cert,minVersion:'TLSv1.2',maxHeaderSize:8192};
    const candidate = https.createServer(tls,async(req,res)=>{
      res.setHeader('Cache-Control','no-store'); res.setHeader('Content-Type','application/json'); res.setHeader('X-Content-Type-Options','nosniff');
      try {
        rate(req.socket.remoteAddress ?? 'unknown');
        if (req.method!=='POST' || !['/v1/challenge','/v1/pair/request','/v1/pair/status','/v1/pair/cancel','/v1/rpc'].includes(req.url) || req.headers.origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')) fail('不支持的设备请求。','permission');
        const chunks=[];let length=0;
        for await (const chunk of req) {length+=chunk.length;if(length>1100000) {req.destroy();return;} chunks.push(chunk);}
        // HTTP chunks can split a UTF-8 codepoint; decode the bounded body only once.
        const result = await publicRequest(req.url,JSON.parse(Buffer.concat(chunks,length).toString('utf8')),req.socket);
        res.end(JSON.stringify({ok:true,result}));
      } catch(error) {res.statusCode=error?.code==='busy'?429:error?.code==='permission'?403:400;res.end(JSON.stringify(errorView(error)));}
    });
    const wss = new WebSocketServer({noServer:true, maxPayload:16384, perMessageDeflate:false});
    candidate.on('upgrade',(req,socket,head)=>{
      try {
        rate(socket.remoteAddress ?? 'unknown');
        if (!watch || req.url!=='/v1/events' || req.headers.origin || wss.clients.size >= 64) {socket.destroy();return;}
        wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
      } catch {socket.destroy();}
    });
    wss.on('connection',(ws,req)=>{
      let unsubscribe, alive=true, stopped=false;
      const close=()=>{if(stopped)return;stopped=true;clearTimeout(deadline);clearInterval(heartbeat);unsubscribe?.();};
      const deadline=setTimeout(()=>ws.terminate(),5000);deadline.unref?.();
      const heartbeat=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;ws.ping();},20000);heartbeat.unref?.();
      ws.on('pong',()=>{alive=true;});ws.on('close',close);ws.on('error',close);
      ws.once('message',async(raw,binary)=>{
        try {
          if(binary)fail('事件认证格式无效。');
          const {body,deviceId}=await proof(JSON.parse(raw.toString()),'/v1/events');
          if(stopped)return;
          const device=state.devices[deviceId];
          if(!device || device.revokedAt)fail('设备访问已被撤销。','permission');
          const owned=sockets.get(deviceId)??new Set();
          if(owned.size>=8)fail('设备连接过多。','busy');
          owned.add(req.socket);sockets.set(deviceId,owned);req.socket.once('close',()=>owned.delete(req.socket));
          clearTimeout(deadline);
          unsubscribe=watch({...body,instanceId},frame=>{
            if(ws.readyState!==1 || ws.bufferedAmount>2*1024*1024)throw new Error('Slow event consumer');
            ws.send(JSON.stringify(frame));
          },()=>ws.terminate(),{clientId:deviceId});
        } catch(error) {if(ws.readyState===1)ws.send(JSON.stringify(errorView(error)));ws.close(1008);}
      });
      // Subscriptions are immutable for this connection; a changed scope reconnects with a new cursor.
    });
    webSockets=wss;
    candidate.requestTimeout=15000; candidate.headersTimeout=10000; candidate.keepAliveTimeout=5000; candidate.maxConnections=128;
    candidate.on('tlsClientError',()=>{});
    const address=new URL(config.endpoint);
    const bind=listenHost ?? (net.isIP(address.hostname.replace(/^\[|\]$/g,''))===6 ? '::' : '0.0.0.0');
    await new Promise((resolve,reject)=>{candidate.once('error',reject);candidate.listen(Number(address.port||443),bind,resolve);});
    server=candidate;
    candidate.on('error',()=>{fault='设备连接入口异常，请检查端口并重新启用。';});
  }
  async function stop() {if(webSockets){for(const ws of webSockets.clients)ws.terminate();webSockets.close();webSockets=null;}if(server){const old=server;server=null;old.closeAllConnections();await new Promise(resolve=>old.close(resolve));}nonces.clear();}
  if(state.config && !state.config.disabled) {try {await start(state.config);} catch {fault='设备连接入口未启动，请检查证书、端口和权限。';}}
  return {management,summary,close:stop};
}
