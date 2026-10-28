import fs from 'node:fs';
import path from 'node:path';

export const COMPONENT_MANIFEST = 'hemi-bot-runtime.manifest.json';
const numbers = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)
  && value.split('.').every(part => Number.isSafeInteger(Number(part)))
  ? [...value.split('.').map(Number), ...(value.split('.').length === 3 ? [0] : [])] : null;

export function formatComponentVersion(appVersion, revision) {
  if (!/^\d+\.\d+\.\d+$/.test(appVersion) || !numbers(appVersion)
    || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Bot 组件版本号无效。');
  return `${appVersion}.${revision}`;
}
export function readComponentVersion(file = path.resolve(import.meta.dirname, '../../..', COMPONENT_MANIFEST)) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (numbers(value.version) && /^[a-f0-9]{64}$/.test(value.build))
      return {version: value.version, build: value.build,
        ...(/^[a-f0-9]{64}$/.test(value.archiveSha256) ? {archiveSha256: value.archiveSha256} : {})};
  } catch {}
  return null;
}

/** An older PC must never replace a newer release deployed by another device. */
export function componentUpdateNeeded(local, remote) {
  if (!local) return false;
  if (!remote) return true;
  const a = numbers(local.version), b = numbers(remote.version);
  if (!a || !b) throw new Error('Bot 组件版本号无效。');
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return local.build !== remote.build;
}
