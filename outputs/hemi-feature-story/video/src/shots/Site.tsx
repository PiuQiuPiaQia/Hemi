// 官网成果（1320–1530f，7s）：停留在真实官网页面，简短滚动后直接接工作流。
// 不点击播放器，不播放片中片，不推进全屏，也没有拉回动作。
import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { Cap } from '../components';
import { C, EASE, FONT, lerp, ramp } from '../theme';
import { SHOTS } from '../timeline';

const WX = 240, WY = 112, WW = 1440, CHROME = 52, VIEW_H = 650;
const PAGE_H = 1415;
const SCROLL_FROM = 68, SCROLL_TO = 144;

export const Site: React.FC = () => {
  const f = useCurrentFrame();
  const dur = SHOTS.site.dur;
  const scroll = lerp(0, PAGE_H - VIEW_H, ramp(f, SCROLL_FROM, SCROLL_TO - SCROLL_FROM, EASE.move));
  const enter = ramp(f, 0, 14, EASE.out);
  const leave = ramp(f, dur - 14, 14, EASE.linear);
  return (
    <AbsoluteFill style={{ background: C.paper, opacity: 1 - leave }}>
      <div style={{ position: 'absolute', left: WX, top: WY + (1 - enter) * 30, width: WW, height: CHROME + VIEW_H, borderRadius: 16, overflow: 'hidden', background: C.paper, opacity: enter,
        boxShadow: `0 0 0 1.5px ${C.lineStrong}, 0 40px 100px -40px rgba(31,43,35,.45), 0 10px 24px rgba(31,43,35,.08)` }}>
        <div style={{ height: CHROME, background: '#efeee9', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px' }}>
          {['#e0ddd5', '#e0ddd5', '#e0ddd5'].map((c, i) => <div key={i} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />)}
          <div style={{ marginLeft: 24, height: 32, flex: '0 0 520px', borderRadius: 8, background: '#fff', border: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', padding: '0 14px', fontFamily: FONT, fontSize: 17, color: C.muted }}>127.0.0.1:4320</div>
        </div>
        <div style={{ position: 'absolute', left: 0, top: CHROME, width: WW, height: VIEW_H, overflow: 'hidden' }}>
          <Img src={staticFile('tex/site-full.png')} style={{ position: 'absolute', left: 0, top: -scroll, width: WW, height: PAGE_H, maxWidth: 'none' }} />
        </div>
      </div>
      <Cap head="官网做好了" sub="一页讲清产品特色和下载入口" x={WX} y={WY + CHROME + VIEW_H + 22} w={1300} size={52} start={8} end={dur - 6} />
    </AbsoluteFill>
  );
};
