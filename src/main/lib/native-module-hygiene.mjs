/**
 * 原生模块加载前的目录卫生：清掉 ._ 开头的 AppleDouble 垃圾文件。
 *
 * 背景（2026-09-23 真机缺陷）：exFAT 工作区与 dmg→/Applications 拷贝链路会
 * 在文件旁生成 `._同名` AppleDouble 垃圾（com.apple.provenance 等扩展属性的
 * 落盘形态），而 node-gyp-build 解析原生模块时**先 readdir `build/Release`、
 * 取第一个 `*.node`**，垃圾文件按目录序排在真身前面就会被 dlopen：
 * `slice is not valid mach-o file`（0.1.0 安装包 8758 个垃圾文件让全局
 * Option 钩子起不来，设置页误报缺辅助功能授权）。
 *
 * 只清已知原生模块的 build/Release、build/Debug 与 prebuilds/<平台> 目录，
 * 不递归 node_modules；只读卷上清不掉时不抛错——失败原因会经 startError
 * 如实上报，不再静默。
 */
import { readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const JUNK_PREFIX = '._';

/**
 * @param {string} moduleName 包名（须能 resolve 到 `<pkg>/package.json`）。
 * @param {{resolveFn?: (id: string) => string, readdirFn?: typeof readdirSync, rmFn?: typeof rmSync}} [deps]
 *   依赖注入供单测使用（resolveFn 默认取 createRequire().resolve）。
 * @returns {string[]} 清掉的文件（相对模块目录），空数组=无需清理或模块不可达。
 */
export function purgeAppleDoubleJunk(moduleName, deps = {}) {
  const resolveFn = deps.resolveFn ?? ((id) => createRequire(import.meta.url).resolve(id));
  const readdirFn = deps.readdirFn ?? readdirSync;
  const rmFn = deps.rmFn ?? rmSync;

  let moduleDir;
  try {
    moduleDir = path.dirname(resolveFn(`${moduleName}/package.json`));
  } catch {
    return [];
  }

  const targets = ['build/Release', 'build/Debug'];
  try {
    for (const name of readdirFn(path.join(moduleDir, 'prebuilds'))) {
      targets.push(`prebuilds/${name}`);
    }
  } catch {
    /* 无 prebuilds 目录的包直接跳过 */
  }

  const removed = [];
  for (const sub of targets) {
    const dir = path.join(moduleDir, ...sub.split('/'));
    let entries;
    try {
      entries = readdirFn(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith(JUNK_PREFIX)) continue;
      try {
        rmFn(path.join(dir, name), { force: true });
        removed.push(`${sub}/${name}`);
      } catch {
        /* 只读卷：清不掉就留给 dlopen 报真实错误 */
      }
    }
  }
  return removed;
}
