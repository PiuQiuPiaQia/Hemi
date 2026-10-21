import { useCallback, useEffect, useState } from 'react';
import type { ModelProfilesDirectory } from '@/shared/types';
import { AddProviderScreen, type ProviderSetupController } from './model-profiles-section';
import { findDefaultModel, providerSaveInput } from './lib/provider-presets';

function message(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

/** 首启与设置共用供应商接入组件；完成前只验证所选的默认模型。 */
export function OnboardingModelStep({ onContinue, onBack, onBusyChange }: {
  onContinue: () => Promise<void>;
  onBack: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [directory, setDirectory] = useState<ModelProfilesDirectory | null>(null);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState('');
  const [vision, setVision] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const adopt = useCallback((next: ModelProfilesDirectory) => {
    setDirectory(next);
    const current = findDefaultModel(next);
    setSelected(current?.model.modelKey ?? '');
    setVision(current?.model.supportsVision === true);
    return next;
  }, []);
  const reload = useCallback(async () => adopt(await window.hemiVoice.listModelProfiles()), [adopt]);

  useEffect(() => {
    let active = true;
    window.hemiVoice.listModelProfiles().then((next) => {
      if (!active) return;
      adopt(next);
      setAdding(!findDefaultModel(next));
    }).catch((reason) => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [adopt]);

  const reportBusy = useCallback((value: boolean) => {
    setBusy(value);
    onBusyChange(value);
  }, [onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const added = async () => {
    try { await reload(); setAdding(false); setError(''); }
    catch (reason) { setError(message(reason)); }
  };

  const connect = async () => {
    const provider = directory?.providers.find(item => item.models.some(model => model.modelKey === selected));
    const model = provider?.models.find(item => item.modelKey === selected);
    if (!provider || !model || busy) return;
    reportBusy(true);
    setError('');
    try {
      const tested = await window.hemiVoice.testModelProfile({ modelKey: selected, requireTools: true });
      if (!tested.ok) throw new Error(tested.error || '模型测试失败，请重试。');
      if (vision !== model.supportsVision) {
        const saved = await window.hemiVoice.saveModelProfile(providerSaveInput(provider, {
          models: provider.models.map(entry => entry.modelKey === selected ? { ...entry, supportsVision: vision } : entry),
        }));
        if (!saved.ok) throw new Error('图片能力没有保存成功，请重试。');
      }
      const result = await window.hemiVoice.setDefaultModelProfile(selected);
      if (!result.ok) throw new Error('默认模型没有保存成功，请重试。');
      if (vision || directory?.visionModelKey === selected) {
        const saved = await window.hemiVoice.setVisionModel(vision ? selected : null);
        if (!saved.ok) throw new Error('看图模型没有保存成功，请重试。');
      }
      await onContinue();
    } catch (reason) { setError(message(reason)); }
    finally { reportBusy(false); }
  };

  if (!directory) return (
    <div className="onboarding-model-panel" role="status">
      {error ? <><p className="onboarding-field-error">{error}</p><button type="button" className="h37-btn h37-btn-secondary" onClick={() => void reload().then(next => setAdding(!findDefaultModel(next))).catch(reason => setError(message(reason)))}>重新读取</button></> : '正在读取模型配置…'}
    </div>
  );

  const controller: ProviderSetupController = {
    directory,
    readOnly: directory.corrupt === true,
    reload,
    back: () => findDefaultModel(directory) ? setAdding(false) : onBack(),
    setStatus: () => {},
    saveProvider: async (input) => {
      const saved = await window.hemiVoice.saveModelProfile(input);
      if (!saved.ok) throw new Error('模型配置没有保存成功，请重试。');
      return { providerId: saved.providerId, modelKeys: saved.modelKeys ?? [] };
    },
    mutate: async (_optimistic, action) => {
      try { await action(directory); await reload(); return null; }
      catch (reason) { return message(reason); }
    },
  };

  return (
    <div className="onboarding-model-panel">
      {directory.corrupt ? <p className="onboarding-field-error" role="alert">模型配置无法读取，请先恢复配置文件后重试。</p> : adding ? (
        <AddProviderScreen ctl={controller} initial={null} embedded onAdded={() => void added()} onBusyChange={reportBusy} />
      ) : (
        <>
          <fieldset disabled={busy} className="onboarding-model-fields">
            <label htmlFor="onboarding-default-model">默认模型</label>
            <select id="onboarding-default-model" className="h37-input onboarding-input" value={selected} onChange={(event) => {
              const key = event.target.value;
              setSelected(key);
              setVision(directory.providers.flatMap(item => item.models).find(item => item.modelKey === key)?.supportsVision === true);
              setError('');
            }}>
              {directory.providers.map(provider => <optgroup key={provider.id} label={provider.name}>{provider.models.map(model => <option key={model.modelKey} value={model.modelKey}>{model.model}</option>)}</optgroup>)}
            </select>
            <label className="onboarding-vision-choice"><input type="checkbox" checked={vision} onChange={(event) => setVision(event.target.checked)} />这个模型支持图片输入</label>
            <p className="onboarding-field-help">按服务商说明确认。开启后也用它看图；连接测试只检查工具调用。</p>
            <button type="button" className="h37-link" onClick={() => { setAdding(true); setError(''); }}>添加其他供应商</button>
          </fieldset>
          <div className="onboarding-actions">
            <button type="button" className="h37-btn h37-btn-primary h37-btn-lg onboarding-primary" disabled={busy || !selected} onClick={() => void connect()}>{busy ? '正在验证工具调用…' : '验证并继续'}</button>
          </div>
          <p className="onboarding-field-help">会向所选服务发送一次少量测试请求，不会操作文件或应用。</p>
        </>
      )}
      {error ? <p className="onboarding-field-error" role="alert">{error}</p> : null}
      <p className="onboarding-privacy">密钥加密保存在本机。对话与附件会发送给你配置的服务商，费用按服务商规则计算。</p>
    </div>
  );
}
