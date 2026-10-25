import { useEffect, useState } from 'react';

type ModelListResult = { ok: boolean; models?: string[]; error?: string };
type Loader = (() => Promise<ModelListResult>) | null;

/** 首次连接就绪后拉取；换连接或卸载时忽略旧请求，失败只在手动刷新时重试。 */
export function useRemoteModels(load: Loader) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    source: Loader;
    models: string[] | null;
    busy: boolean;
    error: string;
  }>({ source: null, models: null, busy: false, error: '' });

  useEffect(() => {
    if (!load) {
      setState({ source: null, models: null, busy: false, error: '' });
      return;
    }
    let active = true;
    setState(previous => ({ source: load, models: previous.source === load ? previous.models : null, busy: true, error: '' }));
    // 粘贴 Key 或编辑接口地址时，等输入稳定再请求。
    const timer = window.setTimeout(async () => {
      try {
        const result = await load();
        if (!result.ok) throw new Error(result.error || '拉取失败，请重试。');
        const models = [...new Set((result.models ?? []).map(id => id.trim()).filter(Boolean))];
        if (!models.length) throw new Error('服务没有返回任何模型，可手动输入型号 ID。');
        if (active) setState({ source: load, models, busy: false, error: '' });
      } catch (reason) {
        const error = (reason instanceof Error ? reason.message : String(reason))
          .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim();
        if (active) setState({ source: load, models: null, busy: false, error: error || '拉取失败，请重试。' });
      }
    }, 600);
    return () => { active = false; window.clearTimeout(timer); };
  }, [load, revision]);

  const current = state.source === load ? state : { models: null, busy: Boolean(load), error: '' };
  return { ...current, refresh: () => setRevision(value => value + 1) };
}
