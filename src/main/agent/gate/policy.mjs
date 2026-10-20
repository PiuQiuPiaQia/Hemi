/**
 * 门控命令策略表（005 迭代，2026-09-19）——纯数据与正则组合，无任何执行逻辑。
 *
 * 分两级（对齐业内分级实践）：
 * - HARDLINE：灾难性、不可逆操作。**任何模式（含完全访问）都硬拦**，不给确认机会。
 * - DANGEROUS：高危但可斟酌的操作。进「问」档——confirm 弹卡、review 交审查、
 *   full 直通（用户开完全访问 = 知情选择跳过这一层）。
 *
 * 匹配工艺（防误伤的关键，比模式清单本身更重要）：
 * - CMDPOS 前缀：危险词必须出现在**命令位置**（行首 / 分隔符后 / 命令替换内，
 *   允许带 sudo/env/exec 等包装器）——`echo reboot`、`grep shutdown` 不误伤；
 * - 引号遮蔽：带 MASKED 标记的模式匹配前先把引号内的字符串内容抹掉——
 *   `echo "cat f > /dev/sda"` 是念字符串不是写盘，不误伤；
 * - 输入统一小写后匹配，模式全按小写写。
 *
 * 面向 macOS（应用宿主平台）：POSIX + 跨平台通用项；Windows 专用簇不收录。
 */

/**
 * sudo 自身的一个选项（含选项参数）。必须按 sudo 的选项语法走：带参选项
 * （-u user / -g group / -p prompt / -r role / -t type / -C num / -D dir，小写归一后
 * 即 [ugprtcd]）要连参数一起吃掉，否则 `sudo -u root reboot` 会把 root 当命令名、
 * 漏掉其后的 reboot（2026-10-12 实测硬拦被绕过）；`--` 与命令名都不以「-字母」开头，
 * 扫描到此即止——被执行命令自己的参数（`sudo ls -la` 的 -la）不属于 sudo。
 */
const SUDO_OPT =
  '(?:-[a-z]*[ugprtcd][ \\t]+[^\\s;|&]+' +
  '|--(?:user|group|prompt|role|type|close-from|chdir|chroot|other-user|command-timeout)[ \\t]+[^\\s;|&]+' +
  '|--[a-z][a-z-]*(?:=[^\\s;|&]+)?' +
  '|-[a-z]+)';

/** 命令位置锚点：行首 / 分隔符（; & | 换行）/ 命令替换内，允许带 sudo/env/包装器。 */
const CMDPOS =
  `(?:^|[;\\n&|\`]|\\$\\()\\s*(?:sudo(?:[ \\t]+${SUDO_OPT})*\\s+)?(?:env\\s+(?:\\w+=\\S*\\s+)*)?(?:(?:exec|nohup|setsid|time)\\s+)*\\s*`;

/** sudo 选项区内的提权选项：只认 sudo 自己的选项，不看被执行命令的参数。 */
const SUDO_FLAG = (flag) => `\\bsudo(?:[ \\t]+${SUDO_OPT})*?[ \\t]+${flag}(?=[\\s;|&)]|$)`;

/** rm 的危险路径形态（带引号或不带）。 */
function rmPath(pathAlt) {
  return `(?:["'](?:${pathAlt})["']|(?:${pathAlt})(?:\\s|$|[)\`;|&]))`;
}

const SYSTEM_DIRS =
  '/home|/home/\\*|/root|/root/\\*|/etc|/etc/\\*|/usr|/usr/\\*|/var|/var/\\*|/var/lib|/var/lib/\\*|/bin|/bin/\\*|/sbin|/sbin/\\*|/boot|/boot/\\*|/lib|/lib/\\*|/lib64|/lib64/\\*|/opt|/opt/\\*|/srv|/srv/\\*|/private/etc(?:/\\*)?|/System(?:/\\*)?|/Library(?:/\\*)?';
