// Focused sharing flow through the real Electron/preload/IPC/desktop service,
// OpenSSH HostName resolution, CLI/socket/Host and HTTPS device gateway.
// Only the SSH network boundary and model execution use local fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID, X509Certificate} from 'node:crypto';
import {SignJWT, generateKeyPair, exportJWK, calculateJwkThumbprint} from 'jose';
import QRCode from 'qrcode';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';

const repo = path.resolve(import.meta.dirname, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-sharing-'));
const output = path.join(repo, '.visual/workflow/bot-sharing');
await fs.mkdir(output, {recursive: true});
process.env.HEMI_BOT_DATA_DIR = path.join(root, 'cloud');
process.env.HEMI_USER_DATA_DIR = path.join(root, 'host-profile');
const {serve} = await import('../src/main/bot/cli.mjs');
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), workingTree: true,
  node: process.version, platform: `${process.platform}/${process.arch}`, date: new Date().toISOString(),
  command: 'node scripts/verify-bot-sharing.mjs', sources: {}, results: []};
for (const name of ['src/main/remote/ssh-runner.mjs', 'src/main/bot/desktop-service.mjs', 'src/renderer/src/windows/bot/pairing.tsx'])
  report.sources[name] = createHash('sha256').update(await fs.readFile(path.join(repo, name))).digest('hex');
