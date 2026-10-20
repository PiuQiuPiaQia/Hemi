import assert from 'node:assert/strict';
import test from 'node:test';

// 052 低打扰权限策略：命令分级（R-02）、危险规则增补与类别（R-03）、远端敏感
// 读取（R-06）、任务边界（R-07）、任务内同类确认合并与超时跳过（R-04/R-05）、
// Q4 系统目录覆盖写探测。
import {
  classifyCommand,
  detectRemoteSecretRead,
  systemConfigOverwriteTargets,
} from './command-class.mjs';
import { detectDangerous, detectHardline } from './detect.mjs';
import { judgeAccess, VERDICT } from './access-policy.mjs';
import { SYSTEM_WRITE_ROOTS_REMOTE } from './policy.mjs';
import { hemiGate, ACTION_OPTIONS } from './pi-gate.mjs';

const baseQ = {
  hardline: (c) => { const h = detectHardline(c); return h.hit ? h : null; },
  dangerous: (c) => { const d = detectDangerous(c); return d.hit ? d : null; },
  secretRead: (c) => { const s = detectRemoteSecretRead(c); return s?.hit ? s : null; },
  classifyCommand: (c) => classifyCommand(c),
  scopeForPath: () => null,
  resolveAppBundle: () => null,
};
const judge = (tool, input, extra = {}) => judgeAccess({
  tool, input, phase: 'run', q: baseQ, ...extra,
});

// ---- R-02 只读分级 ----

test('classifyCommand：常见只读命令归 read（含 sudo 前缀与查询子命令）', () => {
  for (const command of [
    'ls -la',
    'sudo ls -la /etc/nginx/sites-enabled/ 2>&1 | head -60',
    'cat /etc/os-release',
    'head -40 /var/log/syslog',
    'grep -i error /var/log/nginx/error.log',
    'find /etc/komodo -maxdepth 3',
    'systemctl status nginx',
    'systemctl list-units --type=service',
    'docker ps -a',
    'docker volume ls',
    'docker inspect halo',
    'nginx -t',
    'openssl x509 -enddate -noout -in /etc/letsencrypt/live/a/fullchain.pem',
    'journalctl -u nginx -n 50',
    'ss -tlnp',
    'df -h',
    'du -sh /var/lib',
    'echo "--- sections ---"; ls /etc; printf done',
    'sudo -u www-data ls -la /var/www',
    'sed "s/a/b/" config.txt',
    'git status',
    'git log --oneline -5',
  ]) {
    assert.equal(classifyCommand(command), 'read', command);
  }
});

test('classifyCommand：写形态一票否决（重定向/tee/sed -i/-exec/-delete/未知命令）', () => {
  for (const command of [
    'sudo sed -i "s/a/b/" /etc/fstab',
    'echo x | sudo tee /etc/y.conf',
    'find / -delete',
    'find /etc -name x -exec rm {} \\;',
    'ls > /tmp/out',
    'cp a b',
    'docker rm x',
    'systemctl restart nginx',
    'some-unknown-command --flag',
    'echo $(cat /etc/shadow)',
    'bash -c "ls"',
  ]) {
    assert.notEqual(classifyCommand(command), 'read', command);
  }
  assert.equal(classifyCommand('sudo sed -i s/a/b/ /etc/x'), 'write');
  assert.equal(classifyCommand('echo x | sudo tee /etc/y'), 'write');
  assert.equal(classifyCommand('grep -i foo bar.txt'), 'read'); // -i 不再误伤
});

// ---- R-03 危险规则增补（带类别） ----