const RM_FLAGS = CMDPOS + 'rm\\s+(-[^\\s]*\\s+)*';
/** 块设备形态：Linux（sd/nvme/…）+ macOS（disk/rdisk）。 */
const BLOCK_DEV = '/dev/(sd|nvme|hd|mmcblk|vd|xvd|disk|rdisk)[a-z0-9]*';

/**
 * 052 R-03：系统配置写入的根目录清单（Q4 存在性探测用——cp/mv/tee/sed -i/重定向
 * 的目标落在这些根下、且目标已存在（覆盖）才进风险确认；新建（如 .bak 备份）放行）。
 * 远端工作区可能就挂在 /opt、/srv 下：调用方须把任务工作区作为豁免根传入。
 */
export const SYSTEM_WRITE_ROOTS = process.platform === 'win32'
  // Windows 系统区＝Windows 目录与 Program Files/ProgramData（本机 POSIX 清单在 win
  // 是死路径；2026-10-20 双平台恢复补，环境变量缺失时退常见默认值）。
  ? [
    process.env.SystemRoot ?? 'C:\\Windows',
    process.env.ProgramFiles ?? 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    process.env.ProgramData ?? 'C:\\ProgramData',
  ]
  : [
    '/etc', '/private/etc', '/System', '/Library', '/usr', '/bin', '/sbin',
    '/var', '/private/var/db', '/boot', '/lib', '/lib64',
  ];
/** 远端（Linux 服务器）清单：补 /opt、/srv、/var/lib、/root、/run（049 denyPathRootsRemote 同族）。 */
export const SYSTEM_WRITE_ROOTS_REMOTE = [
  '/etc', '/usr', '/bin', '/sbin', '/boot', '/lib', '/lib64', '/opt', '/srv',
  '/var', '/var/lib', '/root', '/run', '/dev',
];

/** 不可绕过层：mode='is' 编译；MASKED = 匹配前先做引号遮蔽。 */
export const HARDLINE_PATTERNS = [
  { pattern: RM_FLAGS + rmPath('/(?:(?:\\.\\.)?/)*(?:\\.\\.)?\\**|/ \\*'), description: '递归删除根文件系统' },
  { pattern: RM_FLAGS + rmPath(SYSTEM_DIRS), description: '递归删除系统目录' },
  { pattern: RM_FLAGS + rmPath('(?:~|\\$\\{?HOME\\}?)(?:/?|/\\*)?'), description: '递归删除用户主目录' },
  { pattern: CMDPOS + 'mkfs(\\.[a-z0-9]+)?\\b', description: '格式化文件系统（mkfs）' },
  { pattern: `dd\\b[^\\n]*\\bof=${BLOCK_DEV}`, description: 'dd 写裸块设备' },
  { pattern: `>\\s*${BLOCK_DEV}\\b`, description: '重定向写裸块设备', masked: true },
  { pattern: ':\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:', description: 'fork 炸弹', masked: true },
  { pattern: CMDPOS + 'kill\\s+(-[^\\s]+\\s+)*-1\\b', description: '杀死全部进程（kill -1）' },
  { pattern: CMDPOS + '(shutdown|reboot|halt|poweroff)\\b', description: '关机/重启' },
  { pattern: CMDPOS + 'init\\s+[06]\\b', description: 'init 0/6 关机重启' },
  { pattern: CMDPOS + 'systemctl\\s+(poweroff|reboot|halt|kexec)\\b', description: 'systemctl 关机/重启' },
  // sudo 提权（-s shell／-S stdin 喂密码）不进灾难级：小写归一后两者同形，且提权
  // 形态在危险级有专门模式（问档/审查/按模式分派），不必硬拦。
];

/**
 * 问档层：full 模式直通，confirm 弹卡，review 交审查。
 * 052 R-03 起，每条带 category（风险类别）——R-04 的「任务内同类确认合并」按
 * 「任务 × 主机 × category」记忆，同任务同类别只问一次；删除/降级 docker 等规则
 * 时同步核对 pi-gate 与单测的正反例。系统目录覆盖写（cp/mv/tee/sed -i/重定向，
 * Q4 存在性探测）不走静态表，见 command-class.systemConfigOverwriteTargets。
 */
