import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {parseEnv} from 'node:util';
import { atomicJson, privateDirectory } from './storage.mjs';

export const INSTALL_FAILURE_MARKER = '__HEMI_BOT_NPM_FAILURE__';
const MIRROR_REGISTRY = 'https://registry.npmmirror.com/';
const PROXY_KEY = /^(?:https?_proxy|all_proxy|no_proxy|proxy|npm_config_(?:https?[-_]proxy|proxy|noproxy))$/i;

export async function readShellProxyEnvironment({ env = process.env, timeoutMs = 5000, platform = process.platform, run = execFile } = {}) {
  if (platform === 'win32') {
    // OpenSSH's service can inherit an older environment than the user's proxy
    // configuration. Probe only proxy values in this cloud Windows account.
    const script = `
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$values = @{}
foreach ($scope in @('Machine','User')) {
  foreach ($entry in [Environment]::GetEnvironmentVariables($scope).GetEnumerator()) {
    if ($entry.Key -match '^(https?_proxy|all_proxy|no_proxy|npm_config_(https?[-_]proxy|proxy|noproxy))$') { $values[$entry.Key] = [string]$entry.Value }
  }
}
if (!$values.ContainsKey('HTTP_PROXY') -and !$values.ContainsKey('HTTPS_PROXY') -and !$values.ContainsKey('ALL_PROXY')) {
  $systemProxy = [Net.WebRequest]::GetSystemWebProxy()
  foreach ($scheme in @('http','https')) {
    $uri = [Uri]($scheme + '://registry.npmjs.org/')
    $proxy = $systemProxy.GetProxy($uri)
    if ($proxy -and $proxy -ne $uri) { $values[$scheme + '_proxy'] = $proxy.AbsoluteUri }
  }
}
$values | ConvertTo-Json -Compress
`;
    const powershell = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    return new Promise(resolve => run(powershell, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {env,timeout:timeoutMs,maxBuffer:64*1024,windowsHide:true}, (error, stdout) => {
      if (error) return resolve({});
      try {resolve(Object.fromEntries(Object.entries(JSON.parse(stdout)).filter(([key,value]) => PROXY_KEY.test(key) && typeof value === 'string')));}
      catch {resolve({});}
    }));
  }
  const shell = env.SHELL || '/bin/bash';
  if (!path.isAbsolute(shell) || !['bash', 'zsh', 'sh', 'dash', 'ksh'].includes(path.basename(shell))) return {};
  // SSH's non-interactive shell may return before the proxy exports in .bashrc.
  // Read only proxy variables; shell banners and other credentials stay local.
  const marker = '__HEMI_PROXY_ENV__';
  const script = `console.log(${JSON.stringify('\n' + marker)}+JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key])=>${PROXY_KEY}.test(key)))))`;
  return new Promise(resolve => {
    const child = execFile(shell, ['-lic', 'exec "$1" -e "$2"', 'hemi-bot-proxy', process.execPath, script], {
      env, cwd: env.HOME || '/', detached: process.platform !== 'win32', maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      clearTimeout(timer);
      if (error) return resolve({});
      try {
        const line = stdout.split('\n').findLast(line => line.startsWith(marker));
        const values = JSON.parse(line.slice(marker.length));
        resolve(Object.fromEntries(Object.entries(values).filter(([key, value]) => PROXY_KEY.test(key) && typeof value === 'string')));
      } catch { resolve({}); }
    });
    const timer = setTimeout(() => {
      // Startup files may wait on another process that holds the stdout pipe.
      // Bound the whole probe, including those children, rather than just bash.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
  });
}

function proxyEnvironment(env) {
  const result = { ...env };
  // npm handles HTTP(S)_PROXY but does not read ALL_PROXY itself (including SOCKS).
  const all = env.all_proxy || env.ALL_PROXY;
  const http = env.http_proxy || env.HTTP_PROXY || all;
  const https = env.https_proxy || env.HTTPS_PROXY || http;
  if (https) result.https_proxy = result.HTTPS_PROXY = https;
  if (http) result.http_proxy = result.HTTP_PROXY = http;
  return result;
}

function shellProxyEnvironment(env, shellProxy) {
  const proxy = proxyEnvironment(shellProxy);
  const result = { ...env, ...proxy };
  // A second route should use the detected shell proxy even if an old npmrc
  // proxy made the first route fail. Environment options override npmrc locally.
  for (const [key, value] of [['proxy', proxy.http_proxy], ['https_proxy', proxy.https_proxy]]) {
    if (!value) continue;
    const config = 'npm_config_' + key;
    if (Object.keys(shellProxy).some(name => name.toLowerCase().replaceAll('-', '_') === config)) continue;
    for (const name of Object.keys(result)) {
      if (name.toLowerCase().replaceAll('-', '_') === config) delete result[name];
    }
    result[config] = value;
  }
  return proxyEnvironment(result);
}

export function classifyInstallFailure(output) {
  if (/\b(?:ENOSPC|EDQUOT)\b/i.test(output)) return 'disk';
  if (/\b(?:EACCES|EPERM)\b/i.test(output)) return 'permission';
  if (/\b(?:EUSAGE|ELOCKVERIFY)\b|lock file.*(?:in sync|invalid)/i.test(output)) return 'lock';
  if (/\b(?:EINTEGRITY|TAR_BAD_ARCHIVE)\b/i.test(output)) return 'cache';
  if (/\b(?:E401|E403|E404|ETARGET|ENOVERSIONS)\b/i.test(output)) return 'other';
  if (/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|E50[0234])\b/i.test(output)) return 'network';
  if (/Exit handler never called/i.test(output)) return 'npm';
  return 'other';
}

function npmEntry() {
  // Invoke npm's JS entry with the selected Node, including distro symlinks.
  // An unrelated npm on PATH must not choose another Node through its shebang.
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue;
    if (process.platform === 'win32') {
      const entry = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (fs.existsSync(entry)) return entry;
      continue;
    }
    const candidate = path.join(dir, 'npm');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const real = fs.realpathSync(candidate);
      if (/\.[cm]?js$/.test(real) || /^#![^\n]*\bnode\b/.test(fs.readFileSync(real, 'utf8').slice(0, 200))) return real;
    } catch {}
  }
  throw new Error('没有找到可用的 npm，请检查服务器运行环境。');
}

