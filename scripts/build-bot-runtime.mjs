import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
export async function buildBotRuntime({
  root = path.resolve(import.meta.dirname, '..'),
  output = path.join(root, 'build/hemi-bot-runtime.tgz'),
} = {}) {
  const temporaryOutput = output + '.' + randomUUID() + '.tmp';
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bot-package-'));
  try {
    async function copy(dir, relative) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('._') || entry.name.endsWith('.test.mjs'))
          continue;
        const source = path.join(dir, entry.name),
          target = path.join(stage, relative, entry.name);
        if (entry.isDirectory())
          await copy(source, path.join(relative, entry.name));
        else if ((/\.(mjs|json)$/.test(entry.name) || (relative === 'src/main/agent/roles' && entry.name.endsWith('.md')))) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(source, target);
        }
      }
    }
    for (const dir of ['src/main', 'src/shared'])
      await copy(path.join(root, dir), dir);
    const app = JSON.parse(
      await fs.readFile(path.join(root, 'package.json'), 'utf8'),
    );
    const names = [
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
      'fflate',
      'unpdf',
      '@xmldom/xmldom',
      'playwright-core',
      'jose',
      'ws',
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
    return output;
  } finally {
    await fs.rm(temporaryOutput, { force: true });
    await fs.rm(stage, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(await buildBotRuntime());
}
