// S2 已接入的 AI（150–360f，局部 0–210）。bezier-source-converge-merge 适配：
// 三张真实接入界面裁片（订阅 / New API / API 配置）→ 各自一枚来源胶囊沿贝塞尔曲线汇入同一个模型列表。
// 时值按 demo 比例换算到本镜 168f 主段（t = (f-18)/168）：draw 0.04+i·0.045 窗 0.17；conv 0.34–0.74 inOutCubic；
// 三段缩小拐点 0.75；数据包 2 个整数周期；erase 0.78–0.9；徽标接收脉冲 +12%。
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Cap, Crop, HemiMark } from '../components';
import { C, EASE, FONT, clamp01, lerp, ramp } from '../theme';

const S = 1.12;
const CARDS = [
  { src: 'tex/settings-model-add-oauth.png', cx: 480, cy: 250, cw: 560, ch: 212, label: '订阅账号' },
  { src: 'tex/settings-model-add-newapi.png', cx: 480, cy: 250, cw: 560, ch: 232, label: 'New API 站点' },
  { src: 'tex/settings-model-add.png', cx: 480, cy: 252, cw: 560, ch: 210, label: '自定义 API' },
];
const X0 = 80, Y0 = 150, GAP = 20;
const cardY = (i: number) => Y0 + CARDS.slice(0, i).reduce((a, c) => a + c.ch * S + GAP, 0);
const NODE_X = X0 + 560 * S + 28; // 胶囊驻留起点（裁片右侧）
const XC = 1560, YC = 560; // 汇聚点
const ACC = C.g700;

type Pt = { x: number; y: number };
const geom = (y0: number) => {
  const L = 110; // 直线段（驻留区）
  const P0 = { x: NODE_X, y: y0 }, P1 = { x: NODE_X + L, y: y0 }, Q1 = { x: NODE_X + L + 230, y: y0 }, Q2 = { x: XC - 210, y: YC }, P3 = { x: XC, y: YC };
  const cubic = (u: number): Pt => { const v = 1 - u; return { x: v * v * v * P1.x + 3 * v * v * u * Q1.x + 3 * v * u * u * Q2.x + u * u * u * P3.x, y: v * v * v * P1.y + 3 * v * v * u * Q1.y + 3 * v * u * u * Q2.y + u * u * u * P3.y }; };
  const N = 800; const cumL = [0]; let prev = cubic(0), acc = 0;
  for (let k = 1; k <= N; k++) { const p = cubic(k / N); acc += Math.hypot(p.x - prev.x, p.y - prev.y); cumL.push(acc); prev = p; }
  const len = L + acc;
  const at = (s: number): Pt => {
    const c = Math.max(0, Math.min(len, s));
    if (c <= L) return { x: P0.x + c, y: y0 };
    const tg = c - L; let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (cumL[m] < tg) lo = m + 1; else hi = m; }
    const i = Math.max(1, lo); const s0 = cumL[i - 1], s1 = cumL[i];
    return cubic((i - 1 + (s1 > s0 ? (tg - s0) / (s1 - s0) : 0)) / N);
  };
  return { len, at, f0: 0, d: `M ${P0.x},${y0} L ${P1.x},${y0} C ${Q1.x},${Q1.y} ${Q2.x},${Q2.y} ${P3.x},${P3.y}`, L };
};
const GEOMS = CARDS.map((c, i) => geom(cardY(i) + (c.ch * S) / 2));
const seg = (t: number, a: number, b: number, e: (x: number) => number = EASE.linear) => e(clamp01((t - a) / (b - a)));