const wait = async (read, label) => {
  const deadline = Date.now() + 20000;
  while (!await read()) {assert.ok(Date.now() < deadline, 'Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 50));}
};
let service, vite, app;
try {
  // The production default must be available; never stop an existing listener.
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {reservation.once('error', reject); reservation.listen(29421, '127.0.0.1', resolve);});
  await new Promise(resolve => reservation.close(resolve));
  service = await serve({defaultDir: path.join(root, 'workspace'), validateModel: async () => {}, executorFactory: () => ({
    async run() {return {};}, async stop() {}, async close() {},
  })});
  const hello = await service.host.request('handshake');
  const call = (method, params = {}) => service.host.request(method, {instanceId: hello.instanceId, requestId: randomUUID(), ...params});
  await call('model.sync', {models: [{modelKey: 'fixture/model', providerId: 'fixture', name: 'Synthetic', model: 'fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid', apiKey: 'TEST_ONLY'}]});
  await call('session.create');
  const ssh = path.join(root, 'ssh.mjs'), config = path.join(root, 'ssh-config'), log = path.join(root, 'calls.jsonl'), ticket = path.join(root, 'invitation.json');
  await fs.writeFile(config, 'Host isolated-sharing-bot\n  HostName 127.0.0.1\n  User fixture\n  Port 2222\n', {mode: 0o600});
  await fs.writeFile(ssh, `#!${process.execPath}
import {spawn} from 'node:child_process';import fs from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('-O'))process.exit(0);
if(args.includes('-G')){const child=spawn('/usr/bin/ssh',['-F',${JSON.stringify(config)},...args],{stdio:['ignore','inherit','inherit']});child.on('exit',code=>process.exit(code??1));}
else {
  const command=args.at(-1);if(!command.includes('cli.mjs'))process.exit(1);
  let raw='';for await(const part of process.stdin)raw+=part;
  const request=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:request.method,endpoint:request.params?.endpoint})+'\\n');
  const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(repo, 'src/main/bot/cli.mjs'))},'rpc'],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(process.env.HEMI_BOT_DATA_DIR)}},stdio:['pipe','pipe','inherit']});
  child.stdin.end(raw);let reply='';child.stdout.on('data',value=>reply+=value);child.on('exit',code=>{if(request.method==='pairing.create'&&JSON.parse(reply).ok)fs.writeFileSync(${JSON.stringify(ticket)},JSON.stringify(JSON.parse(reply).result));process.stdout.write(reply);process.exit(code??1);});
}
`, {mode: 0o700});
  vite = await createServer({configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error', server: {host: '127.0.0.1', port: 0, strictPort: false}});
  await vite.listen();
  for (const mode of ['dev', 'built']) {
    const profile = path.join(root, mode);
    await fs.mkdir(path.join(profile, 'bot'), {recursive: true});
    await fs.writeFile(path.join(profile, 'bot/connection.json'), JSON.stringify({host: 'isolated-sharing-bot', instanceId: hello.instanceId, protocol: hello.protocol, version: hello.version, home: root, dataDir: process.env.HEMI_BOT_DATA_DIR, boundAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now()}));
    await fs.writeFile(path.join(profile, 'doubao-asr.json'), JSON.stringify({globalPushToTalkEnabled: false}));
    await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({schemaVersion: 1, skinId: 'classic', mode: 'light'}));
    const env = {...process.env, HEMI_USER_DATA_DIR: profile, HEMI_SSH_BIN: ssh, HEMI_BOT_AUTO_UPDATE: '0', HEMI_TEST_MIC_GRANT: '1'};
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    const result = {mode, checks: [], errors: [], screenshots: []}; report.results.push(result);
    const check = name => {result.checks.push(name); console.log('PASS', mode, name);};
    app = await _electron.launch({executablePath: electronPath, args: ['.'], cwd: repo, env});
    let page;
    await wait(() => {page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page;}, 'main window');
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') result.errors.push(message.text());});
    try {
      await page.getByRole('button', {name: 'Bot', exact: true}).click();
      await wait(async () => (await page.evaluate(() => window.hemiVoice.bot.getState())).online, 'Bot connected');
      if (mode === 'dev') assert.equal((await call('pairing.status')).enabled, false);
      await fs.writeFile(log, '');
      await page.getByRole('button', {name: '连接新设备', exact: true}).click();
      const dialog = page.getByRole('dialog', {name: '连接新设备', exact: true});
      const image = dialog.getByRole('img', {name: 'Hemi 一次性设备配对码', exact: true});
      await image.waitFor();
      const seconds = /· (\d+) 秒后过期/.exec(await dialog.locator('figcaption').innerText());
      assert.ok(seconds && Number(seconds[1]) > 0 && Number(seconds[1]) <= 120);
      assert.equal(await dialog.getByRole('textbox').count(), 0);
      assert.equal(await dialog.getByRole('button', {name: '启用设备连接', exact: true}).count(), 0);
      const first = JSON.parse(await fs.readFile(ticket, 'utf8')), invite = JSON.parse(first.qr);
      assert.equal(invite.endpoint, 'https://127.0.0.1:29421');
      assert.equal(invite.botInstanceId, hello.instanceId);
      const expectedQr = await QRCode.toDataURL(first.qr, {width: 288, margin: 4, errorCorrectionLevel: 'M'});
      const samePixels = await image.evaluate(async (node, expectedQr) => {
        const expected = new Image(); expected.src = expectedQr; await expected.decode();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 288;
        const context = canvas.getContext('2d'); context.drawImage(node, 0, 0);
        const actual = context.getImageData(0, 0, 288, 288).data;
        context.clearRect(0, 0, 288, 288); context.drawImage(expected, 0, 0);
        return context.getImageData(0, 0, 288, 288).data.every((value, index) => value === actual[index]);
      }, expectedQr);
      assert.equal(samePixels, true, 'rendered QR pixels must encode the exact Host invitation');
      const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(calls.filter(item => item.method === 'pairing.create').length, 1);
      assert.equal(calls.filter(item => item.method === 'pairing.configure').length, mode === 'dev' ? 1 : 0);
      check('opening directly generates one real invitation with effective SSH HostName; no input or enable step');
      for (const width of [1440, 768, 375]) {
        await app.evaluate(({BrowserWindow}, width) => {const win = BrowserWindow.getAllWindows().find(w => /^(file|http):/.test(w.webContents.getURL()) && !new URL(w.webContents.getURL()).searchParams.has('mode')); win.setMinimumSize(1, 1); win.setContentSize(width, 850);}, width);
        await page.waitForFunction(width => innerWidth === width, width);
        assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        const file = path.join(output, `${mode}-qr-${width}.png`);
        await page.screenshot({path: file, animations: 'disabled', scale: 'css'}); result.screenshots.push(file);
      }
      result.darkMode = 'Skipped: application appearance schema supports light mode only.';
      check('QR layout has no horizontal overflow at 375/768/1440');
      await dialog.getByRole('button', {name: '完成', exact: true}).click();
      await dialog.waitFor({state: 'hidden'});
      assert.equal((await call('pairing.status', {inviteId: first.inviteId})).invitation.status, 'cancelled');
      await page.getByRole('button', {name: '连接新设备', exact: true}).click();
      await image.waitFor();
      const next = JSON.parse(await fs.readFile(ticket, 'utf8'));
      assert.notEqual(next.inviteId, first.inviteId);
      check('closing cancels the unscanned invitation; reopening creates a fresh QR');
      const cert = await fs.readFile(path.join(process.env.HEMI_BOT_DATA_DIR, 'device-access/tls-cert.pem'));
      assert.equal(createHash('sha256').update(new X509Certificate(cert).raw).digest('base64url'), invite.certificatePin);
      const post = (route, body) => new Promise((resolve, reject) => {
        const raw = Buffer.from(JSON.stringify(body));
        const request = https.request(invite.endpoint + route, {method: 'POST', ca: cert, agent: false, headers: {'content-type': 'application/json', 'content-length': raw.length}}, response => {
          const chunks = []; response.on('data', part => chunks.push(part)); response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks))));
        }); request.on('error', reject); request.end(raw);
      });
      const challenge = await post('/v1/challenge', {}), keys = await generateKeyPair('ES256'), jwk = await exportJWK(keys.publicKey);
      const details = JSON.parse(next.qr), requestId = randomUUID();
      const payload = JSON.stringify({inviteId: next.inviteId, ticket: details.requestTicket, requestId, name: 'Synthetic phone'});
      const proof = await new SignJWT({nonce: challenge.result.nonce, bodyHash: createHash('sha256').update(payload).digest('base64url')})
        .setProtectedHeader({alg: 'ES256', typ: 'hemi-device+jwt', jwk}).setIssuedAt().setJti(randomUUID()).setIssuer('hemi-device-v1')
        .setSubject(await calculateJwkThumbprint(jwk)).setAudience(`${hello.instanceId}:/v1/pair/request`).sign(keys.privateKey);
      assert.equal((await post('/v1/pair/request', {payload, proof})).ok, true);
      await dialog.getByRole('checkbox', {name: '两台设备显示的验证码一致', exact: true}).waitFor();
      assert.equal(await dialog.getByRole('button', {name: '允许连接', exact: true}).isDisabled(), true);
      await image.waitFor({state: 'hidden'});
      await dialog.getByRole('button', {name: '关闭弹窗', exact: true}).click();
      assert.equal((await call('pairing.status')).invitation.request.status, 'pending');
      await page.getByRole('button', {name: '连接新设备', exact: true}).click();
      await dialog.getByRole('checkbox', {name: '两台设备显示的验证码一致', exact: true}).waitFor();
      await dialog.getByRole('button', {name: '拒绝', exact: true}).click();
      await dialog.getByRole('button', {name: '生成配对二维码', exact: true}).waitFor();
      check('actual signed HTTPS request still requires explicit verification; closing preserves pending request');
      await dialog.getByRole('button', {name: '完成', exact: true}).click();
      await page.getByRole('button', {name: '连接新设备', exact: true}).click();
      await image.waitFor();
      await page.evaluate(() => window.hemiVoice.bot.command('connection.disconnect'));
      await image.waitFor({state: 'hidden'});
      await dialog.getByRole('button', {name: '隐藏配对页', exact: true}).click();
      await page.getByRole('button', {name: '连接新设备', exact: true}).click();
      await dialog.getByRole('button', {name: '重新连接', exact: true}).click();
      await dialog.getByRole('button', {name: '检查是否受理', exact: true}).click();
      await dialog.getByText('Bot 尚未记录该操作，请核对当前状态后重试。', {exact: true}).waitFor();
      await dialog.getByRole('button', {name: '完成', exact: true}).click();
      await dialog.waitFor({state: 'hidden'});
      assert.equal((await call('pairing.status')).invitation, null);
      check('disconnect hides QR and cancellation can be reconciled after reconnect');
      assert.deepEqual(result.errors, []);
    } catch (error) {
      result.error = error.stack;
      await page.screenshot({path: path.join(output, mode + '-failure.png')});
      throw error;
    } finally {await app.close(); app = null;}
  }
} finally {
  await app?.close().catch(() => {}); await vite?.close(); await service?.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await fs.rm(root, {recursive: true, force: true});
}
