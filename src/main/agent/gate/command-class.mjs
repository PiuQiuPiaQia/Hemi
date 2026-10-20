/**
 * 052 R-02 · 命令风险分级器——纯函数，无执行逻辑。
 *
 * classifyCommand(command) → 'read' | 'write' | 'unknown'：
 * 整条命令（含管道、`;`、`&&`、`||`、换行）每段都是只读才算 'read'；
 * 已知写命令或任何写形态（重定向、tee、sed -i、find -exec/-delete…）→ 'write'；
 * 未知命令保守归 'unknown'（不归 read——白名单的定位是减少打扰，不是安全边界）。
 *
 * 消费方：access-policy 的任务边界判定（R-07：readonly 边界下非 read 直接拒）、
 * R-06 远端敏感读取（detectRemoteSecretRead）、Q4 系统目录覆盖写目标提取
 * （systemConfigOverwriteTargets）、离线回放评估（技术方案 S1）。
 */

/** sudo 自身选项（带参选项连参数一起吃掉；与 policy.mjs 的 SUDO_OPT 同语法，独立复制避免耦合）。 */
const SUDO_OPT =
  '(?:-[a-z]*[ugprtcd][ \\t]+[^\\s;|&]+' +
  '|--(?:user|group|prompt|role|type|close-from|chdir|chroot|other-user|command-timeout)[ \\t]+[^\\s;|&]+' +
  '|--[a-z][a-z-]*(?:=[^\\s;|&]+)?' +
  '|-[a-z]+)';

/**
 * 只读首词表（保守收录：确定无副作用的查询与过滤类）。
 * 子命令限读的命令（systemctl/docker/nginx/openssl/git…）在 READ_SUBCOMMANDS 展开。
 */
const READ_FIRST_WORDS = new Set([
  // 目录与文件查看
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'stat', 'file', 'wc', 'du', 'df',
  'tree', 'basename', 'dirname', 'realpath', 'readlink', 'pwd', 'mdfind',
  // 搜索
  'grep', 'egrep', 'fgrep', 'rg', 'find', 'locate',
  // 过滤与格式化（无重定向时只消费 stdin、产 stdout）
  'cut', 'sort', 'uniq', 'tr', 'rev', 'column', 'awk', 'sed', 'jq', 'nl', 'paste',
  'expand', 'fold', 'strings', 'iconv',
  // 摘要与编码查看
  'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum', 'xxd', 'od', 'base64',
  // 系统/进程/网络查询
  'ps', 'ss', 'lsof', 'top', 'htop', 'free', 'uptime', 'w', 'who', 'last', 'id',
  'whoami', 'groups', 'uname', 'hostname', 'hostnamectl', 'arch', 'nproc',
  'sw_vers', 'system_profiler', 'sysctl', 'vm_stat', 'dmesg', 'journalctl',
  'lsblk', 'blkid', 'iostat', 'vmstat', 'netstat', 'ifconfig', 'lscpu', 'lsmod',
  'dig', 'nslookup', 'host', 'getent', 'dscacheUtil',
  // 环境与杂项（无副作用）
  'printenv', 'env', 'locale', 'date', 'cal', 'echo', 'printf', 'true', 'false',
  'test', 'sleep', 'seq',
  // 版本与路径查询
  'which', 'whatis', 'apropos',
]);

/**
 * 首词限子命令的只读形态：命令 → 允许的只读子命令（小写，含短 flag 形态）。
 * 不在子命令表里的形态按 WRITE_FIRST_WORDS/unknown 处理（docker run、git push 不算只读）。
 */