export const DANGEROUS_PATTERNS = [
  // rm 家族：含 GNU「flag 在参数后」的变形（rm build/ -rf）。
  { pattern: '\\brm\\s+(-[^\\s]*\\s+)*/', description: '在根路径下执行删除', category: 'delete' },
  { pattern: '\\brm\\s+-[^\\s]*r', description: '递归删除', category: 'delete' },
  { pattern: '\\brm\\s+--recursive\\b', description: '递归删除（长 flag）', category: 'delete' },
  {
    pattern: "\\brm\\s+(?!--(?:\\s|$))(?:(?!\\s--(?:\\s|$))[^\\n\"';|&])*\\s(?:-[a-z]*r[a-z]*\\b|--recursive\\b)",
    description: '递归删除（flag 在参数后）',
    category: 'delete',
  },
  // 权限与所有权破坏。
  { pattern: '\\bchmod\\s+(-[^\\s]*\\s+)*(777|666|o\\+[rwx]*w|a\\+[rwx]*w)\\b', description: '放开全局写权限（chmod 777 类）', category: 'permission' },
  { pattern: '\\bchmod\\s+--recursive\\b.*(777|666|o\\+[rwx]*w|a\\+[rwx]*w)', description: '递归放开全局写权限', category: 'permission' },
  { pattern: '\\bchown\\s+(-[^\\s]*)?R\\s+root', description: '递归 chown 给 root', category: 'permission' },
  { pattern: '\\bchown\\s+--recur[a-z]*\\b.*root', description: '递归 chown 给 root（长 flag）', category: 'permission' },
  // 远端内容执行家族（curl|sh 及其等价变形）。
  { pattern: '\\b(curl|wget)\\b.*\\|\\s*(?:[/\\w]*/)?(?:ba)?sh(?:\\s|$|-c)', description: '远端内容管道进 shell', category: 'remote-exec' },
  { pattern: '\\b(bash|sh|zsh|ksh)\\s+<\\s*<?\\s*\\(\\s*(curl|wget)\\b', description: '进程替换执行远端脚本', category: 'remote-exec' },
  { pattern: '(?:\\beval\\b|\\bsource\\b|\\.)\\s*(?:\\$\\(\\s*|`\\s*)(?:curl|wget)\\b', description: '命令替换执行远端内容', category: 'remote-exec' },
  // 磁盘与系统配置。
  { pattern: CMDPOS + 'mkfs\\b', description: '格式化文件系统', category: 'disk' },
  { pattern: CMDPOS + 'dd\\s+.*if=', description: '磁盘复制（dd）', category: 'disk' },
  { pattern: `>\\s*${BLOCK_DEV}`, description: '写块设备', category: 'disk' },
  // 进程强杀。
  { pattern: '\\bkill\\s+-9\\s+-1\\b', description: '强杀全部进程', category: 'process' },
  { pattern: '\\bpkill\\s+-9\\b', description: '强杀进程（pkill -9）', category: 'process' },
  { pattern: '\\bkillall\\s+(-[^\\s]*\\s+)*-(9|KILL|SIGKILL)\\b', description: '强杀进程（killall -KILL）', category: 'process' },
  { pattern: '\\bkillall\\s+(-[^\\s]*\\s+)*-s\\s+(KILL|SIGKILL|9)\\b', description: '强杀进程（killall -s KILL）', category: 'process' },
  { pattern: '\\bkillall\\s+(-[^\\s]*\\s+)*-r\\b', description: '按正则杀进程（killall -r）', category: 'process' },
  // 系统服务（052 R-03：reload/restart 影响线上服务，进确认）。
  { pattern: '\\bsystemctl\\s+(-[^\\s]+\\s+)*(stop|restart|reload|disable|mask)\\b', description: '停止/重启/重载/禁用系统服务', category: 'service' },
  { pattern: '\\bservice\\s+[^;\\n|&]+\\s+(restart|reload|stop)\\b', description: '停止/重启/重载系统服务（service 命令）', category: 'service' },
  // 容器与镜像（052 R-03：删容器/卷/镜像不可逆）。
  { pattern: '\\bdocker(?:-compose)?\\s+(?:rm|rmi)\\b', description: '删除容器/镜像', category: 'container' },
  { pattern: '\\bdocker\\s+volume\\s+(?:rm|prune)\\b', description: '删除数据卷', category: 'container' },
  { pattern: '\\bdocker\\s+(?:network|image|container)\\s+(?:rm|prune)\\b', description: '删除网络/镜像/容器', category: 'container' },
  { pattern: '\\bdocker\\s+system\\s+prune\\b', description: '清理全部未用容器/镜像/卷', category: 'container' },
  { pattern: '\\bdocker(?:-compose)?\\s+(?:compose\\s+)?down\\b[^;\\n|&]*\\s-{1,2}[a-z]*v\\b', description: 'docker compose down -v（连同数据卷删除）', category: 'container' },
  // 软件包卸载（052 R-03）。
  { pattern: '\\b(?:apt(?:-get)?|yum|dnf|apk|brew)\\s+(?:remove|purge|uninstall|autoremove)\\b', description: '卸载软件包', category: 'package' },
  { pattern: '\\bpacman\\s+-R\\w*\\b', description: '卸载软件包（pacman）', category: 'package' },
  // SQL 破坏（Pi 可能跑本地 sqlite）。
  { pattern: '\\bDROP\\s+(TABLE|DATABASE)\\b', description: 'SQL DROP', category: 'database' },
  { pattern: '\\bDELETE\\s+FROM\\b(?![^\\n]*\\bWHERE\\b)', description: '无 WHERE 的 SQL DELETE', category: 'database' },
  { pattern: '\\bTRUNCATE\\s+(TABLE)?\\s*\\w', description: 'SQL TRUNCATE', category: 'database' },
  // sudo 提权形态（普通 `sudo cmd` 在无 TTY 下本就跑不动，交问档/审查即可）。
  // 只扫 sudo 自己的选项区：旧写法扫整段命令，`sudo ls -la`、`sudo find -maxdepth`
  // 这类只读命令因参数里带 s/a 被误判提权（2026-10-12 远端会话 12 卡 11 误报）。
  { pattern: SUDO_FLAG('(?:-[sa]|--(?:shell|stdin|askpass|auth-type)(?:=[^\\s;|&]+)?)'), description: 'sudo 提权 flag（shell/askpass）', category: 'sudo-escalation' },
  { pattern: SUDO_FLAG('-[a-z]*[sa][a-z]*'), description: 'sudo 组合 flag 提权', category: 'sudo-escalation' },
  // 云实例凭据端点（IMDS）：任何客户端取它都是在摸凭据。
  { pattern: '169\\.254\\.169\\.254|fd00:ec2::254|metadata\\.google\\.internal|100\\.100\\.100\\.200', description: '访问云实例凭据端点（IMDS）', category: 'credentials' },
];

