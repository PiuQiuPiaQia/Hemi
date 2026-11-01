import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { C, EASE, FONT, clamp01, lerp, ramp } from './theme';

export const HemiMark: React.FC<{ size: number; bg?: string; fg?: string }> = ({ size, bg = C.g800, fg = '#FAFAF7' }) => (
  <svg width={size} height={size} viewBox="0 0 1024 1024" style={{ display: 'block' }}>
    <path fill={bg} d="M286 48H738C891 48 976 133 976 286V738C976 891 891 976 738 976H286C133 976 48 891 48 738V286C48 133 133 48 286 48Z" />
    <g fill={fg}><rect x="272" y="256" width="112" height="512" rx="22" /><rect x="640" y="256" width="112" height="512" rx="22" /><path d="M368 474C452 450 572 506 656 482V550C572 574 452 518 368 542Z" /></g>
  </svg>
);

/** 素材性质角标，右上角。字号 38（CJK 有效字高 ≥32px）。 */
export const Badge: React.FC<{ text: string; start?: number; end?: number; tone?: 'light' | 'warn' }> = ({ text, start = 0, end = 1e9, tone = 'light' }) => {
  const f = useCurrentFrame();
  const o = ramp(f, start, 12) * (1 - ramp(f, end - 10, 10));
  const warn = tone === 'warn';
  return (
    <div style={{ position: 'absolute', right: 56, bottom: 44, fontFamily: FONT, fontSize: 38, lineHeight: 1, color: warn ? '#7a4b12' : C.muted, opacity: o,
      background: warn ? '#fbecd2' : 'rgba(255,255,255,.86)', border: `1.5px solid ${warn ? '#e2b86d' : C.lineStrong}`, padding: '14px 24px', borderRadius: 999, whiteSpace: 'nowrap' }}>{text}</div>
  );
};

/** 左上任务条：全片同一任务、同一标题。几何常量供 ask 降格与 brand 收束对位。 */
export const TB = { x: 56, y: 40, h: 76, mark: 44, font: 40, padL: 16, gap: 16 };
export const TB_TITLE = '给自己做个官网和宣传片';
export const TB_TITLE_X = TB.x + TB.padL + TB.mark + TB.gap;
export const TB_TITLE_CY = TB.y + TB.h / 2;
export const TaskBar: React.FC<{ o?: number; titleO?: number }> = ({ o = 1, titleO = 1 }) => (
  <div style={{ position: 'absolute', left: TB.x, top: TB.y, height: TB.h, display: 'flex', alignItems: 'center', gap: TB.gap, padding: `0 30px 0 ${TB.padL}px`,
    background: 'rgba(255,255,255,.92)', border: `1.5px solid ${C.line}`, borderRadius: 999, boxShadow: '0 10px 30px -18px rgba(31,43,35,.35)', opacity: o, fontFamily: FONT }}>
    <HemiMark size={TB.mark} />
    <span style={{ fontSize: TB.font, fontWeight: 600, color: C.ink, letterSpacing: '-0.01em', whiteSpace: 'nowrap', lineHeight: 1, opacity: titleO }}>{TB_TITLE}</span>
  </div>
);

/** 字幕：主句 64/600 + 副句 40/400，blur-slide 三通道同一进度。 */
export const Cap: React.FC<{ head: string; sub?: string; x: number; y: number; start: number; end?: number; align?: 'left' | 'center'; w?: number; dark?: boolean; size?: number }> = ({ head, sub, x, y, start, end = 1e9, align = 'left', w = 900, dark, size = 64 }) => {
  const f = useCurrentFrame();
  const out = ramp(f, end - 12, 12, EASE.exit);
  const p = (d: number) => ramp(f, start + d, 22, EASE.out);
  const st = (q: number, s: number): React.CSSProperties => ({ opacity: q * (1 - out), transform: `translateY(${(1 - q) * s * 0.38 - out * 12}px)`, filter: q > 0.999 ? undefined : `blur(${(1 - q) * 12}px)` });
  return (
    <div style={{ position: 'absolute', left: align === 'center' ? x - w / 2 : x, top: y, width: w, textAlign: align, fontFamily: FONT }}>
      <div style={{ fontSize: size, fontWeight: 600, lineHeight: 1.22, letterSpacing: '-0.015em', color: dark ? '#fafaf7' : C.ink, ...st(p(0), size) }}>{head}</div>
      {sub ? <div style={{ marginTop: 18, fontSize: 40, fontWeight: 400, lineHeight: 1.4, color: dark ? 'rgba(250,250,247,.75)' : C.muted, ...st(p(6), 40) }}>{sub}</div> : null}
    </div>
  );
};

/** 截图纹理（2x，CSS 1440×900）中的一块区域，以 scale 放到画面 (x,y)。 */
export const Crop: React.FC<{ src: string; cx: number; cy: number; cw: number; ch: number; x: number; y: number; s: number; r?: number; shadow?: boolean; style?: React.CSSProperties }> = ({ src, cx, cy, cw, ch, x, y, s, r = 18, shadow = true, style }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: cw * s, height: ch * s, borderRadius: r, overflow: 'hidden', background: '#fff',
    boxShadow: shadow ? `0 0 0 1.5px ${C.line}, 0 30px 70px -36px rgba(31,43,35,.42), 0 8px 20px -12px rgba(31,43,35,.14)` : undefined, ...style }}>
    <Img src={staticFile(src)} style={{ position: 'absolute', left: -cx * s, top: -cy * s, width: 1440 * s, height: 900 * s, maxWidth: 'none' }} />
  </div>
);

