// Shared CDP page operations for the extension and Hemi-managed headless browser.
// Reference tables remain in an isolated world; both backends use the same v2 protocol.
globalThis.HEMI_CREATE_PAGE_OPERATIONS = function ({
  requireActiveTab, evaluate, evaluateIn, cdp, delay, ensureWorld,
  pageLogic: PAGE_LOGIC, serialized = (_task, run) => run(), showCursor = async () => {},
}) {
  const recentReceipts = new Map();
  const RECEIPTS_CAP = 60;
  async function opExtract(params, task) {
    const tabId = requireActiveTab(task);
    await showCursor(tabId, { action: 'read' });
    const selector = params.selector ? String(params.selector) : null;
    const data = await evaluate(
      tabId,
      `(sel) => {
        const root = sel ? document.querySelector(sel) : document.body;
        if (sel && !root) return null;
        const text = root ? String(root.innerText || '') : '';
        return { title: document.title || '', url: location.href, text: text.trim() };
      }`,
      [selector],
    );
    if (!data) throw new Error(`页面上找不到元素：${selector}`);
    return data;
  }

  async function opClick(params, task) {
    const tabId = requireActiveTab(task);
    const selector = String(params.selector || '').trim();
    if (!selector) throw new Error('selector 不能为空');
    const rect = await evaluate(
      tabId,
      `(sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: String(el.textContent || '').trim().slice(0, 80) };
      }`,
      [selector],
    );
    if (!rect) throw new Error(`页面上找不到元素：${selector}`);
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1,
    });
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1,
    });
    await delay(150);
    return { hitText: rect.text };
  }

  async function opType(params, task) {
    const tabId = requireActiveTab(task);
    const text = String(params.text ?? '');
    if (!text) throw new Error('text 不能为空');
    if (params.selector) {
      const ok = await evaluate(
        tabId,
        `(sel, clear) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.focus();
          if (clear !== false && 'value' in el) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return true;
        }`,
        [String(params.selector), params.clear !== false],
      );
      if (!ok) throw new Error(`页面上找不到输入框：${params.selector}`);
    }
    await cdp(tabId, 'Input.insertText', { text });
    await delay(80);
    return {};
  }

  async function opSnapshot(params, task) {
    const tabId = requireActiveTab(task);
    return serialized(task, async () => {
      await showCursor(tabId, { action: 'read' });
      const contextId = await ensureWorld(tabId);
      const snap = await evaluateIn(tabId, contextId, PAGE_LOGIC.SNAPSHOT_SOURCE, []);
      if (!snap || snap.v !== 2 || !Array.isArray(snap.lines)) {
        throw new Error('页面快照失败：脚本未返回 v2 结果（扩展与桥版本不匹配？）');
      }
      return { ...snap, session: { windowId: task.windowId, tabId: task.tabId } };
    });
  }

  async function opRefAct(params, task) {
    const tabId = requireActiveTab(task);
    return serialized(task, () => refActInner(tabId, params));
  }

  async function refActInner(tabId, params) {
    const action = String(params.action || '');
    // 滚动不需要元素下标（整页滚动，固定脚本，非模型输出）；隔离世界共享
    // 页面滚动位置，在哪个世界 scrollBy 都滚同一个窗口。
    if (action === 'scroll') {
      // 重复派发防御同样生效：同 dispatchId 的滚动不重复滚。
      const dedupKey = `${params.dispatchId || ''}:scroll:0`;
      if (params.dispatchId && recentReceipts.has(dedupKey)) return recentReceipts.get(dedupKey);
      const dir = String(params.text || '') === 'SCROLL_UP' ? -1 : 1;
      const contextId = await ensureWorld(tabId);
      await showCursor(tabId, { action: 'scroll' });
      await evaluateIn(tabId, contextId, `(d) => { scrollBy(0, d * innerHeight * 0.8); }`, [dir]);
      await delay(150);
      const receipt = { status: 'ok', label: '', id: '' };
      if (params.dispatchId) storeReceipt(dedupKey, receipt);
      return receipt;
    }
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 1) throw new Error('index 必须是正整数（元素表编号）');
    if (!['click', 'type', 'select'].includes(action)) throw new Error(`不支持的动作：${action}`);

    // 回执去重（R-09）：同 dispatchId 的动作不重复执行，回上一次回执。
    const dedupKey = `${params.dispatchId || ''}:${action}:${index}`;
    if (params.dispatchId && recentReceipts.has(dedupKey)) return recentReceipts.get(dedupKey);

    // 解析 + 存活 + 遮挡一次做完；引用必须是快照时留存的节点（isConnected 挡
    // 页面已换），且只从隔离世界的引用表解析——主世界改写同名变量无效（R-06）。
    const contextId = await ensureWorld(tabId);
    const probe = await evaluateIn(
      tabId,
      contextId,
      `(index, act) => {
        const el = (window.__hemiRefs || [])[index - 1];
        if (!el || !el.isConnected) return { status: 'stale' };
        window.__hemiTmp = el;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        const covered = !(top && (top === el || el.contains(top) || top.contains(el)));
        return {
          status: covered ? 'covered' : 'ok',
          id: el.id || '',
          label: String(el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 60),
          x: Math.round(cx), y: Math.round(cy),
          tag: el.tagName,
        };
      }`,
      [index, action],
    );
    if (probe.status === 'stale') return { status: 'stale', label: '', id: '' };
    if (probe.status === 'covered') return { status: 'covered', label: probe.label, id: probe.id };

    let receipt;
    if (action === 'click') {
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: probe.x, y: probe.y, button: 'left', clickCount: 1 });
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: probe.x, y: probe.y, button: 'left', clickCount: 1 });
      await delay(150);
      receipt = { status: 'ok', label: probe.label, id: probe.id };
    } else if (action === 'type') {
      const text = String(params.text ?? '');
      if (!text) return { status: 'noText', label: probe.label, id: probe.id };
      // 先清旧值再真实点击聚焦，insertText 走输入法级通道（联想框只认真实事件）；
      // 输完不 blur，留给候选弹层。清理走隔离世界引用（主世界摸不到 __hemiTmp）。
      await evaluateIn(tabId, contextId, `() => { const el = window.__hemiTmp; if (el && 'value' in el && el.value) el.value = ''; }`, []);
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: probe.x, y: probe.y, button: 'left', clickCount: 1 });
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: probe.x, y: probe.y, button: 'left', clickCount: 1 });
      await cdp(tabId, 'Input.insertText', { text });
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await delay(300);
      receipt = { status: 'ok', label: probe.label, id: probe.id };
    } else {
      await showCursor(tabId, { x: probe.x, y: probe.y, action: 'select' });
      // select：精确且唯一匹配才动手（021 R-11）——空文本拒绝、模糊多候选返回
      // 歧义、无匹配返回 fail，任何非 ok 结果都不修改 DOM。匹配函数以源码内联
      // 传入（evaluate 参数走 JSON 序列化，函数对象传不过去）。
      const pickResult = await evaluateIn(
        tabId,
        contextId,
        `(pickSrc, want) => {
          const pickFn = eval('(' + pickSrc + ')');
          const el = window.__hemiTmp;
          if (!el || el.tagName !== 'SELECT') return { status: 'stale' };
          const options = [];
          for (let i = 0; i < el.options.length; i++) {
            options.push({ value: el.options[i].value, text: String(el.options[i].textContent || '') });
          }
          const picked = pickFn(options, want);
          if (picked.status !== 'ok') return picked;
          el.value = picked.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { status: 'ok', value: picked.value, match: picked.match };
        }`,
        [PAGE_LOGIC.PICK_OPTION_SOURCE, String(params.text ?? '')],
      );
      if (!pickResult || pickResult.status === 'stale') return { status: 'stale', label: probe.label, id: probe.id };
      if (pickResult.status === 'empty') return { status: 'noText', label: probe.label, id: probe.id };
      if (pickResult.status === 'ambiguous') return { status: 'ambiguous', label: probe.label, id: probe.id };
      if (pickResult.status !== 'ok') return { status: 'fail', label: probe.label, id: probe.id };
      await delay(150);
      receipt = { status: 'ok', label: probe.label, id: probe.id };
    }
    if (params.dispatchId) storeReceipt(dedupKey, receipt);
    return receipt;
  }

  function storeReceipt(key, receipt) {
    if (recentReceipts.size >= RECEIPTS_CAP) {
      const oldest = recentReceipts.keys().next().value;
      recentReceipts.delete(oldest);
    }
    recentReceipts.set(key, receipt);
  }


  return { opExtract, opClick, opType, opSnapshot, opRefAct };
};
