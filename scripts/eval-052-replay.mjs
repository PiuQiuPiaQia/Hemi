#!/usr/bin/env node
/**
 * 052 技术方案 S1 · 离线回放评估（不改行为）：从 hemi.log 抽「确认请求」「远端命令」
 * 「沙箱命令」记录，用 052 新规则（R-03 增补＋Q4 覆盖写探测＋R-06 敏感读取）重放，
 * 产出「会少弹多少／新增弹多少」对照表，并按「任务 × 类别」模拟 R-04 合并后的卡数。
 *
 * 用法：node scripts/eval-052-replay.mjs [hemi.log 路径…]
 * 缺省评 dev 与生产两份日志（存在才评）。Q4 存在性无法离线探测远端文件——
 * 覆盖写目标按「已存在」（保守上界）评估，报告里注明。
 */
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectDangerous, detectHardline } from '../src/main/agent/gate/detect.mjs';
import { judgeAccess, VERDICT } from '../src/main/agent/gate/access-policy.mjs';
import { classifyCommand, detectRemoteSecretRead, systemConfigOverwriteTargets } from '../src/main/agent/gate/command-class.mjs';
import { SYSTEM_WRITE_ROOTS, SYSTEM_WRITE_ROOTS_REMOTE } from '../src/main/agent/gate/policy.mjs';

const LINE = /^\[(?<ts>[\d-]+ [\d:.]+)\] \[(?<level>\w+)\] \[(?<domain>[\w/-]+)\] (?<text>.*)$/;

/** 单条命令的完整判定（对齐 pi-gate 的 q 注入；覆盖写按已存在保守处理）。 */
function judgeCommand(command, { remote }) {
  const roots = remote ? SYSTEM_WRITE_ROOTS_REMOTE : SYSTEM_WRITE_ROOTS;
  const targets = systemConfigOverwriteTargets(command, roots, null);
  const overwrite = targets.length ? { hit: true, description: '改写系统配置（覆盖已存在的目标）', category: 'system-config' } : null;
  const q = {
    hardline: (c) => { const h = detectHardline(c); return h?.hit ? h : null; },
    dangerous: (c) => { const d = detectDangerous(c); if (d?.hit) return d; return overwrite; },
    remoteSecretRead: (c) => { const s = detectRemoteSecretRead(c); return s?.hit ? s : null; },
    classifyCommand: (c) => classifyCommand(c),
    scopeForPath: () => null,
    resolveAppBundle: () => null,
  };
  return judgeAccess({
    tool: 'bash', input: { command }, phase: 'run',
    features: { web: true },
    remoteHost: remote ? 'replay-host' : null,
    q,
  });
}

function parseLog(file) {
  const commands = []; // { ts, source: 'remote'|'local', command }
  const oldCards = []; // { ts, task, summary }
  const taskBounds = []; // { ts, key, outcome } 任务终态切分点
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split('\n')) {
    const m = LINE.exec(rawLine);
    if (!m) continue;
    const { ts, text: body } = m.groups;
    let hit = /^远端命令 \d+ · \d+B · [\d.]+ms · (.+)$/.exec(body);
    if (hit) {
      commands.push({ ts, source: 'remote', command: hit[1] });
      continue;
    }
    hit = /^沙箱命令 \d+ · \d+B · [\d.]+ms · (.+)$/.exec(body);
    if (hit) {
      commands.push({ ts, source: 'local', command: hit[1] });
      continue;
    }
    hit = /^确认请求（(?<task>t\d+)）：(?<summary>.+)$/.exec(body);
    if (hit) {
      oldCards.push({ ts, task: hit.groups.task, summary: hit.groups.summary });
      continue;
    }
    hit = /^任务终态 (?<outcome>\w+)：/.exec(body);
    if (hit) taskBounds.push({ ts, outcome: hit.groups.outcome });
  }
  return { commands, oldCards, taskBounds };
}

function evaluate(label, parsed) {
  const { commands, oldCards, taskBounds } = parsed;
  const wouldAsk = [];
  const wouldDeny = [];
  for (const entry of commands) {
    const verdict = judgeCommand(entry.command, { remote: entry.source === 'remote' });
    if (verdict.verdict === VERDICT.confirmAction) {
      wouldAsk.push({ ...entry, category: verdict.category, reason: verdict.reason });
    } else if (verdict.verdict === VERDICT.deny) {
      wouldDeny.push({ ...entry, reasonCode: verdict.reasonCode, message: verdict.message });
    }
  }
  // R-04 合并模拟：按任务终态切分时间窗，窗口内按类别去重。
  const boundsTs = taskBounds.map((b) => b.ts);
  const windowOf = (ts) => boundsTs.filter((b) => b <= ts).length;
  const merged = new Set();
  for (const ask of wouldAsk) merged.add(`${windowOf(ask.ts)}|${ask.category}`);
  const oldCardKeys = new Set(oldCards.map((c) => `${c.ts} ${c.summary.slice(0, 60)}`));

  console.log(`\n===== ${label} =====`);
  console.log(`语料：远端/本机命令 ${commands.length} 条（远端 ${commands.filter((c) => c.source === 'remote').length}）；历史确认卡 ${oldCards.length} 张；任务终态 ${taskBounds.length} 个`);
  console.log(`新规则下会弹卡的命令：${wouldAsk.length} 条；按任务×类别合并后 ≈ ${merged.size} 张卡`);
  console.log(`新规则下会直接拒的命令：${wouldDeny.length} 条（R-06 敏感读取）`);
  const byCategory = {};
  for (const ask of wouldAsk) byCategory[ask.category] = (byCategory[ask.category] ?? 0) + 1;
  console.log('按类别：', Object.entries(byCategory).map(([k, v]) => `${k}=${v}`).join(' ') || '（无）');
  if (wouldAsk.length) {
    console.log('—— 会弹卡明细（Q4 覆盖写按已存在的保守上界）——');
    for (const ask of wouldAsk) console.log(`  [${ask.category}] ${ask.command.slice(0, 140)}`);
  }
  if (wouldDeny.length) {
    console.log('—— 会硬拒明细（R-06）——');
    for (const d of wouldDeny) console.log(`  [${d.reasonCode}] ${d.command.slice(0, 140)}`);
  }
  console.log(`历史卡里因规则修复（R-01）与新表不再弹的：${
    oldCards.filter((c) => {
      const cmdHit = /^在 .+? 上执行命令：(.+)$/.exec(c.summary);
      if (!cmdHit) return false;
      const v = judgeCommand(cmdHit[1], { remote: true });
      return v.verdict !== VERDICT.confirmAction;
    }).length}/${oldCards.length}`);
  return { commands: commands.length, oldCards: oldCards.length, wouldAsk: wouldAsk.length, mergedCards: merged.size };
}

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : [
      path.join(os.homedir(), 'Library/Application Support/hemi-dev/hemi.log'),
      path.join(os.homedir(), 'Library/Application Support/hemi/hemi.log'),
    ];

const totals = { commands: 0, oldCards: 0, wouldAsk: 0, mergedCards: 0 };
for (const file of files) {
  const parsed = parseLog(file);
  if (!parsed) {
    console.log(`\n===== ${file} 不存在，跳过`);
    continue;
  }
  const r = evaluate(path.basename(path.dirname(file)) + '/hemi.log', parsed);
  for (const key of Object.keys(totals)) totals[key] += r[key];
}
console.log('\n===== 汇总（两份日志）=====');
console.log(`命令 ${totals.commands} 条：历史卡 ${totals.oldCards} 张 → 新规则 ${totals.wouldAsk} 条命中、合并后 ≈ ${totals.mergedCards} 张`);
