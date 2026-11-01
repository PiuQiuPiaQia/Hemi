#!/usr/bin/env node
// Real codesign verification; no TCC records or installed applications are used.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectSigningMode } from '../src/main/services/updater.mjs';
import { certificatePath, prepareMacSigning, signingCommand, signingDirectory, signingRequirement, verifyMacSignature } from './lib/macos-signing.mjs';
import signMac from './sign-macos.cjs';

const { keychain, fingerprint } = prepareMacSigning();
const root = mkdtempSync(path.join(os.tmpdir(), 'hemi-signing-verification-'));
const appId = 'ai.hemi.signing-verification';
const checks = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const fixture = (name, version) => {
  const app = path.join(root, `${name}.app`);
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(path.join(app, 'Contents/Resources'));
  copyFileSync('/usr/bin/true', path.join(app, 'Contents/MacOS/Fixture'));
  writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${appId}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>`);
  writeFileSync(path.join(app, 'Contents/Resources/payload.txt'), version);
  writeFileSync(path.join(app, 'Contents/Resources/asset.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]));
  return app;
};
const sign = (app, extra = []) => signingCommand('/usr/bin/codesign', ['--force', '--sign', fingerprint, '--keychain', keychain, '--timestamp=none', ...extra, app]);

try {
  const pinnedBefore = readFileSync(certificatePath);
  execFileSync(process.execPath, ['scripts/setup-macos-signing.mjs'], { stdio: 'pipe' });
  assert.deepEqual(readFileSync(certificatePath), pinnedBefore);
  check('setup reuses the pinned signing identity');
  assert.throws(() => execFileSync(process.execPath, ['scripts/setup-macos-signing.mjs', '--create'], { stdio: 'pipe' }));
  assert.deepEqual(readFileSync(certificatePath), pinnedBefore);
  check('setup refuses to regenerate an existing project identity');

  const ciDir = path.join(root, 'ci-signing');
  const ciEnv = { ...process.env, HEMI_MAC_SIGNING_DIR: ciDir };
  delete ciEnv.HEMI_MAC_SIGNING_P12; delete ciEnv.HEMI_MAC_SIGNING_PASSWORD;
  assert.throws(() => execFileSync(process.execPath, ['scripts/setup-macos-signing.mjs', '--ci'], { env: ciEnv, stdio: 'pipe' }));
  check('CI refuses to build without its saved signing secrets');

  const oldApp = fixture('Old', '1');
  const newApp = fixture('New', '2');
  const signBundle = app => signMac({ app, identity: fingerprint, keychain, identityValidation: false, platform: 'darwin', preAutoEntitlements: false, optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }) });
  await signBundle(oldApp); await signBundle(newApp);
  const oldInfo = verifyMacSignature(oldApp, { appId });
  const newInfo = verifyMacSignature(newApp, { appId });
  assert.equal(oldInfo.requirement, newInfo.requirement);
  const cdhash = app => /CDHash=(.+)/.exec(signingCommand('/usr/bin/codesign', ['-dv', '--verbose=4', app]))?.[1];
  assert.ok(cdhash(oldApp));
  assert.notEqual(cdhash(oldApp), cdhash(newApp));
  signingCommand('/usr/bin/codesign', ['--verify', '-R', `=${oldInfo.requirement}`, newApp]);
  signingCommand('/usr/bin/codesign', ['--verify', '-R', `=${newInfo.requirement}`, oldApp]);
  check('different builds retain the same certificate-bound identity in both directions');
  const asset = path.join(oldApp, 'Contents/Resources/asset.png');
  assert.ok(!execFileSync('/usr/bin/xattr', [asset], { encoding: 'utf8' }).split('\n').some(name => name.startsWith('com.apple.cs.')));
  assert.deepEqual(readFileSync(asset), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]));
  check('binary resources remain unchanged without detached signature attributes');

  try {
    const saved = signingDirectory();
    execFileSync(process.execPath, ['scripts/setup-macos-signing.mjs', '--ci'], {
      env: { ...ciEnv, HEMI_MAC_SIGNING_P12: readFileSync(path.join(saved, 'identity.p12')).toString('base64'), HEMI_MAC_SIGNING_PASSWORD: readFileSync(path.join(saved, 'identity-password'), 'utf8') }, stdio: 'pipe',
    });
    const restored = fixture('CI', '3');
    signingCommand('/usr/bin/codesign', ['--force', '--sign', fingerprint, '--keychain', path.join(ciDir, 'hemi-signing.keychain-db'), '--timestamp=none', restored]);
    assert.equal(verifyMacSignature(restored, { appId }).requirement, oldInfo.requirement);
    check('CI restores the original private identity and signs a compatible third build');
  } finally {
    if (existsSync(path.join(ciDir, 'hemi-signing.keychain-db'))) signingCommand('/usr/bin/security', ['delete-keychain', path.join(ciDir, 'hemi-signing.keychain-db')]);
  }

  assert.equal(detectSigningMode({ execPath: path.join(newApp, 'Contents/MacOS/Fixture') }), 'ad-hoc');
  check('actual self-signed executable keeps Hemi on its existing swap installer');

  const unrelated = fixture('Other', '2');
  signingCommand('/usr/bin/codesign', ['--force', '--sign', '-', unrelated]);
  assert.throws(() => verifyMacSignature(unrelated, { appId }));
  check('same bundle identifier with an ad-hoc signer is rejected');

  sign(newApp, ['--requirements', `=designated => identifier "${appId}"`]);
  assert.throws(() => verifyMacSignature(newApp, { appId }), /designated requirement/);
  check('identifier-only identity is rejected even when signed with the correct certificate');

  writeFileSync(path.join(oldApp, 'Contents/Resources/payload.txt'), 'tampered');
  assert.throws(() => verifyMacSignature(oldApp, { appId }));
  check('modified bundle resources are rejected');

  const evidence = path.resolve('.visual/workflow/macos-signing');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'identity-verification.json'), `${JSON.stringify({
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: 'uncommitted macOS signing changes',
    environment: `${process.platform}/${process.arch}; Node ${process.version}; ${os.release()}`,
    command: 'npm run verify:mac-signing', requirement: signingRequirement(), checks,
    remaining: 'Actual TCC grant continuity requires a manual grant on build A and a real update to build B; no installed Hemi or existing privacy permissions were modified.',
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
