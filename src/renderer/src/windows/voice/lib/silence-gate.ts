/**
 * RMS voice gate, used by call mode only.
 *
 * A call keeps one provider session open for minutes at a time, and the
 * provider bills by audio duration — so without a gate every silent second is
 * streamed upstream and paid for. The gate drops silence while protecting the
 * two things that actually hurt recognition quality:
 *
 *  - a pre-roll ring buffer, so the leading syllable of the first word after a
 *    pause is still delivered;
 *  - a hangover window, so a short pause inside a sentence does not split one
 *    utterance into two.
 *
 * Levels are RMS in dBFS (0 dBFS = digital full scale), which is all a browser
 * can measure — absolute SPL is unavailable, and the microphone's own
 * processing matters more than the room. Measured on one machine, same room,
 * same minute:
 *
 *   AGC + NS + AEC (what the app requests)  → −29 dBFS median over silence
 *   AGC only                                → −42 dBFS median
 *   raw microphone                          → −39 dBFS median
 *
 * A fixed threshold would therefore have to be wrong for someone. The threshold
 * is derived from the room instead, and three details make that work:
 *
 *  1. The floor is the *median* of quiet frames seen while the gate is closed, not a
 *     minimum. A minimum is dragged down by one processing dip and then sits
 *     ~25 dB below the real floor, which makes every room tone look like
 *     speech — a gate that opens two seconds into a call and never closes.
 *  2. Judge opening before adapting the floor. Only frames whose instantaneous
 *     and smoothed levels are below the closing threshold feed it: a closed
 *     gate alone does not mean the user is silent.
 *  3. The calibration window seeds the floor from the *upper* edge of the
 *     ambient (p80), which is where the threshold has to clear, rather than
 *     from the average, which peaks sail straight over.
 *
 * The absolute clamps are the safety net: the threshold can never ask for more
 * than `maxOpenThresholdDb`, so even a room the estimator misjudges cannot mute
 * normal speech.
 */

export type SilenceGateConfig = {
  /** Stream everything for this long after connecting, before gating starts. */
  calibrationMs: number;
  /** Voice must clear the noise floor by this much before the gate opens. */
  openMarginDb: number;
  /** Never treat anything quieter than this as voice, whatever the floor says. */
  minOpenThresholdDb: number;
  /**
   * Ceiling for the threshold. Keep this just above the loudest ambient peaks
   * measured in a working room, or quiet speech starts getting cut.
   */
  maxOpenThresholdDb: number;
  /**
   * The gate closes below `threshold - hysteresis`. Keep it small: room noise
   * fluctuates over several dB, so a wide gap leaves the level parked between
   * the two thresholds and the gate never closes at all.
   */
  closeHysteresisDb: number;
  /**
   * Time constant of the smoothed level used for the *closing* decision. The
   * instantaneous level opens the gate, because opening early is free (the
   * pre-roll replays it), but closing is judged on a smoothed level so that
   * noise fluctuation cannot hold the gate open forever.
   */
  levelSmoothingMs: number;
  /** Keep streaming this long after the level drops, so pauses do not split words. */
  hangoverMs: number;
  /** Gate closure must still deliver enough silence for ASR's 800ms endpoint
   * window plus its 200ms upload batching. Wall-clock silence is not audio. */
  endpointSilenceMs: number;
  /** Audio retained before the gate opens. */
  preRollMs: number;
  /** Retain speech throughout the local duck/interrupt confirmation window. */
  interruptionPreRollMs: number;
  /** Cadence for a silent frame that stops the provider socket from idling out. */
  keepAliveMs: number;
  /** How much qualified quiet history the floor median is taken from. */
  noiseFloorWindowMs: number;
  /** Percentile of that history used as the floor. */
  noiseFloorPercentile: number;
  /** Percentile of the calibration samples used to seed the floor. */
  calibrationPercentile: number;
  /** Floor assumed before any level has been measured. */
  noiseFloorInitialDb: number;
  /**
   * Consecutive frames that must clear the threshold before opening. Two frames
   * is ~170 ms, which costs nothing because the pre-roll still delivers them,
   * and it rejects the isolated peaks that room noise produces.
   */
  openRunFrames: number;
};

