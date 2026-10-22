// Real production startup/IPC, with the system credential store blocked in every phase.
// Run with the built renderer and with VITE_DEV_SERVER_URL. No personal data is read.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import electronPath from 'electron';

const runtime = process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-local-secrets-app-'));
const identity = `hemi-keychain-test-${randomUUID()}`;
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const out = path.resolve(process.env.HEMI_KEYCHAIN_TEST_EVIDENCE || `.visual/workflow/vision/local-secrets/${mode}`);
await fs.mkdir(out, { recursive: true });
const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), workingTree: 'uncommitted changes', node: process.version, platform: `${process.platform}/${process.arch}`, mode, userData, checks: [], command: `${process.env.VITE_DEV_SERVER_URL ? `VITE_DEV_SERVER_URL=${process.env.VITE_DEV_SERVER_URL} ` : ''}node scripts/verify-keychain-startup.mjs`, remaining: 'Installed application and personal profiles are not modified; obsolete credentials require reconfiguration.' };
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
const requests = [];
const server = http.createServer((req, res) => {
  const authenticated = req.headers.authorization === 'Bearer synthetic-model-key';
  requests.push({ url: req.url, authenticated });
  res.writeHead(authenticated ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(authenticated ? { data: [{ id: 'fixture-model' }] } : { error: { message: 'missing synthetic credential' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, HEMI_USER_DATA_DIR: userData, HEMI_KEYCHAIN_TEST_IDENTITY: identity, HEMI_KEYCHAIN_TEST_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1` };
for (const name of Object.keys(env)) if (name.startsWith('HEMI_LLM_') || name.startsWith('DOUBAO_')) delete env[name];
delete env.HEMI_SMOKE_TEST;
const childPath = path.join(root, 'scripts/lib/verify-keychain-app.mjs');
const stored = async () => {
  const speech = JSON.parse(await fs.readFile(path.join(userData, 'doubao-asr.json'), 'utf8'));
  const web = JSON.parse(await fs.readFile(path.join(userData, 'web-search.json'), 'utf8'));
  const profiles = JSON.parse(await fs.readFile(path.join(userData, 'runtime-v2/text-model-profiles.json'), 'utf8'));
  return [speech.encryptedApiKey, speech.jevEncryptedApiKey, web.encryptedApiKey, profiles.providers[0].encryptedApiKey];
};
const viewsOf = page => page.evaluate(async () => {
  const b = window.hemiVoice;
  return Promise.all([b.getConfig(), b.getTtsConfig(), b.getTextModelConfig(), b.getWebSearch(), b.getBrowserAct(), b.getOnboardingState(), b.getUiPreferences()]);
});
let app, page;
try {
  await promisify(execFile)(electronPath, [childPath], { cwd: root, env: { ...env, HEMI_KEYCHAIN_TEST_SEED: '1' }, timeout: 30000 });
  for (let round = 1; round <= 2; round += 1) {
    app = await _electron.launch({ executablePath: electronPath, args: [childPath], cwd: root, env, timeout: 30000 });
    page = await app.firstWindow();
    await page.waitForFunction(() => window.hemiVoice && document.querySelector('textarea.text-composer-input'));
    const views = await viewsOf(page);
    if (round === 1) {
      check('obsolete credentials are shown as unconfigured', views.slice(0, 5).every(value => !value.hasApiKey) && !views[5].asrSaved && !views[5].modelComplete);
      check('speech resource and model endpoint/name are preserved', views[0].resourceId === 'synthetic-resource' && views[2].model === 'fixture-model' && views[2].baseUrl === env.HEMI_KEYCHAIN_TEST_ENDPOINT);
      const original = await stored();
      check('all obsolete credentials are rejected without migration', await app.evaluate(() => globalThis.__hemiKeychainProbe.verifyUnsupportedCredentials()));
      check('reading obsolete configuration does not rewrite it', JSON.stringify(original) === JSON.stringify(await stored()));
      const secretFiles = await fs.readdir(path.join(userData, 'secrets')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      check('obsolete reads create no local key or migration cache', secretFiles.length === 0);
      await page.evaluate(async () => {
        const b = window.hemiVoice;
        await b.saveConfig({ apiKey: 'synthetic-speech-key' });
        await b.setBrowserAct({ apiKey: 'synthetic-jev-key' });
        await b.setWebSearch({ apiKey: 'synthetic-web-key' });
        await b.saveModelProfile({ id: 'fixture', apiKey: 'synthetic-model-key', models: [{ id: 'main', model: 'fixture-model' }] });
      });
      await app.evaluate(() => globalThis.__hemiKeychainProbe.configureOtherCredentials());
      const configured = await viewsOf(page);
      check('reconfiguration reports every API key saved', configured.slice(0, 5).every(value => value.hasApiKey) && configured[5].asrSaved && configured[5].modelComplete);
      check('reconfiguration preserves the existing model endpoint', configured[2].baseUrl === env.HEMI_KEYCHAIN_TEST_ENDPOINT);
    } else {
      check('cold restart restores local key status', views.slice(0, 5).every(value => value.hasApiKey) && views[5].asrSaved && views[5].modelComplete);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await page.waitForTimeout(1200);
    check(`round ${round}: startup and background polling never access the system store`, await app.evaluate(() => globalThis.__hemiKeychainProbe.calls.length === 0));
    const before = await stored();
    await page.evaluate(async () => {
      const b = window.hemiVoice;
      await b.saveTtsConfig({ ttsEnabled: false });
      await b.setFloatingOrbEnabled(false);
      await b.setWebSearch({ enabled: false });
      await b.setBrowserAct({ enabled: false });
    });
    check(`round ${round}: ordinary preferences preserve local ciphertexts`, JSON.stringify(before) === JSON.stringify(await stored()));
    check(`round ${round}: local credentials work across all production stores`, await app.evaluate((_electron, round) => globalThis.__hemiKeychainProbe.verifyCredentials(round === 1 ? 'synthetic-speech-key' : 'synthetic-speech-replacement', round === 1 ? 'synthetic-web-key' : 'synthetic-web-replacement'), round));
    const models = await page.evaluate(() => window.hemiVoice.listRemoteModels({ providerId: 'fixture' }));
    check(`round ${round}: saved model key authenticates a real IPC/provider request`, models.ok && requests.at(-1)?.authenticated);
    check(`round ${round}: credential reads do not rewrite ciphertexts`, JSON.stringify(before) === JSON.stringify(await stored()));
    if (round === 1) {
      await page.evaluate(async () => {
        await window.hemiVoice.saveConfig({ apiKey: 'synthetic-speech-replacement' });
        await window.hemiVoice.setWebSearch({ apiKey: 'synthetic-web-replacement' });
      });
      const after = await stored();
      check('explicit replacement changes only requested ciphertexts', before[0] !== after[0] && before[2] !== after[2] && before[1] === after[1] && before[3] === after[3]);
    } else {
      const cleared = await page.evaluate(() => window.hemiVoice.setWebSearch({ apiKey: '' }));
      const after = await stored();
      check('explicit web-key removal preserves other credentials', !cleared.hasApiKey && !after[2] && before[0] === after[0] && before[1] === after[1] && before[3] === after[3]);
    }
    check(`round ${round}: save, read, requests and replacement never access Electron safeStorage`, await app.evaluate(() => globalThis.__hemiKeychainProbe.calls.length === 0));
    await page.evaluate(() => window.hemiVoice.setFloatingOrbEnabled(true));
    await app.close(); app = null; page = null;
  }
  report.ok = true;
  console.log(`PASS ${mode}: ${report.checks.length} checks; obsolete configuration reset, reconfiguration and cold restart; system store blocked throughout`);
} catch (error) {
  report.failure = error.stack;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
}
