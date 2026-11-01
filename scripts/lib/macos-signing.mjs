import { X509Certificate } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const signingName = 'Hemi Self-Signed';
export const certificatePath = fileURLToPath(new URL('../../build/macos-signing.cer', import.meta.url));
export const signingDirectory = () => path.resolve(process.env.HEMI_MAC_SIGNING_DIR || path.join(os.homedir(), 'Library/Application Support/Hemi Build Signing'));

// Do not include command arguments in errors: security/openssl receive passwords.
export function signingCommand(command, args, { input, secrets = [] } = {}) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) {
    let detail = result.stderr?.trim() || result.error?.code || `exit ${result.status}`;
    for (const secret of secrets) if (secret) detail = detail.split(secret).join('[redacted]');
    throw new Error(`${path.basename(command)} failed: ${detail}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

export function signingCertificate() {
  if (!existsSync(certificatePath)) throw new Error('Missing public signing certificate. Run npm run signing:mac:setup -- --create once.');
  return new X509Certificate(readFileSync(certificatePath));
}

export function signingFingerprint() {
  return signingCertificate().fingerprint.replaceAll(':', '').toUpperCase();
}

export function signingRequirement(appId = 'ai.hemi.desktop') {
  if (!/^[a-zA-Z0-9.-]+$/.test(appId)) throw new Error('Invalid bundle identifier');
  return `identifier "${appId}" and certificate leaf = H"${signingFingerprint().toLowerCase()}"`;
}

export function prepareMacSigning() {
  if (process.platform !== 'darwin') throw new Error('macOS signing requires macOS');
  const dir = signingDirectory();
  const keychain = path.join(dir, 'hemi-signing.keychain-db');
  const passwordFile = path.join(dir, 'keychain-password');
  if (!existsSync(keychain) || !existsSync(passwordFile)) {
    throw new Error('Stable macOS signing identity is not installed. Run npm run signing:mac:setup; restore the original identity instead of generating a replacement.');
  }
  const password = readFileSync(passwordFile, 'utf8').trim();
  signingCommand('/usr/bin/security', ['unlock-keychain', '-p', password, keychain], { secrets: [password] });
  const identities = signingCommand('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
  if (!identities.includes(signingFingerprint())) throw new Error('Keychain does not contain the pinned Hemi signing identity; refusing to change release identity.');
  // Select the dedicated keychain; never use another same-name certificate.
  // electron-builder resolves this signing info after beforePack.
  process.env.CSC_KEYCHAIN = keychain;
  return { keychain, fingerprint: signingFingerprint() };
}

export function verifyMacSignature(appPath, { appId = 'ai.hemi.desktop' } = {}) {
  const requirement = signingRequirement(appId);
  signingCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=${requirement}`, appPath]);
  const display = signingCommand('/usr/bin/codesign', ['-d', '-r-', '--verbose=2', appPath]);
  const actual = /^designated => (.+)$/m.exec(display.replace(/^# /gm, ''))?.[1];
  // Checking the external requirement alone would accept a hash-pinned or
  // identifier-only DR. Require the stable signer-bound DR stored by TCC too.
  if (actual?.toLowerCase() !== requirement.toLowerCase()) throw new Error(`App designated requirement is not the stable Hemi certificate requirement: ${actual ?? 'missing DR'}`);
  return { requirement, fingerprint: signingFingerprint() };
}