export const DEFAULT_SILENCE_GATE_CONFIG: SilenceGateConfig = {
  calibrationMs: 800,
  openMarginDb: 6,
  minOpenThresholdDb: -52,
  // Startup speech can contaminate calibration. Favor uploading extra ambient
  // audio over treating a normal/soft utterance as silence (-18 lost words).
  maxOpenThresholdDb: -36,
  closeHysteresisDb: 3,
  levelSmoothingMs: 200,
  hangoverMs: 700,
  endpointSilenceMs: 1200,
  preRollMs: 320,
  interruptionPreRollMs: 1000,
  keepAliveMs: 8000,
  noiseFloorWindowMs: 20000,
  noiseFloorPercentile: 0.5,
  calibrationPercentile: 0.8,
  noiseFloorInitialDb: -60,
  openRunFrames: 2,
};

/** ≈ -140 dBFS, low enough to mean silence and finite for `Math.log10`. */
const MIN_RMS = 1e-7;

/** How often the percentile is recomputed, rather than on every frame. */
const FLOOR_REFRESH_MS = 250;

export function rootMeanSquare(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / samples.length);
}

export function toDecibels(rms: number): number {
  return 20 * Math.log10(Math.max(rms, MIN_RMS));
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * fraction)),
  );
  return sorted[index];
}

export type SilenceGateStatus = {
  calibrating: boolean;
  open: boolean;
  levelDb: number;
  smoothedDb: number;
  noiseFloorDb: number;
  thresholdDb: number;
  floorFrames: number;
  skippedMs: number;
  sentFrames: number;
  droppedFrames: number;
  opens: number;
  /**
   * 闭门期间已连续过阈、还差几帧就开门的帧数。播报期间（barge-in）它就是
   * 「有人正在说话」的最早信号：第一帧过阈先压低播报音量（duck），
   * 攒满 openRunFrames 开门即为确认打断。
   */
  pendingOpenFrames: number;
};

type PreRollFrame = {
  data: ArrayBuffer;
  durationMs: number;
};

export class SilenceGate {
  private readonly config: SilenceGateConfig;

  private firstFrameAtMs: number | null = null;
  private calibrated = false;
  private calibrationSamples: number[] = [];

  /** Qualified quiet frame levels, oldest first, trimmed to the window. */
  private history: { at: number; db: number }[] = [];
  private floorDb: number;
  private floorComputedAtMs = -Infinity;

  private open = false;
  private runAbove = 0;
  private lastVoiceAtMs: number | null = null;
  private lastKeepAliveAtMs: number | null = null;

  private preRoll: PreRollFrame[] = [];
  private preRollMs = 0;

  private levelDb = toDecibels(0);
  private smoothedDb = toDecibels(0);
  private skippedMs = 0;
  private sentFrames = 0;
  private droppedFrames = 0;
  private opens = 0;
  private endpointRemainingMs = 0;
  private mutedFrames: PreRollFrame[] = [];
  private mutedMs = 0;
  private upstreamMuted = false;

  /**
   * 播报期间的「上行压制」开关（003 barge-in）：门照常判定（预缓冲、
   * keepalive、噪声地板照常运转），音频先保留在本地，确认打断后一次补发。
   */
  get muted(): boolean { return this.upstreamMuted; }

  set muted(value: boolean) {
    if (value === this.upstreamMuted) return;
    this.upstreamMuted = value;
    this.mutedFrames = [];
    this.mutedMs = 0;
    // 播报结束不能把缓存里的扬声器回声带到下一句。
    this.preRoll = [];
    this.preRollMs = 0;
    this.endpointRemainingMs = 0;
  }

  releaseInterruption(): ArrayBuffer[] {
    const frames = this.mutedFrames.map((frame) => frame.data);
    this.muted = false;
    this.sentFrames += frames.length;
    return frames;
  }

  constructor(config: Partial<SilenceGateConfig> = {}) {
    this.config = { ...DEFAULT_SILENCE_GATE_CONFIG, ...config };
    this.floorDb = this.config.noiseFloorInitialDb;
  }

