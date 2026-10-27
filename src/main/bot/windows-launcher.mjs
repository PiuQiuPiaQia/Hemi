// Stable Task Scheduler entry. Releases can change while this path stays fixed.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = import.meta.dirname;
process.env.USERPROFILE = path.resolve(root, '../../..');
process.env.HEMI_BOT_DATA_DIR = path.join(root, 'data');
process.env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? '');
try {
  const active = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
  const releases = path.join(root, 'releases') + path.sep;
  if (!path.resolve(active.release).startsWith(releases)) throw new Error('Bot release path is invalid');
  const instance = process.argv[2] === 'desktop'
    ? await (await import(pathToFileURL(path.join(active.release, 'src/main/bot/windows-desktop.mjs')).href)).startWindowsDesktopWorker({dataDir: process.env.HEMI_BOT_DATA_DIR})
    : await (await import(pathToFileURL(path.join(active.release, 'src/main/bot/cli.mjs')).href)).serve();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void instance.close().then(() => process.exit(0));
  });
} catch (error) {
  fs.appendFileSync(path.join(root, process.argv[2] === 'desktop' ? 'desktop-error.log' : 'host-error.log'), `${new Date().toISOString()} ${error.stack}\n`);
  process.exitCode = 1;
}
