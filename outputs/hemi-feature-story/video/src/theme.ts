// 品牌 tokens：packages/ui/src/tokens.css + outputs/hemi-site-simple/styles.css（已定的精简官网）。
import { Easing } from 'remotion';
export const C = {
  ink: '#1a1a19', body: '#2d2d2c', muted: '#5f5f5c', faint: '#8b8b88', line: '#e4e3de', lineStrong: '#d6d5cf',
  canvas: '#ffffff', rail: '#f6f6f5', paper: '#f9f8f4',
  g50: '#f2f5f1', g100: '#e4ebe3', g200: '#cfdcd1', g500: '#8fa794', g700: '#566e5d', g800: '#4b6152', g900: '#3e5044',
  forest: '#1f2b23',
};
export const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif";
export const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";
// 动效性格：专业信赖 + 平静（低能量、严肃偏亲和）。主时长 ~21–26f，入场不弹；只有「落地」隐喻处 y1>1。
export const EASE = {
  out: Easing.bezier(0.22, 1, 0.36, 1),
  enter: Easing.bezier(0, 0, 0.2, 1),
  move: Easing.bezier(0.65, 0, 0.35, 1),
  demote: Easing.bezier(0.6, 0, 0.18, 1), // title-demote-to-label 命门
  cam: Easing.bezier(0.55, 0, 0.18, 1), // cursor-flyover 相机
  fly: Easing.bezier(0.5, 0, 0.8, 0.75), // row-embed 下落
  exit: Easing.bezier(0.7, 0, 0.84, 0),
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  overshoot: Easing.bezier(0.34, 1.4, 0.64, 1),
  linear: (t: number) => t,
};
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const ramp = (f: number, s: number, d: number, e: (t: number) => number = EASE.out) => e(clamp01((f - s) / Math.max(1e-6, d)));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
