// Developer/build step only; deployed Bots use the checked, packaged executable.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec = promisify(execFile);
if (process.platform !== 'win32') throw new Error('Build the command supervisor on Windows, then retain its source and hash manifest together');
const directory = process.argv[2] ?? path.resolve(import.meta.dirname, '../src/main/agent/gate');
const source = await fs.readFile(path.join(directory, 'windows-command-job.cs'), 'utf8');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-command-build-'));
try {
  const input = path.join(temporary, 'command.cs'), output = path.join(temporary, 'command.exe');
  await fs.writeFile(input, source.replace(/\r\n/g, '\n'));
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await exec(compiler, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', '/out:'+output, input], {windowsHide:true, timeout:30000});
  const binary = await fs.readFile(output), sha256 = value => createHash('sha256').update(value).digest('hex');
  const manifest = {schema:1, platform:'win32-x64', runtime:'.NET Framework 4', sourceSha256:sha256(source.replace(/\r\n/g, '\n')), binarySha256:sha256(binary)};
  await fs.writeFile(path.join(directory, 'windows-command-job.exe'), binary);
  await fs.writeFile(path.join(directory, 'windows-command-job.json'), JSON.stringify(manifest, null, 2)+'\n');
  console.log(JSON.stringify(manifest));
} finally {await fs.rm(temporary, {recursive:true, force:true});}
