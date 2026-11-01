import React from 'react';
import { Composition } from 'remotion';
import { HemiFeatures } from './Main';
import { Reel } from './shots/Reel';
import { FPS, REEL_DUR, TOTAL } from './timeline';
export const Root: React.FC = () => (
  <>
    <Composition id="HemiFeatures" component={HemiFeatures} defaultProps={{ bgm: true }} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
    <Composition id="HemiReel" component={Reel} durationInFrames={REEL_DUR} fps={FPS} width={1920} height={1080} />
  </>
);
