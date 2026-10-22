// Production app with synthetic obsolete configuration and the OS store blocked.
import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const dir = process.env.HEMI_USER_DATA_DIR;
const identity = process.env.HEMI_KEYCHAIN_TEST_IDENTITY;
if (!dir || !/^hemi-keychain-test-[a-f0-9-]+$/.test(identity ?? '')) throw new Error('Isolated test identity required');
const setName = app.setName.bind(app);
const probe = { calls: [], names: [] };
globalThis.__hemiKeychainProbe = probe;
app.setName = name => { probe.names.push(name); setName(identity); };
app.setName('hemi');
app.setPath('userData', dir);
for (const method of ['isEncryptionAvailable', 'encryptString', 'decryptString']) {
  safeStorage[method] = () => { probe.calls.push(method); throw new Error('System credential store must never be accessed'); };
}

if (process.env.HEMI_KEYCHAIN_TEST_SEED === '1') {
  app.whenReady().then(async () => {
    // No real OS ciphertext is needed: the obsolete format must never be decoded.
    const obsolete = Buffer.from('v10-obsolete-synthetic-ciphertext').toString('base64');
    const write = (name, value) => fs.writeFile(path.join(dir, name), JSON.stringify(value), { mode: 0o600 });
    await fs.mkdir(dir, { recursive: true });
    await write('onboarding.json', { version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() });
    await write('doubao-asr.json', { encryptedApiKey: obsolete, jevEncryptedApiKey: obsolete, resourceId: 'synthetic-resource', ttsEnabled: true, floatingOrbEnabled: true, globalPushToTalkEnabled: false });
    await write('web-search.json', { provider: 'tavily', encryptedApiKey: obsolete });
    await write('text-model.json', { model: 'legacy-model', baseUrl: process.env.HEMI_KEYCHAIN_TEST_ENDPOINT, encryptedApiKey: obsolete });
    await write('text-model-profiles.json', { version: 3, defaultModelId: 'fixture/main', providers: [
      { id: 'fixture', name: 'Fixture', baseUrl: process.env.HEMI_KEYCHAIN_TEST_ENDPOINT, encryptedApiKey: obsolete, models: [{ id: 'main', model: 'fixture-model' }] },
    ] });
    await write('remote-passwords.json', { version: 1, hosts: { 'fixture-host': obsolete } });
    const { initializeRuntimeStorage } = await import('../../src/main/agent-runtime/storage-migration.mjs');
    await initializeRuntimeStorage({ userDataDir: dir });
    await write('runtime-v2/oauth-credentials.json', { version: 1, deviceId: 'synthetic-device', entries: { openai: obsolete } });
    await fs.mkdir(path.join(dir, 'provider-import'), { recursive: true });
    await write('provider-import/obsolete-operation.json', { schema: 1, operationId: 'obsolete-operation', encrypted: obsolete });
    await fs.mkdir(path.join(dir, 'provider-logins'), { recursive: true });
    const siteKey = createHash('sha256').update('https://fixture.test').digest('hex');
    await write(`provider-logins/${siteKey}.json`, { schema: 1, encrypted: obsolete });
    if (probe.calls.length) throw new Error('Fixture accessed the system store');
    app.quit();
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  await import('../../src/main/index.mjs');
  const c = await import('../../src/main/lib/config-store.mjs');
  const p = await import('../../src/main/lib/profiles-holder.mjs');
  const r = await import('../../src/main/remote/remote-service.mjs');
  const { createLoginStore } = await import('../../src/main/services/provider-import/login-store.mjs');
  const { createImportJournal } = await import('../../src/main/services/provider-import/journal.mjs');
  const { secretStorage } = await import('../../src/main/lib/secret-storage.mjs');
  const loginStore = createLoginStore({ dirPath: path.join(dir, 'provider-logins'), safeStorage: secretStorage });
  const journal = createImportJournal({ dirPath: path.join(dir, 'provider-import'), safeStorage: secretStorage });
  probe.verifyUnsupportedCredentials = async () => {
    const model = await p.getProfiles().resolveStrict('fixture/main');
    return !(await c.resolveConfig()).apiKey && !(await c.resolveJevConfig()).apiKey
      && !(await c.resolveWebSearchConfig()).apiKey && !(await c.resolveTextModelConfig()).apiKey
      && !model.ok && model.reason === 'no-credentials'
      && !(await p.getOAuthRuntime().credentials.read('openai'))
      && (await p.getOAuthRuntime().credentials.list()).length === 0
      && !(await journal.read('obsolete-operation')).ok
      && !(await loginStore.read('https://fixture.test')).credentials
      && !r.getRemoteService().hasPassword('fixture-host');
  };
  probe.configureOtherCredentials = async () => {
    await c.saveTextModelStore({ apiKey: 'synthetic-text-key' });
    await p.getOAuthRuntime().credentials.modify('openai', () => ({ type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3600000 }));
    await journal.persist('obsolete-operation', { phase: 'failed', apiKey: 'synthetic-import-key' });
    await loginStore.update('https://fixture.test', { credentials: { password: 'synthetic-login-password' } });
    r.getRemoteService().rememberPassword('fixture-host', 'synthetic-ssh-password', { remember: true });
  };
  probe.verifyCredentials = async (speechKey, webKey) => (await c.resolveConfig()).apiKey === speechKey
    && (await c.resolveJevConfig()).apiKey === 'synthetic-jev-key'
    && (await c.resolveWebSearchConfig()).apiKey === webKey
    && (await c.resolveTextModelConfig()).apiKey === 'synthetic-text-key'
    && (await p.getProfiles().resolveStrict('fixture/main')).config.apiKey === 'synthetic-model-key'
    && (await p.getOAuthRuntime().credentials.read('openai')).access === 'synthetic-access'
    && (await journal.read('obsolete-operation')).payload.apiKey === 'synthetic-import-key'
    && (await loginStore.read('https://fixture.test')).credentials.password === 'synthetic-login-password'
    && r.getRemoteService().hasPassword('fixture-host');
}
