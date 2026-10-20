// duplexd — 019 原生双工守护进程（阶段 C 产品化的桥接宿主，选型：独立进程 + stdio JSON 行协议）。
//
// 职责：独占 macOS 的采播链——同一 AVAudioEngine 上播 Hemi 的 TTS（VoiceProcessingIO
// 参考）并采集消完回声的麦克风 PCM。Electron 主进程只做控制与转发，不碰音频。
//
// 协议（stdin 命令 / stdout 事件，均为单行 JSON；PCM 为 base64 小端 int16）：
//   → {"cmd":"start"}                                        启动引擎并开始采集
//   → {"cmd":"play","pcm":"<b64 24k mono i16>"}              入队一段 TTS
//   → {"cmd":"stopPlay"}                                     停播清队（打断）
//   → {"cmd":"volume","gain":0.25}                           播放增益（duck 用，块间渐变）
//   → {"cmd":"shutdown"}                                     退出进程
//   ← {"event":"ready"}                                      引擎已跑、采集开始
//   ← {"event":"cap","pcm":"<b64 16k mono i16>","ms":21.3}   处理后麦克风 PCM（消回声后）
//   ← {"event":"drained"}                                    队列全部播完（自然播完）
//   ← {"event":"underrun"}                                   断流（队列空了才来新块）
//   ← {"event":"fault","error":"..."}                        命令/引擎级故障
//   ← {"event":"bye"}                                        stdin 关闭或 shutdown 后正常退出前
//
// 实现沿用 poc/vpio-duplex 的结论：VPIO 输出节点必须 player 直连（立体声 48k，
// 过 mainMixer 会 -10875）；VPIO 输入 7ch 由引擎转成单声道 tap；主线程 RunLoop
// 自旋服务引擎与命令（stdin 线程收到命令后 sync 到主线程执行）。

import AVFAudio
import Foundation

let CAPTURE_RATE = 16_000.0
let PLAY_IN_RATE = 24_000.0
let ENGINE_RATE = 48_000.0

let outLock = NSLock()

func emit(_ dict: [String: Any]) {
  outLock.lock()
  defer { outLock.unlock() }
  guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

/// AVAudioPCMBuffer 没有深拷贝 API：tap 回调里复制一份，转后台队列再转码，
/// 不在音频线程上做 base64/序列化。
func deepCopy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
  guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameCapacity) else { return nil }
  copy.frameLength = buffer.frameLength
  let channels = Int(buffer.format.channelCount)
  let frames = Int(buffer.frameLength)
  for channel in 0..<channels {
    guard let source = buffer.floatChannelData?[channel],
          let target = copy.floatChannelData?[channel] else { continue }
    memcpy(target, source, frames * MemoryLayout<Float>.size)
  }
  return copy
}

// ---- 引擎与节点 ----

let engine = AVAudioEngine()
let input = engine.inputNode
let output = engine.outputNode
let player = AVAudioPlayerNode()

var engineRunning = false

// 播放队列状态（player 串行调度保序；completion 计数判定 drained）。
let playLock = NSLock()
var pendingBuffers = 0
var playedAnything = false
/** stopPlay 之后为 true：在途 completion 一律丢弃，drained 不再上报。 */
var stopped = false
var currentGain = 1.0
var targetGain = 1.0

let playFormat = AVAudioFormat(standardFormatWithSampleRate: ENGINE_RATE, channels: 2)!

/// 增益子块：把入队 PCM 切成 ~20ms 小块分别排程，增益渐变以子块为粒度——
/// volume 命令最迟 20ms 后生效，duck 手感对齐渲染层旧链路的 15ms 渐变。
/// completion 只挂在每条命令的最后一个子块上，drained 语义保持「整条命令播完」。
let GAIN_PIECE_MS = 20.0
let gainPieceSamples = Int(PLAY_IN_RATE * GAIN_PIECE_MS / 1000.0)

func schedulePcm(_ pcm: Data) {
  let samplesIn = pcm.count / 2
  guard samplesIn > 0 else { return }
  let source = pcm.withUnsafeBytes { pointer -> [Int16] in
    Array(pointer.bindMemory(to: Int16.self))
  }
  let pieces = (samplesIn + gainPieceSamples - 1) / gainPieceSamples
  for piece in 0..<pieces {
    let start = piece * gainPieceSamples
    let end = min(samplesIn, start + gainPieceSamples)
    let frames = (end - start) * 2
    let frameCapacity = AVAudioFrameCount(frames)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: frameCapacity) else { continue }
    buffer.frameLength = frameCapacity
    playLock.lock()
    let startGain = currentGain
    let endGain = targetGain
    currentGain = targetGain
    playLock.unlock()
    for channel in 0..<2 {
      guard let data = buffer.floatChannelData?[channel] else { continue }
      for frame in 0..<frames {
        let sourceIndex = start + frame / 2
        var sample = Float(source[sourceIndex]) / 32768.0
        if frame % 2 == 1 && sourceIndex + 1 < end {
          sample = (sample + Float(source[sourceIndex + 1]) / 32768.0) / 2
        }
        let t = Double(frame) / Double(frames)
        data[frame] = sample * Float(startGain + (endGain - startGain) * t)
      }
    }
    let isLast = piece == pieces - 1
    player.scheduleBuffer(buffer, completionCallbackType: .dataConsumed) { _ in
      guard isLast else { return }
      playLock.lock()
      let dropped = stopped
      if !dropped { pendingBuffers -= 1 }
      let drainedNow = !dropped && pendingBuffers == 0
      playLock.unlock()
      if drainedNow {
        emit(["event": "drained"])
      }
    }
  }
}