const READ_SUBCOMMANDS = {
  systemctl: ['status', 'list-units', 'list-unit-files', 'show', 'is-active', 'is-enabled', 'is-failed', 'cat', 'list-timers', 'list-sockets', 'help'],
  docker: ['ps', 'inspect', 'logs', 'images', 'version', 'info', 'stats', 'port', 'top', 'diff', 'events'],
  nginx: ['-t', '-v', '-vv', '-t;', '-v;'],
  openssl: ['x509', 'version'],
  git: ['status', 'log', 'diff', 'show', 'blame', 'describe', 'shortlog', 'reflog', 'rev-parse', 'ls-files'],
  crontab: ['-l', '--list'],
  ip: ['addr', 'a', 'address', 'link', 'l', 'route', 'r', 'neigh', 'n'],
  apt: ['list', 'search', 'show', 'policy'],
  dpkg: ['-l', '--list', '-s', '--status', '-l;', '--listfiles', '-s;'],
  pkgutil: ['--pkgs', '--pkg-info', '--files', '--vars'],
};

/** docker 的复合只读子命令（docker volume ls / docker network inspect 等）。 */
const DOCKER_NESTED_READONLY = new Map([
  ['volume', new Set(['ls', 'list', 'inspect'])],
  ['network', new Set(['ls', 'list', 'inspect'])],
  ['image', new Set(['ls', 'list', 'inspect', 'history'])],
  ['container', new Set(['ls', 'list', 'inspect', 'logs', 'top', 'diff', 'stats'])],
]);

/** 已知写/有副作用命令首词（分级 'write'；不在两表里的未知命令归 'unknown'）。 */
const WRITE_FIRST_WORDS = new Set([
  'rm', 'cp', 'mv', 'ln', 'mkdir', 'rmdir', 'touch', 'truncate', 'shred', 'install',
  'tee', 'dd', 'chmod', 'chown', 'chgrp', 'chattr', 'setfacl',
  'mkfs', 'mkfs.ext4', 'mkfs.xfs', 'swapon', 'swapoff',
  'kill', 'pkill', 'killall',
  'reboot', 'shutdown', 'halt', 'poweroff', 'init',
  'systemctl', 'docker', 'kubectl', 'podman', 'nginx',
  'apt-get', 'apt', 'yum', 'dnf', 'pacman', 'apk', 'dpkg', 'brew', 'npm', 'pip', 'pip3', 'gem',
  'git', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'sftp',
  'mysql', 'psql', 'sqlite3', 'redis-cli', 'mongo', 'mongosh',
  'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'passwd',
  'iptables', 'nft', 'ufw', 'firewall-cmd', 'sysctl',
  'launchctl', 'defaults', 'pmset', 'networksetup', 'nvram',
  'perl', 'python', 'python3', 'node', 'bash', 'sh', 'zsh', 'eval', 'source', 'xargs',
  'open', 'osascript', 'caffeinate', 'say', 'afplay', 'pbcopy', 'pbpaste',
  'supervisorctl', 'nginxctl',
  'gzip', 'gunzip', 'tar', 'zip', 'unzip', 'bzip2', 'xz',
]);

/** 写形态一票否决（在遮蔽引号后的段落文本上匹配；sed -i 在 segmentClass 里按首词判）。 */
const WRITE_FORM_PATTERNS = [
  /(?:^|[^>])>{1,2}(?!&)\s*\S/, // > file / >> file（>&fd 不算；任意输出重定向都摘掉只读）
  /<(?![(<])\s*\S/, // < file 输入重定向（进程替换 <( 与 heredoc << 除外）
  /\btee\b/,
  /(?:^|\s)-?-?(?:exec|execdir|delete|fprint\w*|fls)\b/,
  /--vacuum-(?:size|time)\b/,
];

/**
 * 引号遮蔽：单/双引号字符串的内容抹成空格（引号保留）——
 * `echo "cat f > /dev/sda"` 里引号内是数据不是重定向。未闭合引号遮到串尾。
 */
export function maskQuotes(command) {
  let out = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (!quote && (ch === "'" || ch === '"')) {
      quote = ch;
      out += ch;
      continue;
    }
    if (quote) {
      if (ch === quote && (quote === "'" || command[i - 1] !== '\\')) {
        quote = null;
        out += ch;
      } else {
        out += ' ';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 按分隔符切段（`;`、`&&`、`||`、`|`、换行），引号内的分隔符不算。
 * 返回 [{ raw, masked }]：raw 供参数解析，masked 供写形态/路径匹配。
 */
export function splitSegments(command) {
  const raw = String(command ?? '');
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (!quote && (ch === "'" || ch === '"')) {
      quote = ch;
      current += ch;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote && (quote === "'" || raw[i - 1] !== '\\')) quote = null;
      continue;
    }
    if (ch === '&' && raw[i + 1] === '&') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ raw: text, masked: maskQuotes(text) }));
}

