# Contributing / 参与贡献

Use the [development guide](docs/development.md) to run Hemi. For a bug report, include the app version, operating system, reproduction steps, expected behavior and actual result. Remove credentials and private content from logs and screenshots.

Keep a pull request focused on one change. Explain the resulting behavior and how you verified it. Run `npm test`, `npm run build` and `node scripts/check-spacing.mjs`. For model or tool changes, verify a real task through the app; for UI lifecycle changes, check both development and built renderers. Mark untested platforms and remaining gaps.

Do not commit API keys, personal configuration, conversations, recordings or local application data. Preserve third-party notices and update the generated license inventory when dependencies change. Contributions to Hemi's own code use its [MIT license](LICENSE); third-party components retain their original licenses.

Report security issues privately as described in [SECURITY.md](SECURITY.md).

---

按[开发指南](docs/development.zh-CN.md)运行 Hemi。报告问题时附应用版本、操作系统、复现步骤、预期与实际结果；日志和截图请先去除凭据及私人内容。

每个 PR 聚焦一项改动，说明改后的行为和验证结果。运行 `npm test`、`npm run build` 和 `node scripts/check-spacing.mjs`。模型或工具改动还需从应用入口跑实际任务；UI 生命周期改动分别检查开发与构建入口。如实标出未测试的平台和剩余缺口。

不要提交 API Key、个人配置、会话、录音或本机应用数据。保留第三方声明，依赖变化时更新生成的许可清单。Hemi 自有代码的贡献沿用 [MIT](LICENSE)，第三方组件保留原许可。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
