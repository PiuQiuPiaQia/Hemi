/** 截图/导入验收脚本共用：从真实首启 UI 接入一个模型，不注入产品就绪状态。 */
export async function completeOnboardingUi({ exec, baseUrl, model, apiKey, name = '验收模型服务' }) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async expression => {
    const end = Date.now() + 30000;
    while (Date.now() < end) { if (await exec(expression)) return; await sleep(100); }
    throw new Error(`首启 UI 等待超时：${expression}`);
  };
  const click = async (text, scope = 'document') => {
    await wait(`Boolean([...(${scope}).querySelectorAll('button')].find(item => item.textContent.includes(${JSON.stringify(text)}) && !item.disabled))`);
    await exec(`[...(${scope}).querySelectorAll('button')].find(item => item.textContent.includes(${JSON.stringify(text)}) && !item.disabled).click()`);
    await sleep(100);
  };
  const fill = async (selector, value) => {
    await exec(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  };
  await wait(`document.querySelector('.onboarding-page')?.dataset.step === 'welcome'`);
  await click('开始设置');
  // 方式卡片是 radiogroup（订阅 / New API / API 配置），按 data-method 点比按文案稳。
  await wait(`Boolean(document.querySelector('.h47n-methods [data-method="api"]'))`);
  await exec(`document.querySelector('.h47n-methods [data-method="api"]').click()`);
  await click('自定义', `document.querySelector('[aria-label="选择供应商"]')`);
  await fill('#h37m-add-name', name);
  await fill('#h37m-add-key', apiKey);
  await fill('#h37m-add-url', baseUrl);
  await click('其他型号');
  await fill('[aria-label="其他型号 ID"]', model);
  await exec(`document.querySelector('[aria-label="其他型号 ID"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await click('添加 1 个模型');
  await wait(`Boolean(document.querySelector('#onboarding-default-model'))`);
  await click('验证并继续');
  await wait(`document.querySelector('.onboarding-page')?.dataset.step === 'capabilities'`);
  await click('继续', `document.querySelector('.onboarding-actions')`);
  await wait(`document.querySelector('.onboarding-page')?.dataset.step === 'done'`);
  await click('开始使用');
  await wait(`!document.querySelector('.onboarding-page')`);
}