/** 剥掉 sudo/env/包装器前缀，返回 { first, args }（首词与参数都小写）。 */
function peelWrapper(segment) {
  let text = segment.masked;
  for (let guard = 0; guard < 8; guard += 1) {
    const sudoMatch = new RegExp(`^sudo(?:[ \\t]+(?:${SUDO_OPT}))*[ \\t]+(.*)$`, 'i').exec(text);
    if (sudoMatch) {
      text = sudoMatch[1];
      continue;
    }
    const envMatch = /^env(?:\s+\w+=\S*\s+)+(.*)$/i.exec(text);
    if (envMatch) {
      text = envMatch[1];
      continue;
    }
    const wrapMatch = /^(?:exec|nohup|setsid|time|command)\s+(?!!)(.*)$/i.exec(text);
    if (wrapMatch) {
      text = wrapMatch[1];
      continue;
    }
    break;
  }
  const tokens = text.split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  return { first: tokens[0] ?? '', args: tokens.slice(1) };
}

function segmentClass(segment) {
  const { first, args } = peelWrapper(segment);
  if (!first) return 'unknown';
  // sed 就地改写：-i / -i'' / --in-place（其余 sed 是流式过滤，进只读表）。
  if (first === 'sed' && args.some((arg) => /^-i/.test(arg) || arg === '--in-place')) return 'write';
  // 写形态一票否决（重定向/tee/find -exec/-delete/--vacuum 等）。
  for (const pattern of WRITE_FORM_PATTERNS) {
    if (pattern.test(segment.masked)) return 'write';
  }
  if (first === 'docker' && DOCKER_NESTED_READONLY.has(args[0])) {
    const nested = DOCKER_NESTED_READONLY.get(args[0]);
    return nested.has(args[1] ?? '') ? 'read' : 'write';
  }
  if (READ_SUBCOMMANDS[first] !== undefined) {
    const sub = args[0] ?? '';
    if (!sub) return 'unknown';
    return READ_SUBCOMMANDS[first].includes(sub) ? 'read' : 'write';
  }
  if (READ_FIRST_WORDS.has(first)) return 'read';
  if (WRITE_FIRST_WORDS.has(first)) return 'write';
  return 'unknown';
}

/**
 * 整条命令分级：任一段 write → write；全部 read → read；其余（含未知段）→ unknown。
 * 命令替换 $(…) / 反引号的内容不可静态分析，出现即 unknown（保守，不认只读）。
 */