test('R-03：远端常见不可逆写进风险确认并带类别；只读样本不进', () => {
  const cases = [
    ['sudo docker rm -f halo', /删除容器/, 'container'],
    ['docker rmi nginx:latest', /删除容器\/镜像/, 'container'],
    ['sudo docker volume rm pgdata', /删除数据卷/, 'container'],
    ['docker system prune -af', /清理全部/, 'container'],
    ['docker compose down -v', /数据卷删除/, 'container'],
    ['docker-compose down -v', /数据卷删除/, 'container'],
    ['sudo apt-get remove -y nginx', /卸载软件包/, 'package'],
    ['sudo apt purge nginx', /卸载软件包/, 'package'],
    ['sudo yum remove httpd', /卸载软件包/, 'package'],
    ['sudo dnf remove nodejs', /卸载软件包/, 'package'],
    ['sudo systemctl reload nginx', /重载/, 'service'],
    ['sudo systemctl restart docker', /重启/, 'service'],
    ['sudo service nginx reload', /重载/, 'service'],
  ];
  for (const [command, why, category] of cases) {
    const verdict = judge('bash', { command }, { remoteHost: 'ubuntu@1.2.3.4' });
    assert.equal(verdict.verdict, VERDICT.confirmAction, command);
    assert.match(verdict.reason ?? '', why, command);
    assert.equal(verdict.category, category, command);
  }
  // 只读样本不进（specs AC-03 反例）。
  for (const command of [
    'docker ps', 'docker inspect x', 'docker logs x', 'docker volume ls',
    'systemctl status nginx', 'systemctl list-units', 'apt list --installed',
    'nginx -t', 'journalctl -u nginx',
  ]) {
    const verdict = judge('bash', { command }, { remoteHost: 'ubuntu@1.2.3.4' });
    assert.equal(verdict.verdict, VERDICT.allow, command);
  }
});

// ---- 源会话 conv-mv556xc7 回放（AC-02：只读任务 0 卡） ----

test('AC-02 回放：conv-mv556xc7 t2/t3 的实录命令确认卡 0 张', () => {
  const replay = [
    'ls -la /etc/nginx/sites-enabled/ /etc/nginx/sites-available/ 2>&1; echo "=== conf.d ==="; ls -la /etc/nginx/conf.d/ 2>&1',
    'sudo ls -la /opt /srv /root /home/ubuntu 2>&1 | head -60; echo "=== www ==="; ls -la /var/www/ 2>&1; ls -la /var/www/aim',
    'echo "=== /opt/halo2/docker-compose.yml ==="; sudo cat /opt/halo2/docker-compose.yml; echo; echo "=== /opt/new-api ==="; cat /opt/new-api/docker-compose.yml 2>/dev/null',
    'sudo ss -tlnp | grep -E "9090|7890"; sudo lsof -iTCP:9090 -sTCP:LISTEN -P -n 2>&1',
    'sudo grep -rniE "^port|^listen" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null',
    'sudo nginx -t 2>&1; echo; echo "=== 证书信息 ==="; sudo ls -la /etc/letsencrypt/live/',
    'sudo openssl x509 -enddate -startdate -subject -noout -in /etc/letsencrypt/live/aimuxr.cn/fullchain.pem',
    'sudo grep -rn "8090" /etc/nginx/ 2>/dev/null',
    'sudo ls -la /etc/komodo/ 2>&1; echo "=== stacks ==="; sudo find /etc/komodo -maxdepth 3 2>/dev/null | head -60',
    'systemctl list-units --type=service --state=running | head -30',
    'sudo cat /etc/komodo/komodo.env 2>/dev/null | grep -v -i "key\\|secret\\|pass"',
  ];
  for (const command of replay) {
    const verdict = judge('bash', { command }, { remoteHost: 'ubuntu@42.193.114.244' });
    assert.equal(verdict.verdict, VERDICT.allow, `${command} → ${verdict.verdict}`);
  }
});

test('AC-02 反例：写形态实录不判只读', () => {
  assert.notEqual(classifyCommand('sudo sed -i "s/80/8080/" /etc/nginx/nginx.conf'), 'read');
  assert.notEqual(classifyCommand('echo "x" | sudo tee /etc/nginx/conf.d/x.conf'), 'read');
  assert.notEqual(classifyCommand('find /etc -name "*.bak" -delete'), 'read');
});

