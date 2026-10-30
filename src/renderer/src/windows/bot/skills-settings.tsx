import {useCallback, useMemo} from 'react';
import type {BotMethod, BotState} from '@shared/bot';
import type {SkillActionResult, SkillMarketState} from '@shared/protocol';
import {SkillMarket, type SkillMarketApi} from '../voice/skill-market';

/** 技能中心：Bot 设置的独立分类（2026-10-30 起，从「电脑与浏览器」页迁出）。
 *  与本机技能中心不同：技能安装在 Bot 主机上，读写全部走 Bot 桥。 */
export function BotSkillsSettings({state}: {state: BotState}) {
  const instanceId = state.binding?.instanceId;
  const command = useCallback(<T,>(method: BotMethod, params: Record<string, unknown> = {}) =>
    window.hemiVoice.bot.command<T>(method, {...params, expectedInstanceId: instanceId}), [instanceId]);
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
    checkSkillsMpUpdate: skillId => command<SkillActionResult>('skills.check-update', {skillId}),
  }), [command]);
  return <section className="h37-enter" aria-label="Bot 技能中心">
    <div className="h37-page-head"><div><h2>技能中心</h2><p>技能安装在 Bot 主机上，供各个对话使用；各项目的技能也会自动发现。</p></div></div>
    {/* SkillMarket 的 onBack 只用于会话内审批返回；设置页内无对话可回，传空实现。 */}
    <SkillMarket api={skillApi} remote initialTab="installed" onBack={() => {}}/>
  </section>;
}
