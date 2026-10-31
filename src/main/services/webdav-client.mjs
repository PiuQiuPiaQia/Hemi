// WebDAV 客户端（坚果云及自建 Nextcloud 等）。Node 内置 fetch，无第三方依赖。
// 需求：docs/requirements/data-backup.md R-04/R-05/R-12——连接测试（PROPFIND）、
// 逐级建目录（MKCOL）、流式上传/下载（PUT/GET）、幂等删除（DELETE）、429/503 退避。
import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';

const RETRY_STATUS=new Set([429,503]);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function encodeRemote(p){
  return p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}
function joinUrl(baseUrl,p){
  const encoded=encodeRemote(p);
  if(!encoded)return baseUrl; // 空路径（挂载根）保留用户填写形式，坚果云地址本身带尾斜杠
  return `${baseUrl.replace(/\/+$/,'')}/${encoded}`;
}
function basicAuth(username,password){
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}
async function withRetries(request,{retries=3,log}={}){
  let attempt=0;
  for(;;){
    const response=await request();
    if(!RETRY_STATUS.has(response.status))return response;
    if(attempt>=retries)return response;
    // 还要重试：先释放本次响应体（连接回池），请求体由 request() 闭包按需重建
    await discardBody(response);
    const retryAfter=Number(response.headers.get('retry-after'));
    const delay=Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:1000*(2**attempt);
    log?.warn?.(`WebDAV ${response.status}，${delay}ms 后重试（第 ${attempt+1} 次）`);
    await sleep(delay);
    attempt+=1;
  }
}
// 丢弃并释放响应体，避免句柄/连接泄漏。真实 Response 用 arrayBuffer 消费完整 body
// （连接可复用）；无 body 或 mock 对象退化为 cancel。
async function discardBody(response){
  try{
    if(typeof response.arrayBuffer==='function')await response.arrayBuffer();
    else if(response.body&&typeof response.body.cancel==='function')await response.body.cancel();
  }catch{}
}
// fetch 网络错误 → 可读原因（带 cause），防御性脱敏：凭据串绝不进用户可见消息
function readableFetchError(error,fallback){
  const raw=String(error?.cause?.message??error?.message??error??fallback);
  return raw.replace(/(Basic|Bearer)\s+[A-Za-z0-9+/=]{8,}/gi,'$1 ***');
}
// 从 PROPFIND 多命名空间 XML 中提取子项（href + getcontentlength + lastmodified）。
function parsePropfind(xml){
  const items=[];
  const responses=xml.match(/<(?:[\w-]+:)?response>[\s\S]*?<\/(?:[\w-]+:)?response>/g)??[];
  for(const block of responses){
    const href=block.match(/<(?:[\w-]+:)?href>([^<]+)<\/(?:[\w-]+:)?href>/)?.[1];
    if(!href)continue;
    const decoded=decodeURIComponent(href).replace(/\/+$/,'');
    const size=block.match(/<(?:[\w-]+:)?getcontentlength>(\d+)</)?.[1];
    const modified=block.match(/<(?:[\w-]+:)?getlastmodified>([^<]+)</)?.[1];
    const resourcetype=block.match(/<(?:[\w-]+:)?resourcetype>([\s\S]*?)<\/(?:[\w-]+:)?resourcetype>/)?.[1]??'';
    const isDir=resourcetype.includes('collection')||!size; // 部分服务器对 collection 也给 size
    items.push({href:decoded,name:decoded.split('/').filter(Boolean).pop()??decoded,isDir,bytes:size?Number(size):null,modified:modified??null});
  }
  return items;
}

