// Only relay the other platform's small manifest; never rebuild or copy its installer.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relayUpdateManifest } from './lib/release-platform.mjs';

const [tag, platform] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !['mac', 'win'].includes(platform)) throw new Error('Usage: node scripts/relay-release-manifest.mjs vX.Y.Z mac|win');
const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const repo = process.env.GH_REPO || gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
const name = platform === 'mac' ? 'latest.yml' : 'latest-mac.yml';
const releases = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100`]));
const previous = releases.find(release => !release.draft && !release.prerelease && release.tag_name !== tag && release.assets.some(asset => asset.name === name));
if (!previous) {
  console.log(`No previous ${name}; no companion platform has been published.`);
} else {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'hemi-release-manifest-'));
  try {
    const file = path.join(temporary, name), asset = previous.assets.find(asset => asset.name === name);
    writeFileSync(file, execFileSync('gh', ['api', `repos/${repo}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { maxBuffer: 1024 * 1024 }));
    writeFileSync(file, relayUpdateManifest(readFileSync(file, 'utf8'), previous.assets));
    gh(['release', 'upload', tag, file]);
    console.log(`Relayed ${name} from ${previous.tag_name}; installer stays in its original release.`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
