/** Real renderer regression with mocked devices and services; no user profile
 * or microphone is opened. Build first, then run with Electron. */
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep cleanup in charge of exit status when the hidden test window closes.
app.on('window-all-closed', () => {});

function installMocks() {
  const listeners = new Map();
  const state = window.voiceTest = { chats: [], speeches: [], cancels: [], audio: 0, sources: [], logs: [], ui: {}, requests: new Map() };
  state.emit = (name, event) => { for (const listener of listeners.get(name) ?? []) listener(event); };
  const config = { hasApiKey: true, resourceId: 'mock', endpoint: 'mock', model: 'mock', ttsEnabled: true, ttsVoice: 'mock', ttsResourceId: 'mock' };
  window.hemiVoice = new Proxy({
    platform: 'darwin',
    getConfig: async () => config,
    getTextModelConfig: async () => config,
    getTtsConfig: async () => config,
    getUiPreferences: async () => ({ floatingOrbEnabled: false, primarySpeakerEnabled: false }),
    getPermissionPreferences: async () => ({ mode: 'confirm' }),
    getMicrophonePermissionStatus: async () => 'granted',
    getContextState: async () => ({ objects: [] }),
    getTaskState: async () => null,
    getLastConversation: async () => null,
    listConversations: async () => ({ sessions: [], storageError: null }),
    getWorkspaceState: async () => ({
      default: { id: 'default', type: 'default', name: '默认空间', dir: '/tmp/hemi-voice-flow-workspace', status: 'ok' },
      projects: [],
    }),
    listModelProfiles: async () => ({ version: 2, defaultModelId: null, providers: [] }),
    getOnboardingState: async () => ({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'granted', asrSaved: true, modelComplete: true }),
    startAsr: async () => { state.emit('onAsrEvent', { type: 'session.started' }); return { ok: true }; },
    stopAsr: async () => {
      // Flush provider events after release, just like the real IPC stop call.
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const event of state.stopEvents ?? []) state.emit('onAsrEvent', event);
      state.stopEvents = [];
      state.emit('onAsrEvent', { type: 'session.ended' });
      return { ok: true };
    },
    sendAudio: () => { state.audio++; },
    chatTextModel: async (request) => { state.chats.push(request); return { text: `回应 ${state.chats.length}` }; },
    speakTts: (request) => {
      state.speeches.push(request);
      return new Promise((resolve) => state.requests.set(request.turnId, resolve));
    },
    cancelTts: (turnId) => state.cancels.push(turnId),
    publishUiState: (ui) => { state.ui = ui; },
    logLine: (line) => state.logs.push(line),
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (String(key).startsWith('on')) return (listener) => {
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key).add(listener);
        return () => listeners.get(key).delete(listener);
      };
      return async () => ({});
    },
  });
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({
    getTracks: () => [{ stop() {} }],
    getAudioTracks: () => [{ getSettings: () => ({}), getCapabilities: () => ({}) }],
  }) } });
  class FakeAudioContext {
    sampleRate = 48000;
    currentTime = 0;
    destination = {};
    constructor(options) { this.sampleRate = options?.sampleRate ?? 48000; }
    createAnalyser() { return { getByteTimeDomainData: (data) => data.fill(128), connect() {} }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      return state.processor = { connect() {}, disconnect() {}, onaudioprocess: null };
    }
    createGain() { return { gain: { value: 1, cancelAndHoldAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createBuffer(_channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    createBufferSource() {
      const source = { connect() {}, start() {}, stop() {}, onended: null };
      state.sources.push(source);
      return source;
    }
    async resume() {}
    async close() {}
  }
  window.AudioContext = FakeAudioContext;
  state.feed = (level) => state.processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(level) } });
}