export function createWebdavClient({baseUrl,username,password,fetchImpl=null,log=null}){
  if(!/^https?:\/\//.test(baseUrl))throw new Error('WebDAV 地址必须以 http(s):// 开头');
  const doFetch=fetchImpl??globalThis.fetch;
  const headers={Authorization:basicAuth(username,password)};
  const request=async(rel,init={})=>{
    const {makeBody,...rest}=init;
    const response=await withRetries(async()=>{
      // 流式 body 是一次性的：每次尝试（含 429/503 重试）都必须新建流，复用已消费/
      // 已锁定的流会抛 ReadableStream locked/disturbed。makeBody 由调用方提供。
      const body=makeBody?makeBody():rest.body;
      return doFetch(joinUrl(baseUrl,rel),{...rest,body,headers:{...headers,...(init.headers??{})}});
    },{log});
    return response;
  };
  return {
    async testConnection(){
      const response=await request('',{method:'PROPFIND',headers:{Depth:'0','Content-Type':'application/xml'},body:'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'});
      if(response.status===401)return {ok:false,code:'AUTH_FAILED',message:'账号或应用密码不正确'};
      if(response.status===404)return {ok:false,code:'NOT_FOUND',message:'路径不存在，请检查服务器地址与路径'};
      if(!response.ok&&response.status!==207)return {ok:false,code:'HTTP_'+response.status,message:`服务器返回 ${response.status}`};
      return {ok:true};
    },
    async ensureDir(relPath){
      const segments=relPath.split('/').filter(Boolean);
      let current='';
      for(const segment of segments){
        current=current?`${current}/${segment}`:segment;
        const response=await request(current,{method:'MKCOL'});
        // 201/200 建成；405 已存在；301 在部分网关表示已存在
        if(![200,201,405,301].includes(response.status))throw new Error(`MKCOL ${current} 失败：HTTP ${response.status}`);
      }
      return true;
    },
    async uploadFile(relPath,absPath){
      const size=fs.statSync(absPath).size;
      const makeBody=()=>Readable.toWeb(fs.createReadStream(absPath,{highWaterMark:1<<20}));
      let response;
      try{
        // Node fetch 规范：流式 body 必须声明 duplex:'half'，否则抛
        // "RequestInit: duplex option is required when sending a body."
        response=await request(relPath,{method:'PUT',duplex:'half',makeBody,headers:{'Content-Type':'application/octet-stream','Content-Length':String(size)}});
      }catch(error){
        throw new Error(`上传 ${relPath} 失败：${readableFetchError(error,'网络请求失败')}`);
      }
      if(response.status!==201&&response.status!==200&&response.status!==204){
        const text=await response.text().catch(()=>'');
        throw new Error(`上传 ${relPath} 失败：HTTP ${response.status}${text?` ${text.slice(0,200)}`:''}`);
      }
      return {bytes:size};
    },
    async downloadToFile(relPath,absPath){
      const response=await request(relPath,{method:'GET'});
      if(response.status===404)throw new Error(`远端不存在：${relPath}`);
      if(!response.ok||!response.body)throw new Error(`下载 ${relPath} 失败：HTTP ${response.status}`);
      fs.mkdirSync(path.dirname(absPath),{recursive:true});
      await pipelineTo(response.body,absPath);
      return {bytes:fs.statSync(absPath).size};
    },
    async deleteFile(relPath){
      const response=await request(relPath,{method:'DELETE'});
      if(![200,204,404].includes(response.status))throw new Error(`删除 ${relPath} 失败：HTTP ${response.status}`);
      return true;
    },
    async listDir(relPath=''){
      const response=await request(relPath||'/',{method:'PROPFIND',headers:{Depth:'1','Content-Type':'application/xml'},body:'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'});
      if(response.status===404)return [];
      if(response.status!==207&&!response.ok)throw new Error(`列举 ${relPath||'/'} 失败：HTTP ${response.status}`);
      const xml=await response.text();
      const items=parsePropfind(xml);
      // 剔除集合自身：按请求路径比对（服务器 href 是站点绝对路径），不依赖
      // multistatus 顺序——坚果云等不一定把自身放在第一个 response。
      const selfPath=new URL(joinUrl(baseUrl,relPath||'/')).pathname.replace(/\/+$/,'');
      return items.filter(item=>item.href&&item.href.replace(/\/+$/,'')!==selfPath&&item.href!=='/');
    },
  };
}

async function pipelineTo(webStream,absPath){
  const nodeStream=Readable.fromWeb(webStream);
  const out=fs.createWriteStream(absPath);
  await new Promise((resolve,reject)=>{
    nodeStream.on('error',reject);out.on('error',reject);out.on('finish',resolve);
    nodeStream.pipe(out);
  });
}