  get status(): SilenceGateStatus {
    return {
      calibrating: this.calibrating,
      open: this.open,
      levelDb: this.levelDb,
      smoothedDb: this.smoothedDb,
      noiseFloorDb: this.floorDb,
      thresholdDb: this.thresholdDb,
      floorFrames: this.history.length,
      skippedMs: this.skippedMs,
      sentFrames: this.sentFrames,
      droppedFrames: this.droppedFrames,
      opens: this.opens,
      pendingOpenFrames: this.runAbove,
    };
  }

  get calibrating(): boolean {
    return !this.calibrated;
  }

  /** True while upstream should be receiving audio (calibration streams too). */
  get isListening(): boolean {
    return this.calibrating || this.open;
  }

  get thresholdDb(): number {
    const raw = this.floorDb + this.config.openMarginDb;
    return Math.min(
      Math.max(raw, this.config.minOpenThresholdDb),
      this.config.maxOpenThresholdDb,
    );
  }

  /**
   * Feeds one captured block and returns the buffers that must be forwarded
   * upstream. An empty array means the block was silence and was dropped.
   */
  process(
    data: ArrayBuffer,
    rms: number,
    frameMs: number,
    nowMs: number,
  ): ArrayBuffer[] {
    const sentBefore = this.sentFrames;
    const frames = this.processFrame(data, rms, frameMs, nowMs);
    if (!this.muted) return frames;
    this.mutedFrames.push({ data, durationMs: frameMs });
    this.mutedMs += frameMs;
    while (this.mutedMs > this.config.interruptionPreRollMs && this.mutedFrames.length > 1) {
      this.mutedMs -= this.mutedFrames.shift()!.durationMs;
    }
    this.sentFrames = sentBefore;
    return [];
  }

  private processFrame(data: ArrayBuffer, rms: number, frameMs: number, nowMs: number): ArrayBuffer[] {
    const levelDb = toDecibels(rms);
    this.levelDb = levelDb;
    if (this.firstFrameAtMs === null) {
      this.firstFrameAtMs = nowMs;
      this.smoothedDb = levelDb;
    } else {
      // Update on every frame, including while open. Otherwise the closing
      // decision sees the initial -140 dBFS forever and shuts after hangoverMs.
      const alpha = this.config.levelSmoothingMs > 0
        ? 1 - Math.exp(-frameMs / this.config.levelSmoothingMs)
        : 1;
      this.smoothedDb += alpha * (levelDb - this.smoothedDb);
    }

    if (this.calibrating) {
      this.calibrationSamples.push(levelDb);
      if (nowMs - this.firstFrameAtMs >= this.config.calibrationMs) {
        this.finishCalibration(nowMs);
      }
      // Stream everything while calibrating: the user may start talking the
      // instant the call connects, and those first words must not be dropped.
      this.sentFrames += 1;
      return [data];
    }

    if (this.open) return this.handleOpenFrame(data, frameMs, nowMs);

    // Use the existing threshold to classify this frame. Learning from it
    // first can turn the beginning of an utterance into its own noise floor.
    const thresholdDb = this.thresholdDb;
    if (levelDb >= thresholdDb) {
      // Require a short run of loud frames: room noise throws isolated peaks,
      // and the pre-roll replays the run when it turns out to be voice.
      this.runAbove += 1;
      if (this.runAbove >= this.config.openRunFrames) {
        this.open = true;
        this.opens += 1;
        this.runAbove = 0;
        this.lastVoiceAtMs = nowMs;
        this.endpointRemainingMs = 0;

        // Flush the pre-roll so the first syllable of the utterance survives.
        const flushed = this.preRoll.map((frame) => frame.data);
        this.preRoll = [];
        this.preRollMs = 0;

        const frames = [...flushed, data];
        this.sentFrames += frames.length;
        return frames;
      }
    } else {
      this.runAbove = 0;
      const quietThresholdDb = thresholdDb - this.config.closeHysteresisDb;
      // 019：播报压制期间不采地板样本。外放回声的帧间低谷会把地板中位数越拖
      // 越低（安静房间实测一路钳到 -52 下限），门限跟着失守、回声逐帧过阈——
      // 底噪估计只属于「没人替我们出声」的时段。
      if (!this.muted && levelDb < quietThresholdDb && this.smoothedDb < quietThresholdDb) {
        this.observeLevel(levelDb, nowMs);
      }
    }

    return this.withhold(data, frameMs, nowMs);
  }

