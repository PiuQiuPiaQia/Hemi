import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { FPS, SHOTS, TASKBAR_IN, TASKBAR_OUT, TOTAL } from './timeline';
import { TaskBar } from './components';
import { C, EASE, ramp } from './theme';
import { Ask, AskLabel } from './shots/Ask';
import { Models } from './shots/Models';
import { Memory } from './shots/Memory';
import { Route } from './shots/Route';
import { Make } from './shots/Make';
import { Remote } from './shots/Remote';
import { Site } from './shots/Site';
import { Flow } from './shots/Flow';
import { Brand } from './shots/Brand';

const TaskBarLayer: React.FC = () => {
  const f = useCurrentFrame();
  if (f < TASKBAR_IN || f >= TASKBAR_OUT) return null;
  // 降格落位期间外框先出现，标题文字由 AskLabel 落位后接管（168f）
  const shell = ramp(f, TASKBAR_IN, 14, EASE.out);
  // 官网只展示实现结果，不再播放片中片；任务条始终保留到品牌收束。
  return <TaskBar o={shell} titleO={f >= 167 ? 1 : 0} />;
};

export type HemiFeaturesProps = { bgm: boolean };

// The approved picture edit is unchanged; BGM can be disabled for the silent master.
export const HemiFeatures: React.FC<HemiFeaturesProps> = ({ bgm = true }) => (
  <AbsoluteFill style={{ background: C.paper }}>
    <Sequence from={SHOTS.ask.from} durationInFrames={SHOTS.ask.dur}><Ask /></Sequence>
    <Sequence from={SHOTS.models.from} durationInFrames={SHOTS.models.dur}><Models /></Sequence>
    <Sequence from={SHOTS.memory.from} durationInFrames={SHOTS.memory.dur}><Memory /></Sequence>
    <Sequence from={SHOTS.route.from} durationInFrames={SHOTS.route.dur}><Route /></Sequence>
    <Sequence from={SHOTS.make.from} durationInFrames={SHOTS.make.dur}><Make /></Sequence>
    <Sequence from={SHOTS.remote.from} durationInFrames={SHOTS.remote.dur}><Remote /></Sequence>
    <Sequence from={SHOTS.site.from} durationInFrames={SHOTS.site.dur}><Site /></Sequence>
    <Sequence from={SHOTS.flow.from} durationInFrames={SHOTS.flow.dur}><Flow /></Sequence>
    <Sequence from={SHOTS.brand.from} durationInFrames={SHOTS.brand.dur}><Brand /></Sequence>
    <TaskBarLayer />
    <AskLabel />
    {bgm ? <Audio src={staticFile('audio/bgm/gentle-piano-guitar.wav')}
      volume={(f) => Math.max(0, Math.min(1, f / (FPS * 1.5), (TOTAL - 1 - f) / (FPS * 4)))} /> : null}
  </AbsoluteFill>
);