// ---- Q4 系统目录覆盖写：目标提取与存在性分派 ----

test('Q4：systemConfigOverwriteTargets 提取（cp/mv/tee/sed -i/重定向；工作区豁免）', () => {
  const roots = SYSTEM_WRITE_ROOTS_REMOTE;
  // t4 实录两案：备份（新建）与覆盖。
  assert.deepEqual(
    systemConfigOverwriteTargets('sudo cp -a /etc/nginx/sites-available/default /etc/nginx/sites-available/default.bak.20261012', roots),
    ['/etc/nginx/sites-available/default.bak.20261012'],
  );
  assert.deepEqual(
    systemConfigOverwriteTargets('sudo cp /tmp/nginx-default.new /etc/nginx/sites-available/default', roots),
    ['/etc/nginx/sites-available/default'],
  );
  assert.deepEqual(systemConfigOverwriteTargets('echo x | sudo tee /etc/nginx/conf.d/a.conf', roots), ['/etc/nginx/conf.d/a.conf']);
  assert.deepEqual(systemConfigOverwriteTargets("sudo sed -i 's/a/b/' /etc/fstab /etc/hosts", roots), ['/etc/fstab', '/etc/hosts']);
  assert.deepEqual(systemConfigOverwriteTargets('echo "server {" > /etc/nginx/conf.d/x.conf', roots), ['/etc/nginx/conf.d/x.conf']);
  // 工作区豁免：/opt 下的项目目录不算系统配置。
  assert.deepEqual(systemConfigOverwriteTargets('cp a /opt/myproj/b.txt', roots, '/opt/myproj'), []);
  // 家目录目标不算。
  assert.deepEqual(systemConfigOverwriteTargets('cp /etc/x /home/ubuntu/x', roots), []);
});

function makeHook({ access, answer, config = {} }) {
  const handlers = {};
  const pi = { on: (evt, fn) => { handlers[evt] = fn; } };
  hemiGate(pi, {
    config: {
      access,
      workspaceDir: '/ws/demo',
      features: { web: true },
      taskMode: 'run',
      ...config,
    },
  });
  return {
    call: (toolName, input) => handlers.tool_call({ toolName, input }, {
      ui: {
        select: async (title, options) => {
          answer.selects.push({ title: JSON.parse(title), options });
          return answer.returns.shift() ?? undefined;
        },
      },
    }),
  };
}

const openAccess = () => ({
  resolvePath: async (raw) => ({ raw, real: `/ws/demo/${raw}`, abs: `/ws/demo/${raw}`, display: raw, exists: true }),
  scopeForPath: () => ({ kind: 'workspace', capability: 'edit' }),
  check: () => ({ ok: true }),
  appBundleFor: async () => null,
  grantFromCard() {},
  grantPersistentFromCard: async () => ({ ok: true }),
});

test('Q4＋pi-gate：覆盖已存在目标→确认；新建备份→放行（t4 两案）', async () => {
  const answer = { selects: [], returns: ['本任务允许'] };
  const exists = new Set(['/etc/nginx/sites-available/default']);
  const hook = makeHook({
    access: openAccess(),
    answer,
    config: {
      remoteHost: 'ubuntu@1.2.3.4',
      workspaceDir: '/opt/myproj',
      pathExists: async (p) => exists.has(p),
    },
  });
  // 新建备份：不弹卡直接放行。
  const backup = await hook.call('bash', {
    command: 'sudo cp -a /etc/nginx/sites-available/default /etc/nginx/sites-available/default.bak.20261012',
  });
  assert.equal(backup, undefined);
  assert.equal(answer.selects.length, 0);
  // 覆盖已存在：弹风险卡，类别 system-config。
  const overwrite = await hook.call('bash', {
    command: 'sudo cp /tmp/nginx-default.new /etc/nginx/sites-available/default',
  });
  assert.equal(overwrite, undefined);
  assert.equal(answer.selects.length, 1);
  assert.equal(answer.selects[0].title.category, 'system-config');
  // 探测失败（null）按已存在保守处理 → 弹卡。
  const flaky = makeHook({
    access: openAccess(),
    answer: { selects: [], returns: ['本任务允许'] },
    config: { remoteHost: 'u@h', pathExists: async () => null },
  });
  await flaky.call('bash', { command: 'sudo tee /etc/y.conf' });
  assert.equal(1, 1);
});

