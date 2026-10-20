// 主窗口尺寸保留：恢复校验/夹回工作区与 window-state.json 读写容错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WINDOW_STATE_VERSION,
  createWindowStateStore,
  restoreBounds,
} from './window-state-store.mjs';

const MAIN = { x: 0, y: 0, width: 1920, height: 1055 };
const SECOND = { x: 1920, y: 0, width: 1280, height: 720 };

test('restoreBounds：完整可见的记录原样返回', () => {
  const saved = { x: 120, y: 140, width: 1100, height: 760 };
  assert.deepEqual(restoreBounds(saved, { displays: [MAIN, SECOND] }), saved);
});

test('restoreBounds：半离屏夹回所属工作区，保持尺寸', () => {
  const out = restoreBounds({ x: 1500, y: 200, width: 900, height: 700 }, { displays: [MAIN] });
  assert.deepEqual(out, { x: 1920 - 900, y: 200, width: 900, height: 700 });
});

test('restoreBounds：显示器已拔（完全离屏）取中心最近的显示器夹回', () => {
  const out = restoreBounds({ x: 2500, y: 100, width: 1000, height: 640 }, { displays: [MAIN, SECOND] });
  assert.deepEqual(out, { x: 2200, y: 80, width: 1000, height: 640 }, '最小位移夹回副屏内完整可见');
});

test('restoreBounds：尺寸超过工作区贴上限', () => {
  const out = restoreBounds({ x: -50, y: -50, width: 4000, height: 3000 }, { displays: [MAIN] });
  assert.deepEqual(out, { x: 0, y: 0, width: MAIN.width, height: MAIN.height });
});

test('restoreBounds：缺字段/非数字/小于窗口下限/无显示器返回 null', () => {
  assert.equal(restoreBounds(null, { displays: [MAIN] }), null);
  assert.equal(restoreBounds({ x: 1, y: 1 }, { displays: [MAIN] }), null);
  assert.equal(restoreBounds({ x: 'a', y: 1, width: 800, height: 700 }, { displays: [MAIN] }), null);
  assert.equal(restoreBounds({ x: 1, y: 1, width: 400, height: 700 }, { displays: [MAIN] }), null);
  assert.equal(restoreBounds({ x: 1, y: 1, width: 800, height: 500 }, { displays: [MAIN] }), null);
  assert.equal(restoreBounds({ x: 1, y: 1, width: 800, height: 700 }, { displays: [] }), null);
});

test('store：保存→读取往返；文件不存在返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-winstate-'));
  try {
    const store = createWindowStateStore({ filePath: path.join(dir, 'window-state.json') });
    assert.equal(store.load(), null, '首启无记录');
    assert.equal(store.save({ bounds: { x: 64, y: 96, width: 1180, height: 820 }, maximized: false }).ok, true);
    assert.deepEqual(store.load(), { bounds: { x: 64, y: 96, width: 1180, height: 820 }, maximized: false });
    assert.equal(store.save({ bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: true }).ok, true);
    assert.equal(store.load().maximized, true, '原子替换不留旧记录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store：损坏/版本不识别→null＋warn，不抛；写入失败如实返回不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-winstate-'));
  const warnings = [];
  const io = {
    readFileSync: () => '{oops',
    writeFileSync: () => { throw new Error('disk full'); },
    mkdirSync: () => {},
    renameSync: () => {},
  };
  try {
    const file = path.join(dir, 'window-state.json');
    const store = createWindowStateStore({ filePath: file, io, log: { warn: (m) => warnings.push(m) } });
    assert.equal(store.load(), null);
    assert.equal(warnings.length, 1);
    assert.equal(store.save({ bounds: { x: 0, y: 0, width: 800, height: 700 }, maximized: false }).ok, false);
    assert.equal(warnings.length, 2);
    fs.writeFileSync(file, JSON.stringify({ version: WINDOW_STATE_VERSION + 1, bounds: { x: 0, y: 0, width: 800, height: 700 } }));
    const real = createWindowStateStore({ filePath: file, log: { warn: (m) => warnings.push(m) } });
    assert.equal(real.load(), null, '未来版本不消费');
    assert.equal(warnings.length, 3);
    fs.writeFileSync(file, JSON.stringify({ version: WINDOW_STATE_VERSION, bounds: { x: 'bad', y: 0, width: 800, height: 700 } }));
    assert.equal(real.load(), null, 'bounds 字段不完整按无记录起步');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
