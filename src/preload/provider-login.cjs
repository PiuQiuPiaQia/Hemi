// 仅供应商登录 View 使用。隔离世界，无 contextBridge、文件/命令/通用 IPC API。
const { ipcRenderer } = require('electron');

if (process.isMainFrame) {
  const LOAD = 'hemi-provider-login:load';
  const CAPTURE = 'hemi-provider-login:submitted';
  let saved = null;
  let filling = false;
  const touched = new WeakSet();
  const filled = new WeakSet();
  const excluded = /(?:register|sign[-_]?up|reset|forgot|change[-_]?password)/i;
  const visible = (input) => !input.disabled && !input.readOnly && input.getClientRects().length > 0;

  function loginFields(root = document) {
    if (excluded.test(location.pathname)) return null;
    const passwords = [...root.querySelectorAll('input[type="password"]')].filter(visible);
    if (passwords.length !== 1) return null;
    const password = passwords[0];
    if (password.autocomplete === 'new-password') return null;
    const container = password.form || password.closest('[role="form"]') || root;
    if ([...container.querySelectorAll('input')].some((el) => el.autocomplete === 'new-password')) return null;
    const inputs = [...container.querySelectorAll('input')].filter((input) => visible(input)
      && ['text', 'email', 'tel'].includes(input.type) && input.autocomplete !== 'one-time-code'
      && !/(?:otp|captcha|verification|verify.?code|search)/i.test(`${input.name} ${input.id}`));
    const username = inputs.find((input) => input.autocomplete === 'username')
      || inputs.find((input) => /user.?name|email|account|login|identifier/i.test(`${input.name} ${input.id}`))
      || (inputs.length === 1 ? inputs[0] : null);
    if (!username) return null;
    if (password.form) {
      try { if (new URL(password.form.action || location.href).origin !== location.origin) return null; }
      catch { return null; }
    }
    return { username, password, container };
  }

  function setValue(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    filled.add(input);
  }
  function fill() {
    if (!saved || saved.origin !== location.origin) return;
    const fields = loginFields();
    if (!fields || touched.has(fields.username) || touched.has(fields.password) || filled.has(fields.password)) return;
    if (fields.password.value || (fields.username.value && fields.username.value !== saved.username)) return;
    filling = true;
    try {
      if (!fields.username.value) setValue(fields.username, saved.username);
      setValue(fields.password, saved.password);
    } finally { filling = false; }
  }
  function capture(root) {
    const fields = loginFields(root);
    if (!fields || !fields.username.value.trim() || !fields.password.value) return;
    ipcRenderer.send(CAPTURE, { username: fields.username.value, password: fields.password.value });
  }

  document.addEventListener('input', (event) => {
    if (!filling && event.target instanceof HTMLInputElement) touched.add(event.target);
  }, true);
  document.addEventListener('submit', (event) => capture(event.target), true);
  // 一些 SPA 登录按钮不触发表单 submit；只识别明确的登录动作。
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('button, input[type="submit"], [role="button"]');
    if (button && /^(?:登\s*录|log\s*in|sign\s*in)$/i.test((button.textContent || button.value || '').trim())) {
      capture(button.form || document);
    }
  }, true);

  function start() {
    const observer = new MutationObserver(fill);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'autocomplete', 'hidden', 'style', 'class'] });
    window.addEventListener('pageshow', fill);
    window.addEventListener('popstate', fill);
    void ipcRenderer.invoke(LOAD).then((value) => { saved = value; fill(); }).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
