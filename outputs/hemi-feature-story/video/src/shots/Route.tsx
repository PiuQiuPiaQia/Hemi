// S4 模型路由（570–780f，局部 0–210）。scanline-annotate-focus 适配：
// 真实模型路由弹窗（model-routing-dialog.png）放大，扫描线严格匀速自上而下；越过哪一行的下缘，
// 那一行就被四角取景框从外扩 76px 处 spring(15,210) 收拢，+5f 贴出标签逐字打出（~2.2 字/帧，这里中文按 1 字/帧）。
// 机器色 = sage 浅色（深森林绿场上可见），品牌内容 = 弹窗原样。
import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Cap, Crop } from '../components';
import { C, EASE, FONT, MONO, clamp01, lerp, ramp } from '../theme';

const DLG = { x: 440, y: 187, w: 560, h: 525 };
const S = 1.56;
const X = 120, Y = 200;
const sx = (px: number) => X + (px - DLG.x) * S;
const sy = (py: number) => Y + (py - DLG.y) * S;
const SCAN0 = 16, SCAN1 = 90;
const Y0 = sy(DLG.y) - 10, Y1 = sy(DLG.y + DLG.h) + 10;
const frameAtY = (y: number) => SCAN0 + ((y - Y0) / (Y1 - Y0)) * (SCAN1 - SCAN0);
const MACH = '#cfe0d2';
// 行 bbox（页面 px，含左侧角色名与右侧模型选择）：layout-2.txt
const TARGETS = [
  { label: '侦察 · 查资料，核对官网能写什么', y: 346, h: 44 },
  { label: '设计 · 出官网和视频的画面', y: 514, h: 44 },
  { label: '执行 · 搭官网、渲染视频', y: 458, h: 44 },
].map((t) => ({ ...t, ft: Math.round(frameAtY(sy(t.y + t.h))) })).sort((a, b) => a.ft - b.ft);
for (let i = 1; i < TARGETS.length; i++) TARGETS[i].ft = Math.max(TARGETS[i].ft, TARGETS[i - 1].ft + 4);

const Corners: React.FC<{ x: number; y: number; w: number; h: number; k: number; arm: number }> = ({ x, y, w, h, k, arm }) => {
  const e = 76 * (1 - k);
  const L = (l: number, t: number, bx: number, by: number) => (
    <div style={{ position: 'absolute', left: l, top: t, width: arm, height: arm, borderLeft: bx < 0 ? `3.5px solid ${MACH}` : undefined, borderRight: bx > 0 ? `3.5px solid ${MACH}` : undefined,
      borderTop: by < 0 ? `3.5px solid ${MACH}` : undefined, borderBottom: by > 0 ? `3.5px solid ${MACH}` : undefined, borderRadius: 3 }} />
  );
  return <>{L(x - e, y - e, -1, -1)}{L(x + w + e - arm, y - e, 1, -1)}{L(x - e, y + h + e - arm, -1, 1)}{L(x + w + e - arm, y + h + e - arm, 1, 1)}</>;
};

export const Route: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scanY = lerp(Y0, Y1, clamp01((f - SCAN0) / (SCAN1 - SCAN0)));
  const scanOn = f >= SCAN0 - 2 && f <= SCAN1 + 6 ? 1 - ramp(f, SCAN1, 6, EASE.linear) : 0;
  const fired = TARGETS.filter((t) => f >= t.ft).length;
  const push = lerp(1, 1.035, clamp01(f / 210));
  const inO = ramp(f, 0, 12, EASE.linear), out = ramp(f, 198, 12, EASE.linear);
  return (
    <AbsoluteFill style={{ background: C.forest, opacity: 1 - out }}>
      <AbsoluteFill style={{ transform: `scale(${push})`, transformOrigin: '40% 45%', opacity: inO }}>
        <Crop src="tex/model-routing-dialog.png" cx={DLG.x} cy={DLG.y} cw={DLG.w} ch={DLG.h} s={S} x={X} y={Y} r={20} />
        {scanOn > 0 ? (
          <div style={{ position: 'absolute', left: X - 20, top: scanY - 140, width: DLG.w * S + 40, height: 143, opacity: scanOn, pointerEvents: 'none' }}>
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(207,224,210,0), rgba(86,110,93,.16))' }} />
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: C.g700, boxShadow: `0 0 12px ${C.g500}` }} />
          </div>
        ) : null}
        {TARGETS.map((t, i) => {
          if (f < t.ft) return null;
          const k = spring({ frame: f - t.ft, fps, config: { damping: 15, stiffness: 210 } });
          const arm = lerp(40, 26, ramp(f, t.ft + 3, 8, EASE.out));
          const bx = sx(DLG.x + 14), by = sy(t.y) - 6, bw = (DLG.w - 28) * S, bh = t.h * S + 12;
          const flash = ramp(f, t.ft + 3, 3, EASE.linear) * (1 - ramp(f, t.ft + 6, 12, EASE.linear));
          const n = Math.max(0, Math.floor((f - t.ft - 5) * 1.0));
          const txt = [...t.label].slice(0, n).join('');
          const lx = X + DLG.w * S + 56;
          return (
            <React.Fragment key={i}>
              <div style={{ position: 'absolute', left: bx, top: by, width: bw, height: bh, borderRadius: 8, background: `rgba(86,110,93,${0.075 * flash})`, boxShadow: flash > 0 ? `inset 0 0 0 2px rgba(86,110,93,${0.6 * flash})` : undefined }} />
              <Corners x={bx} y={by} w={bw} h={bh} k={k} arm={arm} />
              {f >= t.ft + 5 ? (
                <>
                  <div style={{ position: 'absolute', left: bx + bw + 10, top: by + bh / 2 - 1.5, width: (lx - bx - bw - 18) * ramp(f, t.ft + 5, 8, EASE.out), height: 3, background: MACH, opacity: 0.8 }} />
                  <div style={{ position: 'absolute', left: lx, top: by + bh / 2, transform: `translateY(calc(-50% + ${(1 - ramp(f, t.ft + 5, 8, EASE.out)) * 8}px))`, background: C.g700, color: '#fff',
                    fontFamily: FONT, fontSize: 40, fontWeight: 600, padding: '12px 22px', borderRadius: 10, whiteSpace: 'nowrap', minHeight: 48 }}>{txt}<span style={{ opacity: n < t.label.length ? 1 : 0 }}>▍</span></div>
                </>
              ) : null}
            </React.Fragment>
          );
        })}
        <div style={{ position: 'absolute', left: X + DLG.w * S + 56, top: Y + 10, fontFamily: MONO, fontSize: 34, color: fired === 3 ? MACH : 'rgba(250,250,247,.7)', letterSpacing: '0.04em' }}>
          {fired === 3 && f >= TARGETS[2].ft + 8 ? '分工完成 3 / 3' : `分工 ${fired} / 3`}
        </div>
      </AbsoluteFill>
      <Cap head="合适的模型，做合适的事" sub="主 agent 按模型路由把活分给各角色" x={X + DLG.w * S + 56} y={812} w={860} dark start={112} />
    </AbsoluteFill>
  );
};
