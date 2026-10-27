// Isolated-world decoration. Build DOM nodes directly so Trusted Types and a
// strict page CSP cannot reject an innerHTML/style-element injection.
globalThis.HEMI_SHOW_CURSOR = function ({ x, y, action = 'read' } = {}) {
  let state = window.__hemiCursor;
  if (action === 'type') {
    const target = document.activeElement;
    if (target && target !== document.body) {
      const rect = target.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    }
  }
  const hasTargetPoint = Number.isFinite(x) && Number.isFinite(y);
  if (!Number.isFinite(x)) x = state?.x ?? 32;
  if (!Number.isFinite(y)) y = state?.y ?? 40;
  if (!hasTargetPoint) {
    x = Math.max(4, Math.min(x, innerWidth - 32));
    y = Math.max(4, Math.min(y, innerHeight - 40));
  }
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!state?.host.isConnected || !state.label || !state.glyph) {
    state?.host.remove();
    const style = (node, properties) => {
      for (const [name, value] of Object.entries(properties)) node.style.setProperty(name, value, 'important');
    };
    const host = document.createElement('hemi-pointer');
    host.setAttribute('aria-hidden', 'true');
    style(host, { all: 'initial', position: 'fixed', left: '0', top: '0', width: '0', height: '0',
      'z-index': '2147483647', 'pointer-events': 'none', visibility: 'visible' });
    const shadow = host.attachShadow({ mode: 'closed' });
    const pointer = document.createElement('div');
    style(pointer, { position: 'absolute', left: '0', top: '0', 'pointer-events': 'none', opacity: '1' });
    const ring = document.createElement('div');
    style(ring, { position: 'absolute', left: '-15px', top: '-15px', width: '30px', height: '30px',
      border: '2px solid #16865c', 'border-radius': '50%', 'box-sizing': 'border-box', opacity: '0', 'pointer-events': 'none' });
    const svgNS = 'http://www.w3.org/2000/svg';
    const glyph = document.createElementNS(svgNS, 'svg');
    glyph.setAttribute('viewBox', '0 0 28 32');
    glyph.setAttribute('aria-hidden', 'true');
    style(glyph, { display: 'block', width: '28px', height: '32px', overflow: 'visible',
      filter: 'drop-shadow(0 2px 3px #0005)', 'transform-origin': '0 0', 'pointer-events': 'none' });
    const arrow = document.createElementNS(svgNS, 'path');
    for (const [name, value] of Object.entries({ d: 'M2 2L2 24L8 18L13 29L18 27L13 16L22 16Z', fill: '#123b2b',
      stroke: '#fff', 'stroke-width': '2', 'stroke-linejoin': 'round' })) arrow.setAttribute(name, value);
    const dot = document.createElementNS(svgNS, 'circle');
    for (const [name, value] of Object.entries({ cx: '22', cy: '25', r: '4', fill: '#16865c', stroke: '#fff', 'stroke-width': '1.5' })) dot.setAttribute(name, value);
    glyph.append(arrow, dot);
    const label = document.createElement('span');
    style(label, { position: 'absolute', 'white-space': 'nowrap', padding: '3px 8px', 'border-radius': '6px',
      background: '#126345', color: '#fff', font: '12px/18px -apple-system, BlinkMacSystemFont, sans-serif',
      'box-shadow': '0 2px 6px #0003', 'pointer-events': 'none' });
    pointer.append(ring, glyph, label);
    shadow.append(pointer);
    document.documentElement.append(host);
    state = window.__hemiCursor = { host, pointer, ring, glyph, label };
  }
  state.x = x; state.y = y;
  state.pointer.style.setProperty('transition', reducedMotion ? 'none' : 'transform 140ms ease-out', 'important');
  state.pointer.style.setProperty('transform', `translate(${x}px,${y}px)`, 'important');
  state.glyph.style.setProperty('transform', `scale(${x > innerWidth - 28 ? -1 : 1},${y > innerHeight - 32 ? -1 : 1})`, 'important');
  state.label.style.setProperty('left', x > innerWidth - 130 ? '-120px' : '24px', 'important');
  state.label.style.setProperty('top', y > innerHeight - 44 ? '-28px' : '18px', 'important');
  const labels = { navigate: '浏览', read: '读取', click: '点击', type: '输入', select: '选择', scroll: '滚动', move: '移动' };
  state.label.textContent = `Hemi · ${labels[action] || '浏览'}`;
  if (['click', 'type', 'select'].includes(action) && !reducedMotion) {
    state.ring.getAnimations().forEach(animation => animation.cancel());
    state.ring.animate([{ opacity: 0.65, transform: 'scale(0.45)' }, { opacity: 0, transform: 'scale(1.6)' }],
      { duration: action === 'type' ? 420 : 600, easing: 'ease-out' });
  }
  return { visible: state.host.isConnected && getComputedStyle(state.pointer).opacity === '1', x, y, action };
};
