// S1 任务输入（0–150f）+ 任务句降格成左上任务条（title-demote-to-label · A 式适配）。
// 真实首页（fs-ask.png：VoiceScreen + 演示数据）。打字由逐字揭示纹理里的真实草稿实现，不重绘输入框。
import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { PageCam, TB_TITLE, TB_TITLE_CY, TB_TITLE_X, TB, camAt, toScreen, type CamKey } from '../components';
import { C, EASE, FONT, clamp01, lerp, ramp } from '../theme';

// 纹理坐标（CSS px，layout-2.txt 实测）：草稿文字 [513,485,327,17]，输入框 textarea [497,466,720,56]
const TXT = { x: 513, y: 485, w: 327, h: 17 };
export const ASK_TEXT = 'Hemi，给自己做个官网和宣传片，沿用我的品牌风格';
// 逐字累计宽度（em）：CJK 1em，拉丁字母按 SF 实测近似
const LATIN: Record<string, number> = { H: 0.72, e: 0.56, m: 0.86, i: 0.25 };
const cum = (() => { const a = [0]; for (const ch of ASK_TEXT) a.push(a[a.length - 1] + (LATIN[ch] ?? 1)); return a; })();
const EM_TOTAL = cum[cum.length - 1];
export const TYPE0 = 34, TYPE1 = 98, SEND = 104;
export const CAM: CamKey[] = [
  { f: 0, cx: 720, cy: 440, z: 1.4 },
  { f: 34, cx: 860, cy: 494, z: 2.5 },
  { f: 104, cx: 860, cy: 494, z: 2.56 },
];
const visibleChars = (f: number) => Math.round(clamp01((f - TYPE0) / (TYPE1 - TYPE0)) * ASK_TEXT.length);

export const Ask: React.FC = () => {
  const f = useCurrentFrame();
  const cam = camAt(Math.min(f, 104), CAM);
  const n = visibleChars(f);
  const revealPx = (cum[n] / EM_TOTAL) * TXT.w;
  const bgFade = ramp(f, 106, 18, EASE.move);
  const caretOn = f < SEND && Math.floor(f / 8) % 2 === 0;
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <AbsoluteFill style={{ opacity: 1 - bgFade, filter: bgFade > 0 ? `blur(${bgFade * 10}px)` : undefined }}>
        <PageCam src="tex/fs-ask.png" cam={cam}>
          {/* 未打出的部分用输入框底色盖住；send 后整句由 AskLabel 接管 */}
          <div style={{ position: 'absolute', left: TXT.x - 2 + (f >= SEND ? 0 : revealPx), top: TXT.y - 3, width: TXT.w + 8 - (f >= SEND ? 0 : revealPx), height: TXT.h + 6, background: '#fff' }} />
          {f >= TYPE0 - 6 && caretOn ? <div style={{ position: 'absolute', left: TXT.x + revealPx + 0.5, top: TXT.y - 1, width: 1.2, height: TXT.h + 2, background: C.ink }} /> : null}
        </PageCam>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** 任务句：send 后浮起成大标题，站稳，再降格进左上任务条。Main 层渲染（跨 S1/S2）。 */
const HERO = 64;
const LEAD = 'Hemi，', TRAIL = '，沿用我的品牌风格';
const emW = (s: string) => [...s].reduce((a, ch) => a + (LATIN[ch] ?? 1), 0);
export const AskLabel: React.FC = () => {
  const f = useCurrentFrame();
  if (f < SEND || f > 176) return null;
  // 起点：纹理里的草稿位置（与相机同帧换算）
  const cam = camAt(104, CAM);
  const p0 = toScreen(cam, TXT.x, TXT.y + TXT.h / 2);
  const s0 = (TXT.w / EM_TOTAL) * cam.z; // 纹理字号（屏幕 px / em）
  // 大标题位：整句居中
  const totalPx = EM_TOTAL * HERO;
  const heroLeadX = 960 - totalPx / 2;
  const lift = ramp(f, SEND + 2, 20, EASE.out); // 106–126 浮起
  const dem = ramp(f, 140, 26, EASE.demote); // 140–166 降格 26f（卡片命门）
  const sideO = 1 - ramp(f, 140, 8, EASE.linear); // 头尾随起飞淡出
  const size = dem > 0 ? lerp(HERO, TB.font, dem) : lerp(s0, HERO, lift);
  // 句首 x（含 LEAD），降格时以标题首字为锚点对齐任务条标题
  const leadW = emW(LEAD) * size * (dem > 0 ? sideO : 1);
  const startLeadX = dem > 0 ? lerp(heroLeadX + emW(LEAD) * HERO, TB_TITLE_X, dem) - leadW : lerp(p0.x, heroLeadX, lift);
  const cy = dem > 0 ? lerp(540, TB_TITLE_CY, dem) : lerp(p0.y, 540, lift);
  const o = 1 - ramp(f, 168, 6, EASE.linear);
  // 降格飞行速度 → 方向性模糊（静止为 0）
  const v = dem > 0 && dem < 1 ? Math.abs(ramp(f + 0.5, 140, 26, EASE.demote) - ramp(f - 0.5, 140, 26, EASE.demote)) * 600 : 0;
  const titleColor = dem > 0 ? C.ink : lift < 1 ? C.ink : C.ink;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: startLeadX, top: cy, transform: 'translateY(-50%)', display: 'flex', whiteSpace: 'nowrap', fontFamily: FONT, fontSize: size, lineHeight: 1,
        fontWeight: lerp(400, 600, Math.max(lift, dem)), color: titleColor, letterSpacing: dem > 0 ? '-0.01em' : '0', opacity: o, filter: v > 0.6 ? `blur(${Math.min(3, v * 0.25)}px)` : undefined }}>
        <span style={{ opacity: sideO, width: emW(LEAD) * size * (dem > 0 ? sideO : 1), overflow: 'hidden', display: 'inline-block' }}>{LEAD}</span>
        <span>{TB_TITLE}</span>
        <span style={{ opacity: sideO }}>{TRAIL}</span>
      </div>
    </AbsoluteFill>
  );
};
