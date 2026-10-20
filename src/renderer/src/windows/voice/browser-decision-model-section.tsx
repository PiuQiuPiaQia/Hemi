import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

import type { BrowserActPreferences, ModelTestResult } from '@/shared/types';

/**
 * 041 设置页·模型与路由 →「浏览器决策模型（Jev）」配置组（020 browser_act 的
 * 地址/型号/Key/测试从浏览器页迁来，M-22）。数据流不变：getBrowserAct /
 * setBrowserAct / testBrowserAct，Key 只写不读（回执只带 hasApiKey）。
 * 默认收起一行摘要；展开编辑、失焦保存。浏览器页只留能力开关与「配置决策模型」跳转，
 * 保存这里不会改变浏览器控制开关。首用明示保留：页面文字将发送至该服务。
 */

export function BrowserDecisionSection({
  open,
  onToggle,
  onBack,
}: {
  open: boolean;
  onToggle: () => void;
  /** 「返回浏览器控制」深层定位（041 双向定位）。 */
  onBack?: () => void;
}) {
  const [act, setAct] = useState<BrowserActPreferences | null>(null);
  const [actKey, setActKey] = useState('');
  const [actSaved, setActSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);
  const baseUrlRef = useRef<HTMLInputElement | null>(null);
  const modelRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void window.hemiVoice?.getBrowserAct().then(setAct).catch(() => {});
  }, []);

  // 测试用输入框当前值（含未保存的 key 不会带上——key 是只写受控值，存了才生效）。
  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const outcome = await window.hemiVoice?.testBrowserAct({
        baseUrl: baseUrlRef.current?.value.trim() || undefined,
        model: modelRef.current?.value.trim() || undefined,
      });
      setTestResult(outcome ?? { ok: false, error: '测试调用没有返回结果。' });
    } catch {
      setTestResult({ ok: false, error: '测试调用失败，请重试。' });
    } finally {
      setTesting(false);
    }
  };

  const saveAct = (next: Partial<BrowserActPreferences> & { apiKey?: string }) => {
    void window.hemiVoice?.setBrowserAct(next).then((saved) => {
      setAct(saved);
      setActSaved(true);
      setTimeout(() => setActSaved(false), 2000);
    }).catch(() => {});
  };

  const model = act?.model?.trim() || 'typesafe-ai/jev';

  return (
    <section className="h37-section" id="settings-browser-decision">
      <div className="h37-section-head">
        <h3>浏览器决策模型（Jev）</h3>
        <span className="h37-aside">
          <span className="h37-badge" data-tone={act?.hasApiKey ? 'ok' : 'warn'}>
            {act?.hasApiKey ? '已配置' : '未配置'}
          </span>
        </span>
      </div>
      <div className="h37-group">
        <div className="h37-row">
          <span className="h37-row-text">
            <b className="h37-settings-mono">{model}</b>
          </span>
          <span className="h37-row-end">
            <button type="button" className="h37-btn h37-btn-ghost h37-btn-sm" onClick={onToggle}>
              {open ? '收起' : '配置'}
            </button>
          </span>
        </div>

        {open ? (
          <div className="h37-settings-form h37-enter">
            <div className="h37-fields">
              <label className="h37-field">
                <span className="h37-field-label">服务地址</span>
                <input
                  className="h37-input"
                  ref={baseUrlRef}
                  defaultValue={act?.baseUrl ?? ''}
                  placeholder="https://api.typesafe.ai"
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value.trim() !== act?.baseUrl) {
                      saveAct({ baseUrl: e.target.value.trim() });
                    }
                  }}
                />
              </label>
              <label className="h37-field">
                <span className="h37-field-label">模型 ID</span>
                <input
                  className="h37-input"
                  ref={modelRef}
                  defaultValue={act?.model ?? 'typesafe-ai/jev'}
                  placeholder="typesafe-ai/jev"
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value.trim() !== act?.model) {
                      saveAct({ model: e.target.value.trim() });
                    }
                  }}
                />
              </label>
              <label className="h37-field h37-full">
                <span className="h37-field-label">API Key{act?.hasApiKey ? '（已配置）' : ''}</span>
                <input
                  className="h37-input"
                  type="password"
                  value={actKey}
                  placeholder={act?.hasApiKey ? '留空保留当前 Key；输入新值可更换' : '粘贴 Key（vck_… 或官方 Key）'}
                  onChange={(e) => setActKey(e.target.value)}
                />
              </label>
            </div>
            <div className="h37-settings-actions">
              <button
                type="button"
                className="h37-btn h37-btn-secondary h37-btn-sm"
                disabled={testing}
                onClick={() => void runTest()}
              >
                {testing ? '测试中…' : '测试已保存配置'}
              </button>
              {testResult ? (
                <span className="h37-settings-test" data-ok={testResult.ok ? 'true' : 'false'}>
                  {testResult.ok
                    ? `连通正常 · ${testResult.latencyMs ?? '?'}ms · 模型 ${testResult.resolvedModel ?? '?'}${
                        testResult.confidence != null ? ` · 置信 ${testResult.confidence}` : ''
                      }`
                    : `连通失败：${testResult.error ?? '未知错误'}`}
                </span>
              ) : null}
            </div>
            <div className="h37-settings-actions">
              <span className="h37-help">
                地址和模型 ID 失焦保存；测试与保存 Key 使用已保存的配置。页面文字将发送给该服务。
              </span>
              <span className="h37-settings-actions-end">
                {actSaved ? (
                  <span className="h37-saved">
                    <Check aria-hidden="true" />
                    已保存
                  </span>
                ) : null}
                <button
                  type="button"
                  className="h37-btn h37-btn-primary h37-btn-sm"
                  disabled={!actKey.trim()}
                  onClick={() => {
                    saveAct({ apiKey: actKey.trim() });
                    setActKey('');
                  }}
                >
                  保存 Key
                </button>
              </span>
            </div>
            {onBack ? (
              <p className="h37-help">
                <button type="button" className="h37-link" onClick={onBack}>
                  ← 返回浏览器控制
                </button>
                保存模型配置不会开启浏览器控制。
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
