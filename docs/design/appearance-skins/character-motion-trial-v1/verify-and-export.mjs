// Standalone design-artifact verification/export. Run from the repository root.
// Uses the locally bundled Playwright runtime; no application dependencies change.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const runtime = process.env.HEMI_PREVIEW_PLAYWRIGHT || '/Users/zhangao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(runtime);
const folder = path.dirname(new URL(import.meta.url).pathname);
const dir = decodeURIComponent(folder);
const ffmpeg = process.env.HEMI_PREVIEW_FFMPEG || '/opt/homebrew/bin/ffmpeg';
const checkExisting = process.argv.includes('--check-existing');
const out = path.resolve('output/theme-preview/character-trial');
await fs.mkdir(out, { recursive: true });
const url = pathToFileURL(path.join(dir, 'index.html')).href;
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('requestfailed', r => errors.push(`${r.url()}: ${r.failure()?.errorText}`));
const qa = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  environment: { platform: process.platform, node: process.version, browser: await browser.version() },
  command: 'node docs/design/appearance-skins/character-motion-trial-v1/verify-and-export.mjs' + (checkExisting ? ' --check-existing' : ''),
  checks: {},
  gaps: ['Procedural WebGL mesh, not a Cubism model or editor project.', 'No head turn, separate articulated arms, or lip sync.', 'Desktop Chrome artifact verification only; Hemi Electron development/built renderers and target-platform decoding have not been tested.', 'Keyframe mixing can briefly blend lash lines; production eye rig needs continuous eyelid geometry.'],
};

function encoder(file, options) {
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '30', '-f', 'image2pipe', '-vcodec', 'png', '-i', 'pipe:0', ...options, file], { stdio: ['pipe', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', data => { log += data; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${log}`)));
  });
  done.catch(() => {});
  return { async write(bytes) { if (!child.stdin.write(bytes)) await once(child.stdin, 'drain'); }, async finish() { child.stdin.end(); await done; } };
}

