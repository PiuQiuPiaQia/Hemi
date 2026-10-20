import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function groupMembers(pid) {
  const {stdout} = await exec('/bin/ps', ['-axo','pid=,pgid=,stat=']);
  return stdout.split('\n').map(row=>row.trim().split(/\s+/)).filter(([,group,status])=>Number(group)===pid&&status&&!status.startsWith('Z')).map(([id])=>Number(id));
}
export async function processBirth(pid) {
  if (process.platform !== 'win32') {
    const {stdout} = await exec('/bin/ps',['-p',String(pid),'-o','lstart=,pgid=,uid=,stat=']);
    if (!stdout.trim()) throw new Error('无法核对命令进程身份');
    const parts=stdout.trim().split(/\s+/);
    return parts.at(-1)?.startsWith('Z') ? null : parts.slice(0,-1).join(' ');
  }
  const {stdout} = await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().Ticks`],{windowsHide:true});
  if (!stdout.trim()) throw new Error('无法核对命令进程身份');
  return stdout.trim();
}

/** 重启先核实 PID 出生信息与随机启动标记，再清理本应用的旧命令，不重放旧命令。 */
export async function recoverOwnedProcesses(journal) {
  const records = Object.values((await journal.snapshot()).processes ?? {}).filter(item=>['active','unknown'].includes(item.state));
  for (const record of records) {
    const birth = await processBirth(record.pid).catch(()=>null);
    let state='gone';
    if (birth && birth === record.birth) {
      if (process.platform !== 'win32') {
        const {stdout:args} = await exec('/bin/ps',['-p',String(record.pid),'-o','command=']);
        if (!args.includes(`hemi-command:${record.token}`)) throw new Error('旧命令身份标记缺失，未执行清理；请核对运行状态');
        try {process.kill(-record.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
        const deadline=Date.now()+3000;
        while ((await groupMembers(record.pid)).length) {if(Date.now()>deadline)throw new Error(`旧命令进程组尚未退出（${record.pid}）`);await pause(30);}
      } else await exec('taskkill.exe',['/pid',String(record.pid),'/T','/F'],{windowsHide:true});
      state='recovered';
    } else if (birth) state='identity-changed'; // PID 已复用，不能向新进程发送信号。
    else if (process.platform !== 'win32' && (await groupMembers(record.pid)).length) throw new Error('旧命令主进程已丢失但进程组仍在，未确认归属；请核对后重试');
    await journal.processEnd(record.id,{state,reason:'进程重启，按真实归属核对；旧命令不重跑'});
  }
  return records.length;
}
