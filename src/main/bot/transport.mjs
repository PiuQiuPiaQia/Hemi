import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';
import { shq, sshFailureCopy } from '../remote/ssh-runner.mjs';
import { BOT_PROTOCOL, fail, botRpcTimeout } from './storage.mjs';
import { NODE_RUNTIME } from './node-runtime.mjs';
import { INSTALL_FAILURE_MARKER } from './install-dependencies.mjs';
import {readComponentVersion} from './component-version.mjs';
import {createRpcStream} from './rpc-stream.mjs';
import { powershellCommand, powershellSource, copyWindowsInput, psLiteral, windowsProbeScript, windowsCliScript, windowsDirectoryScript, windowsInstallScript, windowsRollbackScript, windowsCleanupScript, windowsControlScript, windowsRoot, windowsRootSetupScript } from './windows-transport.mjs';
const ROOT = '"$HOME/.local/share/hemi-bot"';
const probeScript = String.raw`set -eu
[ "$(uname -s)" = Linux ] || { echo '需要 Linux 服务器' >&2; exit 1; }
case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo '暂不支持此服务器架构' >&2; exit 1;; esac
systemctl --user show-environment >/dev/null 2>&1 || { echo '此账号不能使用 systemd 用户服务' >&2; exit 1; }
[ "$(loginctl show-user "$(id -u)" -p Linger --value)" = yes ] || { echo "需先执行 loginctl enable-linger $(id -un)，才能退出 SSH 后常驻" >&2; exit 1; }
[ -w "$HOME" ] || { echo '账号主目录不可写' >&2; exit 1; }
space=$(df -Pk "$HOME" | awk 'NR==2 {print $4}')
[ "$space" -gt 524288 ] || { echo '安装需要至少 512 MB 可用空间' >&2; exit 1; }
for tool in tar sha256sum base64; do command -v "$tool" >/dev/null || { echo "缺少 $tool" >&2; exit 1; }; done
root="$HOME/.local/share/hemi-bot"
nodebin="$root/runtime/bin/node"
if [ ! -x "$nodebin" ]; then nodebin=$(command -v node || true); fi
needed=1
version=''
if [ -n "$nodebin" ] && [ -x "$nodebin" ]; then
  version=$("$nodebin" -p process.version)
  if "$nodebin" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a===22&&b>=19?0:1)' && { command -v npm >/dev/null || [ -x "$root/runtime/bin/npm" ]; }; then needed=0; fi
fi
if [ "$needed" = 1 ]; then
  nodebin="$root/runtime/bin/node"
  command -v curl >/dev/null || command -v wget >/dev/null || { echo '缺少 curl 或 wget，无法部署私有运行环境' >&2; exit 1; }
fi
existing=0
if [ -e "$root/data/state.json" ] || [ -e "$root/current/src/main/bot/cli.mjs" ]; then existing=1; fi
emit(){ printf '__HB_%s=' "$1"; printf %s "$2" | base64 | tr -d '\n'; printf '\n'; }
emit home "$HOME"
emit arch "$arch"
emit node "$version"
emit nodeBin "$nodebin"
emit runtimeNeeded "$needed"
emit existing "$existing"`;