try {
  await page.goto(url + '?capture');
  await page.evaluate(() => window.previewReady);
  qa.checks.renderers = await page.evaluate(() => window.characterTrial.getInfo());
  qa.checks.pixels = await page.evaluate(() => {
    const canvas = document.querySelector('#hero');
    const gl = canvas.getContext('webgl');
    const snap = (time, eye) => {
      window.characterTrial.seek(time, eye);
      const data = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    };
    const diff = (a, b, roi = [0, 0, canvas.width, canvas.height]) => {
      let pixels = 0, minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
      for (let y = roi[1]; y < roi[3]; y++) for (let x = roi[0]; x < roi[2]; x++) {
        const i = ((canvas.height - 1 - y) * canvas.width + x) * 4;
        if ([0, 1, 2, 3].some(c => a[i + c] !== b[i + c])) {
          pixels++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
      }
      return { pixels, bbox: pixels ? [minX, minY, maxX, maxY] : null };
    };
    const open = snap(2290, 0), closed = snap(2290, 1);
    const first = snap(0, 0), moving = snap(1700, 0), end = snap(8000, 0);
    return {
      eyeOnly: diff(open, closed),
      faceStability: diff(first, moving, [430, 405, 740, 600]),
      localMotion: diff(first, moving),
      loopBoundary: diff(first, end),
    };
  });
  const px = qa.checks.pixels;
  assert.equal(px.faceStability.pixels, 0, 'Central face moved with local motion');
  assert.equal(px.loopBoundary.pixels, 0, '8-second loop boundary differs');
  assert(px.localMotion.pixels > 1000, 'Hair/clothing motion did not render');
  assert(px.eyeOnly.pixels > 1000, 'Blink did not render');
  const [x0, y0, x1, y1] = px.eyeOnly.bbox;
  assert(x0 >= 385 && x1 <= 571 && y0 >= 397 && y1 <= 539, 'Blink altered pixels outside eye region');
  for (const [eye, name] of [[0, 'open'], [.5, 'half'], [1, 'closed']]) {
    await page.evaluate(eye => window.characterTrial.seek(2290, eye), eye);
    await page.screenshot({ path: path.join(dir, `keyframe-${name}.png`) });
  }

  // Real controls and reduced-motion behavior, without capture-only UI overrides.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  await page.evaluate(() => window.previewReady);
  assert.equal(await page.evaluate(() => window.characterTrial.getState().playing), false);
  qa.checks.reducedMotionPaused = true;
  await page.locator('#eye').fill('1');
  assert.equal(await page.evaluate(() => window.characterTrial.getState().eye), 1);
  await page.locator('#mesh').click();
  assert.equal(await page.locator('#mesh').getAttribute('aria-pressed'), 'true');
  await page.locator('#mesh').click();
  await page.locator('#blink').click();
  await page.waitForTimeout(190);
  assert.equal(await page.evaluate(() => window.characterTrial.getState().playing), true);
  await page.locator('#toggle').click();
  assert.equal(await page.evaluate(() => window.characterTrial.getState().playing), false);
  qa.checks.controls = 'Eye slider, mesh toggle, manual blink, play/pause passed';
  qa.checks.viewports = [];
  for (const width of [375, 560, 980, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
    assert(dimensions.page <= width, `Horizontal overflow at ${width}`);
    qa.checks.viewports.push(dimensions);
  }

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(url + '?capture');
  await page.evaluate(() => window.previewReady);
  if (!checkExisting) {
  const mp4 = encoder(path.join(dir, 'character-motion-preview.mp4'), ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an']);
  const alpha = encoder(path.join(dir, 'character-idle-alpha.webm'), ['-vf', 'scale=560:684', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '24', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-an']);
  for (let frame = 0; frame < 240; frame++) {
    await page.evaluate(time => window.characterTrial.seek(time), frame * 1000 / 30);
    const shot = await page.screenshot();
    const hero = await page.locator('#hero').evaluate(canvas => canvas.toDataURL('image/png').split(',')[1]);
    await mp4.write(shot);
    await alpha.write(Buffer.from(hero, 'base64'));
    if (frame % 30 === 0) console.log(`Export ${frame}/240`);
  }
  await mp4.finish();
  await alpha.finish();
  console.log('Both encodings finished');
  }

  qa.checks.video = {};
  for (const [file, type] of [['character-motion-preview.mp4', 'video/mp4'], ['character-idle-alpha.webm', 'video/webm']]) {
    const bytes = await fs.readFile(path.join(dir, file));
    const check = await page.evaluate(async ({ source, isAlpha }) => {
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.src = source;
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('Video metadata failed')); });
      video.currentTime = 2.3;
      await new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = () => reject(new Error('Video seek failed')); });
      const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(video, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let zero = 0, opaque = 0, partial = 0, nearlyOpaque = 0;
      for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] === 0) zero++; else if (pixels[i] === 255) opaque++; else partial++; if (pixels[i] >= 250) nearlyOpaque++; }
      const before = video.currentTime; await video.play(); await new Promise(resolve => setTimeout(resolve, 180)); video.pause();
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, alpha: { zero, opaque, partial, nearlyOpaque }, playbackAdvanced: video.currentTime > before, isAlpha };
    }, { source: `data:${type};base64,${bytes.toString('base64')}`, isAlpha: type === 'video/webm' });
    assert(Math.abs(check.duration - 8) < .1);
    assert.equal(check.playbackAdvanced, true);
    // The supplied character's interior alpha is predominantly 253, not 255.
    if (check.isAlpha) assert(check.alpha.zero > 10000 && check.alpha.nearlyOpaque > 10000, 'WebM alpha is not decoded');
    qa.checks.video[file] = { ...check, bytes: bytes.length };
  }
  assert.deepEqual(errors, []);
  qa.checks.browserErrors = errors;
  qa.result = 'PASS';
  await fs.writeFile(path.join(dir, 'qa.json'), JSON.stringify(qa, null, 2) + '\n');
  console.log(JSON.stringify(qa, null, 2));
} finally {
  await browser.close();
}
