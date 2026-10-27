import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
const exec = promisify(execFile);
let helper;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function readWindowsCommandArtifact(directory = import.meta.dirname) {
  const [source, binary, manifest] = await Promise.all([
    fs.readFile(path.join(directory, 'windows-command-job.cs'), 'utf8'),
    fs.readFile(path.join(directory, 'windows-command-job.exe')),
    fs.readFile(path.join(directory, 'windows-command-job.json'), 'utf8').then(JSON.parse),
  ]);
  if (manifest.sourceSha256 !== sha256(source.replace(/\r\n/g, '\n')) || manifest.binarySha256 !== sha256(binary)) {
    throw new Error('Windows 命令守卫与源码校验不一致；请重新构建组件');
  }
  return {binary, manifest};
}

/** Extract our packaged .NET Framework supervisor. No target-machine compiler or SDK. */
export function windowsCommandHelper() {
  return helper ??= (async () => {
    const {binary, manifest} = await readWindowsCommandArtifact();
    const key = manifest.binarySha256;
    const dir = path.join(os.tmpdir(), 'hemi-command-jobs', key);
    await fs.mkdir(dir, {recursive:true});
    const target = path.join(dir, 'command-job.exe');
    try {if (sha256(await fs.readFile(target)) === key) return target;} catch {}
    const staging = path.join(dir, randomUUID()); await fs.mkdir(staging);
    try {
      const exe = path.join(staging, 'command.exe');
      await fs.writeFile(exe, binary, {mode:0o700});
      // Concurrent hosts extract identical bytes; never replace an executable in use.
      try { await fs.rename(exe, target); } catch (error) {
        if (sha256(await fs.readFile(target)) !== key) throw error;
      }
      return target;
    } finally { await fs.rm(staging, {recursive:true, force:true}); }
  })().catch(error => {helper=null; throw error;});
}

export async function reapWindowsCommand(token, timeoutMs = 7000) {
  const exe = await windowsCommandHelper();
  await exec(exe, ['reap', token], {windowsHide:true, timeout:timeoutMs});
}
