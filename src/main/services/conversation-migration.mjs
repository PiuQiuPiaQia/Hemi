/**
 * 057 S3-2d：旧档一次性迁移到 conversation version=2（flow 快照随档）。
 * 契约 §8：先备份原始 v1（备份成功才提交 v2）；幂等（已有 flow／version≥2 跳过）；
 * 损坏档案保留不覆盖；缺 flow 的漏网档案由流服务打开时现场引导兜底。
 */
import fs from 'node:fs';
import path from 'node:path';

import { bootstrapFlowFromTurns, normalizeFlowHistory } from './flow-bootstrap.mjs';
import { FLOW_SCHEMA_VERSION } from '../../shared/conversation-flow.mjs';
import { dropCutTurns } from '../history/conversation-store.mjs';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BACKUP_SUFFIX = '.migration-v1.json';

/** 懒恢复的完整历史门禁：备份原始字节 → 同目录原子提交；失败向调用方暴露。 */
export function repairConversationFlowHistory(dir, record, { io = fs } = {}) {
  if (!SESSION_ID_RE.test(String(record?.id ?? ''))) throw new Error('非法会话 ID');
  const result = normalizeFlowHistory(record.flow, dropCutTurns(record.turns ?? [], record.cutKeys), { conversationId: record.id });
  if (!result.changed) return { ...result, record };
  const target = path.join(dir, `${record.id}.json`);
  const backup = `${target}.history-r${record.flow.revision}-g${record.flow.generation ?? 1}.bak`;
  const raw = io.readFileSync(target, 'utf8');
  // wx 防覆盖；上次提交失败后可重试，但必须确认旧备份仍是本次源记录。
  try { io.writeFileSync(backup, raw, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || io.readFileSync(backup, 'utf8') !== raw) throw error; }
  const next = { ...record, flow: result.snapshot };
  const tmp = `${target}.historytmp-${process.pid}`;
  try {
    io.writeFileSync(tmp, JSON.stringify(next, null, 2));
    io.renameSync(tmp, target);
  } catch (error) {
    try { io.unlinkSync(tmp); } catch { /* 未创建 */ }
    throw error;
  }
  return { ...result, record: next, backup };
}

export function migrateConversationDirToV2(dir, { log = null } = {}) {
  const report = { migrated: 0, backups: 0, skippedCorrupt: 0, skippedCurrent: 0, failed: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return report; // 目录不可读：留给打开时的现场引导
  }
  for (const name of entries) {
    if (!name.endsWith('.json') || name.endsWith(BACKUP_SUFFIX)) continue;
    const id = name.slice(0, -5);
    if (!SESSION_ID_RE.test(id)) continue;
    const target = path.join(dir, name);
    const backup = path.join(dir, id + BACKUP_SUFFIX);
    try {
      const record = JSON.parse(fs.readFileSync(target, 'utf8'));
      // 高版本（未知 schema）只读不动（契约 §8：不回落重建）；v2 但缺 flow 的
      // 漏网档案由流服务打开时现场引导，迁移不补写。
      if ((record?.version ?? 1) >= 2) {
        report.skippedCurrent += 1;
        continue;
      }
      const hasFlow = record?.flow && typeof record.flow === 'object' && typeof record.flow.revision === 'number';
      const flow = hasFlow ? record.flow : bootstrapFlowFromTurns(record?.turns, { conversationId: id });
      if (!flow) {
        // 空会话（无 turns 无 flow）：只标版本不动内容。
        if (!fs.existsSync(backup)) {
          fs.copyFileSync(target, backup);
          report.backups += 1;
        }
        const next = { ...record, version: 2 };
        const tmp = `${target}.migtmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
        fs.renameSync(tmp, target);
        report.migrated += 1;
        continue;
      }
      // 备份先行（幂等：已备份不重复）。
      if (!fs.existsSync(backup)) {
        fs.copyFileSync(target, backup);
        report.backups += 1;
      }
      const next = {
        ...record,
        version: 2,
        flow: { ...flow, schemaVersion: FLOW_SCHEMA_VERSION, conversationId: flow.conversationId ?? id },
      };
      const tmp = `${target}.migtmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, target);
      report.migrated += 1;
    } catch (error) {
      report.skippedCorrupt += 1;
      log?.warn?.(`v2 迁移跳过 ${name}：${error?.message ?? error}`);
    }
  }
  return report;
}