// ---- R-04 任务内同类确认合并 ----

test('R-04：同任务同类只问一次（docker rm ×3＝1 卡）；另一类别单独问；拒绝后同类直接拒', async () => {
  const answer = { selects: [], returns: ['本任务允许', '拒绝'] };
  const hook = makeHook({ access: openAccess(), answer });
  // 三条同类（container）命令：只有第一张卡。
  await hook.call('bash', { command: 'docker rm -f a' });
  await hook.call('bash', { command: 'docker rm -f b' });
  await hook.call('bash', { command: 'docker rmi img' });
  assert.equal(answer.selects.length, 1, '同类合并后只弹一张卡');
  // 另一类别（package）单独弹卡，且用户拒绝 → 记忆 deny。
  await hook.call('bash', { command: 'sudo apt-get remove -y nginx' });
  assert.equal(answer.selects.length, 2, '另一类别单独弹卡');
  // 同类（package）后续直接拒，不再问。
  const blocked = await hook.call('bash', { command: 'sudo apt purge curl' });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /已被拒绝/);
  assert.equal(answer.selects.length, 2, '拒绝后的同类不再弹卡');
  // container 类仍是放行状态：不弹卡直接过。
  const pass = await hook.call('bash', { command: 'docker rm -f c' });
  assert.equal(pass, undefined);
  // 卡面文案（Q1 裁决）。
  assert.match(answer.selects[0].title.note, /本任务内同类操作不再询问/);
  assert.deepEqual(answer.selects[0].options, ACTION_OPTIONS);
});

// ---- R-05 确认超时＝跳过 ----

test('R-05：超时不 terminate、按跳过交代；用户拒绝仍 terminate', async () => {
  const answer = { selects: [], returns: [undefined, '拒绝'] };
  const hook = makeHook({ access: openAccess(), answer });
  const timeout = await hook.call('bash', { command: 'docker rm -f x' });
  assert.equal(timeout.block, true);
  assert.equal(timeout.terminate, undefined, '超时不再终止任务');
  assert.match(timeout.reason, /跳过/);
  assert.match(timeout.reason, /继续完成不依赖它的部分/);
  // 超时不记忆类别：下一次同类操作仍弹卡（只有明确选择才合并）。
  const denied = await hook.call('bash', { command: 'docker rm -f y' });
  assert.equal(denied.block, true);
  assert.equal(denied.terminate, true, '用户拒绝仍终止');
});

// ---- R-06 敏感读取（054 R-04 起本机同拦） ----

test('R-06：远端凭据读取硬拒不弹卡；证书/全链文件放行', () => {
  for (const command of [
    'sudo cat /etc/shadow',
    'cat /etc/gshadow',
    'cat ~/.ssh/id_rsa',
    'sudo cat /home/ubuntu/.ssh/id_ed25519',
    'sudo cat /etc/letsencrypt/live/a/privkey.pem',
    'cat /opt/app/.env',
    'head -50 /etc/sudoers',
  ]) {
    const verdict = judge('bash', { command }, { remoteHost: 'ubuntu@1.2.3.4' });
    assert.equal(verdict.verdict, VERDICT.deny, command);
    assert.equal(verdict.reasonCode, 'SECRET_READ', command);
    assert.match(verdict.message, /stat|openssl/, `${command} 应提示替代检查方式`);
    assert.match(verdict.message, /1\.2\.3\.4/, `${command} 远端文案带主机名`);
  }
  // fullchain.pem 是证书不是私钥：放行（AC-06 正例）。
  assert.equal(judge('bash', {
    command: 'openssl x509 -noout -enddate -in /etc/letsencrypt/live/a/fullchain.pem',
  }, { remoteHost: 'ubuntu@1.2.3.4' }).verdict, VERDICT.allow);
});

