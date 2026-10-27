import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function botControlEndpoint(dataDir, platform = process.platform, token = '') {
  if (platform !== 'win32') return path.join(dataDir, 'control.sock');
  const identity = path.win32.resolve(dataDir).toLowerCase();
  return '\\\\.\\pipe\\hemi-bot-' + createHash('sha256').update(identity + '\0' + token).digest('hex').slice(0, 32);
}
export function controlToken(dataDir, {create = false, platform = process.platform} = {}) {
  if (platform !== 'win32') return undefined;
  const file = path.join(dataDir, 'control-token');
  if (create) {
    try { fs.writeFileSync(file, randomBytes(32).toString('hex'), {flag: 'wx', mode: 0o600}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return fs.readFileSync(file, 'utf8');
}
export function validControlToken(actual, expected) {
  if (expected === undefined) return true;
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
