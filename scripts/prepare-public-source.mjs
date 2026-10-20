#!/usr/bin/env node
// Prepares a separate candidate directory from committed Git objects. Never deletes source/history.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outputArg = args.shift();
let ref = 'HEAD';
if (args[0] === '--ref' && args[1]) { args.shift(); ref = args.shift(); }
if (!outputArg || args.length) throw new Error('Usage: node scripts/prepare-public-source.mjs <new-directory> [--ref <commit-or-tree>]');
const output = path.resolve(outputArg);
const parent = fs.realpathSync(path.dirname(output));
const resolvedOutput = path.join(parent, path.basename(output));
const sourceRoot = fs.realpathSync(root);
const within = (base, target) => target === base || (!path.relative(base, target).startsWith(`..${path.sep}`) && path.relative(base, target) !== '..' && !path.isAbsolute(path.relative(base, target)));
if (within(sourceRoot, resolvedOutput) || within(resolvedOutput, sourceRoot)) throw new Error('Output must be outside the source checkout');
if (fs.existsSync(output) || fs.existsSync(`${output}.report.json`)) throw new Error('Output or report already exists; choose a new path');

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { cwd: root, maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr?.toString()}`);
  return result.stdout;
}
const tree = run('git', ['rev-parse', '--verify', `${ref}^{tree}`], { encoding: 'utf8' }).trim();
const read = filename => run('git', ['show', `${tree}:${filename}`]);
const policy = JSON.parse(read('scripts/public-source-policy.json').toString('utf8'));
const hasPrivateInputs = spawnSync('git', ['cat-file', '-e', `${tree}:${policy.privateSubstitutions}`], { cwd: root }).status === 0;
const privateInputs = hasPrivateInputs ? JSON.parse(read(policy.privateSubstitutions).toString('utf8')) : { files: [], replacements: [] };
const entries = run('git', ['ls-tree', '-r', '-z', tree], { encoding: 'utf8' }).split('\0').filter(Boolean).map(line => {
  const tab = line.indexOf('\t');
  const [mode] = line.slice(0, tab).split(' ');
  return { mode, filename: line.slice(tab + 1) };
});
const included = [], excluded = [];
for (const entry of entries) {
  const { filename, mode } = entry;
  if (filename.split('/').some(part => part === '..' || part === '.git') || /[\r\n]/.test(filename)) throw new Error('Unsafe repository path');
  const keep = !policy.excludeFiles.includes(filename) && (policy.includeRoots.includes(filename.split('/')[0]) || policy.includeFiles.includes(filename) || policy.includePrefixes.some(prefix => filename.startsWith(prefix)));
  if (!keep) { excluded.push(filename); continue; }
  if (!['100644', '100755'].includes(mode)) throw new Error(`Review symlink/submodule before export: ${filename}`);
  included.push(filename);
}
if (included.includes(policy.privateSubstitutions)) throw new Error('Private export inputs must be excluded from the candidate');
const guidance = read(policy.guidanceTemplate);
const archive = run('git', ['archive', '--format=tar', tree, '--', ...included]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-public-archive-'));
const archivePath = path.join(temporary, 'source.tar');
const replacements = [];
try {
  fs.writeFileSync(archivePath, archive);
  fs.mkdirSync(output);
  run('tar', ['-xf', archivePath, '-C', output]);
  fs.writeFileSync(path.join(output, 'AGENTS.md'), guidance);
  for (const replacement of policy.replacements) {
    if (!included.includes(replacement.file)) throw new Error('Replacement must target an included file');
    const target = path.join(output, replacement.file);
    const before = fs.readFileSync(target, 'utf8');
    const pattern = new RegExp(replacement.pattern, 'g');
    const count = [...before.matchAll(pattern)].length;
    fs.writeFileSync(target, before.replace(pattern, replacement.to));
    replacements.push({ ...replacement, count });
  }
  for (const filename of privateInputs.files) {
    if (!included.includes(filename)) throw new Error('Private substitution must target an included file');
    const target = path.join(output, filename);
    let text = fs.readFileSync(target, 'utf8');
    let count = 0;
    for (const replacement of privateInputs.replacements) {
      count += text.split(replacement.from).length - 1;
      text = text.replaceAll(replacement.from, replacement.to);
    }
    fs.writeFileSync(target, text);
    replacements.push({ file: filename, privateInput: true, count });
  }
  const files = [...included, 'AGENTS.md'].sort().map(filename => ({ filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(output, filename))).digest('hex') }));
  const report = { status: 'candidate only; not published, no Git history created', tree, output: resolvedOutput, originalWorkingTreeCopied: false, included: files, excluded, generated: ['AGENTS.md'], replacements };
  fs.writeFileSync(`${output}.report.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, report: `${output}.report.json`, included: files.length, excluded: excluded.length, replacements }));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