export function classifyCommand(command) {
  const raw = String(command ?? '');
  if (!raw.trim()) return 'unknown';
  const segments = splitSegments(raw);
  if (!segments.length) return 'unknown';
  let sawUnknown = /\$\([^)]*\)|`[^`]*`/.test(maskQuotes(raw));
  for (const segment of segments) {
    const cls = segmentClass(segment);
    if (cls === 'write') return 'write';
    if (cls === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'read';
}

/**
 * 052 R-06 · 敏感读取检测：读取类命令 + 凭据路径 → 命中（硬拒不弹卡）。
 * 054 R-04 起本机与远端同样生效（沙箱放开 ~/.ssh 只读后补缺口）；ssh/git 进程
 * 自读密钥不受影响——规则只看命令文本是否引用了凭据路径。
 * 返回 { hit: true, description } | null。
 */
const SECRET_PATH_PATTERNS = [
  { pattern: /(?:^|[\s"'=])\/etc\/(?:shadow|gshadow|sudoers)\b/, description: '系统凭据文件（shadow/sudoers）' },
  { pattern: /(?:^|[\s"'=])(?:~\/)?\.ssh\/id_\w+\b/, description: 'SSH 私钥文件' },
  { pattern: /(?:^|[\s"'=])\S+\/\.ssh\/id_\w+\b/, description: 'SSH 私钥文件' },
  { pattern: /(?:^|[\s"'=])\S*privkey\.pem\b/, description: 'TLS 私钥文件（privkey.pem）' },
  { pattern: /(?:^|[\s"'=])(?:\S*\/)?\.env\b/, description: '环境变量文件（.env）' },
];

/** 读取通道首词：内容会进模型上下文的命令（比只读表窄：只看「读取」类）。 */
const READ_CHANNEL_WORDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'strings',
  'od', 'xxd', 'base64', 'awk', 'sed', 'jq', 'nl', 'paste', 'column',
  'diff', 'comm', 'curl', 'wget', 'scp', 'rsync', 'ssh', 'cp', 'mv',
]);

export function detectRemoteSecretRead(command) {
  const raw = String(command ?? '');
  if (!raw.trim()) return null;
  const masked = maskQuotes(raw).toLowerCase();
  let hit = null;
  for (const rule of SECRET_PATH_PATTERNS) {
    if (rule.pattern.test(masked)) {
      hit = rule;
      break;
    }
  }
  if (!hit) return null;
  for (const segment of splitSegments(raw)) {
    const { first } = peelWrapper(segment);
    if (READ_CHANNEL_WORDS.has(first)) return { hit: true, description: hit.description };
  }
  return null;
}

/**
 * 052 R-03/Q4 · 系统目录覆盖写目标提取：cp/mv/install/tee/sed -i/输出重定向的
 * 目标落在系统目录时返回词法提取的目标路径清单。存在性由宿主探测：任一存在＝
 * 覆盖 → 风险确认；全不存在＝新建（如 .bak 备份）→ 放行（Q4 裁决）。
 *
 * @param {string} command 原始命令
 * @param {string[]} systemRoots 系统目录根清单（本机/远端由调用方注入）
 * @param {string|null} exemptRoot 豁免根（任务工作区——远端工作区常在 /opt、
 *        /srv 下，不豁免会整片误伤）
 */
/** 不算覆盖写的黑洞/终端设备（`2>/dev/null` 是最常见的只读命令伴随形态）。 */
const NULL_DEVICES = new Set(['/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/dev/tty']);
export function systemConfigOverwriteTargets(command, systemRoots, exemptRoot = null) {
  const raw = String(command ?? '');
  const masked = maskQuotes(raw).toLowerCase();
  const targets = new Set();
  const inSystem = (p) => {
    if (!p.startsWith('/') || NULL_DEVICES.has(p)) return false;
    if (exemptRoot && (p === exemptRoot || p.startsWith(`${exemptRoot}/`))) return false;
    return systemRoots.some((root) => p === root || p.startsWith(`${root}/`));
  };
  const add = (p) => {
    const clean = p.replace(/^["']+|["']+$/g, '');
    if (inSystem(clean)) targets.add(clean);
  };
  for (const segment of splitSegments(raw)) {
    const { first, args } = peelWrapper(segment);
    if (first === 'cp' || first === 'mv' || first === 'install') {
      // 位置参数（剥选项）的最后一个＝目标；「-」结尾（写 stdout）跳过。
      const positional = args.filter((token) => token !== '--' && !token.startsWith('-'));
      const dest = positional.at(-1);
      if (dest && dest !== '-' && dest.startsWith('/')) add(dest);
    } else if (first === 'tee') {
      const positional = args.filter((token) => token !== '--' && !token.startsWith('-'));
      for (const dest of positional) if (dest.startsWith('/')) add(dest);
    } else if (first === 'sed' && args.some((arg) => /^-i/.test(arg) || arg === '--in-place')) {
      // sed -i：首个位置参数是脚本表达式，其余是文件——全部（除首项）算目标。
      const positional = args.filter((token) => token !== '--' && !token.startsWith('-'));
      for (const dest of positional.slice(1)) if (dest.startsWith('/')) add(dest);
    }
  }
  for (const match of masked.matchAll(/(?:^|[^>])>{1,2}(?!&)\s*(\/[^\s;|&"']+)/g)) {
    add(match[1]);
  }
  return [...targets];
}
