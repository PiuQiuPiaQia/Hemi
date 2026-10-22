import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base = process.env.HEMI_FIXTURES_BASE ?? 'http://127.0.0.1:5187';
const out = path.resolve('.visual/workflow/vision');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
try {
  for (const scene of ['settings-model-add-oauth', 'settings-oauth-device', 'settings-oauth-error', 'settings-oauth-code']) {
    for (const width of [1440, 768, 375]) {
      const errors = [];
      const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/fixtures.html?scene=${scene}`, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: '.h65-perf { display: none !important; }' });
      await page.locator('.h-oauth').waitFor();
      const modal = scene !== 'settings-model-add-oauth';
      const trigger = page.locator('.h-oauth-row').filter({ hasText: 'ChatGPT' }).getByRole('button', { name: '登录', exact: true });
      if (scene === 'settings-oauth-error') await trigger.click();
      if (modal) {
        await page.locator('.h-oauth-dialog').waitFor();
        await page.waitForFunction(() => !document.querySelector('.h-oauth-dialog')?.hasAttribute('data-starting-style'));
        await page.locator('.h-oauth-dialog').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
      }
      const checks = await page.evaluate(() => {
        const dialog = document.querySelector('.h-oauth-dialog');
        const rect = dialog?.getBoundingClientRect();
        const foreground = dialog ?? document.querySelector('.h-oauth');
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          accounts: [...document.querySelectorAll('.h-oauth-label > b')].map(item => item.textContent),
          allButtonsAccessible: [...foreground.querySelectorAll('button')].every(button => { const rect = button.getBoundingClientRect(); return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth; }),
          dialogInViewport: !rect || rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight + 1,
          dialogNamed: !dialog || Boolean(document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent.includes('登录')),
          focusInDialog: !dialog || dialog.contains(document.activeElement),
          deviceCode: document.querySelector('.h-oauth-code')?.textContent,
          alert: document.querySelector('.h-oauth-dialog [role="alert"]')?.textContent,
        };
      });
      const screenshot = `oauth-modal-${scene}-${width}.png`;
      await page.screenshot({ path: path.join(out, screenshot), fullPage: true });
      let actionsReachable = true;
      for (const button of await page.locator(modal ? '.h-oauth-dialog button' : '.h-oauth button').all()) {
        await button.scrollIntoViewIfNeeded();
        actionsReachable &&= await button.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)); });
      }
      const behavior = {};
      if (modal) {
        for (let index = 0; index < 8; index++) {
          await page.keyboard.press('Tab');
          assert.ok(await page.locator('.h-oauth-dialog').evaluate(element => element.contains(document.activeElement)), `focus escaped ${scene}@${width}`);
        }
        behavior.focusTrapped = true;
      }
      if (scene === 'settings-oauth-code') {
        const input = page.locator('.h-oauth-dialog input');
        await input.fill('synthetic-code#state');
        await input.press('Enter');
        await page.getByRole('status').filter({ hasText: '正在验证授权并获取账号模型' }).waitFor();
        assert.equal(await page.locator('.h-oauth-dialog input').count(), 0);
        behavior.enterSubmitsPrompt = true;
      }
      if (scene === 'settings-oauth-error') {
        await page.getByRole('button', { name: '重新登录', exact: true }).click();
        assert.equal(await page.locator('.h-oauth-dialog').count(), 1);
        await page.getByRole('button', { name: '关闭登录授权', exact: true }).click();
        await page.locator('.h-oauth-dialog').waitFor({ state: 'detached' });
        assert.ok(await trigger.evaluate(element => element === document.activeElement));
        behavior.retryAndFocusRestored = true;
      } else if (modal) {
        await page.keyboard.press('Escape');
        await page.locator('.h-oauth-dialog').waitFor({ state: 'detached' });
        assert.equal(await page.locator('.h-oauth-row').count(), 3);
        behavior.escapeCancelsAndCloses = true;
      }
      const ok = actionsReachable && !checks.overflow && checks.allButtonsAccessible && checks.dialogInViewport && checks.dialogNamed && checks.focusInDialog && checks.accounts.length === 3 && !errors.length && (scene !== 'settings-oauth-device' || checks.deviceCode === 'HEMI-TEST') && (scene !== 'settings-oauth-error' || Boolean(checks.alert));
      results.push({ scene, width, ok, actionsReachable, checks, behavior, errors, screenshot });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${scene}@${width}`);
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  await page.goto(`${base}/fixtures.html?scene=settings-oauth-device`, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '.h65-perf { display: none !important; }' });
  await page.locator('.h-oauth-dialog').waitFor();
  await page.waitForFunction(() => !document.querySelector('.h-oauth-dialog')?.hasAttribute('data-starting-style'));
  await page.locator('.h-oauth-dialog').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
  await page.screenshot({ path: path.join(out, 'oauth-modal-dark-1440.png'), fullPage: true });
  await page.close();
} finally { await browser.close(); }
await writeFile(path.join(out, 'oauth-modal-layout.json'), JSON.stringify({ results }, null, 2));
if (results.some(item => !item.ok)) process.exitCode = 1;
