import fs from 'node:fs';
import path from 'node:path';

/** Keep license inventories portable when node_modules is a local symlink. */
export function dependencySourcePath(root, filename) {
  const inside = relative => relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  const relative = path.relative(root, filename);
  if (inside(relative)) return relative.replaceAll('\\', '/');
  const modules = fs.realpathSync(path.join(root, 'node_modules'));
  const dependency = path.relative(modules, filename);
  if (!inside(dependency)) throw new Error('Dependency resolves outside the checkout and its node_modules');
  return path.posix.join('node_modules', dependency.replaceAll('\\', '/'));
}
