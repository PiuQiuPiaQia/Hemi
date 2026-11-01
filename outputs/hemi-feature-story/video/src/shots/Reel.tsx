// 独立成片节选（180f）：在官网播放器里播放。只取本片的三个片段，均不含播放器、不含官网，避免任何套娃。
//   0–60  任务输入（Ask 局部 34–94）   60–110 模型路由扫描（Route 局部 20–70）   110–180 品牌（standalone）
import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { Ask } from './Ask';
import { Route } from './Route';
import { Brand } from './Brand';
export const Reel: React.FC = () => (
  <AbsoluteFill style={{ background: '#000' }}>
    <Sequence from={-34} durationInFrames={94}><Ask /></Sequence>
    <Sequence from={40} durationInFrames={70}><Route /></Sequence>
    <Sequence from={110} durationInFrames={70}><Brand standalone /></Sequence>
  </AbsoluteFill>
);
