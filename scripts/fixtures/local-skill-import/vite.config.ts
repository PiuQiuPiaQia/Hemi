// 导入本地技能弹窗的隔离验证页：复用渲染层 vite 配置（别名、Tailwind），
// 只换 root / 输出目录，不进 dist-renderer，也不读写任何真实应用数据。
import path from 'node:path';
import { defineConfig, type ConfigEnv, type UserConfig } from 'vite';
import base from '../../../vite.config';

const repo = path.resolve(import.meta.dirname, '../../..');

export default defineConfig((env: ConfigEnv) => {
  const config = (typeof base === 'function' ? base(env) : base) as UserConfig;
  return {
    ...config,
    root: import.meta.dirname,
    publicDir: path.join(repo, 'src/renderer/public'),
    server: { host: '127.0.0.1', port: Number(process.env.HEMI_FIXTURE_PORT || 5188), strictPort: true },
    preview: { host: '127.0.0.1', port: Number(process.env.HEMI_FIXTURE_PORT || 5189), strictPort: true },
    build: { outDir: path.join(repo, 'tmp/local-skill-import-build'), emptyOutDir: true },
  };
});
