import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
async function run(script, signal) {
  const {stdout} = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from('[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$ErrorActionPreference="Stop";\n' + script, 'utf16le').toString('base64')],
  {signal, timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true});
  return JSON.parse(stdout.trim() || 'null');
}

const native = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class HemiDesktop {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder appId);
  [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr data, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);
  public static int ConnectionState(int session) {
    IntPtr data;int bytes;
    if(!WTSQuerySessionInformation(IntPtr.Zero,session,8,out data,out bytes))return -1;
    try {return bytes>=4?Marshal.ReadInt32(data):-1;} finally {WTSFreeMemory(data);}
  }
  public static string AppId(int pid) {
    var handle=OpenProcess(0x1000,false,pid);if(handle==IntPtr.Zero)return "";
    try {uint length=0;GetApplicationUserModelId(handle,ref length,null);if(length==0||length>4096)return "";
      var text=new StringBuilder((int)length);return GetApplicationUserModelId(handle,ref length,text)==0?text.ToString():"";}
    finally {CloseHandle(handle);}
  }
}
'@
`;

export const windowsAppIdentity = ({appId, executable}) => appId
  ? `win32:aumid:${appId.toLowerCase()}`
  : executable ? `win32:exe:${path.win32.normalize(executable).toLowerCase()}` : null;

/** Discovery and launching run in the logged-in user's session, never in the S4U Host. */
export function createWindowsDesktopApps() {
  let cached = null, cachedAt = 0, sessionStatus = null;
  return {
    async status({signal, refresh = false} = {}) {
      // Session zero cannot host a user desktop. Foreground/background action
      // availability belongs to Cua Driver; external input-desktop probes also
      // reject valid targeted UIA/capture routes and must not gate them.
      if (refresh) sessionStatus = null;
      sessionStatus ??= run(native + '$session=(Get-Process -Id $PID).SessionId;$state=[HemiDesktop]::ConnectionState($session);@{available=($session -gt 0);sessionId=$session;sessionConnected=($state -eq 0);connectionState=$state;reason=$(if($session -gt 0){""}else{"桌面助手未进入登录用户会话，请登录 Windows 或修复 Bot 组件。"});note=$(if($state -eq 4){"远程桌面已断开；前台按键需要保持连接且未锁定。后台操作仍由驱动核验。"}else{""})}|ConvertTo-Json -Compress', signal).catch(error => {sessionStatus = null;throw error;});
      return sessionStatus;
    },
    async running({signal} = {}) {
      const rows = await run(native + '@(Get-Process | ForEach-Object {try {if($_.Path){@{pid=$_.Id;executable=$_.Path;appId=[HemiDesktop]::AppId($_.Id)}}}catch {}})|ConvertTo-Json -Compress', signal);
      return new Map((rows ?? []).map(row => [row.pid, {...row, bundleId: windowsAppIdentity(row)}]));
    },
    async list({signal} = {}) {
      if (cached && Date.now() - cachedAt < 30000) return cached;
      const rows = await run(String.raw`
$items=@();$shell=New-Object -ComObject WScript.Shell
foreach($root in @([Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu'))){
  if($root){Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue|ForEach-Object {
    try{$link=$shell.CreateShortcut($_.FullName);if($link.TargetPath -and [IO.Path]::GetExtension($link.TargetPath) -eq '.exe' -and (Test-Path -LiteralPath $link.TargetPath)){
      $items+=@{name=$_.BaseName;executable=$link.TargetPath;launchPath=$_.FullName;appId=''}
    }}catch{}
  }}
}
foreach($entry in @(Get-StartApps)){if($entry.AppID -match '!'){$items+=@{name=$entry.Name;executable='';launchPath='';appId=$entry.AppID}}}
foreach($name in @('notepad.exe','calc.exe','mspaint.exe')){$command=Get-Command $name -ErrorAction SilentlyContinue;if($command){$items+=@{name=$name.Substring(0,$name.Length-4);executable=$command.Source;launchPath=$command.Source;appId=''}}}
@($items)|ConvertTo-Json -Compress
`, signal);
      const unique = new Map();
      for (const row of rows ?? []) {
        const bundleId = windowsAppIdentity(row);
        if (bundleId && !unique.has(bundleId)) unique.set(bundleId, {...row, bundleId});
      }
      cached = [...unique.values()];cachedAt = Date.now();return cached;
    },
    async open(target, {signal} = {}) {
      // target comes from our catalog after an app-scoped permission grant.
      await run(`$target=${literal(target.appId ? 'shell:AppsFolder\\' + target.appId : target.launchPath)};Start-Process -FilePath $target;@{ok=$true}|ConvertTo-Json -Compress`, signal);
      return {ok: true, name: target.name};
    },
  };
}
