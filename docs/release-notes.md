本次更新可以直接用 ChatGPT、Claude 或 GitHub Copilot 账号登录，凭据改为应用本地加密。

- 账号登录：在「设置 → 模型与路由 → 添加供应商 → 账号登录」连接账号，浏览器授权后模型直接进入对话和角色路由的选择列表。每家服务商保留一个账号，可随时重新登录或退出。
- 凭据存储：API Key、账号 token 和记住的密码改由应用在本机用 AES-256-GCM 加密，不再使用系统钥匙串。加密钥匙在应用数据目录的 `secrets/` 中，备份时需保留整个应用数据目录。旧的系统密文不再兼容，需要重新填写或登录；模型名称和接口地址会保留。
- 修复：Windows 上的无头浏览器发现按目标平台拼接路径；生成的皮肤文件固定为 LF，避免 Windows 检出后换行比对失败。

下载：macOS（Apple 芯片）用 `.dmg`，Windows（64 位）用 `-setup.exe`。macOS 安装包未签名、未公证，首次打开需在「系统设置 → 隐私与安全性」中允许。

---

This update adds sign-in with a ChatGPT, Claude or GitHub Copilot account, and moves credentials to app-owned local encryption.

- Account sign-in: connect an account under Settings → Models and routing → Add provider → Account sign-in. After browser authorization, its models join the conversation and role-routing pickers. One account is kept per provider, and you can reconnect or sign out at any time.
- Credential storage: API keys, account tokens and remembered passwords are now encrypted locally with AES-256-GCM instead of the system credential store. The key lives in `secrets/` inside the application-data directory, so back up the whole directory. Credentials saved in the old format need to be entered again; model names and endpoints are kept.
- Fixes: headless browser discovery joins paths for the target platform, and generated skin files stay LF so the byte comparison no longer fails on a Windows checkout.

Downloads: `.dmg` for macOS (Apple silicon), `-setup.exe` for Windows (64-bit). The macOS build is unsigned and unnotarized; allow it on first launch under System Settings → Privacy & Security.
