import { modelPolicyView } from '../presentation/model-policy-view.js';
import { AttachmentCard } from '../components/attachment-card.js';
import { useEffect, useId, useMemo, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, } from 'react';
import { ArrowUp, AtSign, FileText, Folder, Check, MessageSquareText, Slash, Sparkles, Square, Workflow, X, } from 'lucide-react';
import type { MessageAttachmentView, MessageReferenceView, ModelProfilesDirectory, SkillSelectionView, SlashCandidatesResult, } from '../types/presentation.js';
import { browseNewer, browseOlder, browseText, HISTORY_BROWSE_IDLE, shouldTakeOverArrow, type HistoryBrowseState, } from '../core/input-history.js';
import { createTagUndoStack, type TagUndoState, } from './tag-undo.js';
import { deleteTagBackward, deleteTagForward, detectComposerToken, insertTagToken, isInlineReference, segmentTaggedText, snapCaretToTagBoundary, syncReferencesWithText, syncSkillsWithText, toExternalPlainText, tokenOfReference, tokenOfSkill, tokenRangeInText, uniqueTokenLabel, type ComposerTokenState, } from '../presentation/composer-tokens.js';
/**
 * 024：对话面板底部的文字输入（v3 全页面重构版：textarea 在上，工具行在下
 * ——附件/快捷提示/权限在左，发送在右，对照设计稿 composer）。受控组件——
 * 草稿归 VoicePage（收起/设置往返不丢），这里只管编辑、行高与键盘语义；
 * 不直接发 IPC，提交一律上抛。默认 1 行（24px 行高），随内容增高到 4 行
 * （96px），之后内部滚动；发送清空后回缩。
 *
 * 028：本条消息附件——托盘（预览/移除/未就绪提示）＋工具行「附加」钮＋
 * 粘贴图片＋拖入文件。附件身份与读取全在主进程，这里只持元数据视图。
 *
 * 063：`/` 首层＝命令（/model）＋技能（生产同源候选）；`@` 首层＝工作流／
 * 文件／文件夹／对话行内引用（旧三类引用走原托盘芯片）。技能与行内引用是
 * 正文中的原子标签——textarea 仍是唯一编辑面，镜像层在文字下方渲染标签
 * 高亮；标签身份存草稿结构，随文本变化同步（文字删半截＝身份不残留）。
 */
/** 行高 24px：起步约两行（55px，设计稿 3.45rem），随内容增高到 4 行（96px）
 *  后内部滚动；发送清空后回落到起步高度。 */