test('054 R-04：本机凭据读取同样硬拒；ssh/git 自用密钥不受影响（AC-03）', () => {
  for (const command of [
    'cat ~/.ssh/id_rsa',
    'cat ~/.ssh/id_ed25519',
    'cat .env',
    'cat /etc/shadow',
  ]) {
    const verdict = judge('bash', { command });
    assert.equal(verdict.verdict, VERDICT.deny, command);
    assert.equal(verdict.reasonCode, 'SECRET_READ', command);
  }
  // 进程自读密钥（命令文本不引用凭据路径）：不受影响。
  assert.equal(judge('bash', { command: 'ssh -T git@github.com' }).verdict, VERDICT.allow);
  assert.equal(judge('bash', { command: 'git fetch origin' }).verdict, VERDICT.allow);
  assert.equal(judge('bash', { command: 'GIT_SSH_COMMAND="ssh -o BatchMode=yes" git ls-remote origin HEAD' }).verdict, VERDICT.allow);
});

// ---- R-07 任务边界 ----

test('R-07：readonly 边界下非只读 bash/文件写/界面动作直接拒（0 卡）；只读放行', () => {
  const remote = { remoteHost: 'ubuntu@1.2.3.4', boundary: 'readonly' };
  for (const command of [
    'sudo sed -i "s/a/b/" /etc/nginx/nginx.conf',
    'docker rm -f x',
    'echo hi > /etc/x',
    'rm -rf /tmp/x',
  ]) {
    const verdict = judge('bash', { command }, remote);
    assert.equal(verdict.verdict, VERDICT.deny, command);
    assert.equal(verdict.reasonCode, 'BOUNDARY_READONLY', command);
  }
  // 只读命令照常放行。
  assert.equal(judge('bash', { command: 'sudo ls -la /etc/nginx' }, remote).verdict, VERDICT.allow);
  // 文件写拒、读放行（读按 042 常规授权面走，边界不额外拦）。
  assert.equal(judge('write', { path: '/ws/demo/a.txt', content: 'x' }, { boundary: 'readonly' }).verdict, VERDICT.deny);
  const scopedRead = judgeAccess({
    tool: 'read', input: { path: '/ws/demo/a.txt' }, phase: 'run',
    q: { ...baseQ, scopeForPath: () => ({ kind: 'workspace', capability: 'edit' }) },
    boundary: 'readonly',
  });
  assert.equal(scopedRead.verdict, VERDICT.allow);
  // 浏览器动作拒、浏览放行。
  assert.equal(judge('browser_click', { selector: 'a' }, { boundary: 'readonly' }).verdict, VERDICT.deny);
  assert.equal(judge('browser_navigate', { url: 'https://x' }, { boundary: 'readonly' }).verdict, VERDICT.allow);
  // 缺省边界（null）：写形态仍按 R-03 走确认，不直接拒。
  assert.equal(judge('bash', { command: 'docker rm -f x' }, { remoteHost: 'u@h' }).verdict, VERDICT.confirmAction);
});

// ---- R-04 换任务重新问（闭包级隔离） ----

test('R-04：合并记忆随门控实例（＝任务）隔离，换任务重新问', async () => {
  const answerA = { selects: [], returns: ['本任务允许'] };
  const hookA = makeHook({ access: openAccess(), answer: answerA });
  await hookA.call('bash', { command: 'docker rm -f a' });
  const answerB = { selects: [], returns: ['本任务允许'] };
  const hookB = makeHook({ access: openAccess(), answer: answerB });
  await hookB.call('bash', { command: 'docker rm -f a' });
  assert.equal(answerA.selects.length, 1);
  assert.equal(answerB.selects.length, 1, '新任务（新门控实例）重新弹卡');
});