/** 路径黑名单（家目录下的敏感点文件 + 系统根区），judgeToolCall 的路径层用。 */
export const POLICY_PATHS = {
  denyPathPrefixes: [
    '.ssh', '.gnupg', '.zshrc', '.bashrc', '.zprofile', '.zshenv',
    '.bash_profile', '.profile', '.netrc', '.pgpass', '.npmrc', '.pypirc', '.env',
  ],
  /**
   * 056 审查补缺：家目录下的个人数据与凭据库（多段相对路径，前缀匹配）。授权了上级目录
   * （如整个 ~/Library）也不放行——内容是聊天记录、邮件、浏览器 Cookie／密码库与钥匙串。
   */
  denyHomeSubpaths: [
    'Library/Keychains', 'Library/Cookies', 'Library/Mail', 'Library/Messages',
    'Library/Safari', 'Library/Accounts', 'Library/Group Containers',
    'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox',
    'Library/Application Support/com.apple.TCC', 'Library/Application Support/AddressBook',
    'Library/Containers/com.apple.mail', 'Library/Containers/com.apple.MobileSMS',
    'Library/Containers/com.apple.Safari',
  ],
  denyPathRoots: [
    '/System', '/Library', '/etc', '/private/etc', '/usr', '/bin', '/sbin',
    '/dev', '/var', '/private/var/db', '/private/var/root',
  ],
  /** 049 R-07：远端（Linux 服务器）用的系统根区——补 /opt、/srv、/var/lib、/root、
   * /proc、/sys 等本机清单没有的 Linux 目录；只在远端工作区生效，不影响本机
   * （macOS 的 /opt/homebrew 等位置不进这份清单）。 */
  denyPathRootsRemote: [
    '/etc', '/usr', '/bin', '/sbin', '/boot', '/lib', '/lib64', '/opt', '/srv',
    '/var/lib', '/root', '/proc', '/sys', '/dev', '/run',
  ],
};