const MIN_HEIGHT = 55;
const MAX_HEIGHT = 96;
/** 悬停／无障碍说明（不常驻占行）。 */
const COMPOSER_HINT = 'Enter 发送，Shift+Enter 换行；文字回复默认不出声';
/** 候选面板打开时的发送提示（063：先选择能力，不把候选片段发出去）。 */
const PANEL_OPEN_SEND_HINT = '先选择能力，或按 Esc 返回输入';
/** `/` 首层候选的本地过滤（名称精确/前缀/包含优先于说明弱匹配；分组次序稳定）。 */
function filterSlashEntries<T extends {
    name: string;
    description?: string;
}>(entries: T[], query: string): T[] {
    const keyword = query.trim().toLowerCase();
    if (!keyword)
        return entries;
    const rank = (item: T) => {
        const name = item.name.toLowerCase();
        if (name === keyword || name === `/${keyword}`)
            return 0;
        if (name.startsWith(keyword) || name.startsWith(`/${keyword}`))
            return 1;
        if (name.includes(keyword))
            return 2;
        if (String(item.description ?? '').toLowerCase().includes(keyword))
            return 3;
        return -1;
    };
    return entries
        .map((item) => ({ item, rank: rank(item) }))
        .filter((entry) => entry.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name))
        .map((entry) => entry.item);
}
const REFERENCE_GROUP_ORDER = ['workflow', 'file', 'folder', 'conversation', 'attachment', 'artifact', 'context'];
export type ComposerAdapter = {
    listSlashCandidates?(conversationId: string): Promise<SlashCandidatesResult>;
    listReferences?(conversationId: string, query: string, workspaceId?: string): Promise<{
        candidates: MessageReferenceView[];
    }>;
    pathForFile?(file: File): string;
    automaticRouting?: boolean;
    hint?: string;
};
export type ConversationComposerProps = {
    adapter?: ComposerAdapter;
    layout?: 'desktop' | 'touch';
    placeholder?: string;
    offline?: boolean;
    stopBlocked?: boolean;
    hasAttachments?: boolean;
    children?: ReactNode;
    value: string;
    onChange: (next: string) => void;
    onSend: () => void;
    /** 模型请求实际在途（播放中与后台任务不锁输入）。 */
    busy: boolean;
    waiting?: boolean;
    /** 有未提交语音：按住录音／ASR 临时稿／定稿未提交。 */
    pendingSpeech?: boolean;
    /** 主脑模型已配置。 */
    modelReady?: boolean;
    /** 通话进行中（保留「麦克风仍在聆听」提示）。 */
    callActive?: boolean;
    /** 模型未配置时的「去设置」直达。 */
    onOpenSettings?: () => void;
    /** 工具行左侧插槽：附加对象、快捷提示、操作权限等入口（发送键在最右）。 */
    toolbar?: ReactNode;
    /** 工具行右端插槽（发送键左侧）——ZCode 同位：模型选择等提交控制簇。 */
    trailing?: ReactNode;
    /** 037：输入框顶部内嵌条（通话中的通话条）；在场时不再重复「通话中」提示。 */
    header?: ReactNode;
    /** 026 R-10：聚焦信号——数字变化即聚焦输入框（「继续讨论」闭环；缺省不动）。 */
    focusToken?: number;
    /** 028：当前会话的草稿附件（发送前可见、可预览、可移除）。 */
    attachments?: MessageAttachmentView[];
    /** 028：登记失败的提示（托盘内联；空串＝无）。 */
    attachError?: string;
    /** 028：粘贴图片（data URL 上抛，主进程登记后取得稳定身份）。 */
    onAttachPaste?: (dataUrl: string) => void;
    /** 028：拖入文件（preload 的 webUtils 取受控路径；空串＝取不到）。 */
    onAttachDrop?: (filePath: string) => void;
    onRemoveAttachment?: (attachmentId: string) => void;
    onPreviewAttachment?: (conversationId: string, attachmentId: string) => void;
    /** 029 R-01：停止当前模型回应（busy 态主操作；只取消本回合）。 */
    onStopTurn?: () => void;
    /** 029 R-03：有任务在跑——停止回应的提示要说明任务不受影响。 */
    tasksRunning?: boolean;
    /** 030 R-04：当前会话的已发送用户输入（最新在前；↑/↓ 找回与历史菜单共用）。 */
    inputHistory?: string[];
    /** 031/063：`/model` 第二层与模型按钮同一份目录；选中走会话选模语义。 */
    modelProfiles?: ModelProfilesDirectory | null;
    onSelectModelProfile?: (profileId: string) => void;
    /** 028 二批：当前会话 id（`@` 引用候选按会话过滤）。 */
    mentionConversationId?: string | null;
    /** 063：`@` 文件/对话候选的工作区范围（与提交的工作区身份一致）。 */
    mentionWorkspaceId?: string | null;
    /** 028 二批：`@` 引用——当前草稿已插入的引用芯片与增删回调。 */
    references?: MessageReferenceView[];
    onAddReference?: (candidate: MessageReferenceView) => void;
    onRemoveReference?: (key: string) => void;
    onPreviewReference?: (reference: MessageReferenceView) => void;
    /** 063：整组引用替换（标签同步/撤销恢复用；旧三类芯片增删仍走上两行回调）。 */
    onSetReferences?: (next: MessageReferenceView[]) => void;
    /** 063：`/` 选中的技能标签（行内标签身份）。 */
    skills?: SkillSelectionView[];
    onSetSkills?: (next: SkillSelectionView[]) => void;
    /** 063：`/model` 本地切换的轻量反馈（输入区短暂提示；不伪造对话消息）。 */
    modelNotice?: string;
    /** 033 R-07：工作区目录失效 → 硬禁发（原因条在上下文栏，草稿保留）。 */
    sendBlocked?: boolean;
    readOnly?: boolean;
    /** 033/049：禁发提示文案（工作区类型区分：本机＝目录不可用，远端＝连不上服务器）。 */
    /** Empty text keeps a transient block silent. */
    sendBlockedHint?: string;
    /** 本会话还没有任何内容：占位文案按「开场」写，不说「继续」。 */
    fresh?: boolean;
    queueEditing?: boolean;
    queueEditSaving?: boolean;
    onCancelQueueEdit?: () => void;
};
type PanelState = {
    kind: 'slash';
} | {
    kind: 'model';
} | {
    kind: 'mention';
} | null;
type PanelItem = {
    key: string;
    disabled: boolean;
};
export function ConversationComposer({ adapter, layout = 'desktop', placeholder, offline = false, stopBlocked = false, hasAttachments = false, children, value, onChange, onSend, busy, waiting = false, pendingSpeech = false, modelReady = true, callActive = false, onOpenSettings, toolbar, focusToken, attachments = [], attachError = '', onAttachPaste, onAttachDrop, onRemoveAttachment, onPreviewAttachment, onStopTurn, tasksRunning = false, inputHistory = [], modelProfiles = null, onSelectModelProfile, mentionConversationId = null, mentionWorkspaceId = null, references = [], trailing, header, onAddReference, onRemoveReference, onPreviewReference, onSetReferences, skills = [], onSetSkills, modelNotice = '', sendBlocked = false, readOnly = false, sendBlockedHint, fresh = false, queueEditing = false, queueEditSaving = false, onCancelQueueEdit, }: ConversationComposerProps) {
    const instanceId = useId();
    const descriptionId = instanceId + '-description';
    const hintId = instanceId + '-hint';
    const bridge = adapter;
    const botEnvironment = adapter?.automaticRouting === false;
    const composerHint = adapter?.hint ?? COMPOSER_HINT;
    const minHeight = layout === 'touch' ? 40 : MIN_HEIGHT;
    const maxHeight = layout === 'touch' ? 128 : MAX_HEIGHT;
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const mirrorRef = useRef<HTMLDivElement | null>(null);
    /** 上次见过的 token（null＝尚未观察）；挂载初值不算变化，不触发聚焦。 */
    const prevTokenRef = useRef<number | null>(null);
    /** 拖拽视觉态计数器（dragenter/dragleave 不配对时不错乱）。 */
    const draggingRef = useRef(0);
    const [dragActive, setDragActive] = useState(false);
    // 030：↑/↓ 历史浏览（缓存原稿；编辑即离开）与历史菜单。
    const [browse, setBrowse] = useState<HistoryBrowseState>(HISTORY_BROWSE_IDLE);
    // 063：光标位置（token 检测与标签操作都以此为准；onSelect 同步）。
    const [caret, setCaret] = useState(0);
    // 063：候选面板（slash 首层／model 二层／mention）；同一时刻只开一个。
    const [panel, setPanel] = useState<PanelState>(null);
    const [panelIndex, setPanelIndex] = useState(0);
    /** Esc 关闭后的「不再立刻重弹」签名（trigger+token 文字）；token 变化即失效。 */
    const dismissedRef = useRef<string | null>(null);
    /** @ 引用候选（防抖查询）。 */
    const [mentionItems, setMentionItems] = useState<MessageReferenceView[]>([]);
    const [mentionLoading, setMentionLoading] = useState(false);
    /** slash 首层候选（打开时拉取；随会话失效）。 */
    const [slashResult, setSlashResult] = useState<{
        conversationId: string | null;
        result: SlashCandidatesResult;
    } | null>(null);
    const [slashLoading, setSlashLoading] = useState(false);
    /** /model 二层的搜索词。 */
    const [modelQuery, setModelQuery] = useState('');
    /** /model 本地切换反馈（组件内兜底展示；外层 modelNotice 优先）。 */
    const [localModelNotice, setLocalModelNotice] = useState('');
    /** 063：标签感知撤销栈（受控 textarea 原生 undo 已随程序化赋值断裂）。 */
    const undoRef = useRef(createTagUndoStack());
    const conversationIdRefForMention = useRef<string | null>(null);
    useEffect(() => {
        conversationIdRefForMention.current = mentionConversationId;
    }, [mentionConversationId]);
    const activeModelNotice = modelNotice || localModelNotice;
    useEffect(() => {
        if (!localModelNotice)
            return;
        const timer = window.setTimeout(() => setLocalModelNotice(''), 2600);
        return () => window.clearTimeout(timer);
    }, [localModelNotice]);
    const inlineTagList = useMemo(() => [
        ...skills.map((skill) => ({ kind: 'skill' as const, tag: skill })),
        ...references.filter(isInlineReference).map((reference) => ({ kind: 'reference' as const, tag: reference })),
    ], [skills, references]);
    /** 当前光标 token（含「与既有标签重叠不触发」守卫——已有标签不是新查询）。 */
    const activeToken = useMemo<ComposerTokenState | null>(() => {
        const token = detectComposerToken(value, caret);
        if (token?.trigger === '/' && !adapter?.listSlashCandidates)
            return null;
        if (token?.trigger === '@' && !adapter?.listReferences)
            return null;
        if (!token)
            return null;
        for (const entry of inlineTagList) {
            const range = tokenRangeInText(value, entry);
            if (range && range[0] === token.start && range[1] <= token.end)
                return null;
        }
        return token;
    }, [value, caret, inlineTagList, adapter?.listSlashCandidates, adapter?.listReferences]);
    // token → 面板开关（dismissed 签名挡住「同一 token 关闭后立刻重弹」）。
    useEffect(() => {
        if (!activeToken) {
            if (panel?.kind === 'slash' || panel?.kind === 'mention') {
                setPanel(null);
                setPanelIndex(0);
            }
            dismissedRef.current = null;
            return;
        }
        if (panel?.kind === 'model')
            return; // 二层开着：Esc 逐层退，不随 token 跳变
        const signature = `${activeToken.trigger}:${value.slice(activeToken.start, activeToken.end)}`;
        if (dismissedRef.current === signature)
            return;
        if (activeToken.trigger === '/' && panel?.kind !== 'slash') {
            setPanel({ kind: 'slash' });
            setPanelIndex(0);
        }
        if (activeToken.trigger === '@' && panel?.kind !== 'mention') {
            setPanel({ kind: 'mention' });
            setPanelIndex(0);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeToken?.trigger, activeToken?.start, activeToken?.end, value]);
    // slash 面板打开 → 拉候选（按会话缓存；失败不缓存——重开可重试）。
    useEffect(() => {
        if (panel?.kind !== 'slash' || !bridge?.listSlashCandidates)
            return;
        const conversationId = conversationIdRefForMention.current;
        if (slashResult && slashResult.conversationId === conversationId && !slashResult.result.skillsError)
            return;
        let cancelled = false;
        setSlashLoading(true);
        bridge
            .listSlashCandidates(conversationId ?? '')
            .then((result) => {
            if (!cancelled)
                setSlashResult({ conversationId, result });
        })
            .catch(() => {
            if (!cancelled)
                setSlashResult({ conversationId, result: { commands: [], skills: [], skillsError: '技能暂时没加载出来，可重试' } });
        })
            .finally(() => {
            if (!cancelled)
                setSlashLoading(false);
        });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [panel?.kind, mentionConversationId, slashResult?.conversationId, bridge?.listSlashCandidates]);
    // @词 防抖查候选（主进程按会话+工作区过滤；旧三类与行内四类同通道）。
    useEffect(() => {
        if (panel?.kind !== 'mention' || !activeToken || activeToken.trigger !== '@' || !onAddReference) {
            setMentionItems([]);
            setMentionLoading(false);
            return;
        }
        const conversationId = conversationIdRefForMention.current ?? '';
        const query = activeToken.query;
        setMentionLoading(true);
        let cancelled = false;
        const timer = window.setTimeout(() => {
            void bridge
                ?.listReferences?.(conversationId, query, mentionWorkspaceId ?? undefined)
                .then((result) => {
                if (cancelled)
                    return;
                setMentionItems(result?.candidates ?? []);
                setMentionLoading(false);
            })
                .catch(() => {
                if (cancelled)
                    return;
                setMentionItems([]);
                setMentionLoading(false);
            });
        }, 200);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [panel?.kind, activeToken?.trigger, activeToken?.query, activeToken?.start, onAddReference, mentionWorkspaceId, mentionConversationId, bridge?.listReferences]);
    const slashCommands = useMemo(() => filterSlashEntries(slashResult?.result.commands ?? [], activeToken?.trigger === '/' ? activeToken.query : ''), [slashResult, activeToken?.trigger, activeToken?.query]);
    const slashSkills = useMemo(() => filterSlashEntries(slashResult?.result.skills ?? [], activeToken?.trigger === '/' ? activeToken.query : ''), [slashResult, activeToken?.trigger, activeToken?.query]);
    const mentionGroups = useMemo(() => {
        const groups = new Map<string, MessageReferenceView[]>();
        for (const candidate of mentionItems) {
            const bucket = groups.get(candidate.kind) ?? [];
            bucket.push(candidate);
            groups.set(candidate.kind, bucket);
        }
        return [...groups.entries()]
            .sort((a, b) => REFERENCE_GROUP_ORDER.indexOf(a[0]) - REFERENCE_GROUP_ORDER.indexOf(b[0]));
    }, [mentionItems]);
    /** 二层模型列表（与模型按钮同源：分组、自动路由、禁用原因）。 */
    const modelEntries = useMemo(() => {
        if (panel?.kind !== 'model')
            return [];
        const keyword = modelQuery.trim().toLowerCase();
        const out: Array<{
            modelKey: string;
            model: string;
            providerName: string;
            hasApiKey: boolean;
            isAuto?: boolean;
        }> = [];
        const directory = modelProfiles;
        const { ready: autoReady, hint: autoHint } = modelPolicyView(directory);
        if (!botEnvironment && (!keyword || `自动路由 auto ${autoHint}`.toLowerCase().includes(keyword))) {
            out.push({ modelKey: 'auto', model: `自动路由 · ${autoHint}`, providerName: '', hasApiKey: autoReady, isAuto: true });
        }
        for (const provider of directory?.providers ?? []) {
            for (const model of provider.models) {
                if (keyword && !provider.name.toLowerCase().includes(keyword) && !model.model.toLowerCase().includes(keyword))
                    continue;
                out.push({ modelKey: model.modelKey, model: model.model || '未填型号', providerName: provider.name, hasApiKey: provider.hasApiKey });
            }
        }
        return out;
    }, [panel?.kind, modelQuery, modelProfiles, botEnvironment]);
    /** 面板可选择条目（禁用项留位但键盘跳过；跨分组顺序＝展示顺序）。 */
    const panelItems = useMemo<PanelItem[]>(() => {
        if (panel?.kind === 'slash') {
            return [
                ...slashCommands.map((item) => ({ key: `command:${item.id}`, disabled: false })),
                ...slashSkills.map((item) => ({ key: `skill:${item.source}:${item.skillId}`, disabled: false })),
            ];
        }
        if (panel?.kind === 'mention') {
            return mentionGroups.flatMap(([, items]) => items.map((item) => ({ key: `${item.kind}:${item.key}`, disabled: false })));
        }
        if (panel?.kind === 'model') {
            return modelEntries.map((item) => ({ key: `model:${item.modelKey}`, disabled: !item.hasApiKey }));
        }
        return [];
    }, [panel?.kind, slashCommands, slashSkills, mentionGroups, modelEntries]);
    const enabledPanelCount = panelItems.filter((item) => !item.disabled).length;
    // 查询变化后高亮复位；列表变化后校正越界索引。
    useEffect(() => { setPanelIndex(0); }, [activeToken?.query, panel?.kind, modelQuery]);
    useEffect(() => {
        if (panelIndex >= panelItems.length)
            setPanelIndex(Math.max(0, panelItems.length - 1));
    }, [panelItems.length, panelIndex]);
    // 标签与正文同步：token 被部分编辑/删除即丢身份（不残留隐藏技能/引用）。
    useEffect(() => {
        if (!onSetSkills && !onSetReferences)
            return;
        const nextSkills = syncSkillsWithText(value, skills);
        const nextReferences = syncReferencesWithText(value, references);
        if (nextSkills.length !== skills.length)
            onSetSkills?.(nextSkills);
        if (nextReferences.length !== references.length)
            onSetReferences?.(nextReferences);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);
    // 026 R-10：外部聚焦信号（「继续讨论」关详情后把用户带回可输入的对话框）。
    // 只认「变化」不认初值：主界面与设置页互为整屏替换，本组件随之时卸时挂，
    // 初值也聚焦的话每次关设置页都会抢一次焦点。比较要在读写 ref 之间完成——
    // StrictMode 双执行下同一值第二次跑也必须判为「无变化」（dev 常态）。
    useEffect(() => {
        const prev = prevTokenRef.current;
        prevTokenRef.current = focusToken ?? 0;
        if (prev === null || prev === (focusToken ?? 0))
            return;
        if (focusToken)
            textareaRef.current?.focus({ preventScroll: true });
    }, [focusToken]);
    // 行高自适应：内容变化／发送清空后重算；不修改窗口与面板尺寸。
    useLayoutEffect(() => {
        const el = textareaRef.current;
        if (!el)
            return;
        el.style.height = 'auto';
        el.style.height = `${Math.max(minHeight, Math.min(el.scrollHeight, maxHeight))}px`;
    }, [value, minHeight, maxHeight]);
    // 面板宽度变化（收起/展开切换）后按当前内容重算一次。
    useEffect(() => {
        const el = textareaRef.current;
        if (!el || typeof ResizeObserver === 'undefined')
            return;
        let lastWidth = -1;
        let frame: number | null = null;
        const observer = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width ?? el.clientWidth;
            if (width === lastWidth)
                return;
            lastWidth = width;
            // 高度由自身内容更新；观察器只响应宽度，且不在观察器回调中触发布局写入。
            if (frame !== null)
                cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                frame = null;
                el.style.height = 'auto';
                el.style.height = `${Math.max(minHeight, Math.min(el.scrollHeight, maxHeight))}px`;
            });
        });
        observer.observe(el);
        return () => {
            observer.disconnect();
            if (frame !== null)
                cancelAnimationFrame(frame);
        };
    }, [minHeight, maxHeight]);
    const applyCaret = (position: number) => {
        setCaret(position);
        requestAnimationFrame(() => {
            const el = textareaRef.current;
            el?.focus({ preventScroll: true });
            el?.setSelectionRange(position, position);
        });
    };
    /** 替换当前 token（[start, end)）为给定内容并落光标。 */
    const replaceTokenWith = (token: ComposerTokenState, insert: string) => {
        const next = value.slice(0, token.start) + insert + value.slice(token.end);
        onChange(next);
        applyCaret(token.start + insert.length);
    };
    /** 关闭面板并记录 dismiss 签名（Esc/选择后同 token 不立刻重弹）。 */
    const dismissPanel = (token: ComposerTokenState | null) => {
        if (token)
            dismissedRef.current = `${token.trigger}:${value.slice(token.start, token.end)}`;
        setPanel(null);
        setPanelIndex(0);
        setModelQuery('');
    };
    /** 选中技能：token → 行内标签（唯一名），身份进草稿 skills。 */
    const selectSkill = (token: ComposerTokenState, skill: {
        skillId: string;
        name: string;
        description?: string;
        source: 'library' | 'project';
    }) => {
        const taken = skills.map(tokenOfSkill);
        const label = uniqueTokenLabel(skill.name, taken);
        const selection: SkillSelectionView = {
            token: label,
            name: skill.name,
            source: skill.source,
            skillId: skill.skillId,
            ...(skill.description ? { description: skill.description } : {}),
        };
        undoRef.current.pushCheckpoint({ text: value, skills, references, caret });
        const withoutToken = value.slice(0, token.start) + value.slice(token.end);
        const insertion = insertTagToken(withoutToken, token.start, label);
        onChange(insertion.text);
        onSetSkills?.([...skills, selection]);
        dismissPanel(token);
        applyCaret(insertion.caret);
    };
    /** 选中引用：行内四类 → 行内标签；旧三类 → 原托盘芯片路径（@名称 文本保留）。 */
    const selectReference = (token: ComposerTokenState, candidate: MessageReferenceView) => {
        if (!isInlineReference(candidate)) {
            // 028 既有路径：替换为 `@名称 ` 文本＋托盘芯片。
            undoRef.current.pushCheckpoint({ text: value, skills, references, caret });
            replaceTokenWith(token, `@${candidate.name} `);
            onAddReference?.(candidate);
            setPanel(null);
            setPanelIndex(0);
            dismissedRef.current = null;
            return;
        }
        const taken = references.filter(isInlineReference).map(tokenOfReference);
        const label = uniqueTokenLabel(candidate.name, taken);
        const reference: MessageReferenceView = { ...candidate, name: label };
        undoRef.current.pushCheckpoint({ text: value, skills, references, caret });
        const withoutToken = value.slice(0, token.start) + value.slice(token.end);
        const insertion = insertTagToken(withoutToken, token.start, `@${label}`);
        onChange(insertion.text);
        onSetReferences?.([...references, reference]);
        dismissPanel(token);
        applyCaret(insertion.caret);
    };
    /** /model 二层：确认模型——本地切换，消费命令片段，正文其余部分保留。 */
    const selectModel = (token: ComposerTokenState, profileId: string) => {
        undoRef.current.pushCheckpoint({ text: value, skills, references, caret });
        replaceTokenWith(token, '');
        onSelectModelProfile?.(profileId);
        setLocalModelNotice('已选择，后续新提交使用');
        dismissPanel(token);
    };
    const movePanelIndex = (delta: number) => {
        if (!panelItems.length)
            return;
        setPanelIndex((index) => {
            let next = index;
            for (let step = 0; step < panelItems.length; step += 1) {
                next = (next + delta + panelItems.length) % panelItems.length;
                if (!panelItems[next].disabled)
                    return next;
            }
            return index;
        });
    };
    /** 面板内确认（Enter/Tab/点击共用；index 对应 panelItems 次序）。 */
    const confirmPanelItem = (index: number) => {
        const item = panelItems[index];
        if (!item || item.disabled || !activeToken)
            return;
        if (panel?.kind === 'slash') {
            if (index < slashCommands.length) {
                // /model → 进入二层（token 与正文保留；取消可回）。
                setModelQuery('');
                setPanel({ kind: 'model' });
                setPanelIndex(0);
                return;
            }
            const skill = slashSkills[index - slashCommands.length];
            if (skill)
                selectSkill(activeToken, skill);
            return;
        }
        if (panel?.kind === 'mention') {
            const flat = mentionGroups.flatMap(([, items]) => items);
            const candidate = flat[index];
            if (candidate)
                selectReference(activeToken, candidate);
            return;
        }
        if (panel?.kind === 'model') {
            const entry = modelEntries[index];
            if (entry)
                selectModel(activeToken, entry.modelKey);
        }
    };
    // ---------- 键盘 ----------
    const snapshotForUndo = (): TagUndoState => ({ text: value, skills, references, caret });
    const applyUndoState = (state: TagUndoState | null) => {
        if (!state)
            return;
        onChange(state.text);
        onSetSkills?.(state.skills);
        onSetReferences?.(state.references);
        applyCaret(Math.min(state.caret, state.text.length));
    };
    const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (queueEditSaving) {
            event.preventDefault();
            return;
        }
        const composing = event.nativeEvent.isComposing || event.keyCode === 229;
        // 063：标签感知撤销（受控 textarea 的原生 undo 不可靠；Cmd/Ctrl+Z）。
        if (!composing && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            applyUndoState(event.shiftKey ? undoRef.current.redo(snapshotForUndo()) : undoRef.current.undo(snapshotForUndo()));
            return;
        }
        // 063：原子删除——Backspace/Delete 紧贴标签边界时整删。
        if (!composing && !panel && inlineTagList.length) {
            const el = textareaRef.current;
            const start = el?.selectionStart ?? caret;
            const end = el?.selectionEnd ?? caret;
            if (event.key === 'Backspace') {
                const result = deleteTagBackward(value, start, end, inlineTagList);
                if (result.deleted) {
                    event.preventDefault();
                    undoRef.current.pushCheckpoint(snapshotForUndo());
                    onChange(result.text);
                    applyCaret(result.caret);
                    return;
                }
            }
            if (event.key === 'Delete') {
                const result = deleteTagForward(value, start, end, inlineTagList);
                if (result.deleted) {
                    event.preventDefault();
                    undoRef.current.pushCheckpoint(snapshotForUndo());
                    onChange(result.text);
                    applyCaret(result.caret);
                    return;
                }
            }
        }
        // 063：候选面板键盘（IME 组词期不接管；Shift+Enter 仍换行、Shift+Tab 走焦点）。
        if (panel && !composing) {
            if (event.key === 'Escape') {
                event.preventDefault();
                if (panel.kind === 'model') {
                    setModelQuery('');
                    setPanel({ kind: 'slash' }); // 二层 Esc → 回首层（token 保留）
                    setPanelIndex(0);
                    return;
                }
                dismissPanel(activeToken);
                textareaRef.current?.focus({ preventScroll: true });
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                movePanelIndex(event.key === 'ArrowDown' ? 1 : -1);
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (!event.repeat && enabledPanelCount > 0)
                    confirmPanelItem(panelIndex);
                return; // 无可选项时不落入发送分支（防误发）
            }
            if (event.key === 'Tab' && !event.shiftKey && enabledPanelCount > 0) {
                event.preventDefault();
                confirmPanelItem(panelIndex);
                return;
            }
        }
        if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
            !event.shiftKey &&
            inputHistory.length &&
            !busy &&
            !panel &&
            shouldTakeOverArrow(event.key, value, textareaRef.current?.selectionStart ?? value.length, composing)) {
            event.preventDefault();
            if (event.key === 'ArrowUp') {
                const next = browseOlder(browse, inputHistory, value);
                const text = browseText(next, inputHistory);
                if (text != null) {
                    setBrowse(next);
                    onChange(text);
                }
                return;
            }
            const newer = browseNewer(browse, inputHistory);
            if (browse.index != null) {
                setBrowse(newer.index == null ? HISTORY_BROWSE_IDLE : newer);
                if (newer.text != null)
                    onChange(newer.text);
            }
            return;
        }
        if (event.key === 'Escape' && browse.index != null) {
            event.preventDefault();
            onChange(browse.cachedDraft ?? '');
            setBrowse(HISTORY_BROWSE_IDLE);
            return;
        }
        if (layout === 'touch' && !(event.metaKey || event.ctrlKey))
            return;
        if (event.key !== 'Enter' || event.shiftKey)
            return; // Shift+Enter 留给换行
        // IME 候选确认不发送（isComposing 与旧键码 229 双保险）；长按不重复提交。
        if (event.repeat ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229) {
            return;
        }
        event.preventDefault();
        if (canSend)
            onSend();
    };
    // 028 R-02：粘贴图片 → data URL 上抛登记；纯文字粘贴走浏览器默认行为。
    const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
        if (!onAttachPaste)
            return;
        for (const item of event.clipboardData?.items ?? []) {
            if (item.type?.startsWith('image/')) {
                const file = item.getAsFile();
                if (!file)
                    continue;
                event.preventDefault();
                const reader = new FileReader();
                reader.onload = () => {
                    if (typeof reader.result === 'string')
                        onAttachPaste?.(reader.result);
                };
                reader.readAsDataURL(file);
                return;
            }
        }
    };
    // 063：复制/剪切的对外可读表示——标签转 `[技能：名称]`／`[引用：名称]`。
    const externalLength = (text: string) => toExternalPlainText(text, { skills, references }).length;
    const handleCopy = (event: ReactClipboardEvent<HTMLTextAreaElement>, alsoCut = false) => {
        if (!inlineTagList.length)
            return;
        const el = textareaRef.current;
        const start = el?.selectionStart ?? 0;
        const end = el?.selectionEnd ?? value.length;
        if (start === end)
            return;
        const clipped = toExternalPlainText(value.slice(0, end), { skills, references })
            .slice(externalLength(value.slice(0, start)));
        event.preventDefault();
        event.clipboardData.setData('text/plain', clipped);
        if (alsoCut) {
            undoRef.current.pushCheckpoint(snapshotForUndo());
            onChange(value.slice(0, start) + value.slice(end));
            applyCaret(start);
        }
    };
    // 028 R-02：拖入文件——沙箱渲染层拿不到 File.path，经 preload 暴露的
    // webUtils.getPathForFile 取受控路径（取不到时提示走「附加」按钮）。
    const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
        draggingRef.current = 0;
        setDragActive(false);
        if (!onAttachDrop)
            return;
        const file = event.dataTransfer?.files?.[0];
        if (!file)
            return;
        event.preventDefault();
        const raw = bridge?.pathForFile?.(file) ?? '';
        const filePath = typeof raw === 'string' ? raw : '';
        if (filePath)
            onAttachDrop(filePath);
    };
    const hasUnreadyAttachment = attachments.some((item) => item.status !== 'ready');
    const hasOutgoingContent = Boolean(value.trim()) || attachments.length > 0 || hasAttachments;
    // 063：候选面板打开时不发送（先选择能力或 Esc）；停止键不受影响。
    const panelOpen = panel != null;
    const canSend = hasOutgoingContent && !pendingSpeech && modelReady && !hasUnreadyAttachment && !sendBlocked && !readOnly && !queueEditSaving && !panelOpen;
    const primaryIsStop = !queueEditing && busy && Boolean(onStopTurn) && !hasOutgoingContent;
    const primaryLabel = primaryIsStop ? '停止当前任务' : queueEditing ? '保存修改' : busy ? '加入队列' : '发送消息';
    const handleSendClick = () => {
        // 063：整条输入只是 /model 命令时，发送＝进入模型选择，不交给模型。
        if (panel?.kind === 'slash' && activeToken && activeToken.trigger === '/') {
            const trimmed = value.trim();
            const tokenText = value.slice(activeToken.start, activeToken.end);
            const wholeToken = trimmed === tokenText.trim();
            const keyword = activeToken.query.trim().toLowerCase();
            const modelListed = slashCommands.some((item) => item.id === 'model');
            if (wholeToken && (modelListed && ('model'.startsWith(keyword) || keyword === 'model' || keyword === ''))) {
                setModelQuery('');
                setPanel({ kind: 'model' });
                setPanelIndex(0);
                return;
            }
        }
        onSend();
    };
    // 条件提示（另计高度，不常驻占行）：面板提示 > 工作区失效 > 待提交语音 > 附件未就绪 > 模型未配置 > 通话提示。
    const hint = panelOpen
        ? { id: hintId, text: activeToken?.trigger === '@' ? '选择一项引用，或按 Esc 返回输入' : PANEL_OPEN_SEND_HINT }
        : sendBlocked
            ? sendBlockedHint === '' ? null : { id: hintId, text: sendBlockedHint ?? '工作区目录不可用，重新选择后才能发送' }
            : pendingSpeech
                ? { id: hintId, text: '先完成当前语音，再发送文字' }
                : hasUnreadyAttachment
                    ? { id: hintId, text: '有附件还没准备好，移除或稍候后再发送' }
                    : !modelReady
                        ? { id: hintId, text: '配置主脑模型后即可发送' }
                        : callActive && !header
                            ? { id: hintId, text: '通话中，麦克风仍在聆听' }
                            : null;
    const segments = useMemo(() => (inlineTagList.length ? segmentTaggedText(value, { skills, references }) : [{ type: 'text' as const, text: value }]), [value, skills, references, inlineTagList.length]);
    const syncMirrorScroll = () => {
        if (mirrorRef.current && textareaRef.current) {
            mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
        }
    };
    /** 光标进入标签内部时贴到较近边界（textarea 挡不住，用吸附近似原子性）。 */
    const handleSelect = () => {
        const el = textareaRef.current;
        if (!el)
            return;
        if (el.selectionStart !== el.selectionEnd) {
            setCaret(el.selectionStart);
            return;
        }
        const snapped = inlineTagList.length ? snapCaretToTagBoundary(value, el.selectionStart, inlineTagList) : el.selectionStart;
        if (snapped !== el.selectionStart)
            el.setSelectionRange(snapped, snapped);
        setCaret(snapped);
    };
    const legacyReferences = references.filter((reference) => !isInlineReference(reference));
    if (layout === 'touch')
        return <div className="input-dock"><div className="composer-surface">
    {queueEditing ? <div className="composer-editing" role="status"><span>正在修改待发送消息</span><button type="button" className="text-button" disabled={sendBlocked} onClick={onCancelQueueEdit}>取消</button></div> : null}
    {children}
    <form className="mobile-composer" aria-label="消息输入区" onSubmit={event => { event.preventDefault(); if (canSend)
            onSend(); }}>
      <textarea ref={textareaRef} id={instanceId} aria-label="消息" rows={1} readOnly={readOnly} value={value} onChange={event => { undoRef.current.push(snapshotForUndo()); setCaret(event.target.selectionStart); onChange(event.target.value); }} onKeyDown={handleKeyDown} placeholder={placeholder ?? (queueEditing ? '修改待发送消息…' : offline ? '连接恢复后发送…' : '发送消息…')} enterKeyHint="enter"/>
      <div className="composer-toolbar">{toolbar}{trailing ? <div className="composer-options">{trailing}</div> : <span className="toolbar-spacer"/>}
        {busy ? <button type="button" className="icon-control stop-control" aria-label="停止任务" title="停止任务" disabled={offline || stopBlocked || readOnly} onClick={onStopTurn}><Square size={14}/></button> : null}
        <button className="send-control" type="submit" disabled={!canSend} aria-label={queueEditing ? '保存修改' : busy ? '加入待发送' : '发送消息'}><ArrowUp size={20}/></button>
      </div>
    </form>
  </div></div>;
    return (<div className={`text-composer${dragActive ? ' is-drag-over' : ''}`} onDragEnter={(event) => {
            if (![...(event.dataTransfer?.types ?? [])].includes('Files'))
                return;
            draggingRef.current += 1;
            setDragActive(true);
        }} onDragOver={(event) => {
            if ([...(event.dataTransfer?.types ?? [])].includes('Files'))
                event.preventDefault();
        }} onDragLeave={() => {
            if (draggingRef.current > 0)
                draggingRef.current -= 1;
            if (draggingRef.current === 0)
                setDragActive(false);
        }} onDrop={handleDrop}>
      {header}
      {queueEditing ? <div className="queue-composer-editing" role="status"><span>编辑待发送消息 · 保存后保留原顺序</span><button type="button" disabled={queueEditSaving} onClick={onCancelQueueEdit}>取消</button></div> : null}
      {activeModelNotice ? (<p className="text-composer-hint text-composer-model-notice" role="status">{activeModelNotice}</p>) : null}
      {hint ? (<p className="text-composer-hint" id={hint.id} role="status">
          {hint.text}
          {!modelReady && onOpenSettings ? (<button type="button" className="text-composer-hint-link" onClick={onOpenSettings}>
              去设置
            </button>) : null}
        </p>) : null}

      {/* 028 R-03：附件托盘——发送前确认范围（预览进 027 宿主、可移除、失败说明）。 */}
      {attachments.length || attachError ? (<div className="h24-attach-tray h-attachment-tray" aria-label="本条消息的附件">
          {attachments.map((attachment) => <AttachmentCard key={attachment.attachmentId} attachment={attachment} onOpen={onPreviewAttachment ? () => onPreviewAttachment(attachment.conversationId, attachment.attachmentId) : undefined} onRemove={onRemoveAttachment ? () => onRemoveAttachment(attachment.attachmentId) : undefined}/>)}
          {attachError ? (<p className="h24-attach-error" role="alert">
              {attachError}
            </p>) : null}
        </div>) : null}

      {/* 028 二批：旧三类 `@` 引用芯片——带身份的引用（名称只是展示；删除芯片不破坏正文）。
            063：行内四类引用不再进托盘（正文行内标签）。 */}
      {legacyReferences.length ? (<div className="h24-attach-tray" aria-label="本条消息的引用">
          {legacyReferences.map((reference) => (<div key={reference.key} className="h24-attach-card" data-kind="reference">
              <button type="button" className="h24-attach-open" title={reference.kind === 'context' ? '当前对象引用（无独立预览）' : '打开这个引用'} onClick={reference.kind !== 'context' && onPreviewReference
                    ? () => onPreviewReference(reference)
                    : undefined}>
                <AtSign className="size-3.5" aria-hidden="true"/>
                <span className="h24-attach-name" title={`${reference.name} · ${reference.subtitle}`}>
                  {reference.name}
                </span>
                <small className="h24-attach-meta">{reference.subtitle}</small>
              </button>
              <button type="button" className="h24-attach-remove" aria-label={`移除引用 ${reference.name}`} title="移除引用（正文里的 @文字保留）" onClick={onRemoveReference ? () => onRemoveReference(reference.key) : undefined}>
                <X className="size-3" aria-hidden="true"/>
              </button>
            </div>))}
        </div>) : null}

      <div className="text-composer-edit">
        {/* 063：标签镜像层——与 textarea 同类名同排版（透明文字），标签区间画高亮。 */}
        <div className="text-composer-input text-composer-mirror" aria-hidden="true" ref={mirrorRef}>
          {segments.map((segment, index) => segment.type === 'text' ? (<span key={index}>{segment.text}</span>) : (<span key={index} className="composer-inline-tag" data-kind={segment.type === 'skill' ? 'skill' : segment.reference.kind} title={segment.type === 'skill'
                ? `技能 · ${segment.skill.name}${segment.skill.description ? ` · ${segment.skill.description}` : ''}`
                : segment.reference.subtitle}>
                {segment.text}
              </span>))}
          {value.endsWith('\n') ? '\u200b' : null}
        </div>
        <textarea ref={textareaRef} className="text-composer-input" value={value} rows={1} placeholder={busy && !value.trim()
            ? waiting ? '可继续输入，发送后排队…' : '正在回应，可先写下一句…'
            : fresh
                ? '问点什么，或交给 Hemi 一件事…'
                : '继续聊聊，或交给 Hemi 一件事…'} aria-label="输入消息" aria-describedby={hint ? `${descriptionId} ${hint.id}` : descriptionId} spellCheck={false} readOnly={queueEditSaving || readOnly} onChange={(event) => {
            undoRef.current.push(snapshotForUndo());
            setCaret(event.target.selectionStart ?? event.target.value.length);
            onChange(event.target.value);
        }} onScroll={syncMirrorScroll} onSelect={handleSelect} onPaste={handlePaste} onCopy={(event) => handleCopy(event)} onCut={(event) => handleCopy(event, true)} onKeyDown={handleKeyDown}/>
      </div>
      <div className="text-composer-toolbar">
        <div className="text-composer-tools">
          {toolbar}
        </div>
        {/* ZCode 同位：模型选择等提交控制簇在发送键左侧 */}
        {trailing}
        {busy && onStopTurn && !primaryIsStop ? (<button type="button" className="text-composer-stop" disabled={readOnly} onClick={onStopTurn} aria-label="停止当前任务" title="停止当前任务及其所属工作">
            <Square className="size-3 fill-current" aria-hidden="true"/>
          </button>) : null}
        <button type="button" className={`text-composer-send${primaryIsStop ? ' is-stop' : ''}`} data-action={primaryIsStop ? 'stop' : queueEditing ? 'save' : 'send'} onClick={primaryIsStop ? onStopTurn : handleSendClick} disabled={readOnly || (primaryIsStop ? false : !canSend)} aria-label={panelOpen ? PANEL_OPEN_SEND_HINT : primaryLabel} title={queueEditing ? 'Enter 保存修改，保留原队列位置' : primaryIsStop ? '停止当前任务及其所属工作' : busy ? '加入待发送队列' : composerHint}>
          {primaryIsStop ? <Square className="size-3.5 fill-current" aria-hidden="true"/> : queueEditing ? <Check className="size-4" aria-hidden="true"/> : <ArrowUp className="size-4" aria-hidden="true"/>}
        </button>
      </div>

      {/* 063：@ 引用候选（行内四类分组＋旧三类兼容区；键盘↑↓/Enter/Tab/Esc）。 */}
      {panel?.kind === 'mention' && activeToken ? (<div className="h24-mention-menu h63-panel" role="menu" aria-label="引用候选">
          {mentionLoading ? <p className="h63-panel-status">正在查找…</p> : null}
          {!mentionLoading && !mentionItems.length ? (<p className="h63-panel-status">没找到相关引用——改关键词，或按 Esc 返回输入</p>) : null}
          {mentionGroups.map(([kind, items]) => {
                const baseIndex = mentionGroups
                    .slice(0, mentionGroups.findIndex(([group]) => group === kind))
                    .reduce((acc, [, bucket]) => acc + bucket.length, 0);
                return (<div key={kind} className="h63-panel-group" data-group={kind}>
                {items.map((candidate, offset) => {
                        const flatIndex = baseIndex + offset;
                        return (<button key={`${candidate.kind}:${candidate.key}`} type="button" role="menuitem" className="h24-model-item h63-panel-item" data-active={flatIndex === panelIndex ? 'true' : undefined} onMouseEnter={() => setPanelIndex(flatIndex)} onClick={() => selectReference(activeToken, candidate)}>
                      {candidate.kind === 'workflow' ? <Workflow className="size-3 shrink-0" aria-hidden="true"/>
                                : candidate.kind === 'folder' ? <Folder className="size-3 shrink-0" aria-hidden="true"/>
                                    : candidate.kind === 'conversation' ? <MessageSquareText className="size-3 shrink-0" aria-hidden="true"/>
                                        : candidate.kind === 'file' ? <FileText className="size-3 shrink-0" aria-hidden="true"/>
                                            : <AtSign className="size-3 shrink-0" aria-hidden="true"/>}
                      <span className="h24-model-item-name">{candidate.name}</span>
                      <span className="h24-model-item-model">{candidate.subtitle}</span>
                    </button>);
                    })}
              </div>);
            })}
        </div>) : null}

      {/* 063：/ 首层——命令（/model）＋技能分组。 */}
      {panel?.kind === 'slash' && activeToken ? (<div className="h24-command-menu h63-panel" role="menu" aria-label="命令与技能">
          <p className="h24-command-hint">命令与技能 · ↑/↓ 选择，Enter 确认，Esc 返回输入</p>
          {slashLoading ? <p className="h63-panel-status">正在读取技能…</p> : null}
          {!slashLoading && !slashCommands.length && !slashSkills.length ? (<p className="h63-panel-status">
              {slashResult?.result.skillsError ?? '没找到相关命令或技能——改关键词，或按 Esc 返回输入'}
            </p>) : null}
          {slashCommands.length ? (<div className="h63-panel-group" data-group="命令">
              {slashCommands.map((item, offset) => (<button key={`command:${item.id}`} type="button" role="menuitem" className="h24-model-item h63-panel-item" data-active={offset === panelIndex ? 'true' : undefined} onMouseEnter={() => setPanelIndex(offset)} onClick={() => confirmPanelItem(offset)}>
                  <Slash className="size-3 shrink-0" aria-hidden="true"/>
                  <span className="h24-model-item-name">{item.name}</span>
                  <span className="h24-model-item-model">{item.description}</span>
                </button>))}
            </div>) : null}
          {slashSkills.length ? (<div className="h63-panel-group" data-group="技能">
              {slashSkills.map((item, offset) => {
                    const itemIndex = slashCommands.length + offset;
                    return (<button key={`skill:${item.source}:${item.skillId}`} type="button" role="menuitem" className="h24-model-item h63-panel-item" data-active={itemIndex === panelIndex ? 'true' : undefined} onMouseEnter={() => setPanelIndex(itemIndex)} onClick={() => confirmPanelItem(itemIndex)}>
                    <Sparkles className="size-3 shrink-0" aria-hidden="true"/>
                    <span className="h24-model-item-name">{item.name}</span>
                    <span className="h24-model-item-model">
                      {item.source === 'project' ? '项目技能' : '技能库'}
                      {item.description ? ` · ${item.description.slice(0, 40)}` : ''}
                    </span>
                  </button>);
                })}
            </div>) : !slashLoading && !slashResult?.result.skills.length ? (slashResult?.result.skillsError ? null : <p className="h63-panel-status">暂无可用技能</p>) : null}
        </div>) : null}

      {/* 063：/model 二层——与模型按钮同源的选择器（自动路由/禁用原因/搜索）。 */}
      {panel?.kind === 'model' ? (<div className="h24-command-menu h63-panel" role="menu" aria-label="切换模型">
          <div className="h63-panel-search">
            <input value={modelQuery} placeholder="搜索名称 / 型号 / 供应商" aria-label="搜索模型" autoFocus onChange={(event) => setModelQuery(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    setModelQuery('');
                    setPanel({ kind: 'slash' });
                    setPanelIndex(0);
                    textareaRef.current?.focus({ preventScroll: true });
                }
            }}/>
          </div>
          {modelProfiles?.envOverride ? (<p className="h63-panel-status">环境变量覆盖中：切换要等环境变量移除后才生效。</p>) : null}
          {modelEntries.length ? modelEntries.map((entry, index) => (<button key={`model:${entry.modelKey}`} type="button" role="menuitemradio" className="h24-model-item h63-panel-item" data-active={index === panelIndex ? 'true' : undefined} disabled={!entry.hasApiKey} title={!entry.hasApiKey ? (entry.isAuto ? '自动路由未配置（模型路由弹窗里配主 agent）' : '供应商尚未连接，到 设置 → 模型 完成登录或密钥配置后可选') : undefined} onMouseEnter={() => { if (entry.hasApiKey)
                setPanelIndex(index); }} onClick={() => { if (entry.hasApiKey && activeToken)
                selectModel(activeToken, entry.modelKey); }}>
              <span className="h24-model-item-name">{entry.model}</span>
              {entry.providerName ? <span className="h24-model-item-model">{entry.providerName}</span> : null}
              {!entry.hasApiKey ? <small>{entry.isAuto ? '未配置' : '未配 Key'}</small> : null}
            </button>)) : <p className="h63-panel-status">没有匹配的模型。</p>}
          <p className="h24-command-hint">Esc 返回命令列表；选择只影响后续新提交</p>
        </div>) : null}
      <span id={descriptionId} className="sr-only">
        {composerHint}
      </span>
    </div>);
}
