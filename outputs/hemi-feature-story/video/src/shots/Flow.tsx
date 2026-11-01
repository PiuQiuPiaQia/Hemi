// S9 工作流 Beta（1740–2010f，局部 0–270）。真实 WorkflowStudio + workflow-demo 的真实发布定义（revision 1，
// 由真实 initWorkflowService saveDraft→publish→prepare，未执行）。三拍：列表里多了这条流程 → 详情（流程概览、默认输入）
// → 「仅调整本次」参数确认框。光标停在「补充并运行」上方，不点击；片中不出现运行结果。
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Cap, Cursor, PageCam, Ripple, camAt, cursorAt, pressAt, toScreen, type CamKey } from '../components';
import { C, EASE, ramp } from '../theme';

const CAM_L: CamKey[] = [{ f: 0, cx: 900, cy: 290, z: 1.72 }, { f: 70, cx: 905, cy: 295, z: 1.78 }];
const CAM_D: CamKey[] = [{ f: 70, cx: 970, cy: 250, z: 1.6 }, { f: 112, cx: 970, cy: 250, z: 1.62 }, { f: 140, cx: 970, cy: 560, z: 1.62 }, { f: 160, cx: 970, cy: 560, z: 1.62 }];
const CAM_P: CamKey[] = [{ f: 160, cx: 720, cy: 380, z: 1.62 }, { f: 205, cx: 720, cy: 390, z: 1.62 }, { f: 230, cx: 720, cy: 720, z: 1.62 }];
const FIELDS = [[500, 184, 440, 57], [500, 315, 440, 36], [500, 559, 440, 36]];
const ADJUST = { x: 727, y: 582 }; // 「仅调整本次」中心（页面 px，layout-3）
const CLICK_ADJ = 152;
const SUBMIT = { x: 882, y: 839 };

export const Flow: React.FC = () => {
  const f = useCurrentFrame();
  const stage = f < 70 ? 'list' : f < 160 ? 'detail' : 'params';
  const cam = stage === 'list' ? camAt(f, CAM_L) : stage === 'detail' ? camAt(f, CAM_D) : camAt(f, CAM_P);
  const xf = (a: number) => ramp(f, a, 8, EASE.linear);
  const inO = ramp(f, 0, 12, EASE.linear), out = ramp(f, 258, 12, EASE.linear);
  // 光标：详情页移到「仅调整本次」点一下；参数框里移到「补充并运行」上方停住
  const dAdj = toScreen(camAt(CLICK_ADJ, CAM_D), ADJUST.x, ADJUST.y);
  const pSub = toScreen(camAt(240, CAM_P), SUBMIT.x - 30, SUBMIT.y - 4);
  const cur = cursorAt(f, [{ f: 120, x: 1500, y: 980 }, { f: 146, x: dAdj.x, y: dAdj.y }, { f: 236, x: dAdj.x, y: dAdj.y }, { f: 244, x: pSub.x, y: pSub.y }], 16);
  const curO = ramp(f, 124, 6, EASE.linear) * (1 - ramp(f, CLICK_ADJ + 4, 6, EASE.linear)) + (f >= 226 ? ramp(f, 226, 6, EASE.linear) : 0);
  return (
    <AbsoluteFill style={{ background: C.paper, opacity: inO * (1 - out) }}>
      {stage === 'list' ? <PageCam src="tex/fs-wf-list.png" cam={cam} /> : null}
      {stage === 'detail' ? <AbsoluteFill style={{ opacity: xf(70) }}><PageCam src="tex/fs-wf-detail.png" cam={cam} /></AbsoluteFill> : null}
      {stage === 'params' ? (
        <AbsoluteFill style={{ opacity: xf(160) }}>
          <PageCam src="tex/fs-wf-params.png" cam={cam}>
            {FIELDS.map(([x, y, w, h], i) => <div key={i} style={{ position: 'absolute', left: x - 3, top: y - 3, width: (w + 6) * ramp(f, 176 + i * 10, 12, EASE.out), height: h + 6, borderRadius: 8, boxShadow: `0 0 0 2px ${C.g700}`, background: 'rgba(207,220,209,.28)' }} />)}
          </PageCam>
        </AbsoluteFill>
      ) : null}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 300, background: `linear-gradient(180deg, rgba(249,248,244,0), ${C.paper} 40%)` }} />
      {curO > 0 ? <><Cursor x={cur.x} y={cur.y} press={pressAt(f, CLICK_ADJ - 3)} o={Math.min(1, curO)} /><Ripple x={dAdj.x} y={dAdj.y} at={CLICK_ADJ} /></> : null}
      <Cap head="这套做法，存成工作流（Beta）" sub="自己配置并发布：资料核对 → 文案分镜 → 官网和视频 → 人工审阅" x={96} y={846} w={1600} size={56} start={6} end={110} />
      <Cap head="下次换一份资料，再跑一遍" sub="默认输入可以改，也可以只调整这一次" x={96} y={846} w={1500} size={56} start={112} end={200} />
      <Cap head="运行前，由你确认" sub="不会自己开始；目前没有定时触发" x={96} y={846} w={1500} size={56} start={202} />
    </AbsoluteFill>
  );
};
