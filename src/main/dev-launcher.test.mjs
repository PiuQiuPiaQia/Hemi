import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnDev } from '../../scripts/dev.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('dev uses Node and the installed concurrently JS entry, without a shell or .cmd', () => {
  const marker = {};
  const child = spawnDev(5317, (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.equal(path.normalize(options.cwd), path.normalize(path.resolve(root)));
    assert.equal(options.env.HEMI_DEV_PORT, '5317');
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
    assert.equal(options.env[pathKey], process.env[pathKey]);
    assert.equal(options.stdio, 'inherit');
    assert.ok(!options.shell);
    assert.match(args[0], /concurrently[\\/]dist[\\/]bin[\\/]index\.js$/);
    assert.deepEqual(args.slice(1), [
      '-k', '-n', 'renderer,electron', '-c', 'cyan,green', 'npm:dev:renderer', 'npm:dev:electron',
    ]);
    return marker;
  });
  assert.equal(child, marker);
});

test('the resolved concurrently entry actually starts on this platform', () => {
  spawnDev(5318, (command, args, options) => {
    const result = spawnSync(command, [args[0], '--version'], {
      ...options, stdio: 'pipe', encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\d+\.\d+\.\d+/);
    return result;
  });
});
