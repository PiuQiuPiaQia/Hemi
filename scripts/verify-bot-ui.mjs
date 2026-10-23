// Actual Electron -> preload/IPC -> strict SSH -> Linux systemd Host -> Pi SDK -> filesystem.
// The model endpoint is the only synthetic service. No installed Hemi data is accessed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';
import { pdfFixture } from './lib/document-fixtures.mjs';
const exec = promisify(execFile),
  repo = path.resolve(import.meta.dirname, '..');
const context = JSON.parse(
  await fs.readFile(
    path.join(
      repo,
      '.visual/workflow/bot-implementation/linux-validation.json',
    ),
    'utf8',
  ),
);
const docker = (...args) =>
  exec('docker', args, { maxBuffer: 4 * 1024 * 1024 });
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const previous = process.env.HEMI_BOT_UI_RESUME
  ? JSON.parse(
      await fs.readFile(
        path.join(
          repo,
          '.visual/workflow/bot-implementation',
          mode,
          'report.json',
        ),
        'utf8',
      ),
    )
  : null;
const user = previous?.user ?? 'bot' + Date.now().toString().slice(-8);
const root =
    previous?.root ??
    (await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-ui-' + mode + '-'))),
  evidence = path.join(repo, '.visual/workflow/bot-implementation', mode);
await fs.mkdir(evidence, { recursive: true });
const userData = path.join(root, 'profile');
await fs.mkdir(userData, { recursive: true });
await fs.writeFile(
  path.join(userData, 'onboarding.json'),
  JSON.stringify({
    version: 2,
    phase: 'complete',
    step: 'done',
    permissionChoice: 'skipped',
    completedAt: Date.now(),
  }),
);
await fs.writeFile(
  path.join(userData, 'appearance.json'),
  JSON.stringify({ schemaVersion: 1, skinId: 'classic', mode: 'light' }),
);
const report = {
  mode,
  date: new Date().toISOString(),
  commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  node: process.version,
  platform: process.platform + '/' + process.arch,
  checks: previous?.checks ?? [],
  errors: [],
  screenshots: [],
};
function check(name) {
  report.checks.push(name);
  console.log('PASS', name);
}
async function wait(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('Timed out: ' + label);
}
const runtime =
  process.env.HEMI_PLAYWRIGHT_MODULE ??
  path.join(
    os.homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs',
  );
const { _electron } = await import(pathToFileURL(runtime).href);
let app, page;
const shot = async (name) => {
  const file = name + '.png';
  await page.screenshot({ path: path.join(evidence, file), scale: 'css' });
  report.screenshots.push(file);
};
const resize = async (width) => {
  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !new URL(w.webContents.getURL()).searchParams.has('mode'),
    );
    win.setMinimumSize(1, 1);
    win.setContentSize(width, 900);
    win.show();
  }, width);
  await page.waitForFunction((width) => innerWidth === width, width);
  if (width <= 880)
    await page.locator('.h24-sidebar').waitFor({ state: 'hidden' });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
};
async function launch() {
  app = await _electron.launch({
    executablePath: electronPath,
    args: ['.'],
    env: {
      ...process.env,
      HEMI_USER_DATA_DIR: userData,
      HEMI_SSH_BIN: path.join(root, 'ssh'),
      HEMI_TEST_MIC_GRANT: '1',
    },
  });
  await wait(() => {
    page = app
      .windows()
      .find(
        (p) =>
          /^(http|file):/.test(p.url()) &&
          !new URL(p.url()).searchParams.has('mode'),
      );
    return !!page;
  }, 'main window');
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(m.text());
  });
  await page.locator('textarea.text-composer-input').waitFor();
  const perf = page.getByRole('button', { name: '移动性能监控', exact: true });
  if (await perf.count()) {
    await perf.focus();
    for (let n = 0; n < 22; n++) await page.keyboard.press('Shift+ArrowUp');
  }
}
const state = () => page.evaluate(() => window.hemiVoice.bot.getState());
const call = (method, params = {}) =>
  page.evaluate(
    ({ method, params }) => window.hemiVoice.bot.command(method, params),
    { method, params },
  );