  private handleOpenFrame(
    data: ArrayBuffer,
    frameMs: number,
    nowMs: number,
  ): ArrayBuffer[] {
    if (this.smoothedDb >= this.thresholdDb - this.config.closeHysteresisDb) {
      this.lastVoiceAtMs = nowMs;
      // 压制中的开门帧同样不上送：Hemi 的声音（或其残余回声）不该进云端。
      this.sentFrames += 1;
      return this.muted ? [] : [data];
    }

    // Level dropped: keep streaming through the hangover window so a short
    // pause between words does not cut the utterance in half.
    if (
      this.lastVoiceAtMs !== null &&
      nowMs - this.lastVoiceAtMs < this.config.hangoverMs
    ) {
      this.sentFrames += 1;
      return this.muted ? [] : [data];
    }

    this.open = false;
    this.runAbove = 0;
    this.lastVoiceAtMs = null;
    this.lastKeepAliveAtMs = nowMs;
    this.endpointRemainingMs = this.config.endpointSilenceMs;
    return this.withhold(data, frameMs, nowMs);
  }

  private withhold(
    data: ArrayBuffer,
    frameMs: number,
    nowMs: number,
  ): ArrayBuffer[] {
    this.bufferPreRoll(data, frameMs);
    this.droppedFrames += 1;
    this.skippedMs += frameMs;

    if (!this.muted && this.endpointRemainingMs > 0) {
      this.endpointRemainingMs = Math.max(0, this.endpointRemainingMs - frameMs);
      this.lastKeepAliveAtMs = nowMs;
      this.sentFrames += 1;
      this.skippedMs -= frameMs;
      this.droppedFrames -= 1;
      return [new ArrayBuffer(data.byteLength)];
    }

    if (
      !this.muted &&
      (this.lastKeepAliveAtMs === null ||
        nowMs - this.lastKeepAliveAtMs >= this.config.keepAliveMs)
    ) {
      this.lastKeepAliveAtMs = nowMs;
      // One silent frame on a slow cadence keeps the provider session from
      // idling out during a long quiet stretch, without reopening the gate.
      this.sentFrames += 1;
      return [new ArrayBuffer(data.byteLength)];
    }

    return [];
  }

  private bufferPreRoll(data: ArrayBuffer, frameMs: number) {
    this.preRoll.push({ data, durationMs: frameMs });
    this.preRollMs += frameMs;

    while (this.preRollMs > this.config.preRollMs && this.preRoll.length > 1) {
      const removed = this.preRoll.shift();
      if (removed) this.preRollMs -= removed.durationMs;
    }
  }

  /**
   * Records a qualified quiet level. Opening candidates and levels near the
   * threshold are excluded by the caller, even when the gate is still closed.
   */
  private observeLevel(levelDb: number, nowMs: number) {
    this.history.push({ at: nowMs, db: levelDb });

    const cutoff = nowMs - this.config.noiseFloorWindowMs;
    while (this.history.length && this.history[0].at < cutoff) this.history.shift();

    if (nowMs - this.floorComputedAtMs < FLOOR_REFRESH_MS) return;
    this.floorComputedAtMs = nowMs;

    this.floorDb = percentile(
      this.history.map((entry) => entry.db),
      this.config.noiseFloorPercentile,
    );
  }

  private finishCalibration(nowMs: number) {
    this.calibrated = true;

    // Seed from the upper edge of the ambient, because that is what the
    // threshold has to clear; a quieter seed makes peaks open the gate.
    if (this.calibrationSamples.length) {
      this.floorDb = percentile(
        this.calibrationSamples,
        this.config.calibrationPercentile,
      );
    }

    this.calibrationSamples = [];
    this.history = [];
    this.floorComputedAtMs = nowMs;
    // 校准期间用户可能已开口。保留开门与尾音，不能在边界突然切断第一句。
    this.open = this.smoothedDb >= this.thresholdDb - this.config.closeHysteresisDb;
    if (this.open) this.opens += 1;
    this.lastVoiceAtMs = this.open ? nowMs : null;
    this.endpointRemainingMs = this.open ? 0 : this.config.endpointSilenceMs;
  }
}
