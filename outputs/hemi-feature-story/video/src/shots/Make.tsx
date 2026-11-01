// S5 各角色产出接成交付（780–960f，局部 0–180）。canvas-materialize-moves · panel-to-canvas 适配：
// 同一任务对话里的三条角色结果行（fs-dispatch.png）先拔起 4f，再沿上抛弧线错峰 6f 飞出，
// 位置先到、宽高晚 3f 收敛（父先子后）；行内容 u<0.4 淡出、卡内容 u>0.5 淡入；落地 4f 压扁回弹；行槽塌成虚线。
import React from 'react';
import { AbsoluteFill, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Cap } from '../components';
import { C, EASE, FONT, MONO, clamp01, lerp, ramp } from '../theme';

const P = { cx: 482, cy: 132, cw: 750, ch: 172 }; // 面板裁切（页面 px）
const S = 1.9;
const PX = 960 - (P.cw * S) / 2, PY = 140;
const toS = (x: number, y: number) => ({ x: PX + (x - P.cx) * S, y: PY + (y - P.cy) * S });
const ROWS = [
  { x: 497, y: 199, w: 420, h: 26 },
  { x: 497, y: 227, w: 310, h: 26 },
  { x: 497, y: 255, w: 220, h: 26 },
];
const CW = 540, CH = 300, CY = 590;
const CARDS = [{ x: 96 }, { x: 690 }, { x: 1284 }];
const LIFT_AT = [40, 46, 52], LIFT = 4, FLY = 40;

const CardBody: React.FC<{ i: number }> = ({ i }) => {
  const head: React.CSSProperties = { fontSize: 32, color: C.g700, fontWeight: 600, marginBottom: 14 };
  const body: React.CSSProperties = { fontSize: 38, color: C.ink, fontWeight: 600, lineHeight: 1.3 };
  if (i === 0) return (<><div style={head}>侦察 · 能写什么</div><div style={body}>五项特色，逐条核对</div><div style={{ ...body, color: C.muted, fontWeight: 400, fontSize: 34, marginTop: 12 }}>每一条都写清使用前提</div></>);
  if (i === 1) return (<><div style={head}>设计 · 画面</div>
    <div style={{ display: 'flex', gap: 14, margin: '6px 0 16px' }}>{[C.g700, C.g200, C.paper].map((c) => <div key={c} style={{ width: 92, height: 64, borderRadius: 12, background: c, boxShadow: `inset 0 0 0 1.5px ${C.line}` }} />)}</div>
    <div style={body}>sage 绿 · 暖白底 · 文案平实</div></>);
  return (<><div style={head}>执行 · 成果</div>
    {['index.html', 'hemi-promo.mp4'].map((n) => <div key={n} style={{ fontFamily: MONO, fontSize: 34, color: C.ink, background: C.g50, border: `1.5px solid ${C.g200}`, borderRadius: 10, padding: '10px 18px', marginTop: 12, width: 'fit-content' }}>{n}</div>)}
    <div style={{ ...body, fontSize: 34, color: C.muted, fontWeight: 400, marginTop: 14 }}>官网 + 宣传片</div></>);
};

