import {useCallback, useLayoutEffect, useMemo, useRef} from 'react';
import type {BotMethod, BotState} from '@shared/bot';
import type {SkillActionResult, SkillMarketState} from '@shared/protocol';
import {SkillMarket, type SkillMarketApi} from '../voice/skill-market';

export function BotSkillsSettings({state, onBack}: {state: BotState; onBack: () => void}) {
  const instanceId = state.binding?.instanceId;
  const root = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const command = useCallback(<T,>(method: BotMethod, params: Record<string, unknown> = {}) =>
    window.hemiVoice.bot.command<T>(method, {...params, expectedInstanceId: instanceId}), [instanceId]);
  useLayoutEffect(() => {root.current?.scrollIntoView({block: 'start'});back.current?.focus({preventScroll: true});}, []);
  const skillApi = useMemo<SkillMarketApi>(() => ({
    getSkillState: () => command<SkillMarketState>('skills.state'),
    refreshSkillCatalog: () => command<SkillActionResult>('skills.refresh'),
    importLocalSkill: () => command<SkillActionResult>('skills.import-local'),
    installMarketSkill: skillId => command<SkillActionResult>('skills.install', {skillId}),
    setSkillEnabled: (skillId, enabled) => command<SkillActionResult>('skills.set-enabled', {skillId, enabled}),
    removeSkill: skillId => command<SkillActionResult>('skills.remove', {skillId}),
    readSkill: skillId => command('skills.read', {skillId}),
    revealSkill: async () => ({ok: false, reason: '技能保存在 Bot 主机上。'}),
    searchSkillsMp: params => command('skills.search', params),
    previewSkillsMp: id => command('skills.preview', {id}),
    installSkillsMp: params => command<SkillActionResult>('skills.mp-install', params),
    checkSkillsMpUpdate: skillId => command('skills.check-update', {skillId}),
  }), [command]);
  return <section ref={root} className="h37-enter" aria-label="Bot 技能中心">
    <div className="h37-page-head"><div><h2>Bot 技能</h2><p>技能安装在 Bot 主机上，供各个对话使用。</p></div></div>
    <button ref={back} type="button" className="h37-btn h37-btn-secondary" onClick={onBack}>返回 Bot 能力</button>
    <SkillMarket api={skillApi} remote initialTab="installed" onBack={onBack}/>
  </section>;
}
