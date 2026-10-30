/** Commands own their descendants and a terminal result, independently of stdio EOF. */
import {spawn, execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {StringDecoder} from 'node:string_decoder';
import {commandDeadline} from './command-deadline.mjs';
import {windowsCommandHelper, reapWindowsCommand} from './windows-command-job.mjs';
import { CommandOutput } from './command-output.mjs';
import { BACKGROUND_WAIT_GUIDANCE } from '../background-wait.mjs';
const exec=promisify(execFile), pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const MAX_OUTPUT=8*1024*1024;
/** 进程组存活探针：默认 /bin/ps 快照（可注入，供回归测试模拟 ps 偶发失败）。 */
const defaultGroupProbe = timeoutMs => exec('/bin/ps', ['-axo', 'pgid=,stat='], { timeout: timeoutMs });

export async function runCommand({command,cwd,timeoutMs=120_000,signal,env=process.env,maxOutput=MAX_OUTPUT,onSpawn=null,onOutput=null,ownerToken=randomUUID(),registrationTimeoutMs=10000,cleanupTimeoutMs=8000,outputDrainMs=250,groupProbe=defaultGroupProbe}) {
  const empty={code:null,signal:null,stdout:'',stderr:'',aborted:false,timedOut:false,cleanupConfirmed:true,truncated:false,spawnError:null,cleanupError:null};
  if(signal?.aborted)return {...empty,aborted:true,status:'cancelled'};
  const windows=process.platform==='win32';
  let helper;
  try {if(windows)helper=await windowsCommandHelper();}
  catch(error){return {...empty,spawnError:error.code??'supervisor-unavailable',stderr:error.message,status:'start-failed'};}
  if(signal?.aborted)return {...empty,aborted:true,status:'cancelled'};
  return new Promise(resolve=>{
    let child,timer,ending=false,closed=false,code=null,exitSignal=null,spawnError=null;
    let stdout='',stderr='',truncated=false,aborted=false,timedOut=false;
    const output = new CommandOutput(maxOutput);
    const decoders={out:new StringDecoder('utf8'),err:new StringDecoder('utf8')};
    const exited=Promise.withResolvers(),streamsClosed=Promise.withResolvers();
    const clean=async()=>{
      if(!child?.pid)return true;
      if(windows){
        // Let the supervisor cancel its Job first; force-closing its handle is the fallback.
        if(child.exitCode===null&&child.signalCode===null){
          child.stdin.write('abort\n',()=>{});
          await commandDeadline(exited.promise,500,'等待命令守卫退出超时').catch(()=>{});
          if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
        }
        await reapWindowsCommand(ownerToken,Math.max(1000,cleanupTimeoutMs-700));
        return true;
      }
      let signalError=null;
      try {process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')signalError=error;}
      const until=Date.now()+Math.max(100,cleanupTimeoutMs-500);
      do{
        let rows;
        // ps 偶发慢/失败（CI 高负载下实测会让单次探针超时）不等于进程还活着：
        // 期限内重试；确认只认探针的阳性证据，到期仍无证据按未确认处理（fail-closed）。
        try {({stdout:rows}=await groupProbe(2000));}
        catch {await pause(50);continue;}
        if(!rows.split('\n').some(row=>{const [group,state]=row.trim().split(/\s+/);return Number(group)===child.pid&&state&&!state.startsWith('Z');}))return true;
        await pause(25);
      }while(Date.now()<until);
      if(signalError)throw signalError;
      return false;
    };
    const finish=async()=>{
      if(ending)return;ending=true;clearTimeout(timer);
      let cleanupConfirmed=false,cleanupError=null;
      try {cleanupConfirmed=await commandDeadline(clean(),cleanupTimeoutMs,'命令进程清理未能在期限内确认');}
      catch(error){cleanupError=error.message;}
      child?.stdin?.destroy();
      await commandDeadline(streamsClosed.promise,outputDrainMs,'命令输出管道仍被持有').catch(error=>{
        // An empty process group/Job with open output can indicate an escaped descendant.
        cleanupConfirmed=false;cleanupError??=error.message;
      });
      child?.stdout?.destroy();child?.stderr?.destroy();
      output.append('out',decoders.out.end());output.append('err',decoders.err.end());
      stdout=output.text('out');stderr=output.text('err');truncated=output.total>output.bytes;
      signal?.removeEventListener('abort',onAbort);
      const status=!cleanupConfirmed?'cleanup-failed':aborted?'cancelled':timedOut?'timed-out':spawnError?'start-failed':code===0?'succeeded':'failed';
      resolve({code,signal:exitSignal,stdout,stderr,cleanupError,spawnError:spawnError?.code??(spawnError?'registration-failed':null),timedOut,aborted,cleanupConfirmed,truncated,status});
    };
    const onAbort=()=>{aborted=true;void finish();};
    const append=(which,chunk)=>{
      if(closed)return;
      const text=decoders[which].write(chunk);
      output.append(which,text);
      try {onOutput?.({get stdout(){return output.text('out');},get stderr(){return output.text('err');},channel:which,chunk:text});}catch(error){spawnError=error;void finish();}
    };
    try{
      const args=windows?['run',ownerToken,Buffer.from(command).toString('base64')]:onSpawn
        ?['-c','IFS= read -r __hemi_command_start || exit 125; exec 3<&0; ( IFS= read -r __hemi_parent_life <&3; kill -KILL -- "-$$" ) <&3 & /bin/bash -c "$1" </dev/null 3<&-; __hemi_status=$?; exit "$__hemi_status"',`hemi-command:${ownerToken}`,command]
        :['-c',command];
      child=spawn(windows?helper:'/bin/bash',args,{cwd,env,detached:!windows,windowsHide:true,stdio:[windows||onSpawn?'pipe':'ignore','pipe','pipe']});
    }catch(error){spawnError=error;closed=true;streamsClosed.resolve();void finish();return;}
    child.stdin?.on('error',()=>{});
    child.stdout.on('data',chunk=>append('out',chunk));child.stderr.on('data',chunk=>append('err',chunk));
    child.once('error',error=>{spawnError=error;void finish();});
    child.once('exit',(value,reason)=>{code=value;exitSignal=reason;exited.resolve();void finish();});
    child.once('close',()=>{closed=true;streamsClosed.resolve();});
    child.once('spawn',()=>{
      if(!windows&&!onSpawn)return;
      void commandDeadline(Promise.resolve().then(()=>onSpawn?.(child.pid,windows?{isolation:'windows-job-v1'}:{})),registrationTimeoutMs,'命令进程登记超时，未启动用户命令')
        .then(()=>{if(!ending&&!signal?.aborted)child.stdin.write('start\n');},error=>{spawnError=error;void finish();});
    });
    if(timeoutMs>0)timer=setTimeout(()=>{timedOut=true;void finish();},timeoutMs);
    signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
  });
}

export { createCommandScope } from './command-scope.mjs';

export function commandToolResult(out) {
  // SDK 仅在整批工具均要求 terminate 时让出生成；同批独立工作仍正常执行并继续。
  // 这是宿主接管等待，不是命令失败或根目标结束；外层 prompt 保留后台完成路径。
  if (out.status === 'waiting-background') return {
    content: [{ type: 'text', text: '占位等待命令未执行，已交由宿主等待当前目标的后台结果。后台工作尚未确认成功；收到完成通知后再继续。' }],
    isError: false, terminate: true, details: out,
  };
  if (out.status === 'background') return {
    content: [{ type: 'text', text: `命令已转后台（${out.jobId}），仍属于当前目标。${BACKGROUND_WAIT_GUIDANCE}` }],
    isError: false, details: out,
  };
  const text = [out.stdout, out.stderr ? `stderr:\n${out.stderr}` : '',
    `exit=${out.code ?? 'none'}${out.signal ? ` signal=${out.signal}` : ''} · ${out.status}`,
    out.truncated ? '（输出已截断，保留最近输出）' : '',
  ].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text }], isError: out.status !== 'succeeded', details: out };
}
