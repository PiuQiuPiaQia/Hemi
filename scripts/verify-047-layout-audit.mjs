// 047 布局审计（AC-10 的程序化证据；视觉模型本轮不可用，此为 tier-2 代理）：
// 三档视口下逐场景检查：横向溢出、元素出界、文本截断（区分故意 ellipsis）、
// 固定操作区遮挡（.h47n-foot 在文档流内且不被覆盖）。
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE || [
  path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'),
  path.join(os.homedir(), '.hermes/hermes-agent/node_modules/playwright/index.mjs'),
].find(existsSync);
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');

const BASE = process.env.HEMI_FIXTURES_BASE ?? 'http://127.0.0.1:5173';
const SCENES = [
  'settings-model-add-newapi',
  'settings-import-login',
  'settings-import-selecting',
  'settings-import-progress',
  'settings-import-success',
  'settings-import-failed',
];
const VIEWPORTS = [1440, 768, 375];

const AUDIT_SCRIPT = () => {
  const issues = [];
  const doc = document.scrollingElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    issues.push(`横向溢出：scrollWidth=${doc.scrollWidth} > clientWidth=${doc.clientWidth}`);
  }
  const container = document.querySelector('.h47n');
  const browser = document.querySelector('.h47n-browser');
  if (container && browser && container.getBoundingClientRect().width >= 480
    && (browser.getBoundingClientRect().width < 480 || browser.dataset.wide !== 'true')) {
    issues.push('导入内容区足宽，站点页面却被两列布局挤窄或隐藏');
  }
  const targets = document.querySelectorAll('.h47n *');
  for (const el of targets) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) continue;
    if (rect.right > window.innerWidth + 1 && style.position !== 'fixed') {
      issues.push(`元素出右界：${el.tagName}.${String(el.className).split(' ')[0]} right=${Math.round(rect.right)}`);
    }
    if (el.children.length === 0 && el.textContent?.trim()) {
      const ellipsis = style.textOverflow === 'ellipsis';
      if (el.scrollWidth > el.clientWidth + 2 && !ellipsis) {
        issues.push(`文本截断（非 ellipsis）：${el.tagName}「${el.textContent.trim().slice(0, 24)}」`);
      }
    }
  }
  const foot = document.querySelector('.h47n-foot');
  if (foot) {
    const rect = foot.getBoundingClientRect();
    const middle = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (middle && !foot.contains(middle) && !middle.contains(foot)) {
      issues.push(`操作区被遮挡：中心点命中最顶层 ${middle.tagName}.${String(middle.className).split(' ')[0]}`);
    }
  }
  return issues.slice(0, 10);
};

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
let failed = 0;
try {
  for (const scene of SCENES) {
    for (const width of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width, height: width === 768 ? 1100 : 1000 }, deviceScaleFactor: 1 });
      await page.goto(`${BASE}/fixtures.html?scene=${scene}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const issues = await page.evaluate(AUDIT_SCRIPT);
      const ok = issues.length === 0;
      if (!ok) failed += 1;
      console.log(`${ok ? '✓' : '✗'} ${scene}@${width}${issues.length ? '' : '（无溢出/出界/截断/遮挡）'}`);
      for (const issue of issues) console.log('   ', issue);
      await page.close();
    }
  }

  // 同一窗口内验证嵌入容器的断点与窄→宽恢复，不能只检查页面没有横向溢出。
  const resizePage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await resizePage.goto(`${BASE}/fixtures.html?scene=settings-import-login`, { waitUntil: 'networkidle' });
  for (const width of [440, 480, 720, 851, 852, 1040, 440, 480]) {
    await resizePage.locator('.h47n').evaluate((el, value) => { el.style.width = `${value}px`; }, width);
    const ok = await resizePage.waitForFunction((value) => {
      const browser = document.querySelector('.h47n-browser');
      const panel = document.querySelector('.h47n-panel');
      const rect = browser.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const visible = browser.dataset.wide === 'true';
      const sideBySide = panelRect.left >= rect.right;
      return visible === (value >= 480) && sideBySide === (value >= 852)
        && (value < 480 || rect.width >= 480);
    }, width, { timeout: 3000 }).then(() => true, () => false);
    if (!ok) failed += 1;
    console.log(`${ok ? '✓' : '✗'} 导入容器 ${width}px（可见性 / 单双列 / 缩放恢复）`);
  }
  await resizePage.close();

  // 块节奏断言（2026-10-08 用户裁决的规范）：pane 内相邻块间距＝--gap-section(32)，
  // 卡内标题↔内容＝--gap-head(8)。覆盖 047 页面与存量供应商页（基线参照）。
  const RHYTHM_SCRIPT = () => {
    const issues = [];
    const rect = (el) => el.getBoundingClientRect();
    const visible = (el) => {
      const r = rect(el);
      return r && r.height > 0 && r.width > 0;
    };
    const measure = (root, label) => {
      const blocks = [...root.children].filter((el) => visible(el) && !['SCRIPT', 'STYLE'].includes(el.tagName));
      for (let i = 0; i + 1 < blocks.length; i += 1) {
        const gap = Math.round(rect(blocks[i + 1]).top - rect(blocks[i]).bottom);
        // 返回按钮↔标题块是收紧档（12），块↔块一律 32。
        if (blocks[i].classList.contains('h37-back')) continue;
        if (gap !== 32) issues.push(`${label} 块间距 ${gap}px（应 32）：${blocks[i].className} → ${blocks[i + 1].className}`);
      }
      for (const section of blocks.filter((el) => el.classList.contains('h37-section'))) {
        const head = [...section.children].find((el) => el.classList.contains('h37-section-head'));
        const body = [...section.children].filter((el) => visible(el) && !el.classList.contains('h37-section-head'))[0];
        if (head && body) {
          const gap = Math.round(rect(body).top - rect(head).bottom);
          if (gap !== 8) issues.push(`${label} 标题↔内容 ${gap}px（应 8）`);
        }
      }
    };
    const pane = document.querySelector('.h37m-pane');
    if (pane) measure(pane, 'pane');
    const panel = document.querySelector('.h47n-panel');
    if (panel) measure(panel, 'panel');
    return issues.slice(0, 8);
  };
  for (const scene of [...SCENES, 'settings-model-add', 'settings-model-provider']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await page.goto(`${BASE}/fixtures.html?scene=${scene}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const issues = await page.evaluate(RHYTHM_SCRIPT);
    const ok = issues.length === 0;
    if (!ok) failed += 1;
    console.log(`${ok ? '✓' : '✗'} 节奏 ${scene}@1440${ok ? '（块间 32 / 标题↔内容 8）' : ''}`);
    for (const issue of issues) console.log('   ', issue);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failed === 0 ? 'LAYOUT_AUDIT_OK' : `LAYOUT_AUDIT_FAILED=${failed}`);
process.exit(failed === 0 ? 0 : 1);
