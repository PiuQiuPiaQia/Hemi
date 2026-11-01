// S6 远程（960–1320f，局部 0–360）。用户授权的功能演示：真实 Hemi 渲染器组件 + 虚构主机 / 项目（studio-node、studio-bot、hemi-site）。
// A 0–180：SSH 远程工作区 —— 同一任务里切到 studio-node · hemi-site，校验完成、渲染进行中；本机需要保持连接。
// B 180–360：Bot —— 同一宣传任务交给 studio-bot 受理；顶栏连接状态从「已连接」变「未连接」，任务仍显示进行中；条件：服务器在线。
// 两段是两种方式的演示，不表现成同一条命令自动迁移。fixture 的「已运行 10m02s」被底色盖掉，不出现耗时。
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Cap, PageCam, camAt, type CamKey } from '../components';
import { C, EASE, ramp } from '../theme';

const CAM_A: CamKey[] = [{ f: 0, cx: 720, cy: 240, z: 1.5 }, { f: 40, cx: 700, cy: 230, z: 1.6 }, { f: 180, cx: 700, cy: 232, z: 1.64 }];
const CAM_B: CamKey[] = [{ f: 180, cx: 840, cy: 300, z: 1.4 }, { f: 230, cx: 840, cy: 300, z: 1.45 }, { f: 360, cx: 845, cy: 300, z: 1.5 }];
const OFFLINE_AT = 252;
const Hide: React.FC<{ r: number[] }> = ({ r }) => <div style={{ position: 'absolute', left: r[0] - 2, top: r[1] - 1, width: r[2] + 4, height: r[3] + 2, background: '#fff' }} />;
const Ring: React.FC<{ r: number[]; p: number }> = ({ r, p }) => (
  <div style={{ position: 'absolute', left: r[0] - 6, top: r[1] - 5, width: r[2] + 12, height: r[3] + 10, borderRadius: 999, boxShadow: `0 0 0 2px ${C.g700}`, opacity: p, transform: `scale(${1.25 - 0.25 * p})` }} />
);

export const Remote: React.FC = () => {
  const f = useCurrentFrame();
  const a = 1 - ramp(f, 172, 12, EASE.linear), b = ramp(f, 176, 12, EASE.linear);
  const o = ramp(f, 0, 12, EASE.linear) * (1 - ramp(f, 348, 12, EASE.linear));
  return (
    <AbsoluteFill style={{ background: C.paper, opacity: o }}>
      {a > 0 ? (
        <AbsoluteFill style={{ opacity: a }}>
          <PageCam src="tex/fs-remote.png" cam={camAt(f, CAM_A)}>
            <Hide r={[761, 204, 82, 18]} />
            <Ring r={[182, 17, 136, 18]} p={ramp(f, 40, 14, EASE.out)} />
            <div style={{ position: 'absolute', left: 497, top: 141, width: 720 * ramp(f, 56, 16, EASE.out), height: 26, borderRadius: 4, background: C.g200, mixBlendMode: 'multiply', opacity: 0.7 }} />
          </PageCam>
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 360, background: `linear-gradient(180deg, rgba(249,248,244,0), ${C.paper} 42%)` }} />
          <Cap head="渲染交给远程主机" sub="通过 SSH 在 studio-node 上执行，过程中本机保持连接" x={96} y={836} w={1500} start={14} end={176} />
        </AbsoluteFill>
      ) : null}
      {b > 0 ? (
        <AbsoluteFill style={{ opacity: b }}>
          <PageCam src={f < OFFLINE_AT ? 'tex/fs-bot-online.png' : 'tex/fs-bot-offline.png'} cam={camAt(f, CAM_B)}>
            <Hide r={[745, 203, 82, 18]} />
            <Ring r={[1305, 17, 119, 18]} p={ramp(f, 220, 14, EASE.out)} />
            <Ring r={[509, 199, 236, 26]} p={ramp(f, OFFLINE_AT + 18, 14, EASE.out)} />
          </PageCam>
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 360, background: `linear-gradient(180deg, rgba(249,248,244,0), ${C.paper} 42%)` }} />
          <Cap head="交给 Bot，合上电脑也能接着做" sub="服务器在线时，Bot 已受理的任务会继续推进" x={96} y={836} w={1500} start={196} end={OFFLINE_AT - 2} />
          <Cap head="本机已断开，任务还在推进" sub="Bot 部署在你自己的服务器上；普通 SSH 工作需要本机保持连接" x={96} y={836} w={1600} start={OFFLINE_AT + 4} end={360} />
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