/**
 * web 检索只读工具（单一事实源）：pi-web 注册表与门控只读层共用。
 * 只读语义：检索与抓正文不落盘、不动系统；用户在设置里开了开关并配了 key
 * 才会挂上，挂上即在 confirm 档免问放行（同浏览器只读工具）。
 */
export const WEB_TOOLS = ['web_search', 'web_extract'];

/**
 * 014 浏览器只读工具（单一事实源，同上）：任务后台标签页的导航与读取，不落盘。
 * 任务日志留痕也用这份——「打开了什么网页」是用户关心的过程节点（2026-10-07），
 * 与文件类只读（read/bash 每步一条会刷屏）不同，浏览器一次任务的导航次数有限。
 */
export const BROWSER_READ_TOOLS = ['browser_navigate', 'browser_extract', 'browser_tabs', 'browser_screenshot'];

/** 只读放行（家目录内）：工具与无元字符 bash 首词。006：视觉只读工具一并放行。014：浏览器只读工具。 */
export const POLICY_READONLY = {
  readOnlyTools: ['read', 'grep', 'glob', 'ls', 'screen_view', 'ui_list', 'ui_tree',
    ...BROWSER_READ_TOOLS,
    ...WEB_TOOLS],
  readOnlyBashFirstWords: [
    'ls', 'cat', 'head', 'tail', 'grep', 'find', 'stat', 'file', 'wc', 'du', 'df',
    'pwd', 'which', 'whoami', 'date', 'uname', 'sw_vers', 'mdfind', 'readlink', 'hostname',
  ],
};

/**
 * 006 操控原语工具名（单一事实源）：pi-vision 注册表、门控摘要、宿主白名单的
 * 工具级粒度共用这一份——只认这四个，其余未知工具永远记不了白名单条目。
 */
// 027：ui_act 是 AX 快车道的聚合动作工具（内部批量点击/键入/设值），同入问档。
export const VISION_ACT_TOOLS = ['ui_click', 'ui_type', 'ui_key', 'ui_scroll', 'ui_act'];

/**
 * 014 浏览器动作工具（单一事实源，同上）：作用于任务自己的后台标签页，
 * 不经屏幕坐标。门控走问档（同视觉原语），宿主会话白名单按工具级粒度记录。
 * 020：browser_act 是聚合动作工具（内部循环含点击/键入），同入问档——
 * confirm 弹卡审批整个子目标、review 交审查、full 直通；步级置信度分层
 * 在工具内部执行（020 specs R-05/D-2）。
 */
export const BROWSER_ACT_TOOLS = ['browser_click', 'browser_type', 'browser_act'];

export function compilePatterns(entries) {
  return entries.map((entry) => ({
    regex: new RegExp(entry.pattern, 'is'),
    description: entry.description,
    category: entry.category ?? 'dangerous',
    masked: Boolean(entry.masked),
  }));
}

export const HARDLINE_COMPILED = compilePatterns(HARDLINE_PATTERNS);
export const DANGEROUS_COMPILED = compilePatterns(DANGEROUS_PATTERNS);
