新增数据备份与恢复：会话、记忆、设置与 API 密钥可备份到本地文件夹或坚果云，新设备可从备份完整恢复。

- 设置新增「备份」分类：支持本地文件夹（系统目录选择）与坚果云等 WebDAV 网盘；服务器地址预填坚果云，应用密码有官方教程直达，保存前可测试连接。
- 备份内容为轻量档快照（会话正文、记忆、草稿与全部设置），含 tar+gzip 流式归档、分卷校验与恢复前自动安全副本；上传按分卷进行，损坏分卷会被校验拦截。
- 凭据随备份：模型密钥、语音密钥与 WebDAV 应用密码采用本机 AES-256-GCM 加密，解密密钥随备份携带，恢复到新设备后即可直接使用。备份包本身不加密，云端保存的是明文等价物，请妥善保管网盘账号。
- 支持定时备份（每天/每周、保留份数自动清理）与手动备份；备份集支持恢复与删除（气泡式二次确认）。
- 首次启动引导新增「从备份恢复」与「跳过引导」：换机或重装后无需重新配置，恢复完成即可进入主界面并直接使用已恢复的模型。
- 修复恢复备份后 WebDAV 应用密码无法解密的问题：恢复会替换本机解密密钥，恢复前保存的密文现于恢复后自动重新加密。

---

Adds data backup and restore: conversations, memory, settings, and API keys can be backed up to a local folder or Nutstore (WebDAV), and a fresh device can restore everything from a backup.

- New "Backup" section in Settings: local folder (with native directory picker) or any WebDAV service such as Nutstore; the Nutstore endpoint is pre-filled, with a link to the official guide for app passwords, and a connection test before saving.
- Backups are light-tier snapshots (conversation transcripts, memory, drafts, and all settings) packed as streaming tar+gzip volumes with per-volume checksums and an automatic safety copy before restoring; uploads go volume-by-volume and corrupted volumes are rejected by verification.
- Credentials travel with the backup: model keys, voice keys, and the WebDAV app password are AES-256-GCM encrypted locally, and the decryption key is included in the backup, so a restored setup works immediately on a new device. The backup itself is not encrypted — the cloud copy is plaintext-equivalent, so protect your cloud-drive account.
- Scheduled backups (daily/weekly with automatic retention) plus manual backup; backup sets can be restored or deleted (with a popover confirmation).
- Onboarding now offers "Restore from backup" and "Skip onboarding": after reinstalling or switching machines there is no need to reconfigure — restoring finishes into the main app with the model already usable.
- Fixed the WebDAV app password failing to decrypt after a restore: restoring replaces the local decryption key, and credentials saved before the restore are now re-encrypted automatically.