export function botServiceUnit(info) {
  return [
    '[Unit]',
    'Description=Hemi resident Bot',
    'After=network-online.target',
    '[Service]',
    'Type=simple',
    `ExecStart=${quoteSystemd(info.nodeBin)} ${quoteSystemd(path.posix.join(info.root, 'current/src/main/bot/cli.mjs'))} serve`,
    'WorkingDirectory=%h',
    `Environment=${quoteSystemd('PATH=' + path.posix.dirname(info.nodeBin) + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')}`,
    'Restart=on-failure',
    'RestartSec=3',
    'KillMode=control-group',
    'TimeoutStopSec=30',
    'UMask=0077',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
export function createBotTransport({ runner, archivePath }) {
  const platforms = new Map();
  const streamHosts = new Set(), channels = new Map();
  function closeChannel(host) {
    channels.get(host)?.close(); channels.delete(host);
  }
  const isWindows = host => platforms.get(host) === 'win32';
  const cliCommand = (host, mode, stdin, file) => isWindows(host)
    ? powershellCommand(windowsCliScript(mode, Buffer.byteLength(stdin), file))
    : `r=${ROOT}; n="$r/runtime/bin/node"; if [ ! -x "$n" ]; then n=$(command -v node); fi; exec "$n" "$r/current/src/main/bot/cli.mjs" ${mode}`;
  async function execute(host, command, stdin, timeoutMs = 30000, signal) {
    const r = await runner.exec({ host, command, stdin, timeoutMs, signal });
    if (r.connError || r.code === 255)
      fail(
        sshFailureCopy(r.connError, host),
        r.connError === 'hostkey'
          ? 'conflict'
          : r.connError === 'auth'
            ? 'permission'
            : 'offline',
      );
    if (r.aborted || r.timedOut)
      fail(
        '连接等待已结束，操作结果待核对；请重新连接查看云端状态。',
        'needs-review',
      );
    if (r.code !== 0) {
      const marker = String(r.stderr).split('\n').findLast(line => line.startsWith(INSTALL_FAILURE_MARKER));
      if (marker) {
        let detail;
        try { detail = JSON.parse(marker.slice(INSTALL_FAILURE_MARKER.length)); } catch {}
        if (detail) {
          const reasons = {
            network: '服务器下载 Bot 依赖失败，请检查 npm 源、网络或代理后重试。',
            npm: 'npm 安装进程异常，自动重试后仍未成功。',
            cache: 'Bot 依赖包校验失败，请检查服务器的 npm 源后重试。',
            disk: '服务器磁盘空间不足，请释放空间后重试。',
            permission: 'Bot 安装目录无法写入，请检查服务器账号权限。',
            lock: 'Bot 安装包的依赖清单不一致，请更新 Hemi 后重试。',
            timeout: 'Bot 依赖安装超时，请检查服务器网络和可用资源后重试。',
            other: 'Bot 依赖安装失败，请查看服务器上的安装日志。',
          };
          const log = typeof detail.logFile === 'string' && (path.posix.isAbsolute(detail.logFile) || path.win32.isAbsolute(detail.logFile)) ? ` 日志：${detail.logFile}` : '';
          fail((reasons[detail.kind] ?? reasons.other) + log, 'unsupported');
        }
      }
      fail(
        '服务器操作失败：' +
          String(r.stderr)
            .split('\n')
            .filter(
              (line) =>
                line && !line.includes('Ignoring unknown extended header'),
            )
            .slice(-6)
            .join(' ')
            .slice(-800),
        'unsupported',
      );
    }
    return r.stdout.toString('utf8');
  }
  async function executeWindows(host, script, stdin, timeoutMs, signal) {
    const command = powershellCommand(script);
    if (command.length < 7500) return execute(host, command, stdin, timeoutMs, signal);
    // cmd.exe's 8191-character limit also applies to OpenSSH's default shell.
    // Upload longer scripts over stdin before sending the binary runtime archive.
    const file = 'install-' + randomUUID() + '.ps1';
    const source = Buffer.from('\ufeff' + powershellSource(script));
    const location = `$r = Join-Path $env:USERPROFILE '.local\\share\\hemi-bot'; $file = Join-Path $r ${psLiteral(file)}`;
    await execute(host, powershellCommand(`${windowsRootSetupScript}\n${location}\n$stream = [IO.File]::Create($file)\ntry { ${copyWindowsInput('$stream', source.length)} } finally { $stream.Dispose() }`),
      source, 180000, signal);
    try {
      return await execute(host, powershellCommand(`${location}\n& $file`), stdin, timeoutMs, signal);
    } finally {
      await execute(host, powershellCommand(`${location}\nRemove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue`)).catch(() => {});
    }
  }
  const windowsFile = file => `Join-Path (Join-Path $env:USERPROFILE '.local\\share\\hemi-bot') ${psLiteral(file)}`;
  async function removeWindowsUpload(host, file) {
    await executeWindows(host, `Remove-Item -LiteralPath (${windowsFile(file)}) -Force -ErrorAction SilentlyContinue`).catch(() => {});
  }
  async function uploadWindows(host, bytes, signal) {
    const file = 'upload-' + randomUUID() + '.tmp';
    await executeWindows(host, `${windowsRootSetupScript}\n[IO.File]::WriteAllBytes((${windowsFile(file)}), (New-Object byte[] 0))`, undefined, 180000, signal);
    try {
      // Windows OpenSSH can stall command stdin at its channel window limit.
      // Bound each transfer and use ASCII base64 so console code pages and EOF
      // conventions cannot change archives, credentials or attachment bytes.
      for (let offset = 0; offset < bytes.length; offset += 48 * 1024) {
        const chunk = Buffer.from(bytes.subarray(offset, offset + 48 * 1024).toString('base64'));
        await executeWindows(host, `$encoded = New-Object IO.MemoryStream\n${copyWindowsInput('$encoded', chunk.length)}\n$bytes = [Convert]::FromBase64String([Text.Encoding]::ASCII.GetString($encoded.ToArray()))\n$stream = [IO.File]::Open((${windowsFile(file)}), 'Append', 'Write', 'None')\ntry { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose(); $encoded.Dispose() }`, chunk, 30000, signal);
      }
      return file;
    } catch (error) { await removeWindowsUpload(host, file); throw error; }
  }
  async function singleRpc(host, method, params = {}, options = {}) {
    const stdin = JSON.stringify({ method, params, clientId: options.clientId });
    const upload = isWindows(host) && Buffer.byteLength(stdin) > 64 * 1024 ? await uploadWindows(host, Buffer.from(stdin), options.signal) : null;
    try {
    const command = cliCommand(host, 'rpc', stdin, upload);
    const r = await runner.exec({
      host,
      command,
      stdin: upload ? null : stdin,
      timeoutMs: botRpcTimeout(method, params),
      signal: options.signal,
    });
    if (r.connError || r.code === 255)
      fail(
        sshFailureCopy(r.connError, host),
        r.connError === 'hostkey'
          ? 'conflict'
          : r.connError === 'auth'
            ? 'permission'
            : 'offline',
      );
    if (r.aborted || r.timedOut)
      fail('连接等待已结束，操作结果待核对。', 'needs-review');
    let data;
    try {
      data = JSON.parse(r.stdout.toString('utf8'));
    } catch {
      fail('没有收到完整云端回执，请重连核对结果。', 'needs-review');
    }
    if (!data.ok) fail(data.message, data.code);
    return data.result;
    } finally { if (upload) await removeWindowsUpload(host, upload); }
  }
  async function rpc(host, method, params = {}, options = {}) {
    const request = {method, params, clientId: options.clientId};
    let result;
    // Keep large Windows uploads on their bounded, staged path. Small control
    // requests share one process and are correlated independently of ordering.
    if (isWindows(host) && streamHosts.has(host) && Buffer.byteLength(JSON.stringify(request)) <= 60 * 1024) {
      let channel = channels.get(host);
      if (!channel || channel.closed) {
        channel = createRpcStream({start: callbacks => runner.exec({
          host, command: cliCommand(host, 'rpc-stream', ''), timeoutMs: 0, ...callbacks,
        })});
        channels.set(host, channel);
      }
      result = await channel.request(request, options);
    } else result = await singleRpc(host, method, params, options);
    if (method === 'handshake') {
      if (result.capabilities?.rpcStream === 1) streamHosts.add(host);
      else {streamHosts.delete(host); closeChannel(host);}
    }
    return result;
  }
  return {
    rpc,
    setPlatform(host, platform) { if (platform === 'win32' || platform === 'linux') platforms.set(host, platform); },
    async watch(host, params, {signal, onEvent, clientId}) {
      const controller=new AbortController(), decoder=new StringDecoder('utf8');
      const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)controller.abort();
      let pending='', lastFrame=Date.now();
      const heartbeat=setInterval(()=>{if(Date.now()-lastFrame>45000)controller.abort();},5000);heartbeat.unref?.();
      try {
        const stdin=JSON.stringify({params,clientId}), command=cliCommand(host, 'watch', stdin);
        const result=await runner.exec({host,command,stdin,timeoutMs:0,signal:controller.signal,onStdout(chunk){
          pending+=decoder.write(chunk);
          if(Buffer.byteLength(pending)>40*1024*1024)throw new Error('Bot event too large');
          let end;while((end=pending.indexOf('\n'))>=0){const raw=pending.slice(0,end);pending=pending.slice(end+1);if(!raw)continue;const frame=JSON.parse(raw);lastFrame=Date.now();onEvent(frame);}
        }});
        if(!signal?.aborted && (result.code!==0 || !result.aborted))fail('实时连接已断开，正在恢复。','offline');
      } finally {clearInterval(heartbeat);signal?.removeEventListener('abort',abort);}
    },
    disconnect() {
      for (const host of channels.keys()) closeChannel(host);
      streamHosts.clear();
      return runner.close?.();
    },
    async directory(host, raw = '~') {
      const requested = String(raw).trim();
      if (isWindows(host)) {
        if ((!/^[A-Za-z]:[\\/]/.test(requested) && requested !== '~' && !/^~[\\/]/.test(requested)) || requested.includes('\0'))
          fail('请输入 Windows 主机上的绝对文件夹路径，例如 C:\\Users。');
        const output = await executeWindows(host, windowsDirectoryScript(requested));
        let reply;
        try { reply = JSON.parse(output.split(/\r?\n/).findLast(line => line.startsWith('__HEMI_DIR_JSON__')).slice('__HEMI_DIR_JSON__'.length)); } catch { fail('服务器返回的目录列表不完整，请重试。', 'offline'); }
        if (reply.status === 'missing') fail('服务器上找不到这个文件夹，请选择其他文件夹。', 'missing');
        if (reply.status === 'not-directory') fail('这不是一个文件夹。', 'missing');
        if (reply.status === 'permission') fail('当前服务器账号没有访问这个文件夹的权限。', 'permission');
        if (reply.status !== 'ok' || !/^[A-Za-z]:[\\/]/.test(reply.path) || !/^[A-Za-z]:[\\/]/.test(reply.home) || !Array.isArray(reply.folders))
          fail('服务器返回的目录列表不完整，请重试。', 'offline');
        return {path: reply.path, parent: reply.parent, home: reply.home, folders: reply.folders.sort((a,b) => a.name.localeCompare(b.name)), truncated: reply.truncated};
      }
      if (
        (!requested.startsWith('/') && requested !== '~' && !requested.startsWith('~/')) ||
        requested.includes('\0')
      ) fail('请输入服务器上的绝对文件夹路径。');
      // Browse before Node/Host installation, using only the remote shell.
      // NUL records preserve spaces/newlines; no GNU find/head dependency.
      const script = `d=${shq(requested)}
case "$d" in '~') d="$HOME";; '~/'*) d="$HOME/\${d#??}";; esac
reply(){ printf '__HEMI_DIR_V1__\\000%s\\000' "$1"; }
if [ ! -e "$d" ]; then
  parent="$d"
  while [ ! -e "$parent" ] && [ "$parent" != / ]; do
    parent="\${parent%/*}"
    [ -n "$parent" ] || parent=/
  done
  if [ -d "$parent" ] && [ ! -x "$parent" ]; then reply permission; else reply missing; fi
  exit 0
fi
if [ ! -d "$d" ]; then reply not-directory; exit 0; fi
if [ ! -r "$d" ] || [ ! -x "$d" ]; then reply permission; exit 0; fi
if ! cd "$d"; then reply permission; exit 0; fi
printf '__HEMI_DIR_V1__\\000ok\\000%s\\000%s\\000' "$(pwd -P)" "$HOME"
count=0
for folder in ./*; do
  [ -d "$folder" ] || continue
  printf '%s\\000' "$folder"
  count=$((count + 1))
  [ "$count" -lt 1001 ] || break
done
`;
      const output = await execute(host, script), marker = '__HEMI_DIR_V1__\0';
      const start = output.indexOf(marker);
      if (start < 0) fail('服务器未返回目录列表，请重试。', 'offline');
      const [status, current, home, ...entries] = output.slice(start + marker.length).split('\0');
      if (status === 'missing') fail('服务器上找不到这个文件夹，请选择其他文件夹。', 'missing');
      if (status === 'not-directory') fail('这不是一个文件夹。', 'missing');
      if (status === 'permission') fail('当前服务器账号没有访问这个文件夹的权限。', 'permission');
      if (status !== 'ok' || !current?.startsWith('/') || !home?.startsWith('/') || !output.endsWith('\0'))
        fail('服务器返回的目录列表不完整，请重试。', 'offline');
      const folders = entries.filter(Boolean);
      return {
        path: current,
        parent: path.posix.dirname(current),
        home,
        folders: folders.slice(0, 1000).map(name => ({
          name: path.posix.basename(name),
          path: path.posix.join(current, name),
        })).sort((a, b) => a.name.localeCompare(b.name)),
        truncated: folders.length > 1000,
      };
    },
    async probe(host) {
      let platform;
      try {
        const name = (await execute(host, 'uname -s')).trim();
        if (name === 'Linux') platform = 'linux';
        else if (!/^MINGW|^MSYS|^CYGWIN/.test(name)) fail('Bot 主机需要 Linux 或 Windows x64。', 'unsupported');
      } catch (error) { if (error.code !== 'unsupported') throw error; }
      const raw = platform === 'linux' ? await execute(host, probeScript) : await executeWindows(host, windowsProbeScript),
        fields = {};
      for (const line of raw.split('\n')) {
        const match = /^__HB_(\w+)=(.*)$/.exec(line.trim());
        if (match)
          fields[match[1]] = Buffer.from(match[2], 'base64').toString('utf8');
      }
      platform = fields.platform ?? platform;
      if (!fields.home || !(platform === 'win32' ? NODE_RUNTIME.win32[fields.arch] : NODE_RUNTIME[fields.arch]))
        fail('服务器探测未返回完整结果。');
      const info = {
        ...fields,
        platform,
        root: platform === 'win32' ? windowsRoot(fields.home) : path.posix.join(fields.home, '.local/share/hemi-bot'),
        existing: fields.existing === '1',
        runtimeNeeded: fields.runtimeNeeded === '1',
      };
      platforms.set(host, platform);
      if (info.existing) {
        try {
          info.bot = await rpc(host, 'handshake');
          if (info.bot.protocol !== BOT_PROTOCOL)
            fail('Bot 协议版本不兼容，请先维护云端组件。', 'unsupported');
        } catch (error) {
          if (error.code === 'unsupported') throw error;
          info.serviceError = '检测到已有 Bot，但服务尚未就绪。';
        }
      }
      return info;
    },
    async install(host, info, signal) {
      closeChannel(host); streamHosts.delete(host);
      if (info.platform) platforms.set(host, info.platform);
      if (info.existing && !info.bot)
        fail('已有安装无法核对身份，停止覆盖。请先修复原服务。', 'conflict');
      if (info.bot?.activeJobs) fail('请等待云端任务结束后更新组件。', 'busy');
      const archive = await fs.readFile(archivePath),
        release = 'release-' + randomUUID(),
        digest = createHash('sha256').update(archive).digest('hex');
      const expected = readComponentVersion(archivePath + '.manifest.json');
      if (expected?.archiveSha256 && expected.archiveSha256 !== digest)
        fail('本机组件包与版本清单不一致，请重新生成组件包后重试。', 'conflict');
      const artifact = `node-v${NODE_RUNTIME.version}-linux-${info.arch}`;
      const runtime = info.runtimeNeeded
        ? `mkdir -p "$r/runtimes"\nfile="$r/runtimes/${artifact}.tar.xz"\nurl=${shq(`https://nodejs.org/dist/v${NODE_RUNTIME.version}/${artifact}.tar.xz`)}\nif command -v curl >/dev/null; then curl --fail --location --retry 2 --max-time 150 "$url" -o "$file"; else wget -T 150 -O "$file" "$url"; fi\nprintf '%s  %s\\n' ${shq(NODE_RUNTIME[info.arch])} "$file" | sha256sum -c -\ntar -xJf "$file" -C "$r/runtimes"\nln -sfn "$r/runtimes/${artifact}" "$r/runtime"\nrm -f "$file"\n`
        : '';
      const script = `set -eu
umask 077
r=${ROOT}
mkdir -p "$r"
mkdir "$r/install.lock" || { echo '另一项安装仍在进行，请稍后重新检测' >&2; exit 1; }
trap 'rmdir "$r/install.lock" 2>/dev/null || true' EXIT HUP INT TERM
mkdir -p "$r/releases/${release}" "$HOME/.config/systemd/user"
cat > "$r/releases/${release}/runtime.tgz"
printf '%s  %s\\n' ${shq(digest)} "$r/releases/${release}/runtime.tgz" | sha256sum -c -
${runtime}export PATH=${shq(path.posix.dirname(info.nodeBin))}:"$r/runtime/bin:$PATH"
tar -xzf "$r/releases/${release}/runtime.tgz" -C "$r/releases/${release}"
cd "$r/releases/${release}"
${shq(info.nodeBin)} src/main/bot/install-dependencies.mjs "$r"
${shq(info.nodeBin)} --check src/main/bot/cli.mjs
old=$(readlink "$r/current" || true)
printf %s "$old" > "$r/previous-release"
if [ -e "$HOME/.config/systemd/user/hemi-bot.service" ]; then cp "$HOME/.config/systemd/user/hemi-bot.service" "$r/previous.service"; fi
printf %s ${shq(botServiceUnit(info))} > "$HOME/.config/systemd/user/hemi-bot.service"
ln -s "$r/releases/${release}" "$r/current.next"
mv -Tf "$r/current.next" "$r/current"
systemctl --user daemon-reload
if ! systemctl --user enable hemi-bot || ! systemctl --user restart hemi-bot; then
  if [ -n "$old" ]; then ln -sfn "$old" "$r/current"; if [ -e "$r/previous.service" ]; then cp "$r/previous.service" "$HOME/.config/systemd/user/hemi-bot.service"; fi; systemctl --user daemon-reload; systemctl --user restart hemi-bot; fi
  exit 1
fi
`;
      if (isWindows(host)) {
        const inputFile = await uploadWindows(host, archive, signal);
        try { await executeWindows(host, windowsInstallScript(info, {release, digest, inputFile}), undefined, 1200000, signal); }
        finally { await removeWindowsUpload(host, inputFile); }
      }
      else await execute(host, script, archive, 600000, signal);
      let last;
      for (let i = 0; i < (isWindows(host) ? 60 : 12); i++) {
        try {
          const bot = await rpc(host, 'handshake');
          if (
            bot.protocol !== BOT_PROTOCOL ||
            (expected && bot.componentVersion?.build !== expected.build) ||
            (info.bot && bot.instanceId !== info.bot.instanceId)
          )
            fail('安装后的协议或实例身份不兼容。', 'unsupported');
          // Keep the running and previous release; user data lives outside releases.
          await (isWindows(host) ? executeWindows(host, windowsCleanupScript) : execute(
            host,
            `set -eu; r=${ROOT}; current=$(readlink "$r/current"); previous=$(cat "$r/previous-release" 2>/dev/null || true); for release in "$r"/releases/release-*; do [ -d "$release" ] || continue; [ "$release" = "$current" ] && continue; [ "$release" = "$previous" ] && continue; rm -rf -- "$release"; done`,
          )).catch(() => {});
          return bot;
        } catch (error) {
          last = error;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (info.bot) {
        await (isWindows(host) ? executeWindows(host, windowsRollbackScript) : execute(
          host,
          `set -eu; r=${ROOT}; old=$(cat "$r/previous-release"); case "$old" in "$r"/releases/*) ;; *) exit 1;; esac; ln -sfn "$old" "$r/current"; if [ -e "$r/previous.service" ]; then cp "$r/previous.service" "$HOME/.config/systemd/user/hemi-bot.service"; fi; systemctl --user daemon-reload; systemctl --user restart hemi-bot`,
        ));
        fail(
          '新组件未通过握手，已切回上一版本；请重新连接核对。',
          'needs-review',
        );
      }
      if (isWindows(host)) await executeWindows(host, windowsControlScript('stop')).catch(() => {});
      throw last;
    },
    async control(host, action) {
      if (!['start', 'stop'].includes(action)) fail('无效的服务操作。');
      closeChannel(host); streamHosts.delete(host);
      await (isWindows(host) ? executeWindows(host, windowsControlScript(action)) : execute(
        host,
        `systemctl --user ${action === 'start' ? 'enable --now' : 'disable --now'} hemi-bot`,
      ));
      if (action === 'start') {
        let last;
        for (let i = 0; i < (isWindows(host) ? 60 : 16); i++) {
          try {
            const hello = await rpc(host, 'handshake');
            if (hello.protocol !== BOT_PROTOCOL)
              fail('Bot 协议不兼容。', 'unsupported');
            return { ok: true };
          } catch (error) {
            if (['conflict', 'permission', 'unsupported'].includes(error.code))
              throw error;
            last = error;
            await new Promise((r) => setTimeout(r, 400));
          }
        }
        throw last;
      }
      return { ok: true };
    },
  };
}
function quoteSystemd(value) {
  return (
    '"' +
    String(value)
      .replace(/%/g, '%%')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"') +
    '"'
  );
}
