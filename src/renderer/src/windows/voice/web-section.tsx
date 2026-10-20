import { useEffect, useState } from 'react';

import { openExternal } from '@/shared/open-external';
import type { WebSearchPreferences } from '@/shared/types';

/**
 * 设置页·联网搜索区块：总开关（默认关）+ provider key。
 * key 只写不读——明文不出主进程，这里只显示「配好了没有」。开关与 key
 * 双条件生效：缺任何一个，执行器的工具面里都不会出现联网工具。
 * 037：分组列表——开关行 + 展开的 Key 表单块（grid 行折叠）。
 */

const TAVILY_KEY_URL = 'https://app.tavily.com';

export function WebSection() {
  const [prefs, setPrefs] = useState<WebSearchPreferences | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keySaved, setKeySaved] = useState(false);

  useEffect(() => {
    void window.hemiVoice?.getWebSearch().then(setPrefs).catch(() => {});
  }, []);

  const toggleEnabled = (enabled: boolean) => {
    setPrefs((prev) => (prev ? { ...prev, enabled } : prev));
    void window.hemiVoice?.setWebSearch({ enabled }).then(setPrefs).catch(() => {});
  };

  const saveKey = async () => {
    if (!keyDraft.trim()) return;
    const saved = await window.hemiVoice?.setWebSearch({ apiKey: keyDraft.trim() });
    if (saved) setPrefs(saved);
    setKeyDraft('');
    setKeySaved(true);
  };

  const enabled = prefs?.enabled ?? false;
  const hasKey = prefs?.hasApiKey ?? false;

  return (
    <section className="h37-section">
      <div className="h37-group">
        <div className="h37-row">
          <span className="h37-row-text">
            <b>允许联网搜索</b>
            <span>只读：搜索并读取公开网页正文，不落盘、不动系统。</span>
          </span>
          <button
            type="button"
            role="switch"
            className="h37-switch"
            aria-checked={enabled}
            aria-label="允许联网搜索"
            onClick={() => toggleEnabled(!enabled)}
          />
        </div>

        {enabled ? (
          <div className="h37-settings-form h37-enter">
            <div className="h37-field">
              <label htmlFor="web-search-key">
                Tavily Key
                <span className="h37-badge h37-settings-label-badge" data-tone={hasKey ? 'ok' : 'warn'}>
                  {hasKey ? '已配好' : '未配置'}
                </span>
              </label>
              <div className="h37-settings-inline">
                <input
                  id="web-search-key"
                  type="password"
                  className="h37-input"
                  value={keyDraft}
                  placeholder={hasKey ? '输入新 Key 可覆盖' : '粘贴 tvly- 开头的 Key'}
                  onChange={(event) => {
                    setKeyDraft(event.target.value);
                    setKeySaved(false);
                  }}
                  autoComplete="off"
                />
                <button
                  type="button"
                  disabled={!keyDraft.trim()}
                  className="h37-btn h37-btn-primary"
                  onClick={() => void saveKey()}
                >
                  保存
                </button>
              </div>
              <p className="h37-help">
                {keySaved ? '已保存，新任务生效。' : hasKey ? '' : '配好后新任务才能联网。'}
                没有 Key？去{' '}
                <button
                  type="button"
                  className="h37-link h37-settings-inline-link"
                  onClick={() => void openExternal(TAVILY_KEY_URL)}
                >
                  tavily.com
                </button>{' '}
                免费领（每月 1000 次，不用绑卡）。
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