export const Make: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pin = ramp(f, 0, 14, EASE.linear), out = ramp(f, 168, 12, EASE.linear);
  const push = lerp(1, 1.025, clamp01((f - 44) / 136));
  return (
    <AbsoluteFill style={{ background: C.paper, opacity: 1 - out }}>
      <AbsoluteFill style={{ transform: `scale(${push})`, transformOrigin: '50% 60%' }}>
        <div style={{ position: 'absolute', left: PX, top: PY, width: P.cw * S, height: P.ch * S, borderRadius: 20, overflow: 'hidden', background: '#fff', opacity: pin,
          boxShadow: `0 0 0 1.5px ${C.line}, 0 30px 70px -36px rgba(31,43,35,.42)` }}>
          <Img src={staticFile('tex/fs-dispatch.png')} style={{ position: 'absolute', left: -P.cx * S, top: -P.cy * S, width: 1440 * S, height: 900 * S, maxWidth: 'none' }} />
          {ROWS.map((r, i) => {
            const gone = f >= LIFT_AT[i] + LIFT;
            if (!gone) return null;
            const a = toS(r.x, r.y);
            return <div key={i} style={{ position: 'absolute', left: a.x - PX - 4, top: a.y - PY, width: r.w * S + 8, height: r.h * S, background: '#fff' }}>
              <div style={{ position: 'absolute', inset: '4px 0', borderRadius: 8, border: `2px dashed ${C.g500}`, opacity: ramp(f, LIFT_AT[i] + LIFT, 10, EASE.out) * 0.8 }} /></div>;
          })}
        </div>
        {ROWS.map((r, i) => {
          const a = toS(r.x, r.y);
          const from = { x: a.x, y: a.y, w: r.w * S, h: r.h * S };
          const to = { x: CARDS[i].x, y: CY, w: CW, h: CH };
          const t0 = LIFT_AT[i];
          if (f < t0) return null;
          const lift = ramp(f, t0, LIFT, EASE.out);
          const sp = f < t0 + LIFT ? 0 : spring({ frame: f - t0 - LIFT, fps, config: { damping: 17 }, durationInFrames: FLY });
          const sp2 = f < t0 + LIFT + 3 ? 0 : spring({ frame: f - t0 - LIFT - 3, fps, config: { damping: 17 }, durationInFrames: FLY });
          const u = clamp01(sp);
          const cx0 = from.x + from.w / 2, cy0 = from.y + from.h / 2, cx1 = to.x + to.w / 2, cy1 = to.y + to.h / 2;
          const mx = (cx0 + cx1) / 2, my = Math.min(cy0, cy1) - 220;
          const bx = (1 - u) * (1 - u) * cx0 + 2 * (1 - u) * u * mx + u * u * cx1;
          const by = (1 - u) * (1 - u) * cy0 + 2 * (1 - u) * u * my + u * u * cy1;
          const w = lerp(from.w, to.w, clamp01(sp2)), h = lerp(from.h, to.h, clamp01(sp2));
          const landAt = t0 + LIFT + FLY - 8;
          const squash = f >= landAt ? 1 - 0.03 * Math.sin(clamp01((f - landAt) / 4) * Math.PI) : 1;
          const rowO = 1 - clamp01(u / 0.4), cardO = clamp01((u - 0.5) / 0.3);
          const tilt = [-1.6, 1.2, -0.8][i] * clamp01(u);
          const air = Math.sin(u * Math.PI);
          return (
            <div key={i} style={{ position: 'absolute', left: bx - w / 2, top: by - h / 2, width: w, height: h, borderRadius: lerp(8, 22, clamp01(sp2)), overflow: 'hidden', background: '#fff',
              transform: `scale(${(1 + 0.02 * lift * (1 - u)).toFixed(4)}, ${squash.toFixed(4)}) rotate(${tilt}deg)`, transformOrigin: '50% 100%',
              boxShadow: `0 0 0 1.5px ${C.line}, 0 ${10 + 40 * air}px ${30 + 60 * air}px -24px rgba(31,43,35,${0.25 + 0.2 * air})` }}>
              {rowO > 0 ? <div style={{ position: 'absolute', left: 0, top: 0, width: from.w, height: from.h, opacity: rowO, overflow: 'hidden' }}>
                <Img src={staticFile('tex/fs-dispatch.png')} style={{ position: 'absolute', left: -r.x * S, top: -r.y * S, width: 1440 * S, height: 900 * S, maxWidth: 'none' }} /></div> : null}
              <div style={{ position: 'absolute', left: 34, top: 30, right: 30, fontFamily: FONT, opacity: cardO }}><CardBody i={i} /></div>
            </div>
          );
        })}
      </AbsoluteFill>
      <Cap head="三份结果，接成一份交付" sub="同一个任务里，官网和宣传片一起做出来" x={96} y={920} w={1500} size={56} start={110} />
    </AbsoluteFill>
  );
};
