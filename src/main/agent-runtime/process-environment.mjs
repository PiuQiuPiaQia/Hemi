import path from 'node:path';
import { mkdirSync } from 'node:fs';

let active = null;

/** Runtime-owned paths. These contain original plugin files, never Hemi memory entities. */
export function agentEnvironmentPaths(dataDir) {
  const root = path.resolve(dataDir);
  return {
    memoryDir: path.join(root, 'pi-memory'),
    qmdConfigDir: path.join(root, 'agent-environment', 'qmd'),
    cacheDir: path.join(root, 'agent-environment', 'cache'),
  };
}

/** One desktop/Bot owns the Node process. All of its SDK sessions share native configuration. */
export function acquireAgentEnvironment({ dataDir }) {
  const owner = path.resolve(dataDir);
  if (active && active.owner !== owner) throw new Error('一个执行进程只能属于一个桌面或 Bot 实例');
  if (!active) {
    const paths = agentEnvironmentPaths(owner);
    mkdirSync(paths.memoryDir, { recursive: true });
    const values = {
      PI_MEMORY_DIR: paths.memoryDir,
      PI_MEMORY_SNAPSHOT: 'per-turn',
      PI_MEMORY_NO_SEARCH: '1',
      PI_MEMORY_QMD_UPDATE: 'off',
      PI_MEMORY_EXIT_SUMMARY: '1',
      QMD_CONFIG_DIR: paths.qmdConfigDir,
      XDG_CACHE_HOME: paths.cacheDir,
    };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    active = { owner, paths, previous, refs: 0 };
  }
  active.refs++;
  let released = false;
  return {
    ...active.paths,
    release() {
      if (released) return;
      released = true;
      if (--active.refs !== 0) return;
      for (const [key, value] of Object.entries(active.previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      active = null;
    },
  };
}
