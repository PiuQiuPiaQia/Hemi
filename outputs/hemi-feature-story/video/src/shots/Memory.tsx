// S3 沿用记忆偏好（360–570f，局部 0–210）。
// A：真实记忆设置页（fs-memory.png）推近，三条 #preference 依次被 sage 底色标出。
// B：同一任务的对话（fs-dispatch.png），Hemi 的回复以 row-embed 降落嵌入，回复里引用的偏好被标出。
import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, Easing } from 'remotion';
import { Cap, PageCam, camAt, type CamKey } from '../components';
import { C, EASE, lerp, ramp } from '../theme';

const CAM_A: CamKey[] = [{ f: 0, cx: 860, cy: 330, z: 1.6 }, { f: 34, cx: 857, cy: 340, z: 2.2 }, { f: 120, cx: 857, cy: 342, z: 2.26 }];
const ROWS = [329, 360, 390];
const CAM_B: CamKey[] = [{ f: 112, cx: 857, cy: 172, z: 2.3 }, { f: 210, cx: 857, cy: 176, z: 2.4 }];
const REPLY = { x: 491, y: 136, w: 734, h: 63 };
export const MEM_CUE = 124, MEM_FLY = 12;
const clampO = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const airOf = (f: number, cue: number) => 1 - interpolate(f, [cue, cue + MEM_FLY], [0, 1], { ...clampO, easing: Easing.bezier(0.5, 0, 0.8, 0.75) });

/** row-embed：纹理裁片从空中降下、rotateX 收平、嵌入时底边亮一道强调色缝（页面坐标）。 */
export const RowFlyer: React.FC<{ src: string; r: { x: number; y: number; w: number; h: number }; cue: number; fly?: number; bg?: string }> = ({ src, r, cue, bg = '#fff' }) => {
  const f = useCurrentFrame();
  const land = cue + MEM_FLY;
  const patchO = interpolate(f, [land, land + 2], [1, 0], clampO);
  const air = airOf(f, cue);
  const p = 1 - air;
  const scale = f < land ? 1.06 - 0.065 * p : interpolate(f, [land, land + 4], [0.995, 1], { ...clampO, easing: Easing.out(Easing.quad) });
  const appear = interpolate(f, [cue, cue + 3], [0, 1], clampO);
  const vy = 60 * (airOf(f - 0.5, cue) - airOf(f + 0.5, cue));
  const spread = interpolate(f, [land, land + 5], [0, 1], { ...clampO, easing: Easing.out(Easing.cubic) });
  const seamO = interpolate(f, [land, land + 2, land + 8], [1, 1, 0], clampO);
  return (
    <>
      {patchO > 0 ? <div style={{ position: 'absolute', left: r.x - 4, top: r.y - 3, width: r.w + 8, height: r.h + 6, background: bg, opacity: patchO }}>
        <div style={{ position: 'absolute', inset: 3, borderRadius: 6, border: '1px dashed rgba(86,110,93,.35)', opacity: interpolate(f, [cue - 6, cue + 4], [0.55, 1], clampO) }} />
      </div> : null}
      {f >= cue && f < land + 4 ? (
        <div style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, opacity: appear, borderRadius: 6, overflow: 'hidden', background: bg,
          transform: `perspective(900px) translateY(${(-60 * air).toFixed(2)}px) rotateX(${(16 * air).toFixed(3)}deg) scale(${scale.toFixed(4)})`,
          boxShadow: `0 ${(17 * air).toFixed(1)}px ${(32 * air).toFixed(1)}px -${(5 * air).toFixed(1)}px rgba(31,43,35,${(0.24 * air).toFixed(3)})`, filter: f < land && vy > 0.3 ? `blur(${Math.min(1.6, vy * 0.11).toFixed(2)}px)` : undefined }}>
          <Img src={staticFile(src)} style={{ position: 'absolute', left: -r.x, top: -r.y, width: 1440, height: 900, maxWidth: 'none' }} />
        </div>
      ) : null}
      {f >= land && f < land + 8 ? <div style={{ position: 'absolute', left: r.x + (r.w - r.w * spread) / 2, top: r.y + r.h - 1, width: r.w * spread, height: 1.2, borderRadius: 1,
        background: `linear-gradient(90deg, rgba(86,110,93,0), ${C.g700} 18%, ${C.g500} 50%, ${C.g700} 82%, rgba(86,110,93,0))`, boxShadow: '0 0 3px rgba(86,110,93,.45)', opacity: seamO }} /> : null}
    </>
  );
};

export const Memory: React.FC = () => {
  const f = useCurrentFrame();
  const camA = camAt(f, CAM_A);
  const camB = camAt(f, CAM_B);
  const xB = ramp(f, 112, 12, EASE.linear);
  const out = ramp(f, 198, 12, EASE.linear);
  return (
    <AbsoluteFill style={{ background: C.paper, opacity: 1 - out }}>
      {xB < 1 ? (
        <AbsoluteFill style={{ opacity: ramp(f, 0, 10, EASE.linear) }}>
          <PageCam src="tex/fs-memory.png" cam={camA}>
            {ROWS.map((y, i) => {
              const p = ramp(f, 40 + i * 14, 14, EASE.out);
              return <div key={i} style={{ position: 'absolute', left: 511, top: y - 2, width: 692 * p, height: 26, borderRadius: 4, background: C.g200, mixBlendMode: 'multiply', opacity: 0.85 }} />;
            })}
          </PageCam>
        </AbsoluteFill>
      ) : null}
      {xB > 0 ? (
        <AbsoluteFill style={{ opacity: xB }}>
          <PageCam src="tex/fs-dispatch.png" cam={camB}>
            <div style={{ position: 'absolute', left: 480, top: 276, width: 760, height: 80, background: '#fff' }} />
            <RowFlyer src="tex/fs-dispatch.png" r={REPLY} cue={MEM_CUE} />
            <div style={{ position: 'absolute', left: 663, top: 142, width: 180 * ramp(f, 146, 14, EASE.out), height: 22, borderRadius: 4, background: C.g200, mixBlendMode: 'multiply', opacity: 0.9 }} />
          </PageCam>
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 300, background: `linear-gradient(180deg, rgba(249,248,244,0), ${C.paper} 38%)` }} />
        </AbsoluteFill>
      ) : null}
      <Cap head="品牌偏好，早就存在记忆里" sub="sage 绿、暖白底、文案平实" x={168} y={846} w={1300} start={70} end={114} />
      <Cap head="这次任务直接照着做" sub="记忆每台桌面、每个 Bot 各存一份，不跨主机自动同步" x={96} y={850} w={1400} start={142} />
    </AbsoluteFill>
  );
};