export const Models: React.FC = () => {
  const f = useCurrentFrame();
  const t = clamp01((f - 18) / 168);
  const conv = seg(t, 0.34, 0.74, EASE.inOutCubic);
  const erase = seg(t, 0.78, 0.9, EASE.outQuad);
  const pk = (seg(t, 0.1, 0.74) * 2) % 1;
  const bp = seg(t, 0.12, 0.24, EASE.out);
  const badgeScale = lerp(0.7, 1, bp) * (1 + seg(t, 0.7, 0.78, EASE.overshoot) * 0.12 - seg(t, 0.78, 0.86, EASE.outQuad) * 0.12);
  const ripple = seg(t, 0.72, 0.86, EASE.out);
  const out = ramp(f, 196, 14, EASE.linear);
  return (
    <AbsoluteFill style={{ background: C.paper, opacity: 1 - out }}>
      {CARDS.map((c, i) => {
        const p = ramp(f, 2 + i * 6, 22, EASE.enter);
        return <Crop key={i} src={c.src} cx={c.cx} cy={c.cy} cw={c.cw} ch={c.ch} s={S} x={X0 - (1 - p) * 60} y={cardY(i)} style={{ opacity: p }} />;
      })}
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        {GEOMS.map((g, i) => {
          const draw = seg(t, 0.04 + i * 0.045, 0.04 + i * 0.045 + 0.17, EASE.outQuad);
          const off = erase > 0 ? -erase * g.len : g.len * (1 - draw);
          return <path key={i} d={g.d} fill="none" stroke={C.g500} strokeWidth={3} strokeLinecap="round" strokeDasharray={g.len} strokeDashoffset={off} opacity={draw * (1 - clamp01((erase - 0.85) / 0.15))} />;
        })}
      </svg>
      {GEOMS.map((g, i) => {
        const tt = conv;
        const pt = g.at(g.len * tt);
        const k = tt < 0.75 ? lerp(1, 0.34, tt / 0.75) : lerp(0.34, 0, (tt - 0.75) / 0.25);
        const appear = seg(t, 0.02 + i * 0.04, 0.12 + i * 0.04, EASE.overshoot);
        const ph = (pk + i * 0.13) % 1;
        const pkOn = seg(t, 0.1, 0.16) * (1 - seg(t, 0.7, 0.76));
        const q = g.at(g.len * ph);
        return (
          <React.Fragment key={i}>
            {pkOn > 0.01 ? <div style={{ position: 'absolute', left: q.x - 7, top: q.y - 7, width: 14, height: 14, borderRadius: 7, background: ACC, opacity: pkOn * (1 - Math.abs(ph - 0.5) * 0.6), boxShadow: '0 0 0 4px rgba(86,110,93,.16)' }} /> : null}
            <div style={{ position: 'absolute', left: pt.x, top: pt.y, transform: `translate(0,-50%) scale(${(appear * k).toFixed(3)})`, transformOrigin: '0 50%', opacity: tt > 0.92 ? (1 - tt) / 0.08 : 1,
              background: '#fff', border: `1.5px solid ${C.lineStrong}`, borderRadius: 999, padding: '12px 26px', fontFamily: FONT, fontSize: 40, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap',
              boxShadow: '0 12px 30px -16px rgba(31,43,35,.35)' }}>{CARDS[i].label}</div>
          </React.Fragment>
        );
      })}
      <div style={{ position: 'absolute', left: XC - 66, top: YC - 66, width: 132, height: 132, borderRadius: '50%', border: `2px solid ${ACC}`, opacity: ripple > 0 && ripple < 1 ? (1 - ripple) * 0.6 : 0, transform: `scale(${lerp(1, 2.1, ripple)})` }} />
      <div style={{ position: 'absolute', left: XC - 66, top: YC - 66, width: 132, height: 132, borderRadius: '50%', background: '#fff', boxShadow: `0 0 0 1.5px ${C.line}, 0 18px 40px -18px rgba(31,43,35,.4)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: bp, transform: `scale(${badgeScale})` }}><HemiMark size={84} /></div>
      <Cap head="先用你已有的 AI" sub="订阅账号、New API、自定义 API" x={1200} y={150} w={700} start={10} />
      <Cap head="都进同一个模型列表" sub="这个任务可以直接选用" x={XC} y={YC + 110} align="center" w={720} size={52} start={18 + Math.round(0.8 * 168)} />
    </AbsoluteFill>
  );
};
