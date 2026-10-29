import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import {COMPONENT_MANIFEST, formatComponentVersion} from '../src/main/bot/component-version.mjs';
import { fileURLToPath } from 'node:url';
import {readWindowsCommandArtifact} from '../src/main/agent/gate/windows-command-job.mjs';
const exec = promisify(execFile);
export async function buildBotRuntime({
  root = path.resolve(import.meta.dirname, '..'),
  output = path.join(root, 'build/hemi-bot-runtime.tgz'),
  componentVersion,
} = {}) {
  if (componentVersion !== undefined) throw new Error('请通过 bot-component-version.json 的 revision 维护组件版本，不支持临时版本覆盖。');
  // Both packaging paths use the application version plus a Bot revision.
  const app = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const {revision} = JSON.parse(await fs.readFile(path.join(root, 'bot-component-version.json'), 'utf8'));
  const version = formatComponentVersion(app.version, revision);
  const temporaryOutput = output + '.' + randomUUID() + '.tmp';
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-package-'));
  try {
    const guard = path.join(root, 'src/main/agent/gate');
    if (await fs.access(path.join(guard, 'windows-command-job.cs')).then(()=>true,()=>false)) await readWindowsCommandArtifact(guard);
    async function copy(dir, relative) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('._') || entry.name.endsWith('.test.mjs'))
          continue;
        const source = path.join(dir, entry.name),
          target = path.join(stage, relative, entry.name);
        if (entry.isDirectory())
          await copy(source, path.join(relative, entry.name));
        else if ((/\.(mjs|json)$/.test(entry.name) || (relative === 'src/main/agent/gate' && /^windows-command-job\.(?:cs|exe)$/.test(entry.name)) || (relative === 'src/main/agent/roles' && entry.name.endsWith('.md')))) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(source, target);
        }
      }
    }
    for (const dir of ['src/main', 'src/shared'])
      await copy(path.join(root, dir), dir);
    const flowWindow='packages/conversation-flow/src/core/flow-window.mjs';
    await fs.mkdir(path.dirname(path.join(stage,flowWindow)),{recursive:true});
    await fs.copyFile(path.join(root,flowWindow),path.join(stage,flowWindow));
    // The headless backend executes these same DOM operations as the extension.
    await fs.cp(path.join(root, 'extensions/chrome-extension'), path.join(stage, 'extensions/chrome-extension'), {
      recursive: true, filter: source => !path.basename(source).startsWith('._'),
    });
    const names = [
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
      '@trycua/cua-driver',
      'pi-memory',
      'fflate',
      'unpdf',
      '@xmldom/xmldom',
      'playwright-core',
      'jose',
      'ws',
      'undici',
      'vscode-jsonrpc',
      '@peculiar/x509',
      'reflect-metadata',
    ];
    const dependencies = Object.fromEntries(
      names.map((name) => [name, app.dependencies[name]]),
    );
    const pkg = {
      name: 'hemi-bot-runtime',
      version: app.version,
      private: true,
      type: 'module',
      license: 'MIT',
      engines: { node: '>=22.19.0 <23' },
      dependencies,
    };
    await fs.writeFile(
      path.join(stage, 'package.json'),
      JSON.stringify(pkg, null, 2),
    );
    const lock = JSON.parse(
      await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'),
    );
    lock.name = pkg.name;
    lock.version = pkg.version;
    lock.packages[''] = {
      name: pkg.name,
      version: pkg.version,
      dependencies,
      engines: pkg.engines,
    };
    await fs.writeFile(
      path.join(stage, 'package-lock.json'),
      JSON.stringify(lock),
    );
    for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md'])
      await fs.copyFile(path.join(root, file), path.join(stage, file));
    await fs.cp(
      path.join(root, 'third-party'),
      path.join(stage, 'third-party'),
      {
        recursive: true,
        filter: (source) => !path.basename(source).startsWith('._'),
      },
    );
    const hash = createHash('sha256');
    async function fingerprint(dir, relative = '') {
      for (const entry of (await fs.readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const name = path.posix.join(relative, entry.name), file = path.join(dir, entry.name);
        if (entry.isDirectory()) await fingerprint(file, name);
        else {
          const bytes = await fs.readFile(file);
          // Git on Windows can check out source with CRLF. The component
          // fingerprint identifies source content across PCs; archiveSha256
          // below still verifies the exact payload, including binary files.
          const text = /\.(?:mjs|js|cs|json|md|txt)$/.test(name) || name === 'LICENSE';
          hash.update(name + '\0');
          hash.update(text ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes);
          hash.update('\0');
        }
      }
    }
    await fingerprint(stage);
    // Component maintenance can advance independently of a desktop release.
    const manifest = JSON.stringify({version, build: hash.digest('hex')}, null, 2) + '\n';
    await fs.writeFile(path.join(stage, COMPONENT_MANIFEST), manifest);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await exec(
      'tar',
      ['--no-xattrs', '--no-acls', '-czf', temporaryOutput, '-C', stage, '.'],
      {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
        maxBuffer: 1024 * 1024,
      },
    );
    await fs.rename(temporaryOutput, output);
    const sidecar = output + '.manifest.json';
    await fs.writeFile(temporaryOutput + '.manifest', JSON.stringify({...JSON.parse(manifest),
      archiveSha256: createHash('sha256').update(await fs.readFile(output)).digest('hex')}, null, 2) + '\n');
    await fs.rename(temporaryOutput + '.manifest', sidecar);
    return output;
  } finally {
    await fs.rm(temporaryOutput, { force: true });
    await fs.rm(temporaryOutput + '.manifest', {force: true});
    await fs.rm(stage, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(await buildBotRuntime());
}