const text = () => page.locator('textarea.text-composer-input');
const send = async (value) => {
  const inputs = (value) =>
    Object.values(value.cache?.details ?? {}).flatMap((d) => [
      ...d.flow.timeline.filter((i) => i.kind === 'user').map((i) => i.id),
      ...d.flow.pending.map((i) => i.inputId),
    ]);
  const before = new Set(inputs(await state()));
  await text().fill(value);
  await text().press('Enter');
  await wait(
    async () => inputs(await state()).some((id) => !before.has(id)),
    'message accepted',
  );
};
try {
  if (!previous) {
    await docker(
      'exec',
      context.name,
      'useradd',
      '-m',
      '-s',
      '/bin/bash',
      '-p',
      '*',
      user,
    );
    await docker('exec', context.name, 'loginctl', 'enable-linger', user);
    await docker(
      'exec',
      context.name,
      'sh',
      '-c',
      `printf '\nPermitUserEnvironment yes\n' >> /etc/ssh/sshd_config; systemctl restart ssh`,
    );
    await docker(
      'exec',
      context.name,
      'install',
      '-d',
      '-m',
      '700',
      '-o',
      user,
      '-g',
      user,
      `/home/${user}/.ssh`,
    );
    await docker(
      'cp',
      path.join(context.root, 'identity.pub'),
      context.name + `:/home/${user}/.ssh/authorized_keys`,
    );
    await docker(
      'exec',
      context.name,
      'sh',
      '-c',
      `printf 'PATH=/usr/bin:/bin\n' > /home/${user}/.ssh/environment; chown -R ${user}:${user} /home/${user}/.ssh; chmod 600 /home/${user}/.ssh/authorized_keys /home/${user}/.ssh/environment; mkdir /home/${user}/project-a /home/${user}/project-b; chown ${user}:${user} /home/${user}/project-*`,
    );
    const original = await fs.readFile(context.sshConfig, 'utf8');
    await fs.writeFile(
      path.join(root, 'ssh_config'),
      original
        .replace('hemi-bot-isolated', 'hemi-bot-ui')
        .replace('User hemi', 'User ' + user),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(root, 'ssh'),
      `#!/bin/sh\nexec /usr/bin/ssh -F '${path.join(root, 'ssh_config')}' "$@"\n`,
      { mode: 0o700 },
    );
    await docker(
      'cp',
      path.join(repo, 'scripts/fixtures/cloud-bot/model-server.mjs'),
      context.name + ':/tmp/model-server-new.mjs',
    );
    // Restart only our disposable fixture process, never the resident Bot.
    await docker(
      'exec',
      context.name,
      'sh',
      '-c',
      "pkill -f '^node /tmp/model-server(-new)?\\.mjs$' || true; node /tmp/model-server-new.mjs >/tmp/hemi-fixture-model.log 2>&1 &",
    );
    await launch();
    report.rendererUrl = page.url();
    await resize(1440);
    await page.evaluate(() =>
      window.hemiVoice.saveModelProfile({
        id: 'fixture',
        name: '隔离模型',
        api: 'openai-completions',
        baseUrl: 'http://hemi-bot-model:3030/v1',
        apiKey: 'fixture-only-key',
        models: [
          {
            id: 'main',
            model: 'fixture-model',
            thinkingLevel: 'off',
            supportsVision: true,
          },
        ],
        makeDefault: true,
      }),
    );
    await page.reload();
    await text().waitFor();
    await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await page.getByRole('button', { name: '创建连接', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'SSH 地址', exact: true })
      .fill('hemi-bot-ui');
    await page.getByRole('button', { name: '连接并继续', exact: true }).click();
    await page
      .getByRole('button', { name: '初始化并开始使用', exact: true })
      .waitFor({ timeout: 90000 });
    assert.equal((await state()).candidate.info.runtimeNeeded, true);
    check('实际引导探测 Linux，识别服务器缺少 Node/npm');
    assert.equal(await page.getByRole('dialog', {name:'配置云端 Bot',exact:true}).getByRole('combobox').count(),0);
    check('初始化只需选择同步模型，默认空间由 Bot 自动准备');
    await shot('setup-configure');
    await page
      .getByRole('button', { name: '初始化并开始使用', exact: true })
      .click();
    await wait(
      async () => !!(await state()).binding,
      'full first install',
      600000,
    );
    await text().waitFor();
    await wait(async () => {
      const value = await state();
      return value.online && !!value.cache?.sessions.length;
    }, 'first conversation');
    check(
      '实际 IPC 部署私有 Node、npm ci、systemd、模型验证、文件命令验证及 SSH 脱离常驻',
    );
  } else {
    await launch();
    await resize(1440);
    if ((await state()).cache?.enabled === false) await call('service.start');
    await wait(async () => (await state()).online, 'restore connection');
    await docker(
      'cp',
      path.join(repo, 'scripts/fixtures/cloud-bot/model-server.mjs'),
      context.name + ':/tmp/model-server-new.mjs',
    );
    await docker(
      'exec',
      context.name,
      'sh',
      '-c',
      "pkill -f '^node /tmp/model-server-new.mjs$' || true; node /tmp/model-server-new.mjs >/tmp/hemi-fixture-model.log 2>&1 &",
    );
    await call('component.update');
    await wait(async () => (await state()).online, 'maintenance recovery');
    for (const session of (await state()).cache.sessions)
      await call('session.remove', { id: session.id });
    await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await wait(
      async () => (await state()).cache.sessions.length === 1,
      'clean test conversation',
    );
    check('空闲时重新部署云端组件并保留原实例与会话');
    check(
      '实际 IPC 部署私有 Node、npm ci、systemd、模型验证、文件命令验证及 SSH 脱离常驻',
    );
  }
  await text().waitFor();
  const botPerf = page.getByRole('button', {
    name: '移动性能监控',
    exact: true,
  });
  if (await botPerf.count()) {
    await botPerf.focus();
    for (let n = 0; n < 22; n++) await page.keyboard.press('Shift+ArrowUp');
  }
  const modelBefore = (
    await docker('exec', context.name, 'node', '-p', 'process.version')
  ).stdout.trim();
  assert.equal(modelBefore, 'v22.22.3');
  const nodePath = (
    await docker(
      'exec',
      context.name,
      'readlink',
      `/home/${user}/.local/share/hemi-bot/runtime`,
    )
  ).stdout.trim();
  assert.match(nodePath, /node-v22\.22\.3-linux-/);
  check('私有运行环境保存于 Bot 目录，全局 Node 保持原版本');
  assert.equal(
    await page.getByRole('button', { name: /开始.*通话|按住.*说话/ }).count(),
    0,
  );
  const voice = await page.evaluate(() => window.hemiVoice.startAsr('hold'));
  assert.equal(voice.code, 'BOT_VOICE_DISABLED');
  check('Bot 无语音入口，主进程拒绝启动 ASR');
  await shot('conversation-empty');
  await send('生成文件，验证真实云端运行');
  await wait(
    async () =>
      Object.values((await state()).cache?.details ?? {}).some(
        (d) => Object.keys(d.flow.artifacts).length && d.flow.phase === 'idle',
      ),
    'real delivery',
  );
  await page.locator('.h62-deliverable-card').first().waitFor();
  await shot('conversation-delivery');
  const current = (await state()).cache.sessions[0].id;
  const detail = await call('session.open', { id: current }),
    artifact = Object.values(detail.flow.artifacts)[0];
  assert.ok(artifact);
  await app.evaluate(
    ({ dialog }, savePath) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: savePath,
      });
    },
    path.join(root, 'download.md'),
  );
  const downloaded = await page.evaluate(
    ({ current, artifact }) => window.hemiVoice.bot.download(current, artifact),
    { current, artifact: artifact.artifactId },
  );
  assert.equal(downloaded.ok, true);
  assert.equal(
    await fs.readFile(path.join(root, 'download.md'), 'utf8'),
    'cloud host proof',
  );
  check('真实云端运行、交付登记、原页面展示和下载字节一致');
  await page.locator('.h62-deliverable-card').first().click();
  await page.getByText('cloud host proof', { exact: false }).first().waitFor();
  await shot('cloud-file-preview');
  await page
    .getByRole('button', { name: '收起预览，返回对话', exact: true })
    .click();
  await page.getByRole('button', { name: '默认空间', exact: true }).click();
  await page.getByRole('button', { name: '主目录', exact: true }).click();
  await page.getByRole('button', { name: 'project-a', exact: true }).click();
  await page.getByRole('button', { name: '使用此文件夹', exact: true }).click();
  await wait(
    async () =>
      (await call('session.open', { id: current })).dir ===
      `/home/${user}/project-a`,
    'cloud cwd',
  );
  check('会话目录使用真实云端文件夹，云端确认后更新');
  await text().fill('会话 A 草稿');
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await wait(
    async () => (await state()).cache.sessions.length === 2,
    'second conversation',
  );
  await wait(
    async () => (await text().inputValue()) === '',
    'switch to new conversation',
  );
  await text().fill('会话 B 草稿');
  await page.waitForTimeout(600);
  const all = (await state()).cache.sessions,
    b = all.find((s) => s.id !== current).id;
  await page
    .getByRole('button', { name: /生成文件，验证真实云端运行/ })
    .first()
    .click();
  await wait(
    async () => (await text().inputValue()) === '会话 A 草稿',
    'switch back to original draft',
  );
  assert.equal(
    (await call('session.open', { id: b, activate: false })).draft.text,
    '会话 B 草稿',
  );
  check('多会话共用普通侧栏与输入框，目录和草稿独立');
  await call('connection.disconnect');
  await text().fill('离线草稿保留');
  await page.waitForTimeout(600);
  assert.equal((await state()).online, false);
  await shot('offline-draft');
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await wait(async () => (await state()).online, 'reconnect');
  assert.equal(await text().inputValue(), '离线草稿保留');
  check('断开连接只影响控制通道，离线草稿保留并恢复');
  const attachmentPath = path.join(root, 'bot-brief.md');
  await fs.writeFile(attachmentPath, '# BOT_UI_REMOTE_ATTACHMENT\n');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, attachmentPath);
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await page.getByRole('menuitem', { name: /选中文件/ }).click();
  await page
    .getByRole('button', { name: '预览文件附件 bot-brief.md', exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: '预览文件附件 bot-brief.md', exact: true })
    .click();
  await page
    .getByText('BOT_UI_REMOTE_ATTACHMENT', { exact: false })
    .first()
    .waitFor();
  await shot('cloud-attachment-preview');
  await page
    .getByRole('button', { name: '收起预览，返回对话', exact: true })
    .click();
  await page
    .getByRole('button', { name: '移除附件 bot-brief.md', exact: true })
    .click();
  check('复用普通附件交互，实际上传云端、按会话读取和预览');
  await send('延时任务，队列验收');
  await send('排队消息');
  await page.getByRole('button', { name: '编辑这条', exact: true }).click();
  await wait(
    async () => (await text().inputValue()) === '排队消息',
    'queue edit',
  );
  await text().fill('修改后的排队消息');
  await text().press('Enter');
  await wait(
    async () =>
      (await call('flow.snapshot', { id: current })).pending.some(
        (i) => i.text === '修改后的排队消息' && i.state === 'pending',
      ),
    'queue saved',
  );
  await page.getByRole('button', { name: '撤回这条', exact: true }).click();
  await wait(
    async () => (await call('flow.snapshot', { id: current })).phase === 'idle',
    'queue active run settled',
  );
  check('复用普通排队、编辑和撤回组件，实际操作云端控制器');
  await text().fill('/model');
  await page.getByRole('menuitem', { name: /^\/model/ }).waitFor();
  await text().press('Enter');
  await page.getByRole('menu', { name: '切换模型', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('menuitemradio', { name: /自动路由/ }).count(),
    0,
  );
  await page.getByRole('menuitemradio', { name: /fixture-model/ }).click();
  await wait(
    async () => (await text().inputValue()) === '',
    'model command consumed',
  );
  check('/model 复用普通模型菜单，只提供已同步云端模型');
  await send('需要确认');
  await wait(
    async () =>
      Object.values(
        (await state()).cache.details[current]?.permissions ?? {},
      ).some((p) => p.status === 'pending'),
    'cloud permission',
  );
  await shot('cloud-permission');
  if (mode === 'dev') {
    await page.waitForTimeout(36000);
    assert.ok(
      Object.values((await state()).cache.details[current].permissions).some(
        (p) => p.status === 'pending',
      ),
    );
    check('云端确认超过35秒仍在等待，未自动拒绝或重放');
  }
  assert.equal(await page.locator('.permission-countdown').count(), 0);
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await wait(
    async () => (await state()).cache.details[current].flow.phase === 'idle',
    'permission decision',
  );
  check('云端敏感命令等待用户确认，不使用本机 35 秒超时');
  await send('延时任务');
  await wait(
    async () => (await state()).cache.details[current].flow.phase !== 'idle',
    'background run accepted',
  );
  await app.close();
  app = null;
  await new Promise((r) => setTimeout(r, 10000));
  await launch();
  await page.getByRole('button', { name: 'Bot', exact: true }).click();
  await wait(
    async () =>
      Object.values((await state()).cache?.details ?? {}).some(
        (d) =>
          d.id === current &&
          d.flow.phase === 'idle' &&
          Object.values(d.flow.artifacts).some(
            (a) => a.name === 'background-proof.md',
          ),
      ),
    'app close residency',
  );
  check('完全退出 Electron 后任务继续，重启客户端恢复同一 Bot 和交付记录');
  const pdf = path.join(root, 'fixture.pdf');
  await fs.writeFile(pdf, pdfFixture(['BOT_PDF_PROOF']));
  await docker(
    'cp',
    pdf,
    context.name + `:/home/${user}/project-a/fixture.pdf`,
  );
  await docker(
    'exec',
    context.name,
    'chown',
    `${user}:${user}`,
    `/home/${user}/project-a/fixture.pdf`,
  );
  await send('PDF 交付验收');
  await wait(
    async () =>
      (await state()).cache.details[current].flow.phase === 'idle' &&
      Object.values((await state()).cache.details[current].flow.artifacts).some(
        (a) => a.name === 'fixture.pdf',
      ),
    'PDF registered',
  );
  await page
    .getByRole('button', { name: '预览 fixture.pdf', exact: true })
    .first()
    .click();
  await page.locator('.h24-preview canvas').first().waitFor({ timeout: 60000 });
  await shot('cloud-pdf-preview');
  await page
    .getByRole('button', { name: '收起预览，返回对话', exact: true })
    .click();
  check('实际云端 PDF 交付通过共用阅读器渲染');
  await page.getByRole('button', { name: '同步本机模型', exact: true }).click();
  await page
    .getByRole('dialog', { name: '同步本机模型', exact: true })
    .waitFor();
  await shot('manual-model-sync');
  await page.getByRole('button', {name:'选择同步模型', exact:true}).click();
  await page
    .getByRole('dialog', { name: '同步本机模型', exact: true })
    .getByRole('checkbox')
    .first()
    .check();
  await page.getByRole('button', { name: '同步到 Bot', exact: true }).click();
  await page.getByText('同步完成', { exact: true }).waitFor();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  check('手动勾选模型后通过实际 IPC 同步，并从云端验证回执');
  await page.getByRole('button', { name: 'Bot 设置', exact: true }).click();
  await shot('bot-settings');
  await app.evaluate(
    ({ dialog }, savePath) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: savePath,
      });
    },
    path.join(root, 'diagnostics.json'),
  );
  await page.getByRole('button', { name: '导出诊断', exact: true }).click();
  await page.getByText('诊断已导出', { exact: true }).waitFor();
  const diagnostic = await fs.readFile(
    path.join(root, 'diagnostics.json'),
    'utf8',
  );
  assert.equal(diagnostic.includes('fixture-only-key'), false);
  assert.equal(diagnostic.includes('离线草稿保留'), false);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  check('手动模型同步和设置可用，诊断不包含密钥或会话正文');
  for (const width of [1440, 1180, 768, 375]) {
    await resize(width);
    await shot('conversation-' + width);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      'viewport ' + width,
    );
  }
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });

  await shot('reduced-motion-os-dark');
  check('1440/1180/768/375 布局无页面横向溢出，减少动态效果可用');
  await resize(1440);

  await page
    .locator('.h24-sidebar-item[data-current="true"]')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
  await page.getByRole('menuitem', { name: '确认删除', exact: true }).click();
  await wait(
    async () => !(await state()).cache.sessions.some((s) => s.id === current),
    'current conversation removed',
  );
  assert.equal((await state()).online, true);
  check('普通侧栏删除当前云端会话后仍保持连接和轮询');
  await page.getByRole('button', { name: 'Bot 设置', exact: true }).click();
  await page.getByRole('button', { name: '停止 Bot', exact: true }).click();
  await page.getByRole('button', { name: '停止 Bot', exact: true }).click();
  await wait(
    async () =>
      !(await state()).online && (await state()).cache.enabled === false,
    'Bot stopped',
  );
  await page
    .getByRole('dialog', { name: 'Bot 设置', exact: true })
    .getByRole('button', { name: '启动 Bot', exact: true })
    .click();
  await wait(
    async () => (await state()).online && (await state()).cache.enabled,
    'Bot restarted',
  );
  await page.getByRole('button', { name: '完成', exact: true }).click();
  check('通过实际设置停止与重新启动 systemd Bot，保留会话');
  const instance = (await state()).binding.instanceId;
  await page.getByRole('button', { name: 'Bot 设置', exact: true }).click();
  await page
    .getByRole('button', { name: '仅移除本机绑定', exact: true })
    .click();
  await page
    .getByRole('button', { name: '仅移除本机绑定', exact: true })
    .click();
  await wait(async () => !(await state()).binding, 'forget binding');
  await page.getByRole('button', { name: '创建连接', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'SSH 地址', exact: true })
    .fill('hemi-bot-ui');
  await page.getByRole('button', { name: '连接并继续', exact: true }).click();
  await page
    .getByRole('button', { name: '连接已有 Bot', exact: true })
    .waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: '连接已有 Bot', exact: true }).click();
  await wait(
    async () => (await state()).online && !!(await state()).binding,
    'restore same Bot',
  );
  assert.equal((await state()).binding.instanceId, instance);
  check('移除本机绑定后识别并恢复原 Bot，不重复安装');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await text().waitFor();
  const local = await page.evaluate(() => window.hemiVoice.listConversations());
  assert.equal(
    local.sessions.some((s) => s.id === current),
    false,
  );
  check('返回普通对话后本地会话与 Bot 会话分离');
  assert.deepEqual(report.errors, [], 'no renderer errors');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  console.error(error.stack);
  if (page) {
    await shot('failure').catch(() => {});
    await fs
      .writeFile(
        path.join(evidence, 'failure-dom.txt'),
        await page.locator('body').innerText(),
      )
      .catch(() => {});
    console.error('STATE', JSON.stringify(await state().catch(() => null)));
  }
} finally {
  await app?.close().catch(() => {});
  await fs.writeFile(
    path.join(evidence, 'report.json'),
    JSON.stringify({ ...report, root, user, container: context.name }, null, 2),
  );
  console.log('REPORT', path.join(evidence, 'report.json'));
  if (!report.passed) process.exitCode = 1;
}
