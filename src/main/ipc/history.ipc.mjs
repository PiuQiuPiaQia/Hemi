import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { renderBodyReportHtml, reportFileName, renderReportHtml } from '../delivery/report-html.mjs';
import { artifactViews, extractHttpsLinks, isExecutablePath, resolveForOpen } from '../history/artifacts.mjs';
import { IPC } from '../../shared/ipc-channels.mjs';
import { createLogger } from '../lib/logger.mjs';
import { getRemoteService } from '../remote/remote-service.mjs';

const log = createLogger('history');

/**
 * 009 任务历史通道：列表 / 详情 / 删除 / 重新总结。全部按 taskId 寻址（R-05），
 * 历史是只读事实档案——不复活确认卡、不延长会话授权（R-06）。
 *
 * @param {{ history: object, delivery?: object }} deps history 存储；
 *   025 另接交付图片读取器（delivery.readDeliveryImage）。
 */
export function registerHistoryIpc({ history, delivery = null }) {
  ipcMain.handle(IPC.history.list, () => history.listTasks());

  ipcMain.handle(IPC.history.getRecord, (_event, payload) => {
    const taskId = String(payload?.taskId ?? '');
    const record = history.getRecord(taskId);
    if (!record) {
      throw new Error('找不到该任务记录（可能已被删除）');
    }
    if (record.corrupt) {
      log.warn(`记录损坏：${taskId}`);
      throw new Error('该任务记录已损坏，无法读取详情');
    }
    // 012 D-3：产物可用性实时查证（不缓存为真），历史详情据此显示。
    return { ...record, deliverables: artifactViews(record.deliverables) };
  });

  ipcMain.handle(IPC.history.remove, (_event, payload) => {
    const ok = history.deleteTask(String(payload?.taskId ?? ''));
    if (!ok) throw new Error('删除任务记录失败');
    return { ok };
  });

  // 056：「重新总结」随回炉退役（结果正文已在任务卡与档案里）。
  ipcMain.handle(IPC.history.resummarize, async () => ({ ok: false, message: '这个功能已经移除：任务结果在卡片里，想让 Hemi 换个说法直接在对话里问' }));

  // 012 R-07：产物打开——渲染层只传 taskId+artifactId，目标由主进程从档案
  // 解析（任意字符串不成为本地执行命令）；可执行产物只定位；link 仅 https。
  ipcMain.handle(IPC.artifact.open, async (_event, payload) => {
    const taskId = String(payload?.taskId ?? '');
    const record = history.getRecord(taskId);
    if (!record || record.corrupt) {
      return { ok: false, message: '任务记录不存在或已损坏' };
    }
    const resolved = resolveForOpen(record, payload?.artifactId, {
      intent: payload?.intent === 'reveal' ? 'reveal' : 'open',
    });
    if (!resolved.ok) {
      log.warn(`产物打开被拒（${taskId}/${payload?.artifactId}）：${resolved.message}`);
      return resolved;
    }
    try {
      if (resolved.kind === 'link') {
        await shell.openExternal(resolved.url);
        return { ok: true };
      }
      if (resolved.kind === 'reveal') {
        shell.showItemInFolder(resolved.path);
        const note = payload?.intent === 'reveal'
          ? undefined
          : '可执行产物只做定位，不会自动运行';
        return { ok: true, message: note };
      }
      const openError = await shell.openPath(resolved.path);
      if (openError) {
        return { ok: false, message: `打开文件失败：${openError}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `打开失败：${error.message}` };
    }
  });

  // 049 R-11：远端产物「下载到本机」——按档案寻址（taskId+artifactId），经 SSH
  // 流式读，系统保存面板默认「下载」目录；本机产物不提供此入口（本来就在本机）。
  ipcMain.handle(IPC.artifact.download, async (event, payload) => {
    const taskId = String(payload?.taskId ?? '');
    const record = history.getRecord(taskId);
    if (!record || record.corrupt) {
      return { ok: false, message: '任务记录不存在或已损坏' };
    }
    const artifact = (record.deliverables ?? []).find((item) => item?.id === String(payload?.artifactId ?? ''));
    if (!artifact || artifact.kind !== 'file' || !artifact.path) {
      return { ok: false, message: '没有这个文件产物' };
    }
    if (!artifact.host) {
      return { ok: false, message: '这个文件在本机，不需要下载' };
    }
    const remoteService = getRemoteService();
    if (!remoteService) return { ok: false, message: '远端服务不可用，稍后重试' };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const chosen = await dialog.showSaveDialog(owner ?? new BrowserWindow({ show: false }), {
      title: `从 ${artifact.host} 下载`,
      defaultPath: path.join(app.getPath('downloads'), path.basename(artifact.path) || 'remote-file'),
    });
    if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true };
    const rfs = remoteService.remoteFsFor({ host: artifact.host, dir: path.posix.dirname(artifact.path) });
    const info = await rfs.stat(artifact.path);
    if (!info.ok || !info.isFile) {
      return { ok: false, message: info.kind === 'conn' ? `连不上 ${artifact.host}，稍后重试` : '文件在服务器上已不在' };
    }
    const read = await rfs.readBytes(artifact.path, 512 * 1024 * 1024);
    if (!read.ok) {
      return { ok: false, message: read.kind === 'conn' ? `连不上 ${artifact.host}，稍后重试` : '读取失败' };
    }
    try {
      await writeFile(chosen.filePath, read.buf);
    } catch (error) {
      return { ok: false, message: `保存失败：${error.message}` };
    }
    log.info(`远端产物已下载（${taskId}）：${artifact.host}:${artifact.path} → ${chosen.filePath}（${read.buf.length}B）`);
    return { ok: true, path: chosen.filePath };
  });

  // ---- 025 交付通道（全部按档案寻址；渲染层不传内容、不传任意路径） ----

  // R-06：保存报告 HTML——内容一律由档案现渲染（不重跑模型、不接受渲染层
  // 传 HTML）；位置交给系统保存面板，写成功才回 ok。
  // 050：优先按正文契约导出（resultText＝Markdown 正文＋sources＋notices）；
  // 旧档案（v1 delivery blocks）沿用 renderReportHtml。
  ipcMain.handle(IPC.delivery.saveReport, async (event, payload) => {
    const taskId = String(payload?.taskId ?? '');
    const record = history.getRecord(taskId);
    if (!record || record.corrupt) {
      return { ok: false, message: '任务记录不存在或已损坏' };
    }
    const hasBody = typeof record.resultText === 'string' && record.resultText.trim();
    const deliveryRecord = record.delivery;
    if (!hasBody && (!deliveryRecord || !Array.isArray(deliveryRecord.blocks) || !deliveryRecord.blocks.length)) {
      return { ok: false, message: '这个任务没有可保存的正文或报告成果' };
    }
    const html = hasBody
      ? renderBodyReportHtml({
        task: {
          taskText: record.taskText,
          outcome: record.outcome,
          resultText: record.resultText,
          notices: record.notices ?? [],
        },
        sources: Array.isArray(record.sources) ? record.sources : [],
        generatedAt: Date.now(),
      })
      : renderReportHtml({
        delivery: deliveryRecord,
        task: { taskText: record.taskText, outcome: record.outcome, resultText: record.resultText },
        artifacts: record.deliverables ?? [],
        readImage: (artifactId) => {
          const result = delivery?.readDeliveryImage?.(taskId, artifactId);
          return result?.ok ? result.dataUrl : null;
        },
        generatedAt: Date.now(),
      });
    const owner = BrowserWindow.fromWebContents(event.sender);
    const chosen = await dialog.showSaveDialog(owner ?? new BrowserWindow({ show: false }), {
      title: '保存正文',
      defaultPath: path.join(app.getPath('downloads'), reportFileName(hasBody ? record.taskText : deliveryRecord.title)),
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (chosen.canceled || !chosen.filePath) {
      return { ok: false, canceled: true };
    }
    try {
      await writeFile(chosen.filePath, html, 'utf8');
    } catch (error) {
      log.warn(`报告保存失败（${taskId}）：${error.message}`);
      return { ok: false, message: `保存失败：${error.message}` };
    }
    log.info(`报告已保存（${taskId}）：${chosen.filePath}`);
    return { ok: true, path: chosen.filePath };
  });

  // 050 R-06：改动文件打开/定位——渲染层只传 taskId+path，主进程按档案
  // fileChanges 校验该路径确属本任务改动（宿主统计的事实，不是模型申报），
  // 再按 intent 打开/访达定位；可执行文件只定位（与 artifact:open 同纪律）。
  ipcMain.handle(IPC.fileChanges.open, async (_event, payload) => {
    const taskId = String(payload?.taskId ?? '');
    const filePath = String(payload?.filePath ?? '');
    const record = history.getRecord(taskId);
    if (!record || record.corrupt) {
      return { ok: false, message: '任务记录不存在或已损坏' };
    }
    const listed = (record.fileChanges?.files ?? []).some(
      (change) => change?.path === filePath || change?.fromPath === filePath,
    );
    if (!listed) {
      return { ok: false, message: '这个文件不在本任务的改动清单里' };
    }
    try {
      const stats = statSync(filePath);
      if (!stats.isFile()) {
        return { ok: false, message: '文件已不可用（可能被移动或删除）' };
      }
      if (payload?.intent === 'reveal' || isExecutablePath(filePath)) {
        shell.showItemInFolder(filePath);
        return { ok: true, message: payload?.intent === 'reveal' ? undefined : '可执行文件只做定位，不会自动运行' };
      }
      const openError = await shell.openPath(filePath);
      if (openError) return { ok: false, message: `打开文件失败：${openError}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `打开失败：${error?.message ?? error}` };
    }
  });

  // 050 R-19：保存交付正文 .md——内容来自档案 resultText（正文契约），
  // 不接受渲染层传内容；系统保存面板，取消不算失败。
  ipcMain.handle(IPC.delivery.saveBody, async (event, payload) => {
    const taskId = String(payload?.taskId ?? '');
    const record = history.getRecord(taskId);
    if (!record || record.corrupt) {
      return { ok: false, message: '任务记录不存在或已损坏' };
    }
    const body = typeof record.resultText === 'string' ? record.resultText.trim() : '';
    if (!body) {
      return { ok: false, message: '这个任务没有可保存的正文' };
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    const safeName = String(record.taskText ?? '')
      .replace(/[\\/:*?"<>|\u0000]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    const chosen = await dialog.showSaveDialog(owner ?? new BrowserWindow({ show: false }), {
      title: '保存正文',
      defaultPath: path.join(app.getPath('downloads'), `${safeName || '任务正文'}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (chosen.canceled || !chosen.filePath) {
      return { ok: false, canceled: true };
    }
    try {
      await writeFile(chosen.filePath, body, 'utf8');
    } catch (error) {
      log.warn(`正文保存失败（${taskId}）：${error.message}`);
      return { ok: false, message: `保存失败：${error.message}` };
    }
    log.info(`正文已保存（${taskId}）：${chosen.filePath}`);
    return { ok: true, path: chosen.filePath };
  });

  // 050 R-22：Diff 审查读取——只认档案 fileDiffs 里存过的快照（首次修改前 vs
  // 最终），不拿工作区当前 diff 冒充；按 taskId+path 寻址。
  ipcMain.handle(IPC.delivery.readFileDiff, (_event, payload) => {
    const taskId = String(payload?.taskId ?? '');
    const filePath = String(payload?.filePath ?? '');
    const record = history.getRecord(taskId);
    if (!record || record.corrupt) {
      return { ok: false, message: '任务记录不存在或已损坏' };
    }
    const entry = record.fileDiffs?.[filePath];
    if (!entry || typeof entry.diff !== 'string') {
      return { ok: false, message: '这个文件没有记录本任务的差异（命令改动或超出记录范围）' };
    }
    return { ok: true, diff: entry.diff, truncated: Boolean(entry.truncated) };
  });

  // R-11：来源外链受控打开——只认档案里登记过的来源（050 record.sources 按
  // `src-N` 序号寻址；旧档案 delivery.sources 按 id），渲染层传任意 URL 一律
  // 拒绝（与 artifact:open 同一寻址纪律）。
  ipcMain.handle(IPC.delivery.openSource, async (_event, payload) => {
    const taskId = String(payload?.taskId ?? '');
    const record = history.getRecord(taskId);
    if (!record || record.corrupt) {
      return { ok: false, message: '任务记录不存在或已损坏' };
    }
    const wanted = String(payload?.sourceId ?? '');
    const fromBody = (Array.isArray(record.sources) ? record.sources : [])
      .map((source, index) => ({ ...source, id: `src-${index + 1}` }))
      .find((source) => source.id === wanted);
    const source = fromBody
      ?? (record.delivery?.sources ?? []).find((item) => item?.id === wanted);
    if (!source) {
      return { ok: false, message: '没有这个来源' };
    }
    const cleaned = extractHttpsLinks(String(source.url ?? ''))[0];
    if (!cleaned) {
      return { ok: false, message: '这个来源没有可打开的链接' };
    }
    try {
      await shell.openExternal(cleaned);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `打开失败：${error.message}` };
    }
  });

  // R-03/R-06：报告图片——只认档案里登记过的图片产物，读成 data URL 给
  // 应用内阅读视图与 HTML 导出共用。
  ipcMain.handle(IPC.delivery.readImage, (_event, payload) => {
    const result = delivery?.readDeliveryImage?.(
      String(payload?.taskId ?? ''),
      String(payload?.artifactId ?? ''),
    );
    return result ?? { ok: false, message: '图片读取不可用' };
  });

  // 026 R-05/R-06：应用内文件预览——Markdown/纯文本/图片的受控读取，失败
  // 返回可展示原因（渲染层原位呈现 + 重试），不抛到系统弹窗。
  ipcMain.handle(IPC.delivery.readPreview, (_event, payload) => {
    const result = delivery?.readArtifactPreview?.(
      String(payload?.taskId ?? ''),
      String(payload?.artifactId ?? ''),
    );
    return result ?? { ok: false, message: '文件预览不可用' };
  });

  // 027 R-02：预览面板路径点击——受控在浏览器打开已登记文件（渲染层仍只传
  // taskId+artifactId；浏览器定向与兜底链见 browser-open.mjs）。
  ipcMain.handle(IPC.delivery.openPreviewFile, (_event, payload) => {
    const result = delivery?.openArtifactPreviewFile?.(
      String(payload?.taskId ?? ''),
      String(payload?.artifactId ?? ''),
    );
    return result ?? Promise.resolve({ ok: false, message: '文件打开不可用' });
  });
}
