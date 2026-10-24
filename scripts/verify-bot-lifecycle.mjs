// Fresh desktop profile, real SSH/Host, focused regression for shared navigation and service state.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import electronPath from 'electron';
import { pathToFileURL } from 'node:url';
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built',
  repo = path.resolve(import.meta.dirname, '..'),
  evidence = path.join(repo, '.visual/workflow/bot-implementation', mode);
const previous = JSON.parse(
  await fs.readFile(path.join(evidence, 'report.json'), 'utf8'),
);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-lifecycle-')),
  profile = path.join(root, 'profile');
await fs.mkdir(path.join(profile, 'bot'), { recursive: true });
for (const file of ['connection.json', 'cache.json'])
  await fs.copyFile(
    path.join(previous.root, 'profile/bot', file),
    path.join(profile, 'bot', file),
  );
await fs.writeFile(
  path.join(profile, 'onboarding.json'),
  JSON.stringify({
    version: 2,
    phase: 'complete',
    step: 'done',
    permissionChoice: 'skipped',
    completedAt: Date.now(),
  }),
);
const runtime =
    process.env.HEMI_PLAYWRIGHT_MODULE ??
    path.join(
      os.homedir(),
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs',
    ),
  { _electron } = await import(pathToFileURL(runtime).href);
let app, page;
const label='生命周期验收-'+Date.now();
const checks = [],
  errors = [];
const note = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const wait = async (fn, label) => {
  for (let n = 0; n < 300; n++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out: ' + label);
};
const state = () => page.evaluate(() => window.hemiVoice.bot.getState());
async function launch() {
  app = await _electron.launch({
    executablePath: electronPath,
    args: ['.'],
    env: {
      ...process.env,
      HEMI_USER_DATA_DIR: profile,
      HEMI_SSH_BIN: path.join(previous.root, 'ssh'),
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
  }, 'window');
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('textarea.text-composer-input').waitFor();
  await page.getByRole('button', { name: 'Bot', exact: true }).click();
  await wait(async () => (await state()).online, 'connection');
  await page.locator('textarea.text-composer-input').waitFor();
}
try {
  await launch();
  const guards = await page.evaluate(async () => ({
    asr: await window.hemiVoice.startAsr('hold'),
    duplex: await window.hemiVoice.startDuplex(),
    tts: await window.hemiVoice.speakTts({ turnId: 1, text: 'fixture' }),
  }));
  assert.equal(guards.asr.code, 'BOT_VOICE_DISABLED');
  assert.equal(guards.duplex.ok, false);
  assert.equal(guards.tts.ok, false);
  note('实际主进程同时拒绝 Bot ASR、duplex 与 TTS，不启动设备');
  const beforeCount=(await state()).cache.sessions.length;
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await wait(
    async () => (await state()).cache.sessions.length > beforeCount,
    'new session',
  );
  await page.locator('button.h24-sidebar-open').first().click();
  await page.waitForTimeout(150);
  await page
    .locator('.h24-sidebar-item[data-current="true"] button')
    .first()
    .dblclick();
  const rename = page.getByRole('textbox', { name: '重命名会话', exact: true });
  await rename.fill(label);
  await rename.press('Enter');
  await page
    .locator('button.h24-sidebar-open').filter({hasText:label})
    .waitFor();
  const input = page.locator('textarea.text-composer-input');
  await input.fill('LIFECYCLE_CLOUD_DRAFT');
  await page.waitForTimeout(800);
  const selected = (await state()).cache.sessions.find(
    (s) => s.title === label,
  ).id;
  await page.locator('button.h24-sidebar-open').filter({hasNotText:label}).first().click();
  await wait(
    async () => (await input.inputValue()) !== 'LIFECYCLE_CLOUD_DRAFT',
    'other session',
  );
  await page.locator('button.h24-sidebar-open').filter({hasText:label}).click();
  await wait(
    async () => (await input.inputValue()) === 'LIFECYCLE_CLOUD_DRAFT',
    'draft restored',
  );
  await app.close();
  app = null;
  await launch();
  await wait(
    async () =>
      (await page.locator('textarea.text-composer-input').inputValue()) ===
      'LIFECYCLE_CLOUD_DRAFT',
    'selection restored after process restart',
  );
  assert.equal((await state()).cache.selectedId, selected);
  note('只读切换已缓存会话后完全重启，仍恢复最后会话和原草稿');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '停止 Bot', exact: true }).click();
  await page.getByRole('dialog', { name: '停止云端 Bot？', exact: true })
    .getByRole('button', { name: '停止 Bot', exact: true }).click();
  await wait(
    async () => (await state()).stoppedConfirmed === true,
    'OS stop confirmed',
  );
  await page.getByText('已确认停止', { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(evidence, 'lifecycle-service-stopped.png'),
  });
  await page
    .locator('.h37-settings-shell')
    .getByRole('button', { name: '启动 Bot', exact: true })
    .click();
  await wait(async () => {
    const s = await state();
    return s.online && s.cache.enabled && !s.stoppedConfirmed;
  }, 'OS restarted');
  await page.getByRole('button', { name: 'Bot', exact: true }).click();
  note('收到 systemd 停止回执后才显示已确认停止，重新启动恢复服务');
  await page
    .locator('.h24-sidebar-item[data-current="true"]')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
  await page.getByRole('menuitem', { name: '确认删除', exact: true }).click();
  await wait(
    async () => !(await state()).cache.sessions.some((s) => s.id === selected),
    'delete',
  );
  assert.equal((await state()).online, true);
  assert.deepEqual(errors, []);
  note('删除当前会话后保持连接，renderer 无异常');
  await fs.writeFile(
    path.join(evidence, 'lifecycle-report.json'),
    JSON.stringify(
      { mode, date: new Date().toISOString(), checks, errors, passed: true },
      null,
      2,
    ),
  );
} catch (e) {
  await page
    ?.screenshot({ path: path.join(evidence, 'lifecycle-failure.png') })
    .catch(() => {});
  throw e;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