async function main() {
  const scratch = await mkdtemp(path.join(tmpdir(), 'hemi-voice-flow-'));
  await mkdir(path.join(scratch, 'profile'));
  await mkdir(path.join(scratch, 'session'));
  app.setPath('userData', path.join(scratch, 'profile'));
  app.setPath('sessionData', path.join(scratch, 'session'));
  let testWindow;
  const errors = [];
  let exitCode = 1;
  try {
    const preload = path.join(scratch, 'preload.cjs');
    await writeFile(preload, `(${installMocks.toString()})();`);
    await app.whenReady();
    testWindow = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { preload, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    testWindow.webContents.on('console-message', (_event, details, legacyMessage) => {
      if (details?.level === 'error' || details === 3) errors.push(details?.message ?? legacyMessage);
    });
    await testWindow.loadFile(fileURLToPath(new URL('../dist-renderer/index.html', import.meta.url)));
    const evaluate = (fn) => testWindow.webContents.executeJavaScript(`(${fn.toString()})()`);
    const playerSource = ts.transpileModule(
      await readFile(new URL('../src/renderer/src/windows/voice/lib/tts-player.ts', import.meta.url), 'utf8'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
    ).outputText.replace('export class TtsPlayer', 'class TtsPlayer');
    await testWindow.webContents.executeJavaScript(playerSource + '\nwindow.ProbeTtsPlayer = TtsPlayer; void 0;');
    // Use Chromium's real audio renderer: a mock AudioParam cannot reveal
    // clicks from missing ramp anchors or per-source resampling boundaries.
    const audioResult = await evaluate(async () => {
      const pcm = Int16Array.from({ length: 19000 }, (_, i) => Math.round(10000 * Math.sin(i / 13)));
      const contiguous = new OfflineAudioContext(1, 24000, 24000);
      const chunked = new OfflineAudioContext(1, 24000, 24000);
      new window.ProbeTtsPlayer(contiguous).enqueue(pcm.buffer);
      const player = new window.ProbeTtsPlayer(chunked);
      for (let i = 0; i < pcm.length; i += 731) player.enqueue(pcm.slice(i, i + 731).buffer);
      const a = (await contiguous.startRendering()).getChannelData(0);
      const b = (await chunked.startRendering()).getChannelData(0);
      let maxDifference = 0;
      for (let i = 0; i < a.length; i++) maxDifference = Math.max(maxDifference, Math.abs(a[i] - b[i]));

      const ctx = new OfflineAudioContext(1, 24000, 24000);
      const duckPlayer = new window.ProbeTtsPlayer(ctx);
      duckPlayer.enqueue(new Int16Array(19000).fill(10000).buffer);
      const pauses = [0.4, 0.408, 0.6].map((time) => ctx.suspend(time));
      const rendering = ctx.startRendering();
      for (let i = 0; i < pauses.length; i++) {
        await pauses[i];
        duckPlayer.setVolume([0.25, 1, 0.25][i]);
        await ctx.resume();
      }
      const samples = (await rendering).getChannelData(0);
      let maxStep = 0;
      for (let i = 8000; i < 17000; i++) maxStep = Math.max(maxStep, Math.abs(samples[i] - samples[i - 1]));
      return { maxDifference, maxStep };
    });
    assert.ok(audioResult.maxDifference < 0.00001, 'PCM chunk boundaries introduce noise');
    assert.ok(audioResult.maxStep < 0.001, 'volume changes introduce clicks');
    console.log('PASS: real Web Audio chunk continuity and overlapping volume ramps', JSON.stringify(audioResult));
    const waitFor = async (fn, label) => {
      const deadline = Date.now() + 9000;
      do {
        if (await evaluate(fn)) return;
        await new Promise((resolve) => setTimeout(resolve, 40));
      } while (Date.now() < deadline);
      throw new Error(`${label}: ${JSON.stringify(await evaluate(() => ({ ui: voiceTest.ui, logs: voiceTest.logs.slice(-10) })))}`);
    };
    await waitFor(() => voiceTest.logs.some((line) => line.includes('启动完成')), 'bootstrap');
    await evaluate(() => voiceTest.emit('onFloatingOrbCommand', 'toggle-call'));
    await waitFor(() => voiceTest.ui.sessionState === 'listening', 'call connects');
    assert.equal(await evaluate(() => { voiceTest.feed(0.01); return voiceTest.audio; }), 1,
      'first capture frame must upload without waiting for the probe');
    await evaluate(() => {
      setInterval(() => { if (voiceTest.processor?.onaudioprocess) voiceTest.feed(0.0001); }, 85);
      voiceTest.emit('onAsrEvent', { type: 'transcript.final', text: '你好', utteranceId: 's1:0' });
    });
    await waitFor(() => voiceTest.speeches.length === 1, 'first reply');
    await evaluate(() => voiceTest.emit('onAsrEvent', { type: 'transcript.final', text: '继续说', utteranceId: 's1:1000' }));
    await waitFor(() => voiceTest.speeches.length === 2, 'new final during speech triggers the next turn');

    // The previous handshake fails after its replacement has already started.
    await evaluate(() => {
      const [old, current] = voiceTest.speeches;
      voiceTest.requests.get(old.turnId)({ ok: false, message: 'old request cancelled' });
      voiceTest.requests.get(current.turnId)({ ok: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const newSpeech = await evaluate(() => {
      const current = voiceTest.speeches.at(-1);
      voiceTest.emit('onTtsAudio', { turnId: current.turnId, seq: 1, audio: new Int16Array([0, 100, -100, 0]).buffer });
      return { ttsActive: voiceTest.ui.ttsActive, sources: voiceTest.sources.length, error: voiceTest.ui.errorText };
    });
    assert.equal(newSpeech.ttsActive, true);
    assert.equal(newSpeech.sources, 1, 'new speech accepts audio after the old request fails');
    assert.equal(newSpeech.error, '');

    // A successful synthesis without audio must release speaking and report why.
    await evaluate(() => voiceTest.emit('onAsrEvent', { type: 'transcript.final', text: '再来一句', utteranceId: 's1:2000' }));
    await waitFor(() => voiceTest.speeches.length === 3, 'third reply');
    await evaluate(() => {
      const current = voiceTest.speeches.at(-1);
      voiceTest.requests.get(current.turnId)({ ok: true });
      voiceTest.emit('onTtsState', { turnId: current.turnId, phase: 'finished' });
    });
    await waitFor(() => !voiceTest.ui.ttsActive && voiceTest.ui.errorText.includes('没有返回音频'), 'empty synthesis releases speaking');
    await evaluate(() => voiceTest.emit('onAsrEvent', { type: 'transcript.final', text: '还能听见吗', utteranceId: 's1:3000' }));
    await waitFor(() => voiceTest.speeches.length === 4, 'next turn recovers after empty audio');
    await evaluate(() => voiceTest.emit('onFloatingOrbCommand', 'toggle-call'));
    await waitFor(() => !voiceTest.ui.callActive, 'call ends');
    await evaluate(() => {
      const current = voiceTest.speeches.at(-1);
      voiceTest.requests.get(current.turnId)({ ok: true });
      voiceTest.emit('onTtsState', { turnId: current.turnId, phase: 'finished' });
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const ended = await evaluate(() => voiceTest.ui);
    assert.equal(ended.ttsActive, false);
    assert.equal(ended.turnPhase, 'idle');
    assert.deepEqual(errors, []);
    console.log('PASS: first-frame capture, four consecutive turns, final during speech, stale TTS failure, empty-audio recovery, hangup during handshake');

    // A fresh real page reproduces the reported hold-to-talk screenshot.
    await testWindow.loadFile(fileURLToPath(new URL('../dist-renderer/index.html', import.meta.url)));
    await waitFor(() => voiceTest.logs.some((line) => line.includes('启动完成')), 'hold bootstrap');
    await evaluate(() => voiceTest.emit('onFloatingOrbCommand', 'hold-start'));
    await waitFor(() => voiceTest.ui.sessionState === 'listening', 'hold connects');
    await evaluate(() => {
      const partial = { type: 'transcript.partial', text: '今天天气怎么样了', utterances: [{ text: '今天天气怎么样了', utteranceId: 'hold:0' }] };
      voiceTest.emit('onAsrEvent', partial);
      voiceTest.stopEvents = [partial, { type: 'transcript.final', text: '今天天气怎么样呢？', utteranceId: 'hold:0' }];
    });
    await waitFor(() => document.querySelector('.h24-user-bubble.is-interim')?.textContent === '今天天气怎么样了', 'interim row is visible while holding');
    await evaluate(() => voiceTest.emit('onFloatingOrbCommand', 'hold-end'));
    await waitFor(() => voiceTest.speeches.length === 1, 'hold release submits final');
    await waitFor(() => !document.querySelector('.h24-user-bubble.is-interim'), 'final correction removes duplicate interim row');
    const holdText = await evaluate(() => document.body.innerText);
    assert.ok(holdText.includes('今天天气怎么样呢？'));
    assert.ok(!holdText.includes('今天天气怎么样了'));
    assert.equal(await evaluate(() => voiceTest.chats.length), 1, 'one utterance submits only once');
    await waitFor(() => [...document.querySelectorAll('.chat-turn')].every((row) => Number(getComputedStyle(row).opacity) === 1), 'chat entry animation finishes');
    const shotPath = fileURLToPath(new URL('../outputs/voice-interim-fixed.png', import.meta.url));
    await mkdir(path.dirname(shotPath), { recursive: true });
    await writeFile(shotPath, (await testWindow.webContents.capturePage()).toPNG());
    console.log('PASS: corrected hold final removes the stale interim row and submits once', shotPath);

    // Also exercise finals while recognition is still active: merely clearing
    // on release would fix the screenshot but leave continuous calls broken.
    await evaluate(() => voiceTest.emit('onFloatingOrbCommand', 'hold-start'));
    await waitFor(() => voiceTest.ui.sessionState === 'listening', 'second hold connects');
    await evaluate(() => voiceTest.emit('onAsrEvent', {
      type: 'transcript.partial', text: '今天天气怎么样了明天呢', utterances: [
        { text: '今天天气怎么样了', utteranceId: 'hold2:0' },
        { text: '明天呢', utteranceId: 'hold2:1000' },
      ],
    }));
    await waitFor(() => voiceTest.ui.interimText === '今天天气怎么样了明天呢', 'aggregate interim');
    await evaluate(() => voiceTest.emit('onAsrEvent', { type: 'transcript.final', text: '今天天气怎么样呢？', utteranceId: 'hold2:0' }));
    await waitFor(() => voiceTest.ui.interimText === '明天呢', 'earlier final preserves next partial');
    await evaluate(() => voiceTest.emit('onAsrEvent', { type: 'transcript.final', text: '明天天气如何？', utteranceId: 'hold2:1000' }));
    await waitFor(() => voiceTest.ui.interimText === '' && !document.querySelector('.h24-user-bubble.is-interim'), 'fully revised final clears active partial');
    await evaluate(() => {
      voiceTest.emit('onAsrEvent', { type: 'transcript.partial', text: '明天呢', utteranceId: 'hold2:1000' });
      voiceTest.emit('onAsrEvent', { type: 'transcript.partial', text: '你好', utteranceId: 'hold2:2000' });
    });
    await waitFor(() => voiceTest.ui.interimText === '你好', 'new partial after stale partial');
    await evaluate(() => voiceTest.emit('onAsrEvent', { type: 'transcript.final', text: '你好。', utteranceId: 'hold2:1000' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await evaluate(() => voiceTest.ui.interimText), '你好', 'identical text from another sentence must not clear current interim');
    await evaluate(() => voiceTest.emit('onAsrEvent', { type: 'transcript.final', text: '你好！', utteranceId: 'hold2:2000' }));
    await waitFor(() => voiceTest.ui.interimText === '', 'repeated phrase final clears by identity');
    await evaluate(() => voiceTest.emit('onAsrEvent', { type: 'transcript.partial', text: '你好', utteranceId: 'hold2:2000' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await evaluate(() => voiceTest.ui.interimText), '', 'stale partial cannot return after final');
    await evaluate(() => voiceTest.emit('onAsrEvent', { type: 'transcript.partial', text: '尚未定稿', utteranceId: 'hold2:3000' }));
    await waitFor(() => voiceTest.ui.interimText === '尚未定稿', 'partial before provider closes');
    await evaluate(() => voiceTest.emit('onAsrEvent', { type: 'session.ended' }));
    await waitFor(() => voiceTest.ui.interimText === '' && voiceTest.ui.sessionState === 'idle', 'provider end clears unfinalized partial');
    await evaluate(() => voiceTest.emit('onAsrEvent', { type: 'transcript.partial', text: '结束后迟到', utteranceId: 'hold2:3000' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await evaluate(() => voiceTest.ui.interimText), '', 'ended session rejects late partials');

    // A paused hold can finalize a fragment before release; second-pass revisions
    // and the trailing fragment must still submit together in one model request.
    await testWindow.loadFile(fileURLToPath(new URL('../dist-renderer/index.html', import.meta.url)));
    await waitFor(() => voiceTest.logs.some((line) => line.includes('启动完成')), 'paused hold bootstrap');
    await evaluate(() => voiceTest.emit('onFloatingOrbCommand', 'hold-start'));
    await waitFor(() => voiceTest.ui.sessionState === 'listening', 'paused hold connects');
    await evaluate(() => {
      voiceTest.emit('onAsrEvent', { type: 'transcript.final', text: '帮我找一命关云。', utteranceId: 'pause:0' });
      voiceTest.emit('onAsrEvent', { type: 'transcript.partial', text: '相关 skill', utteranceId: 'pause:4000' });
      voiceTest.stopEvents = [
        { type: 'transcript.final', text: '帮我找关于命理的', utteranceId: 'pause:0' },
        { type: 'transcript.final', text: '相关 skill。', utteranceId: 'pause:4000' },
      ];
    });
    await waitFor(() => voiceTest.ui.interimText === '相关 skill', 'paused hold keeps live interim text');
    assert.equal(await evaluate(() => voiceTest.chats.length), 0, 'a pause does not submit a hold early');
    await evaluate(() => voiceTest.emit('onFloatingOrbCommand', 'hold-end'));
    await waitFor(() => voiceTest.chats.length === 1, 'release submits the corrected hold');
    const userMessages = await evaluate(() => voiceTest.chats[0].messages.filter((message) => message.role === 'user').map((message) => message.content));
    assert.deepEqual(userMessages, ['帮我找关于命理的', '相关 skill。'], 'all corrected fragments reach the same model request');
    assert.equal(await evaluate(() => voiceTest.chats.length), 1);
    await waitFor(() => !document.querySelector('.h24-user-bubble.is-interim'), 'release clears corrected hold interim text');
    console.log('PASS: paused hold waits for release and submits all second-pass corrections together');
    assert.deepEqual(errors, []);
    console.log('PASS: active-session corrections, aggregate partials, earlier revisions, repeated phrases, stale partials and provider closure');
    exitCode = 0;
  } catch (error) {
    console.error(error);
    console.error(errors);
  } finally {
    testWindow?.destroy();
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    app.exit(exitCode);
  }
}

void main().catch((error) => { console.error(error); app.exit(1); });
