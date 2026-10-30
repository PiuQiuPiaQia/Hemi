import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {windowsCommandHelper, reapWindowsCommand} from '../agent/gate/windows-command-job.mjs';
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function groupMembers(pid) {
  const {stdout} = await exec('/bin/ps', ['-axo','pid=,pgid=,stat='], {timeout:2000});
  return stdout.split('\n').map(row=>row.trim().split(/\s+/)).filter(([,group,status])=>Number(group)===pid&&status&&!status.startsWith('Z')).map(([id])=>Number(id));
}
export async function processBirth(pid) {
  if (process.platform !== 'win32') {
    const {stdout} = await exec('/bin/ps',['-p',String(pid),'-o','lstart=,pgid=,uid=,stat='],{timeout:2000});
    if (!stdout.trim()) throw new Error('无法核对命令进程身份');
    const parts=stdout.trim().split(/\s+/);
    return parts.at(-1)?.startsWith('Z') ? null : parts.slice(0,-1).join(' ');
  }
  const {stdout} = await exec(await windowsCommandHelper(),['birth',String(Number(pid))],{windowsHide:true,timeout:5000});
  if (!stdout.trim()) throw new Error('无法核对命令进程身份');
  return stdout.trim();
}

async function recoverProcess(record) {
  if (process.platform === 'win32' && record.isolation === 'windows-job-v1') {
    await reapWindowsCommand(record.token);
    return {state:'recovered',cleanupConfirmed:true,reason:'按随机 Job 身份回收全部成员；旧命令不重跑'};
  }
  if (process.platform === 'win32') throw new Error('旧版命令没有 Job 归属，无法确认子进程；没有清理或重跑现有服务');
  if (record.state === 'unknown' && record.cleanupConfirmed === false) {
    throw new Error(record.reason ?? '旧命令清理未确认，保留待核对记录；没有重跑命令');
  }
  const birth = await processBirth(record.pid).catch(error => {
    if (error.code === 1 && !error.stdout?.trim()) return null;
    throw error;
  });
  let state = 'gone';
  if (birth && birth === record.birth) {
    const {stdout:args} = await exec('/bin/ps',['-p',String(record.pid),'-o','command='],{timeout:2000});
    if (!args.includes(`hemi-command:${record.token}`)) throw new Error('旧命令身份标记缺失，未执行清理');
    try {process.kill(-record.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
    const deadline=Date.now()+3000;
    while ((await groupMembers(record.pid)).length) {if(Date.now()>deadline)throw new Error('旧命令进程组尚未退出');await pause(30);}
    state='recovered';
  } else {
    // PID 复用不能成为误杀依据；查询失败也不能当作进程已经消失。
    if ((await groupMembers(record.pid)).length) throw new Error('旧命令进程组仍在，未确认归属；未执行清理');
    if (birth) state='identity-changed';
  }
  return {state,cleanupConfirmed:true,reason:'进程重启，按真实归属核对；旧命令不重跑'};
}

/** 逐条核实并回收旧命令。单条未知状态不阻止其他会话，事实库故障仍向上报错。 */
export async function recoverOwnedProcesses(journal, {log} = {}) {
  const records = Object.values((await journal.snapshot()).processes ?? {}).filter(item=>['active','unknown'].includes(item.state));
  for (const record of records) {
    let result;
    try { result = await recoverProcess(record); }
    catch (error) {
      result = {state:'unknown',cleanupConfirmed:false,reason:error.message};
      log?.warn?.(`[command ${record.id}] ${record.owner?.conversationId ?? '归属未知'}：${error.message}`);
    }
    // 存储错误不属于某条命令的清理失败，不能在逐条恢复时吞掉。
    await journal.processEnd(record.id,result);
  }
  return records.length;
}
