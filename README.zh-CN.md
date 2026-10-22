# Hemi

[English](README.md) · 简体中文

Hemi 是一款 macOS 桌面 AI 助手，用语音或文字交代任务，让 AI 在电脑上行动。

[下载安装包：macOS（Apple Silicon）／Windows（x64）](https://github.com/PiuQiuPiaQia/Hemi/releases/latest)

## 自动路由与成本控制

为主模型与不同角色分别配置模型，按任务需要分工协作，兼顾能力与调用成本。实际请求用量可追溯。

[![Hemi 模型路由配置](docs/media/screenshots/feature-routing.png)](docs/media/screenshots/feature-routing.png)

[![Hemi 会话用量：各角色调用、输入输出与缓存统计](docs/media/screenshots/feature-usage.png)](docs/media/screenshots/feature-usage.png)

## 模型账号登录

在「设置 → 模型与路由 → 添加供应商 → 账号登录」连接 ChatGPT、Claude 或 GitHub Copilot。浏览器授权后，模型直接加入对话与角色路由的选择列表。凭据加密保存在本机，到期自动刷新；支持重新登录和退出登录。每家服务商保留一个账号，具体模型权限与额度由服务商决定。

## New API 登录接入

在应用内登录受支持的 New API 站点，创建专属 Key，验证并导入接口与模型配置。支持保留登录状态、过期后补全账号密码。

[![Hemi New API 登录接入](docs/media/screenshots/feature-newapi.png)](docs/media/screenshots/feature-newapi.png)

## 应用级权限

桌面操作按应用授权，可选择本次任务或持续允许，并随时撤销。危险命令仍需单独确认。

[![Hemi 应用授权管理](docs/media/screenshots/feature-app-permissions.png)](docs/media/screenshots/feature-app-permissions.png)

## 自动记忆

在交流中记住长期偏好和项目约定，按个人、全局、工作区分别管理。支持查看、编辑、删除和撤销。

[![Hemi 记忆条目与范围管理](docs/media/screenshots/feature-memory.png)](docs/media/screenshots/feature-memory.png)

## 从源码运行

macOS（Apple Silicon），Node.js 22.19+。

```bash
npm ci
npm run dev
```

启动后，在「设置 → 模型与路由」配置模型。

## 许可

[MIT](LICENSE) · [第三方声明](THIRD-PARTY-NOTICES.md) · [截图来源](docs/media/screenshots/SOURCES.md)

[开发](docs/development.zh-CN.md) · [参与贡献](CONTRIBUTING.md) · [安全与隐私](SECURITY.md)