async function attempt({ directory, npmCli, cache, logDir, number, timeoutMs, env, registry, direct = false }) {
  const logFile = path.join(logDir, `${number}.log`);
  const npmLogs = path.join(logDir, `${number}-npm`);
  privateDirectory(npmLogs);
  const fd = fs.openSync(logFile, 'wx', 0o600);
  let tail = '', timedOut = false, killTimer, child, writeError;
  const append = value => {
    const text = String(value);
    tail = (tail + text).slice(-512 * 1024);
    try { fs.writeSync(fd, text); } catch (error) {
      writeError = error;
      child?.kill('SIGTERM');
    }
  };
  try {
    // npm already implements HTTPS_PROXY. Node's native proxy layer can wrap
    // npm's proxy connection again, so disable it only for this child.
    const npmEnv = { ...env, PATH: path.dirname(process.execPath) + path.delimiter + (env.PATH ?? '') };
    delete npmEnv.NODE_USE_ENV_PROXY;
    const nodeArgs = process.allowedNodeEnvironmentFlags.has('--use-env-proxy') ? ['--no-use-env-proxy'] : [];
    child = spawn(process.execPath, [...nodeArgs, npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress', '--update-notifier=false',
      '--cache', cache, '--logs-dir', npmLogs, '--fetch-retries=' + (direct ? 0 : 1), '--fetch-retry-mintimeout=1000',
      '--fetch-retry-maxtimeout=5000', '--fetch-timeout=' + (direct ? 8000 : 20000), '--maxsockets=4', '--strict-ssl=true',
      ...(registry ? ['--registry', registry, '--replace-registry-host=registry.npmjs.org'] : []),
      ...(direct || registry ? ['--proxy=false', '--https-proxy=null'] : [])], {
      cwd: directory,
      env: npmEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);
    let code;
    try {
      code = await new Promise(resolve => {
        child.on('error', error => append(error.message));
        child.on('close', resolve);
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
    }
    if (code !== 0) {
      // npm sometimes prints only its exit-handler error on stderr; the actual
      // fetch/disk error is in its debug log. Preserve a bounded tail privately.
      for (const name of fs.readdirSync(npmLogs).filter(name => name.endsWith('.log')).sort().slice(-2)) {
        let debug;
        try {
          debug = fs.openSync(path.join(npmLogs, name), 'r');
          const size = fs.fstatSync(debug).size, bytes = Buffer.alloc(Math.min(size, 256 * 1024));
          fs.readSync(debug, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
          append('\n[npm debug log]\n' + bytes.toString('utf8'));
        } catch {} finally { if (debug !== undefined) fs.closeSync(debug); }
      }
    }
    return { code: writeError ? 1 : code, kind: writeError ? classifyInstallFailure(writeError.code) : timedOut ? 'timeout' : classifyInstallFailure(tail), logFile };
  } finally {
    fs.closeSync(fd);
  }
}

export function reuseBotDependencies({root, directory, reuseFrom}) {
  if (!reuseFrom) return false;
  let source, target;
  try {
    const releases = fs.realpathSync(path.join(root, 'releases'));
    source = fs.realpathSync(reuseFrom);
    const relative = path.relative(releases, source);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return false;
    if (source === fs.realpathSync(directory)) return false;
    for (const name of ['package.json', 'package-lock.json'])
      if (!fs.readFileSync(path.join(source, name)).equals(fs.readFileSync(path.join(directory, name)))) return false;
    const modules = path.join(source, 'node_modules');
    // npm's completed installation marker and every direct dependency must
    // exist. An interrupted or changed installation falls back to npm ci.
    JSON.parse(fs.readFileSync(path.join(modules, '.package-lock.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const installed = JSON.parse(fs.readFileSync(path.join(modules, name, 'package.json'), 'utf8'));
      const version = lock.packages?.['node_modules/' + name]?.version;
      if (typeof version !== 'string' || installed.version !== version) return false;
    }
    target = path.join(directory, 'node_modules');
    if (fs.existsSync(target)) return false;
    // Copy, not hard-link: a failed update or later npm operation must never
    // modify the still-running release or the rollback copy.
    fs.cpSync(modules, target, {recursive: true, verbatimSymlinks: true});
    return true;
  } catch {
    if (target) fs.rmSync(target, {recursive: true, force: true});
    return false;
  }
}

export async function installBotDependencies({
  root, directory = process.cwd(), npmCli = npmEntry(), timeoutMs = process.platform === 'win32' ? 300000 : 90000,
  env = process.env, loadShellProxy = readShellProxyEnvironment, mirrorRegistry = MIRROR_REGISTRY, reuseFrom,
}) {
  const logDir = path.join(root, 'install-logs', 'install-' + randomUUID());
  const cache = path.join(root, 'npm-cache');
  privateDirectory(logDir);
  privateDirectory(cache);
  const attempts = [];
  if (reuseBotDependencies({root, directory, reuseFrom})) {
    attempts.push({code: 0, strategy: 'reuse'});
    atomicJson(path.join(logDir, 'result.json'), {node: process.version, attempts});
    return {logDir, attempts};
  }
  // Read the cloud Bot's own network file on both platforms. Values explicitly
  // supplied to this process retain precedence, matching Node's env-file flag.
  let network = {};
  try {network = parseEnv(fs.readFileSync(path.join(root, 'network.env'), 'utf8'));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  const explicitKeys = new Set(Object.keys(env).map(key => key.toLowerCase().replaceAll('-','_')));
  env = {...Object.fromEntries(Object.entries(network).filter(([key]) => PROXY_KEY.test(key) && !explicitKeys.has(key.toLowerCase().replaceAll('-','_')))), ...env};
  const directEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !PROXY_KEY.test(key)));
  let installEnv = directEnv, strategy = 'direct';
  for (let number = 1; number <= 3; number++) {
    const registry = number === 3 ? mirrorRegistry : undefined;
    const currentCache = number === 1 ? cache : path.join(logDir, `retry-cache-${number}`);
    privateDirectory(currentCache);
    let result;
    try {
      const started = Date.now();
      result = await attempt({ directory, npmCli, cache: currentCache, logDir, number, timeoutMs, env: installEnv, registry, direct:strategy === 'direct' || strategy === 'retry' });
      result.durationMs = Date.now() - started;
    } finally {
      // Keep diagnostics, not another full dependency cache after every retry.
      if (number > 1) {
        try { fs.rmSync(currentCache, { recursive: true, force: true }); } catch {}
      }
    }
    attempts.push({ ...result, strategy });
    atomicJson(path.join(logDir, 'result.json'), { node: process.version, attempts });
    if (result.code === 0) {
      return { logDir, attempts };
    }
    // Repeating npm ci is safe here: scripts are disabled and this release is
    // not active yet. Permanent failures must not trigger network fallbacks.
    if (number === 3 || !['npm', 'network', 'cache'].includes(result.kind) || (number === 2 && result.kind === 'cache')) {
      throw Object.assign(new Error('Bot 依赖安装失败。'), { kind: result.kind, logFile: result.logFile });
    }
    if (number === 1) {
      const configured = proxyEnvironment(env);
      const hasProxy = values => Object.entries(values).some(([key,value]) => PROXY_KEY.test(key) && !/no_?proxy$/i.test(key) && value);
      const shellProxy = ['npm', 'network'].includes(result.kind)
        ? hasProxy(configured) ? Object.fromEntries(Object.entries(configured).filter(([key]) => PROXY_KEY.test(key))) : await loadShellProxy({env}) : {};
      installEnv = hasProxy(shellProxy) ? shellProxyEnvironment(env, shellProxy) : directEnv;
      strategy = hasProxy(shellProxy) ? 'server-proxy' : 'retry';
    } else {
      // The mirror is a final direct route, so a dead local proxy cannot block
      // it too. Override npmrc proxies only for this child; keep TLS and SRI.
      installEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !PROXY_KEY.test(key)));
      strategy = 'npmmirror';
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    await installBotDependencies({ root: process.argv[2], reuseFrom: process.argv[3] });
  } catch (error) {
    process.stderr.write(INSTALL_FAILURE_MARKER + JSON.stringify({ kind: error.kind ?? classifyInstallFailure(error.code ?? ''), logFile: error.logFile ?? null }) + '\n');
    process.exitCode = 1;
  }
}
