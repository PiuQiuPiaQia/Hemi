#!/usr/bin/env node
/**
 * 059 fixtures 像素回归比对（0.5% 阈值，memory 工具链：sips→BMP＋Node 分区统计）：
 *   node scripts/compare-fixture-baseline.mjs <current.png> <baseline.png> [label]
 * 幅度分桶统计差异像素（排除 total），≤0.5% 过；字体/抗锯齿造成的非零 diff 由
 * tier-2 视觉评审裁决，不放宽阈值。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const [current, baseline, label = current] = process.argv.slice(2);
if (!current || !baseline) {
  console.error('用法：compare-fixture-baseline.mjs <current.png> <baseline.png> [label]');
  process.exit(2);
}
for (const f of [current, baseline]) {
  if (!fs.existsSync(f)) { console.error(`缺文件：${f}`); process.exit(2); }
}
const toBmp = (png, out) => execSync(`sips -s format bmp "${png}" --out "${out}" > /dev/null 2>&1`);
toBmp(current, '/tmp/cmp-current.bmp');
toBmp(baseline, '/tmp/cmp-baseline.bmp');

function stats(file) {
  const buf = fs.readFileSync(file);
  const offset = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  const h = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28) / 8;
  return { buf, offset, w, h, bpp };
}
const a = stats('/tmp/cmp-current.bmp');
const b = stats('/tmp/cmp-baseline.bmp');
if (a.w !== b.w || a.h !== b.h) {
  console.log(`DIMENSION_MISMATCH ${a.w}x${a.h} vs ${b.w}x${b.h}`);
  process.exit(1);
}
let diff = 0;
let total = 0;
const step = 2;
for (let y = 0; y < a.h; y += step) {
  for (let x = 0; x < a.w; x += step) {
    const ia = a.offset + (a.h - 1 - y) * a.w * a.bpp + x * a.bpp;
    const ib = b.offset + (b.h - 1 - y) * b.w * b.bpp + x * b.bpp;
    const dr = Math.abs(a.buf[ia] - b.buf[ib]);
    const dg = Math.abs(a.buf[ia + 1] - b.buf[ib + 1]);
    const db = Math.abs(a.buf[ia + 2] - b.buf[ib + 2]);
    total += 1;
    if (dr + dg + db > 24) diff += 1; // 幅度分桶：低于阈值视为亚像素噪声
  }
}
const pct = +(diff / total * 100).toFixed(3);
const pass = pct <= 0.5;
console.log(`${pass ? 'PASS' : 'FAIL'} [${label}] diff=${pct}%（阈值 0.5%，采样 ${total} 点）`);
process.exit(pass ? 0 : 1);