func handlePlay(_ pcmBase64: String) {
  guard let pcm = Data(base64Encoded: pcmBase64), pcm.count >= 2 else {
    emit(["event": "fault", "error": "play chunk undecodable"])
    return
  }
  playLock.lock()
  stopped = false
  if playedAnything && pendingBuffers == 0 {
    emit(["event": "underrun"])
  }
  playedAnything = true
  pendingBuffers += 1
  playLock.unlock()
  schedulePcm(pcm)
}

func handleStopPlay() {
  playLock.lock()
  pendingBuffers = 0
  playedAnything = false
  stopped = true
  playLock.unlock()
  player.stop()
  // stop() 会重置节点，之后 scheduleBuffer 不发声（2026-09-21 审核实证）——
  // 立即重新 play()：空队列下无声，但下一次 play 命令能正常出声并汇报 drained。
  player.play()
}

// 48k float 单声道 tap → 16k i16（3:1 均值降采样，与渲染层 downsampleToPcm16 同法）。
func handleCapture(_ buffer: AVAudioPCMBuffer) {
  guard let channel = buffer.floatChannelData?[0] else { return }
  let frameCount = Int(buffer.frameLength)
  let ratio = Int(ENGINE_RATE / CAPTURE_RATE)
  let outputCount = max(1, frameCount / ratio)
  var pcm = Data(count: outputCount * 2)
  pcm.withUnsafeMutableBytes { pointer in
    let samples = pointer.bindMemory(to: Int16.self)
    for index in 0..<outputCount {
      let start = index * ratio
      let end = min(frameCount, start + ratio)
      var sum = 0.0
      for position in start..<end { sum += Double(channel[position]) }
      let value = max(-1.0, min(1.0, sum / Double(max(1, end - start))))
      samples[index] = value < 0 ? Int16(value * 32768.0) : Int16(value * 32767.0)
    }
  }
  let ms = Double(outputCount) / CAPTURE_RATE * 1000.0
  emit(["event": "cap", "pcm": pcm.base64EncodedString(), "ms": (ms * 10).rounded() / 10])
}

func startEngine() {
  if engineRunning {
    emit(["event": "ready", "note": "already-running"])
    return
  }
  do {
    try input.setVoiceProcessingEnabled(true)
  } catch {
    emit(["event": "fault", "error": "voice processing enable failed: \(error)"])
    exit(1)
  }
  engine.attach(player)
  engine.connect(player, to: output, format: playFormat)

  let tapFormat = AVAudioFormat(standardFormatWithSampleRate: ENGINE_RATE, channels: 1)!
  let tapQueue = DispatchQueue(label: "duplexd.tap")
  input.installTap(onBus: 0, bufferSize: 1024, format: tapFormat) { buffer, _ in
    guard let copy = deepCopy(buffer) else { return }
    tapQueue.async { handleCapture(copy) }
  }

  engine.prepare()
  do {
    try engine.start()
  } catch {
    emit(["event": "fault", "error": "engine start failed: \(error)"])
    exit(1)
  }
  player.play()
  engineRunning = true
  emit([
    "event": "ready",
    "inFormat": "\(input.outputFormat(forBus: 0).sampleRate)Hz/\(input.outputFormat(forBus: 0).channelCount)ch",
    "outFormat": "\(output.outputFormat(forBus: 0).sampleRate)Hz/\(output.outputFormat(forBus: 0).channelCount)ch",
  ])
}

// ---- stdin 行协议（readabilityHandler 在后台队列回调；引擎操作 sync 到主线程） ----

let mainQueue = DispatchQueue.main
var lineBuffer = Data()

func dispatchLine(_ line: String) {
  guard let data = line.data(using: .utf8),
        let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let cmd = command["cmd"] as? String else {
    emit(["event": "fault", "error": "undecodable command line"])
    return
  }
  mainQueue.sync {
    switch cmd {
    case "start":
      startEngine()
    case "play":
      handlePlay(command["pcm"] as? String ?? "")
    case "stopPlay":
      handleStopPlay()
    case "volume":
      if let gain = command["gain"] as? Double {
        playLock.lock()
        targetGain = max(0.0, min(1.0, gain))
        playLock.unlock()
      }
    case "shutdown":
      emit(["event": "bye"])
      engine.stop()
      exit(0)
    default:
      emit(["event": "fault", "error": "unknown command \(cmd)"])
    }
  }
}

FileHandle.standardInput.readabilityHandler = { handle in
  let data = handle.availableData
  if data.isEmpty {
    // 上游关流：按 shutdown 处理，绝不留一个不出声不采样的引擎。
    emit(["event": "bye"])
    exit(0)
  }
  lineBuffer.append(data)
  while let newline = lineBuffer.firstIndex(of: UInt8(0x0A)) {
    let lineData = lineBuffer[lineBuffer.startIndex..<newline]
    lineBuffer.removeSubrange(lineBuffer.startIndex...newline)
    if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
      dispatchLine(line)
    }
  }
}

signal(SIGTERM) { _ in exit(0) }

// 主线程 RunLoop 自旋（服务引擎回调与 main queue 命令），生命周期由 stdin/信号终止。
while true {
  RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
}
