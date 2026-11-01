// 唯一时间表（30fps）。字幕、转场、验收帧都从这里派生。
export const FPS = 30;
export const SHOTS = {
  ask: { from: 0, dur: 150 },        // 0:00–0:05 任务输入
  models: { from: 150, dur: 210 },   // 0:05–0:12 已有订阅 / New API / 自定义 API
  memory: { from: 360, dur: 210 },   // 0:12–0:19 沿用记忆偏好
  route: { from: 570, dur: 210 },    // 0:19–0:26 模型路由
  make: { from: 780, dur: 180 },     // 0:26–0:32 各角色产出接成交付
  remote: { from: 960, dur: 360 },   // 0:32–0:44 SSH / Bot（真实界面、用户授权功能演示）
  site: { from: 1320, dur: 210 },    // 0:44–0:51 官网完成，简短滚动，不播放视频
  flow: { from: 1530, dur: 270 },    // 0:51–1:00 工作流 Beta
  brand: { from: 1800, dur: 150 },   // 1:00–1:05 品牌
} as const;
export const TOTAL = 1950;
export type ShotKey = keyof typeof SHOTS;
export const end = (k: ShotKey) => SHOTS[k].from + SHOTS[k].dur;
/** TaskBar（左上任务条）在 ask 降格落位后常驻，到 brand 被收进标志。 */
export const TASKBAR_IN = 144;
export const TASKBAR_OUT = SHOTS.brand.from + 6;
/** 独立成片节选（在官网播放器里播；不含播放器与官网）。 */
export const REEL_DUR = 180;