/** 相机：整张 1440×900 纹理，对准点 (cx,cy) 页面 px，缩放 z。children 用页面坐标。 */
export type CamKey = { f: number; cx: number; cy: number; z: number };
export const camAt = (frame: number, keys: CamKey[], ease = EASE.cam) => {
  if (frame <= keys[0].f) return keys[0];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (frame <= b.f) { const t = ease((frame - a.f) / Math.max(1, b.f - a.f)); return { f: frame, cx: lerp(a.cx, b.cx, t), cy: lerp(a.cy, b.cy, t), z: lerp(a.z, b.z, t) }; }
  }
  return keys[keys.length - 1];
};
export const PageCam: React.FC<{ src: string; cam: { cx: number; cy: number; z: number }; bg?: string; w?: number; h?: number; children?: React.ReactNode }> = ({ src, cam, bg = '#fff', w = 1440, h = 900, children }) => (
  <AbsoluteFill style={{ background: bg, overflow: 'hidden' }}>
    <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, transformOrigin: '0 0', transform: `translate(${(960 - cam.cx * cam.z).toFixed(2)}px, ${(540 - cam.cy * cam.z).toFixed(2)}px) scale(${cam.z.toFixed(4)})` }}>
      <Img src={staticFile(src)} style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, maxWidth: 'none' }} />
      {children}
    </div>
  </AbsoluteFill>
);
/** 页面坐标 → 画面坐标 */
export const toScreen = (cam: { cx: number; cy: number; z: number }, px: number, py: number) => ({ x: 960 + (px - cam.cx) * cam.z, y: 540 + (py - cam.cy) * cam.z });

export const Cursor: React.FC<{ x: number; y: number; press?: number; o?: number }> = ({ x, y, press = 0, o = 1 }) => (
  <svg width={46} height={50} viewBox="0 0 28 30" style={{ position: 'absolute', left: x - 6, top: y - 3, opacity: o, transform: `scale(${1 - press * 0.16})`, transformOrigin: '15% 10%',
    filter: 'drop-shadow(0 2px 3px rgba(16,18,24,.25)) drop-shadow(0 10px 18px rgba(16,18,24,.18))' }}>
    <path d="M4 2 L4 24 L9.5 18.5 L13 27 L16.8 25.4 L13.3 17 L21 17 Z" fill="#fff" stroke="#1a1a19" strokeWidth={1.6} strokeLinejoin="round" />
  </svg>
);
/** 点击涟漪（cursor-flyover：80px、18f、0.3→1.5）。 */
export const Ripple: React.FC<{ x: number; y: number; at: number; color?: string }> = ({ x, y, at, color = C.g700 }) => {
  const f = useCurrentFrame();
  const t = clamp01((f - at) / 18);
  if (f < at || t >= 1) return null;
  const s = lerp(0.3, 1.5, EASE.out(t));
  return <div style={{ position: 'absolute', left: x - 40, top: y - 40, width: 80, height: 80, borderRadius: '50%', border: `3px solid ${color}`, opacity: 1 - t, transform: `scale(${s})` }} />;
};

/** 镜头间淡入淡出（只用在需要的边界）。 */
export const fadeIO = (f: number, dur: number, inF = 10, outF = 10) => ramp(f, 0, inF, EASE.linear) * (1 - ramp(f, dur - outF, outF, EASE.linear));

/** 占位卡：远程等真实证据。明确写出待采集，不可作为终版。 */
export const Pending: React.FC<{ x: number; y: number; w: number; h: number; title: string; lines: string[] }> = ({ x, y, w, h, title, lines }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: 22, border: '3px dashed #c99a4a', background: 'repeating-linear-gradient(135deg, #fbf4e6 0 22px, #f7eddb 22px 44px)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, fontFamily: FONT, textAlign: 'center' }}>
    <div style={{ fontSize: 46, fontWeight: 700, color: '#7a4b12' }}>{title}</div>
    {lines.map((l, i) => <div key={i} style={{ fontSize: 34, color: '#8a6328', maxWidth: w - 80 }}>{l}</div>)}
  </div>
);

/** 光标路径（cursor-flyover：swift 16f + 与位移垂直的轻弧，起止弧度 0）。 */
export type CurKey = { f: number; x: number; y: number };
export const cursorAt = (frame: number, keys: CurKey[], dur = 16) => {
  let p = { x: keys[0].x, y: keys[0].y };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    const t0 = b.f - dur;
    if (frame >= b.f) { p = { x: b.x, y: b.y }; continue; }
    if (frame > t0) {
      const t = EASE.out(clamp01((frame - t0) / dur));
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, arc = Math.sin(Math.PI * t) * Math.min(60, L * 0.12);
      p = { x: a.x + dx * t + (-dy / L) * arc, y: a.y + dy * t + (dx / L) * arc };
    }
    break;
  }
  return p;
};
export const pressAt = (frame: number, at: number) => (frame >= at && frame < at + 7 ? Math.sin(((frame - at) / 7) * Math.PI) : 0);
