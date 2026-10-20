// 059 P01 编辑器探针 Electron 壳：真实 Electron 44 运行时加载构建产物，
// 轮询页面 __runProbe()，汇总控制台错误，打一行 HEMI_PROBE_RESULT。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = process.env.PROBE_DIST_DIR || '/tmp/hemi-059-editor-probe'

app.setName('hemi-059-editor-probe')
app.setPath('userData', `/tmp/hemi-059-editor-probe-userdata`)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const consoleErrors = []
  win.webContents.on('console-message', (...args) => {
    // Electron 版本差异：新版 (event, {level, message})，旧版 (event, level, message, …)
    const a = args[1]
    if (a && typeof a === 'object' && 'level' in a) {
      if (a.level >= 3 || a.level === 'error') consoleErrors.push(String(a.message))
    } else if (typeof a === 'number') {
      if (a >= 3) consoleErrors.push(String(args[2]))
    }
  })
  try {
    await win.loadFile(path.join(OUT_DIR, 'index.html'))
  } catch (e) {
    console.log('HEMI_PROBE_RESULT ' + JSON.stringify({ pass: false, fatal: `loadFile: ${e.message}` }))
    app.exit(1)
    return
  }
  win.show()

  let result = null
  for (let i = 0; i < 100 && !result; i++) {
    await new Promise((r) => setTimeout(r, 250))
    result = await win.webContents
      .executeJavaScript('window.__runProbe ? window.__runProbe() : null', true)
      .catch((e) => ({ pass: false, fatal: `executeJavaScript: ${e.message}` }))
  }
  if (!result) result = { pass: false, fatal: 'probe never returned（页面 25s 内未就绪或 __runProbe 不存在）' }

  const env = { electron: process.versions.electron, chrome: process.versions.chrome, react: result.react ?? null }
  const ok = Boolean(result.pass) && consoleErrors.length === 0
  console.log('HEMI_PROBE_RESULT ' + JSON.stringify({ pass: ok, ...result, consoleErrors, env }))
  app.exit(ok ? 0 : 1)
})
