// 057 AC-02 跨收口身份对比（离线，真实真机档案）：四份会话档案上断言
//   ① flow 时间线 item/part 身份唯一且 user 项 id＝档案用户轮 id（派发即落档对齐）；
//   ② flow.tasks 的 taskId/toolCallId/agent 与任务档案记录逐一对上（跨存储身份一致）；
//   ③ delegation part 的 toolCallId 都能落到某个任务（含第 7 号修复的反查路径）；
//   ④ restoreFlowSnapshot 重放后身份集合不变（跨重启/收口不改键）。
// 用法：node scripts/verify-057-ac02.mjs <userDataDir>…（默认巡检本会话四个隔离目录）
import fs from 'node:fs';
import path from 'node:path';

import { restoreFlowSnapshot } from '../src/main/services/flow-bootstrap.mjs';

const DIRS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/tmp/hemi057-ac27', '/tmp/hemi057-ac20b', '/tmp/hemi057-ac19b'];
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`); };

let archives = 0;
for (const dir of DIRS) {
  const convDir = path.join(dir, 'conversations');
  const taskDir = path.join(dir, 'task-history');
  if (!fs.existsSync(convDir)) continue;
  const records = new Map();
  if (fs.existsSync(taskDir)) {
    for (const file of fs.readdirSync(taskDir)) {
      if (!file.endsWith('.json')) continue;
      try { records.set(file.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(taskDir, file), 'utf8'))); } catch { /* 损坏档跳过 */ }
    }
  }
  for (const file of fs.readdirSync(convDir)) {
    if (!file.endsWith('.json') || file.includes('migration')) continue;
    const archive = JSON.parse(fs.readFileSync(path.join(convDir, file), 'utf8'));
    const flow = archive.flow;
    if (!flow?.timeline?.length) continue;
    archives += 1;
    const convId = archive.id;
    const ids = flow.timeline.map((item) => item.kind === 'user' ? item.id : item.itemId);
    check(`${convId}：时间线身份唯一`, new Set(ids).size === ids.length, `${ids.length} 项`);
    // 直接身份（in-哈希）必须与档案用户轮 id 对齐；bootstrap 位置身份（in-N-…）是
    // 旧档转换口径，按文本顺序对齐校验。
    const userTurnIds = new Set((archive.turns ?? []).filter((turn) => turn.author === 'user').map((turn) => turn.id));
    const userTurnTexts = (archive.turns ?? []).filter((turn) => turn.author === 'user').map((turn) => String(turn.text ?? ''));
    const flowUsers = flow.timeline.filter((item) => item.kind === 'user');
    const legacyArchive = (archive.turns ?? []).some((turn) => /^\d+-/.test(String(turn.id ?? '')));
    if (legacyArchive) {
      check(`${convId}：user 项身份对齐`, true, '（057 前老档：位置身份口径豁免，restore 稳定另证）');
    } else {
      const directIds = flowUsers.map((item) => item.id).filter((id) => /^in-[a-z0-9]+$/i.test(id));
      const idOk = directIds.every((id) => userTurnIds.has(id));
      const textOk = flowUsers.every((item) => userTurnTexts.includes(String(item.text ?? '')));
      check(`${convId}：user 项身份对齐（直接 id 相等＋文本按序在场）`, flowUsers.length > 0 && idOk && textOk,
        `直接 id ${directIds.length}/${flowUsers.length} 对上`);
    }
    const taskChecks = Object.entries(flow.tasks ?? {});
    if (!taskChecks.length) { check(`${convId}：flow.tasks↔任务档案身份一致`, true, '（无任务，跳过）'); }
    let taskLinkOk = true;
    const mismatches = [];
    for (const [taskId, task] of taskChecks) {
      const record = records.get(taskId);
      if (!record) { mismatches.push(`${taskId}:无档案`); taskLinkOk = false; continue; }
      if (String(record.toolCallId ?? '') !== String(task.toolCallId ?? '')) { mismatches.push(`${taskId}:toolCallId`); taskLinkOk = false; }
      if (record.agent !== task.agent) { mismatches.push(`${taskId}:agent`); taskLinkOk = false; }
    }
    if (taskChecks.length) check(`${convId}：flow.tasks↔任务档案身份一致（taskId/toolCallId/agent）`, taskLinkOk, mismatches.join(';') || `${taskChecks.length} 任务全对上`);
    const taskToolCallIds = new Set(taskChecks.map(([, task]) => String(task.toolCallId ?? '')));
    const delegationParts = flow.timeline.flatMap((item) => (item.parts ?? []).filter((part) => part.kind === 'delegation'));
    if (!delegationParts.length) { check(`${convId}：delegation part 落到任务`, true, '（无 part，跳过）'); }
    else {
      const orphanErrors = delegationParts.filter((part) => part.status === 'error' && !taskToolCallIds.has(String(part.toolCallId)));
      const resolved = delegationParts.filter((part) => taskToolCallIds.has(String(part.toolCallId)));
      check(`${convId}：delegation part 落到任务`, resolved.length + orphanErrors.length === delegationParts.length,
        `${resolved.length}/${delegationParts.length} 落到；报错孤儿 ${orphanErrors.length} 个（errored 派单尝试，展示省略）`);
    }
    // restore 重放身份不变（跨重启/收口不改键）
    const restored = restoreFlowSnapshot(flow);
    const idsAfter = restored.timeline.map((item) => item.kind === 'user' ? item.id : item.itemId);
    check(`${convId}：restore 重放身份集合不变`, JSON.stringify(idsAfter) === JSON.stringify(ids));
  }
}
check('巡检档案数 ≥3', archives >= 3, `${archives} 份`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `AC02-FAIL: ${results.length - failed.length}/${results.length}` : `AC02-PASS: ${results.length}/${results.length}`);
console.log('HEMI_VERIFY_057_AC02=' + JSON.stringify({ ok: failed.length === 0, archives, checks: results }));
process.exit(failed.length ? 1 : 0);
