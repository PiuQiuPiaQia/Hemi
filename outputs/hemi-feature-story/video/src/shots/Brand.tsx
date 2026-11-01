// S10 品牌落版（2010–2160f，局部 0–150）。ui-to-brand-morph · input-morph-assemble 适配：
// 左上任务条（全片同一任务）以同一个 spring(damping 15, stiffness 95) 收缩成 Hemi 标志，
// 标志让位后字标逐字升起、口号逐词升起；落定 hold ≥ 45f。standalone=true 时（成片节选里）标志直接缩放入场。
import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { HemiMark, TB, TB_TITLE } from '../components';
import { C, EASE, FONT, clamp01, lerp, ramp } from '../theme';

const MARK = 148, GAP = 36, WORD = 132;
const WORD_W = WORD * 2.75; // 「Hemi」SF Pro Display 600 近似宽度
const LOCK_W = MARK + GAP + WORD_W;
const MX = 960 - LOCK_W / 2, MY = 330;
// 任务条外框几何（与 components.TaskBar 一致）：宽 = padL + mark + gap + 标题 + 右 30
const TB_W = TB.padL + TB.mark + TB.gap + TB_TITLE.length * TB.font + 30;

export const Brand: React.FC<{ standalone?: boolean }> = ({ standalone }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const m = standalone ? 1 : spring({ frame: f - 4, fps, config: { damping: 15, stiffness: 95 } });
  const box = standalone
    ? { x: MX, y: MY, w: MARK, h: MARK, r: MARK * 0.24 }
    : { x: lerp(TB.x, MX, m), y: lerp(TB.y, MY, m), w: lerp(TB_W, MARK, m), h: lerp(TB.h, MARK, m), r: lerp(TB.h / 2, MARK * 0.24, m) };
  const fill = standalone ? 1 : ramp(f, 14, 14, EASE.out); // 白 → 品牌绿
  const glyph = standalone ? 1 : ramp(f, 26, 10, EASE.out);
  const titleO = standalone ? 0 : 1 - ramp(f, 4, 8, EASE.linear);
  const appear = standalone ? ramp(f, 0, 18, EASE.overshoot) : 1;
  const rise = (d: number) => ramp(f, d, 20, EASE.out);
  const letters = [...'Hemi'];
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <div style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, borderRadius: box.r, overflow: 'hidden', transform: `scale(${appear})`, transformOrigin: '50% 50%',
        background: `rgb(${Math.round(lerp(255, 75, fill))},${Math.round(lerp(255, 97, fill))},${Math.round(lerp(255, 82, fill))})`, boxShadow: `0 0 0 1.5px rgba(228,227,222,${1 - fill}), 0 20px 50px -26px rgba(31,43,35,.45)` }}>
        {titleO > 0 ? <div style={{ position: 'absolute', left: TB.padL + TB.mark + TB.gap, top: 0, height: TB.h, display: 'flex', alignItems: 'center', fontFamily: FONT, fontSize: TB.font, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap', opacity: titleO }}>{TB_TITLE}</div> : null}
        <div style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(-50%,-50%) scale(${lerp(0.6, 1, glyph)})`, opacity: glyph }}>
          <HemiMark size={Math.min(box.w, box.h)} bg="transparent" />
        </div>
      </div>
      <div style={{ position: 'absolute', left: MX + MARK + GAP, top: MY + MARK / 2, transform: 'translateY(-54%)', display: 'flex', fontFamily: FONT, fontSize: WORD, fontWeight: 600, letterSpacing: '-0.02em', color: C.ink, lineHeight: 1 }}>
        {letters.map((ch, i) => { const p = rise((standalone ? 8 : 30) + i * 3); return <span key={i} style={{ display: 'inline-block', opacity: p, transform: `translateY(${(1 - p) * 40}px)` }}>{ch}</span>; })}
      </div>
      {(() => { const p = rise(standalone ? 22 : 48); return (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 560, textAlign: 'center', fontFamily: FONT, fontSize: 76, fontWeight: 600, color: C.ink, letterSpacing: '-0.015em', opacity: p, transform: `translateY(${(1 - p) * 26}px)` }}>
          不止帮你想。<span style={{ color: C.g700 }}>陪你做到交付。</span></div>); })()}
      {(() => { const p = rise(standalone ? 32 : 60); return (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 700, textAlign: 'center', fontFamily: FONT, opacity: p, transform: `translateY(${(1 - p) * 20}px)` }}>
          <div style={{ fontSize: 44, color: C.body }}>免费下载 · macOS / Windows · MIT 开源</div>
          <div style={{ marginTop: 22, fontSize: 44, color: C.g700, fontWeight: 600 }}>github.com/PiuQiuPiaQia/Hemi</div>
        </div>); })()}
    </AbsoluteFill>
  );
};
export const BRAND_SETTLE = 80; // 最后一行落定（60+20），之后 hold 70f
export const _clamp = clamp01;
