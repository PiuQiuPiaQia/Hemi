import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { shq, sshFailureCopy } from '../remote/ssh-runner.mjs';
import { BOT_PROTOCOL, fail, botRpcTimeout } from './storage.mjs';
import { NODE_RUNTIME } from './node-runtime.mjs';
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
    if (r.code !== 0)
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
    return r.stdout.toString('utf8');
  }
  async function rpc(host, method, params = {}, options = {}) {
    const command = `r=${ROOT}; n="$r/runtime/bin/node"; if [ ! -x "$n" ]; then n=$(command -v node); fi; exec "$n" "$r/current/src/main/bot/cli.mjs" rpc`;
    const r = await runner.exec({
      host,
      command,
      stdin: JSON.stringify({ method, params }),
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
  }
  return {
    rpc,
    disconnect: () => runner.close(),
    async directory(host, raw = '~') {
      const requested = String(raw).trim();
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
      const raw = await execute(host, probeScript),
        fields = {};
      for (const line of raw.split('\n')) {
        const match = /^__HB_(\w+)=(.*)$/.exec(line);
        if (match)
          fields[match[1]] = Buffer.from(match[2], 'base64').toString('utf8');
      }
      if (!fields.home || !NODE_RUNTIME[fields.arch])
        fail('服务器探测未返回完整结果。');
      const info = {
        ...fields,
        platform: 'linux',
        root: path.posix.join(fields.home, '.local/share/hemi-bot'),
        existing: fields.existing === '1',
        runtimeNeeded: fields.runtimeNeeded === '1',
      };
      if (info.existing) {
        try {
          info.bot = await rpc(host, 'handshake');
          if (info.bot.protocol !== BOT_PROTOCOL)
            fail('Bot 协议版本不兼容，请先维护云端组件。', 'unsupported');
        } catch (error) {
          if (error.code === 'unsupported') throw error;
          info.serviceError =
            '检测到已有安装，但服务未能响应。请先检查 systemctl --user status hemi-bot';
        }
      }
      return info;
    },
    async install(host, info, signal) {
      if (info.existing && !info.bot)
        fail('已有安装无法核对身份，停止覆盖。请先修复原服务。', 'conflict');
      if (info.bot?.activeJobs) fail('请等待云端任务结束后更新组件。', 'busy');
      const archive = await fs.readFile(archivePath),
        release = 'release-' + randomUUID(),
        digest = createHash('sha256').update(archive).digest('hex');
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
${runtime}export PATH="$r/runtime/bin:$PATH"
tar -xzf "$r/releases/${release}/runtime.tgz" -C "$r/releases/${release}"
cd "$r/releases/${release}"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund >&2
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
      await execute(host, script, archive, 600000, signal);
      let last;
      for (let i = 0; i < 12; i++) {
        try {
          const bot = await rpc(host, 'handshake');
          if (
            bot.protocol !== BOT_PROTOCOL ||
            (info.bot && bot.instanceId !== info.bot.instanceId)
          )
            fail('安装后的协议或实例身份不兼容。', 'unsupported');
          // Keep the running and previous release; user data lives outside releases.
          await execute(
            host,
            `set -eu; r=${ROOT}; current=$(readlink "$r/current"); previous=$(cat "$r/previous-release" 2>/dev/null || true); for release in "$r"/releases/release-*; do [ -d "$release" ] || continue; [ "$release" = "$current" ] && continue; [ "$release" = "$previous" ] && continue; rm -rf -- "$release"; done`,
          ).catch(() => {});
          return bot;
        } catch (error) {
          last = error;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (info.bot) {
        await execute(
          host,
          `set -eu; r=${ROOT}; old=$(cat "$r/previous-release"); case "$old" in "$r"/releases/*) ;; *) exit 1;; esac; ln -sfn "$old" "$r/current"; if [ -e "$r/previous.service" ]; then cp "$r/previous.service" "$HOME/.config/systemd/user/hemi-bot.service"; fi; systemctl --user daemon-reload; systemctl --user restart hemi-bot`,
        );
        fail(
          '新组件未通过握手，已切回上一版本；请重新连接核对。',
          'needs-review',
        );
      }
      throw last;
    },
    async control(host, action) {
      if (!['start', 'stop'].includes(action)) fail('无效的服务操作。');
      await execute(
        host,
        `systemctl --user ${action === 'start' ? 'enable --now' : 'disable --now'} hemi-bot`,
      );
      if (action === 'start') {
        let last;
        for (let i = 0; i < 16; i++) {
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
