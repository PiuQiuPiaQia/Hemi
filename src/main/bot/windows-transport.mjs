import path from 'node:path';
import { NODE_RUNTIME } from './node-runtime.mjs';

// EncodedCommand works with both cmd.exe and PowerShell as OpenSSH's default
// shell. All dynamic values are PowerShell literals, never executable source.
export const psLiteral = value => "'" + String(value).replaceAll("'", "''") + "'";
export function powershellSource(script) {
  return `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\ntry {\n${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
}
export function copyWindowsInput(destination, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid stdin size');
  return `$inputStream = [Console]::OpenStandardInput(); $remaining = ${size}; $buffer = New-Object byte[] 32768\nwhile ($remaining -gt 0) { $read = $inputStream.Read($buffer, 0, [Math]::Min($remaining, $buffer.Length)); if ($read -le 0) { throw 'SSH 输入不完整' }; ${destination}.Write($buffer, 0, $read); $remaining -= $read }`;
}
export function powershellCommand(script) {
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' +
    Buffer.from(powershellSource(script), 'utf16le').toString('base64');
}

const rootScript = String.raw`
$root = Join-Path $env:USERPROFILE '.local\share\hemi-bot'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = 'HemiBot-' + $sid
$desktopTaskName = $taskName + '-Desktop'
`;

export const windowsRootSetupScript = rootScript + String.raw`
[IO.Directory]::CreateDirectory($root) | Out-Null
$acl = Get-Acl -LiteralPath $root
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$private = $acl.AreAccessRulesProtected -and $rules.Count -eq 2
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin @($sid, 'S-1-5-18') -or $rule.AccessControlType -ne 'Allow' -or ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { $private = $false }
}
if (-not $private) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($identity in @($sid, 'S-1-5-18')) {
    $who = New-Object Security.Principal.SecurityIdentifier($identity)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($who, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $root -AclObject $acl
}
`;

export const windowsProbeScript = rootScript + String.raw`
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw '需要 Windows 或 Linux 主机' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') { throw 'Windows Bot 当前支持 x64 系统' }
if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw 'Windows Bot 需要 PowerShell 5.1 或以上版本' }
foreach ($tool in @('tar.exe', 'Register-ScheduledTask', 'Get-ScheduledTask', 'Start-ScheduledTask', 'Stop-ScheduledTask', 'icacls.exe')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw ('缺少 Windows 组件：' + $tool) }
}
if ((Get-Service Schedule).Status -ne 'Running') { throw '请先启动 Windows Task Scheduler 服务' }
$drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($env:USERPROFILE))
if ($drive.AvailableFreeSpace -lt 536870912) { throw '安装需要至少 512 MB 可用空间' }
$node = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
  $found = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($found) { $node = $found.Source } else { $node = '' }
}
$version = ''; $needed = '1'
if ($node) {
  $version = & $node -p 'process.version'
  $parsed = [version]$version.TrimStart('v')
  $nodeArch = & $node -p 'process.arch'
  if ($parsed.Major -eq 22 -and $parsed.Minor -ge 19 -and $nodeArch -eq 'x64' -and (Test-Path -LiteralPath (Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'))) { $needed = '0' }
}
if ($needed -eq '1') { $node = Join-Path $root 'runtime\node.exe' }
$existing = '0'
if ((Test-Path -LiteralPath (Join-Path $root 'data\state.json')) -or (Test-Path -LiteralPath (Join-Path $root 'current.json'))) { $existing = '1' }
function Emit($name, $value) { [Console]::WriteLine('__HB_' + $name + '=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value))) }
Emit platform 'win32'; Emit home $env:USERPROFILE; Emit arch 'x64'; Emit node $version; Emit nodeBin $node; Emit runtimeNeeded $needed; Emit existing $existing
`;

// Forward raw stdin, stdout and stderr. PowerShell 5's native pipeline otherwise
// converts UTF-8 JSON and binary attachments using the current Windows code page.
export function windowsCliScript(mode, inputSize = 0, inputFile = null) {
  if (!['rpc', 'watch', 'rpc-stream'].includes(mode)) throw new Error('Invalid Bot CLI mode');
  const bufferedInput = mode !== 'rpc-stream' && !inputFile;
  return rootScript + String.raw`
$active = Get-Content -LiteralPath (Join-Path $root 'current.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$node = $active.node
$entry = Join-Path $active.release 'src\main\bot\cli.mjs'
$env:HEMI_BOT_DATA_DIR = Join-Path $root 'data'
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $node
$start.Arguments = '"' + $entry + '" ${mode}'
$start.UseShellExecute = $false
# Persistent control inherits the raw SSH stdin handle. A redirected .NET pipe
# can buffer tiny frames until EOF, which a long-lived channel never sends.
$start.RedirectStandardInput = ${mode === 'rpc-stream' ? '$false' : '$true'}
${bufferedInput ? `# Capture SSH input before launching Node. On Windows OpenSSH, starting a
# console child first can leave the parent's stdin read waiting indefinitely.
$payload = New-Object IO.MemoryStream
try { ${copyWindowsInput('$payload', inputSize)}
$inputBytes = $payload.ToArray() } finally { $payload.Dispose() }
` : ''}
$process = [Diagnostics.Process]::Start($start)
try { ${mode === 'rpc-stream' ? '' : (inputFile ? `$source = [IO.File]::OpenRead((Join-Path $root ${psLiteral(inputFile)})); try { $source.CopyTo($process.StandardInput.BaseStream) } finally { $source.Dispose() }` : '$process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)') + '\n$process.StandardInput.Close();'}
$process.WaitForExit(); exit $process.ExitCode }
finally { $process.Dispose() }
`;
}

export function windowsDirectoryScript(raw) {
  return String.raw`
$requested = ${psLiteral(raw)}
if ($requested -eq '~') { $requested = $env:USERPROFILE }
elseif ($requested.StartsWith('~/') -or $requested.StartsWith('~\')) { $requested = Join-Path $env:USERPROFILE $requested.Substring(2) }
try {
  $item = Get-Item -LiteralPath $requested -Force -ErrorAction Stop
  if (-not $item.PSIsContainer) { [Console]::WriteLine('__HEMI_DIR_JSON__{"status":"not-directory"}'); exit 0 }
  $folders = @(Get-ChildItem -LiteralPath $item.FullName -Directory -ErrorAction Stop | Where-Object { -not $_.Name.StartsWith('.') } | Select-Object -First 1001 | ForEach-Object { @{name=$_.Name;path=$_.FullName} })
  $parent = $item.Parent
  $parentPath = $item.FullName; if ($parent) { $parentPath = $parent.FullName }
  $reply = @{status='ok';path=$item.FullName;home=$env:USERPROFILE;parent=$parentPath;folders=@($folders | Select-Object -First 1000);truncated=($folders.Count -gt 1000)}
} catch [System.UnauthorizedAccessException] { $reply = @{status='permission'} }
catch [System.Management.Automation.ItemNotFoundException] { $reply = @{status='missing'} }
[Console]::WriteLine('__HEMI_DIR_JSON__' + ($reply | ConvertTo-Json -Depth 5 -Compress))
`;
}

const management = rootScript + String.raw`
function Write-Active($value) {
  $file = Join-Path $root 'current.json'; $temp = $file + '.tmp'
  [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $file) { [IO.File]::Replace($temp, $file, [NullString]::Value) } else { [IO.File]::Move($temp, $file) }
}
function Restore-Bot {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName $desktopTaskName -ErrorAction SilentlyContinue
  $previous = Join-Path $root 'previous.json'
  if (Test-Path -LiteralPath $previous) {
    Write-Active (Get-Content -LiteralPath $previous -Encoding UTF8 -Raw | ConvertFrom-Json)
    $xml = Join-Path $root 'previous-task.xml'
    if (Test-Path -LiteralPath $xml) { Register-ScheduledTask -TaskName $taskName -Xml ([IO.File]::ReadAllText($xml)) -Force | Out-Null }
    $desktopXml = Join-Path $root 'previous-desktop-task.xml'
    if (Test-Path -LiteralPath $desktopXml) {
      Register-ScheduledTask -TaskName $desktopTaskName -Xml ([IO.File]::ReadAllText($desktopXml)) -Force | Out-Null
      Start-ScheduledTask -TaskName $desktopTaskName
    } else { Unregister-ScheduledTask -TaskName $desktopTaskName -Confirm:$false -ErrorAction SilentlyContinue }
    Enable-ScheduledTask -TaskName $taskName | Out-Null
    Start-ScheduledTask -TaskName $taskName
  } else {
    Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
    Unregister-ScheduledTask -TaskName $desktopTaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
}
`;

export function windowsInstallScript(info, {release, digest, size = 0, inputFile = null}) {
  const artifact = `node-v${NODE_RUNTIME.version}-win-x64`;
  return management + windowsRootSetupScript + String.raw`
$lockPath = Join-Path $root 'install.lock'
$lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
try {
  $release = Join-Path $root ${psLiteral('releases/' + release)}
  [IO.Directory]::CreateDirectory($release) | Out-Null
  $archive = Join-Path $release 'runtime.tgz'
  ${inputFile ? `Move-Item -LiteralPath (Join-Path $root ${psLiteral(inputFile)}) -Destination $archive` : `$stream = [IO.File]::Create($archive)\n  try { ${copyWindowsInput('$stream', size)} } finally { $stream.Dispose() }`}
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${psLiteral(digest)}) { throw 'Bot 组件包完整性核验失败' }
  ${info.runtimeNeeded ? String.raw`
  $runtimes = Join-Path $root 'runtimes'; [IO.Directory]::CreateDirectory($runtimes) | Out-Null
  $zip = Join-Path $runtimes '${artifact}.zip'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v${NODE_RUNTIME.version}/${artifact}.zip' -OutFile $zip -TimeoutSec 150
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${NODE_RUNTIME.win32.x64}') { throw 'Node 安装包完整性核验失败' }
  Expand-Archive -LiteralPath $zip -DestinationPath $runtimes -Force
  $runtime = Join-Path $root 'runtime'
  if (Test-Path -LiteralPath $runtime) { throw '已有私有 Node 无法使用，请先修复或移走 runtime 目录后重试' }
  Move-Item -LiteralPath (Join-Path $runtimes '${artifact}') -Destination $runtime
  Remove-Item -LiteralPath $zip
  ` : ''}
  $node = ${psLiteral(info.nodeBin)}
  $env:PATH = (Split-Path $node) + ';' + $env:PATH
  & tar.exe -xzf $archive -C $release
  if ($LASTEXITCODE -ne 0) { throw 'Bot 组件包解压失败' }
  $networkEnv = Join-Path $root 'network.env'
  Push-Location -LiteralPath $release
  try {
    $reuse = ''
    $activeFile = Join-Path $root 'current.json'
    if (Test-Path -LiteralPath $activeFile) {
      $active = Get-Content -LiteralPath $activeFile -Encoding UTF8 -Raw | ConvertFrom-Json
      if ($active.node -eq $node) { $reuse = $active.release }
    }
    & $node ('--env-file-if-exists=' + $networkEnv) 'src/main/bot/install-dependencies.mjs' $root $reuse
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $node --check 'src/main/bot/cli.mjs'
    if ($LASTEXITCODE -ne 0) { throw 'Bot 组件检查失败' }
  } finally { Pop-Location }
  $current = Join-Path $root 'current.json'
  $previous = Join-Path $root 'previous.json'
  if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous }
  if (Test-Path -LiteralPath $current) { Copy-Item -LiteralPath $current -Destination $previous }
  $oldTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $oldXml = Join-Path $root 'previous-task.xml'
  if (Test-Path -LiteralPath $oldXml) { Remove-Item -LiteralPath $oldXml }
  if ($oldTask) { [IO.File]::WriteAllText($oldXml, (Export-ScheduledTask -TaskName $taskName)) }
  $oldDesktopXml = Join-Path $root 'previous-desktop-task.xml'
  Remove-Item -LiteralPath $oldDesktopXml -ErrorAction SilentlyContinue
  if (Get-ScheduledTask -TaskName $desktopTaskName -ErrorAction SilentlyContinue) { [IO.File]::WriteAllText($oldDesktopXml, (Export-ScheduledTask -TaskName $desktopTaskName)) }
  $launcher = Join-Path $root 'windows-launcher.mjs'
  Copy-Item -LiteralPath (Join-Path $release 'src\main\bot\windows-launcher.mjs') -Destination $launcher -Force
  $envProxyFlag = ''
  $supportsEnvProxy = & $node -e "console.log(process.allowedNodeEnvironmentFlags.has('--use-env-proxy') ? 'yes' : 'no')"
  if ($supportsEnvProxy -eq 'yes') { $envProxyFlag = '--use-env-proxy ' }
  $action = New-ScheduledTaskAction -Execute $node -Argument ($envProxyFlag + '--env-file-if-exists="' + $networkEnv + '" "' + $launcher + '"') -WorkingDirectory $env:USERPROFILE
  # A repeating time trigger works for an unprivileged user's own S4U task and
  # resumes after a reboot without requiring an interactive desktop logon.
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType S4U -RunLevel Limited
  # Interactive requests need normal CPU, I/O and memory priority. The scheduler
  # default (7) lowers all three, including the synchronous acceptance writes.
  $settings = New-ScheduledTaskSettingsSet -Priority 4 -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  try { Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null }
  catch { throw ('无法创建常驻计划任务，请检查账号的“作为批处理作业登录”权限与计划任务策略：' + $_.Exception.Message) }
  try {
    # The resident S4U service has no interactive desktop. A separate task runs
    # only in this user's logged-in session and serves the authenticated pipe.
    $desktopAction = New-ScheduledTaskAction -Execute $node -Argument ($envProxyFlag + '--env-file-if-exists="' + $networkEnv + '" "' + $launcher + '" desktop') -WorkingDirectory $env:USERPROFILE
    $desktopPrincipal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    $desktopTriggers = @((New-ScheduledTaskTrigger -AtLogOn -User $sid), $trigger)
    Register-ScheduledTask -TaskName $desktopTaskName -Action $desktopAction -Trigger $desktopTriggers -Principal $desktopPrincipal -Settings $settings -Force | Out-Null
    Stop-ScheduledTask -TaskName $desktopTaskName -ErrorAction SilentlyContinue
    for ($i=0; $i -lt 50 -and (Get-ScheduledTask -TaskName $desktopTaskName).State -eq 'Running'; $i++) { Start-Sleep -Milliseconds 100 }
    if ((Get-ScheduledTask -TaskName $desktopTaskName).State -eq 'Running') { throw '旧桌面助手未能停止，已保留原安装' }
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    for ($i=0; $i -lt 50 -and (Get-ScheduledTask -TaskName $taskName).State -eq 'Running'; $i++) { Start-Sleep -Milliseconds 100 }
    if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') { throw '旧 Bot 进程未能停止，已保留原安装' }
    Write-Active @{release=$release;node=$node}
    Start-ScheduledTask -TaskName $taskName
    Start-ScheduledTask -TaskName $desktopTaskName
  } catch { Restore-Bot; throw }
} finally { $lock.Dispose() }
`;
}

export const windowsRollbackScript = management + 'Restore-Bot';
export const windowsCleanupScript = rootScript + String.raw`
$current = (Get-Content -LiteralPath (Join-Path $root 'current.json') -Encoding UTF8 -Raw | ConvertFrom-Json).release
$previous = ''; $file = Join-Path $root 'previous.json'
if (Test-Path -LiteralPath $file) { $previous = (Get-Content -LiteralPath $file -Encoding UTF8 -Raw | ConvertFrom-Json).release }
Get-ChildItem -LiteralPath (Join-Path $root 'releases') -Directory -Filter 'release-*' | Where-Object { $_.FullName -ne $current -and $_.FullName -ne $previous } | Remove-Item -Recurse -Force
`;
export function windowsControlScript(action) {
  return rootScript + (action === 'start'
    ? `$task = Get-ScheduledTask -TaskName $taskName
if ($task.Settings.Priority -ne 4) {
  $task.Settings.Priority = 4
  Set-ScheduledTask -TaskName $taskName -Settings $task.Settings | Out-Null
}
Enable-ScheduledTask -TaskName $taskName | Out-Null
Start-ScheduledTask -TaskName $taskName
if (Get-ScheduledTask -TaskName $desktopTaskName -ErrorAction SilentlyContinue) {Enable-ScheduledTask -TaskName $desktopTaskName | Out-Null;Start-ScheduledTask -TaskName $desktopTaskName}`
    : 'Disable-ScheduledTask -TaskName $taskName | Out-Null\nStop-ScheduledTask -TaskName $taskName\nif (Get-ScheduledTask -TaskName $desktopTaskName -ErrorAction SilentlyContinue) {Disable-ScheduledTask -TaskName $desktopTaskName | Out-Null;Stop-ScheduledTask -TaskName $desktopTaskName}');
}

export function windowsRoot(home) { return path.win32.join(home, '.local', 'share', 'hemi-bot'); }
