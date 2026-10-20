# Hemi 官方 Skill 目录

首批官方源由本仓库维护。`source/<id>/` 存放审阅用原文；`npm run build:skill-market` 确定性生成
`src/main/skills/official/catalog.json` 和 `bundles/*.json`。应用内置同一份目录与包。当前代码配置的
Hemi `main` 分支 GitHub Raw 地址因仓库私有，对未登录用户返回 404，尚不能用于在线更新；公开
发布源或随应用更新的方式待确定。候选上架必须由仓库维护者审阅 `SKILL.md`、相对资源和
可能的脚本，再合并到 `main`；发布权限沿用仓库写权限。

更新现有 Skill 时：

1. 修改 `source/<id>/`，递增 `scripts/build-skill-market.mjs` 中的语义版本。
2. 运行 `npm run build:skill-market`，检查生成的文件清单和 SHA-256 一并提交。
3. 运行 `node --test src/main/skills/skill-store.test.mjs`、`npm test` 和 `npm run build`。
4. 当前内置目录的变更随下一版应用提供；配置可公开访问的目录后，应用里的“刷新官方目录”才会读取新版本，用户仍需手动点更新。

包格式是 `schema: 1` 的 JSON 文件列表，正文以 Base64 表示。安装器限制数量、大小、路径和
文件类型；安装不运行包内脚本。SHA-256 校验传输完整性，HTTPS 与仓库维护权限构成首批发布
信任边界。当前没有独立目录签名，也不开放任意第三方源。
