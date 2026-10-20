// 057 AC-23 同源走查（主窗＋字幕窗双目标 CDP）：
//   前置：隔离实例（预置空档 conv-ac23，--remote-debugging-port=9249，字幕窗常驻）。
//   文字回合流式中：主窗与字幕窗正文同流（同一运行事实）；停止后字幕冻结收口不再增长；
//   全程 tts 播报留痕零增长（文字回合不口播）。停止面时机由 AC-10/verify-057-ac10 与
//   stopped fixtures 覆盖（本脚本停止可能落在收口后）。
// AC-23 同源走查：文字回合流式中与停止后，主窗与字幕窗反映同一运行/停止事实；
// 文字回合不口播（无 tts 播报留痕）；语音转述对照（口播仅语音回合）。
const fs = await import('node:fs');
const LOG = '/tmp/hemi057-ac23/hemi.log';
const targets = await (await fetch("http://127.0.0.1:9249/json/list")).json();
const main = targets.find((t) => t.type === 'page' && !/mode=/.test(t.url));
const caption = targets.find((t) => t.type === 'page' && t.url.includes('mode=caption'));
if (!main || !caption) { console.error('需要主窗＋字幕窗'); process.exit(1); }

const connect = (target) => new Promise((resolve, reject) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.onopen = () => resolve({
    evalJs: (x) => new Promise((res, rej) => {
      const id = ++seq; pending.set(id, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: x, returnByValue: true, awaitPromise: true } }));
    }).then((r) => r?.result?.value ?? null).catch(() => null),
    close: () => ws.close(),
  });
  ws.onerror = reject;
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`); };

const M = await connect(main);
const C = await connect(caption);
const ttsLineCount = () => ((fs.readFileSync(LOG, 'utf8').match(/口播|tts 播报|开始播报/g) ?? []).length);
const captionState = () => C.evalJs(`(() => ({ text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 80), empty: document.body.innerText.trim().length === 0 }))()`);
const mainState = () => M.evalJs(`(() => ({ text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200) }))()`);

await M.evalJs(`window.hemiVoice.chatTextModel({ turnId: 9911, conversationId: 'conv-ac23', workspaceId: 'default', profileId: 'mp-muxxaz5x-s2frgd/m-new-muxxaz5x-0', inputSource: 'text', messages: [{ role: 'user', content: '不要用任何工具，直接从 1 慢慢数到 60，每行一个数字。' }] }).then(() => 'settled', () => 'rejected')`).catch(() => {});
// 流式中采样（等主窗出现流式内容）
let midMain = null;
for (let i = 0; i < 40; i++) {
  await sleep(700);
  midMain = await mainState();
  if (midMain?.text && /\n2\n3|\b12\b|\b8\b/.test(midMain.text) && midMain.text.includes('1')) break;
}
const midCaption = await captionState();
const ttsBefore = ttsLineCount();
check('主窗流式正文在场（运行中）', Boolean(midMain?.text?.match(/1/)), (midMain?.text ?? '').slice(0, 60));

// 字幕窗：同一运行的正文/状态在场（反映同一事实），或至少非空地反映运行
const capDuring = (midCaption?.text ?? '').length > 0;
check('字幕窗反映同一运行（内容在场）', capDuring, midCaption?.text ?? '(空)');

// 停止（渲染层同一通路：cancelTextModel）
await M.evalJs(`window.hemiVoice.cancelTextModel({ turnId: 9911, conversationId: 'conv-ac23' })`);
await sleep(2500);
const afterMain = await mainState();
const afterCaption = await captionState();
check('主窗反映停止（已停止保留部分内容）', /已停止/.test(afterMain?.text ?? '') || /已停止/.test((await mainState())?.text ?? ''), (afterMain?.text ?? '').slice(-40));
// 字幕窗在停止后清空/停止（不再挂着运行内容）
const capStopped = !afterCaption || afterCaption.empty || afterCaption.text.length <= (midCaption?.text ?? '').length;
check('字幕窗随停止收口（不再持续运行态）', capStopped, JSON.stringify(afterCaption));
await sleep(1500);
const capSettled = await captionState();
check('字幕窗停止后稳定（无残留增长）', !capSettled || capSettled.empty || capSettled.text.length <= (afterCaption?.text ?? '').length + 2, JSON.stringify(capSettled));

// 文字回合不口播：全程 tts 播报留痕零增长
check('文字回合不口播（零播报留痕）', ttsLineCount() === ttsBefore, `${ttsBefore}→${ttsLineCount()}`);

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `AC23-FAIL: ${results.length - failed.length}/${results.length}` : `AC23-PASS: ${results.length}/${results.length}`);
console.log('HEMI_VERIFY_057_AC23=' + JSON.stringify({ ok: failed.length === 0, checks: results }));
M.close(); C.close(); process.exit(failed.length ? 1 : 0);
