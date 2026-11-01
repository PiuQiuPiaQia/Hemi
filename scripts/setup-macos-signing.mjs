#!/usr/bin/env node
import { randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { certificatePath, prepareMacSigning, signingCommand, signingDirectory, signingFingerprint, signingName } from './lib/macos-signing.mjs';

if (process.platform !== 'darwin') throw new Error('Run this setup on macOS.');
const args = new Set(process.argv.slice(2));
for (const arg of args) if (!['--create', '--ci', '--upload-secrets'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
if (args.has('--ci') && args.has('--create')) throw new Error('CI must import the original certificate, never create a new one.');

const dir = signingDirectory();
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const p12Path = path.join(dir, 'identity.p12');
const passPath = path.join(dir, 'identity-password');
const keychain = path.join(dir, 'hemi-signing.keychain-db');
const keychainPassPath = path.join(dir, 'keychain-password');
const temp = mkdtempSync(path.join(os.tmpdir(), 'hemi-signing-'));
chmodSync(temp, 0o700);
const secretWrite = (file, bytes) => { writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); };
const importedP12 = process.env.HEMI_MAC_SIGNING_P12;
const importedPassword = process.env.HEMI_MAC_SIGNING_PASSWORD;
const secrets = [importedP12, importedPassword];

try {
  if (args.has('--ci') && (!importedP12 || !importedPassword)) throw new Error('CI requires HEMI_MAC_SIGNING_P12 and HEMI_MAC_SIGNING_PASSWORD secrets; ad-hoc fallback is disabled.');
  if (args.has('--create')) {
    if (existsSync(certificatePath) || existsSync(p12Path) || existsSync(passPath)) throw new Error('A signing identity already exists or is pinned. Restore it; do not rotate it during setup.');
    const password = randomBytes(32).toString('base64url');
    secrets.push(password);
    const privateKey = path.join(temp, 'key.pem');
    const publicCert = path.join(temp, 'cert.pem');
    const config = path.join(temp, 'openssl.cnf');
    writeFileSync(config, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=signing\n[dn]\nCN=${signingName}\n[signing]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\n`);
    signingCommand('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '3650', '-nodes', '-keyout', privateKey, '-out', publicCert, '-config', config]);
    const p12 = path.join(temp, 'identity.p12');
    signingCommand('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', privateKey, '-in', publicCert, '-out', p12, '-passout', 'stdin', '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'], { input: `${password}\n`, secrets });
    secretWrite(p12Path, readFileSync(p12));
    secretWrite(passPath, password);
    // Only the public certificate belongs in the repository.
    writeFileSync(certificatePath, new X509Certificate(readFileSync(publicCert)).raw, { flag: 'wx' });
  } else if (importedP12 || importedPassword) {
    if (!importedP12 || !importedPassword) throw new Error('Both signing import variables are required.');
    if (existsSync(p12Path) || existsSync(passPath)) throw new Error('Refusing to overwrite a saved signing identity; use a fresh signing directory for imports.');
    const bytes = Buffer.from(importedP12, 'base64');
    if (!bytes.length) throw new Error('Empty signing certificate archive.');
    secretWrite(p12Path, bytes);
    secretWrite(passPath, importedPassword);
  }
  if (!existsSync(p12Path) || !existsSync(passPath)) throw new Error('Restore identity.p12 and identity-password to the signing directory, or import the two signing variables. Only the first repository setup uses --create.');
  const password = readFileSync(passPath, 'utf8').trim();
  secrets.push(password);
  chmodSync(p12Path, 0o600);
  chmodSync(passPath, 0o600);
  // Check the archive before changing trust or creating a keychain.
  const certPem = signingCommand('/usr/bin/openssl', ['pkcs12', '-in', p12Path, '-passin', 'stdin', '-clcerts', '-nokeys'], { input: `${password}\n`, secrets });
  const importedCert = new X509Certificate(certPem);
  if (importedCert.fingerprint.replaceAll(':', '').toUpperCase() !== signingFingerprint()) throw new Error('Imported certificate differs from the repository signing certificate.');
  const trustCert = path.join(temp, 'signer.cer');
  writeFileSync(trustCert, importedCert.raw);
  if (!existsSync(keychainPassPath)) secretWrite(keychainPassPath, randomBytes(32).toString('base64url'));
  const keychainPassword = readFileSync(keychainPassPath, 'utf8').trim();
  secrets.push(keychainPassword);
  if (!existsSync(keychain)) signingCommand('/usr/bin/security', ['create-keychain', '-p', keychainPassword, keychain], { secrets });
  signingCommand('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', keychain]);
  signingCommand('/usr/bin/security', ['unlock-keychain', '-p', keychainPassword, keychain], { secrets });
  const validIdentities = signingCommand('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
  if (!validIdentities.includes(signingFingerprint())) {
    const identities = signingCommand('/usr/bin/security', ['find-identity', '-p', 'codesigning', keychain]);
    if (!identities.includes(signingFingerprint())) signingCommand('/usr/bin/security', ['import', p12Path, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign'], { secrets });
    // Trust only this certificate for code signing in the current user's domain.
    const importedIdentities = signingCommand('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
    if (!importedIdentities.includes(signingFingerprint())) signingCommand('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychain, trustCert], { secrets });
  }
  signingCommand('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychain], { secrets });
  // codesign still needs the dedicated keychain in the search list, even when
  // --keychain is supplied. Preserve all existing entries and their order.
  const searchList = signingCommand('/usr/bin/security', ['list-keychains', '-d', 'user']).split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    try { return JSON.parse(line); }
    catch { throw new Error('Cannot parse the existing keychain search list; leaving it unchanged.'); }
  });
  if (!searchList.includes(keychain)) signingCommand('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...searchList, keychain]);
  prepareMacSigning();
  if (args.has('--upload-secrets')) {
    signingCommand('gh', ['secret', 'set', 'HEMI_MAC_SIGNING_P12', '--repo', 'PiuQiuPiaQia/Hemi'], { input: readFileSync(p12Path).toString('base64'), secrets });
    signingCommand('gh', ['secret', 'set', 'HEMI_MAC_SIGNING_PASSWORD', '--repo', 'PiuQiuPiaQia/Hemi'], { input: password, secrets });
    console.log('Stored the same signing identity in the Hemi repository Actions secrets.');
  }
  console.log(`Ready: ${signingName}; public certificate ${signingFingerprint()}`);
  console.log(`Private signing backup: ${dir} (keep identity.p12 and identity-password together).`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
