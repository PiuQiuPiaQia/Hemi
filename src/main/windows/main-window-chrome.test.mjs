import assert from 'node:assert/strict';
import test from 'node:test';
import { SKINS } from '../../shared/appearance/skins.mjs';
import { mainWindowChromeFor, updateMainWindowChrome } from './main-window-chrome.mjs';

test('native controls occupy one renderer navigation row on each supported desktop', () => {
  const mac = mainWindowChromeFor('darwin', SKINS[0]);
  assert.equal(mac.titleBarStyle, 'hiddenInset');
  assert.equal(mac.trafficLightPosition.y + 6, 52 / 2);
  assert.equal(mac.titleBarOverlay, undefined);
  const win = mainWindowChromeFor('win32', SKINS[0]);
  assert.equal(win.titleBarStyle, 'hidden');
  assert.equal(win.titleBarOverlay.height, 52);
  assert.equal(win.autoHideMenuBar, true, 'the development menu does not add a second navigation row');
  assert.equal(win.trafficLightPosition, undefined);
  assert.deepEqual(mainWindowChromeFor('linux', SKINS[0]), { titleBarStyle: 'default' });
});

test('skin changes update Windows caption contrast without calling unsupported macOS APIs', () => {
  const updates = [];
  const window = { setTitleBarOverlay: options => updates.push(options) };
  for (const skin of SKINS) {
    updateMainWindowChrome(window, 'darwin', skin);
    updateMainWindowChrome(window, 'linux', skin);
  }
  assert.equal(updates.length, 0);
  for (const skin of SKINS) updateMainWindowChrome(window, 'win32', skin);
  assert.equal(updates.length, SKINS.length);
  for (const [index, update] of updates.entries()) {
    assert.equal(update.symbolColor, SKINS[index].colors['--body'], 'caption symbol follows the body ink (v0.2.24 semantics shared with windows-chrome)');
    assert.equal(update.color, '#00000000', 'caption buttons reveal the same backdrop as the navigation');
  }
});

test('overlay delegates to windows-chrome with a fallback symbol color for incomplete skins', () => {
  const updates = [];
  const window = { setTitleBarOverlay: options => updates.push(options) };
  updateMainWindowChrome(window, 'win32', null);
  updateMainWindowChrome(window, 'win32', {});
  assert.equal(updates[0].symbolColor, '#2d2d2c');
  assert.equal(updates[1].symbolColor, '#2d2d2c');
  assert.equal(updates.every(update => update.color === '#00000000'), true);
});
