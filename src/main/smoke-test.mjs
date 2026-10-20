/**
 * Electron 冒烟测试：在真实窗口里把主要行为跑一遍（主窗口/悬浮球/悬浮字幕条、
 * 拖动、逐句淡出、退场动画、连续对话压测），断言失败抛异常。
 *
 * 由 main.mjs 在 HEMI_SMOKE_TEST=1 时调用；拆出来是为了让 main.mjs 只留应用装配。
 * 这里只做「等不到就算失败」的时间上界，不复制渲染层的动画时长常量。
 */
import { app, screen } from 'electron';

import {
  FLOATING_CAPTION_MAX_WIDTH,
  FLOATING_CAPTION_MIN_WIDTH,
  FLOATING_CAPTION_PADDING,
  FLOATING_CAPTION_SIZE,
} from './lib/floating-caption-layout.mjs';

const POLL_INTERVAL_MS = 100;
/** 单步等待上限：够宽松，只看「最终有没有做到」。 */
const STEP_TIMEOUT_MS = 20000;

/** 说话中：单轮焦点只显示正在识别的这句（超长内容换行展示全文）。 */
const START_STATE = {
  sessionState: 'listening',
  isSpeaking: true,
  interimText:
    '正在识别的临时结果，长度足够触发换行，用来确认超长内容完整展示不截断。',
  recentLines: ['应被丢弃的更早一句', '最近第一行', '最近第二行'],
  elapsedSeconds: 2,
};
const REVEAL_STATE = {
  sessionState: 'listening',
  isSpeaking: true,
  interimText: '',
  recentLines: ['最近第二行', '淡出之后定稿的一句'],
  elapsedSeconds: 3,
};
/** 思考中：用户句保持 + 「正在想」指示行。 */
const THINKING_STATE = {
  sessionState: 'listening',
  isSpeaking: false,
  interimText: '',
  recentLines: [{ text: '帮我看看今天杭州的天气', author: 'user' }],
  turnPhase: 'thinking',
  elapsedSeconds: 4,
};
/** 长回应：远超卡片高度，检验不被裁顶、可从顶部读起、超出时自动缓慢上滚。 */
const LONG_REPLY_STATE = {
  sessionState: 'listening',
  isSpeaking: false,
  interimText: '',
  recentLines: [
    {
      text:
        '今天杭州是晴到多云，白天最高 26 度、夜里最低 18 度，风不大。' +
        '早晚温差有点拉开，出门带一件薄外套比较稳妥；紫外线不算弱，' +
        '中午在外面待久了记得防晒。你要是打算傍晚去西湖边走一圈，' +
        '那会儿光线正好、人也不算多，就是湖边风会稍微凉一点。' +
        '明天开始云量增多，后天可能有一场阵雨，伞可以先放进包里备着。' +
        '另外周日会有一股弱冷空气过境，白天最高温会掉到 20 度上下，' +
        '如果那两天有户外安排，建议把时间挪到周六，体感会舒服很多。' +
        '下周一之后天气会重新转晴，气温也会慢慢回到二十五度以上，' +
        '到时候再想出门就不需要带外套了。',
      author: 'hemi',
    },
  ],
  turnPhase: 'replying',
  elapsedSeconds: 5,
};
const BURST_SENTENCES = [
  '第一句：帮我看看今天杭州的天气怎么样',
  '第二句：顺便把明天的日程念一遍',
  '第三句：再提醒我下午三点开会',
  '第四句：最后记一下要买牛奶',
];
const BURST_PARTIAL_LENGTHS = [6, 13];
/** 连续对话时字幕最多几行：单轮焦点下是 1 行焦点 + 1 行余量兜底。 */
const BURST_MAX_LINES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSmokeTest(context) {
  const { mainWindow } = context;

  const windowLayout = await probeWindowLayout(context);
  const { orb, caption } = await context.createFloatingSurface();
  // 窗口创建时是 show:false，CSS 动画在从未显示的窗口里不推进——
  // 先显示再发状态，否则入场动画冻在第 0 帧，透明度断言全歪。
  caption.showInactive();
  orb.showInactive();
  const orbBounds = orb.getBounds();
  const captionBounds = caption.getBounds();
  const captionLayout = { ...context.readCaptionLayout() };

  context.publishUiState(START_STATE);
  // 新句带 240ms 入场动画（globals.css 的 floating-caption-line-in），
  // 等它走完再采样，否则行不透明度停在过渡中途。Windows 真机首帧渲染
  // 偏慢时动画会晚启动，固定 sleep 采在半途——再轮询到「全部行不透明」。
  await sleep(340);
  await waitForCaptionVisible(caption);
  const orbProbe = await probeOrbDom(orb);
  const captionProbe = await probeCaptionDom(caption);

  const autoFade = await probeCaptionAutoFade(context, caption);
  const thinking = await probeCaptionThinking(context, caption);
  const longReply = await probeCaptionLongReply(context, caption);
  const burst = await probeCaptionConversationBurst(context, caption);

  caption.hide();
  const draggedOrbBounds = await probeOrbDrag(context, orb);
  const recoveredVisibility = await probeFloatingRecovery(context, orb, caption);
  const mainProbe = await probeMainWindow(mainWindow);

  const result = {
    ...mainProbe,
    windowLayout,
    floatingWindow: {
      bounds: orbBounds,
      renderer: orbProbe,
      draggedBounds: draggedOrbBounds,
    },
    floatingCaption: {
      bounds: captionBounds,
      renderer: captionProbe,
      layout: captionLayout,
      ...autoFade,
      ...thinking,
      ...longReply,
      burst,
    },
    recoveredVisibility,
  };
  console.log(`HEMI_SMOKE_RESULT=${JSON.stringify(result)}`);

  assertSmokeResult(result, context);

  orb.destroy();
  caption.destroy();
  app.quit();
}

/** 紧凑/展开两种主窗口尺寸。主窗口初始即展开态，先显式收起再取紧凑基准。 */
async function probeWindowLayout(context) {
  context.setMainWindowExpanded(false);
  const compactBounds = context.mainWindow.getBounds();
  context.setMainWindowExpanded(true);
  const expandedBounds = context.mainWindow.getBounds();
  context.setMainWindowExpanded(false);
  return { compactBounds, expandedBounds };
}

/** 主窗口渲染层：品牌、配置、麦克风权限、外链白名单。 */
function probeMainWindow(mainWindow) {
  return mainWindow.webContents.executeJavaScript(`
    (async () => ({
      hasBridge: typeof window.hemiVoice === 'object',
      documentTitle: document.title,
      // 026 R-01：主窗顶栏不再渲染品牌行——brandText 断言改为「不存在」；
      // 「新建对话」是侧栏首个明显操作，改断它在。
      brandText:
        document.querySelector('.brand-wordmark')?.textContent?.trim() ?? '',
      // 040 视觉重构：引导页品牌识别改为标题文案形态。
      onboardingTitle:
        document.querySelector('.onboarding-title')?.textContent?.trim() ?? '',
      mainShellClass: document.querySelector('main')?.className ?? '',
      sidebarNewButton: Boolean(document.querySelector('.h24-sidebar-new')),
      platform: window.hemiVoice?.platform,
      config: await window.hemiVoice?.getConfig?.(),
      preferences: await window.hemiVoice?.getUiPreferences?.(),
      microphonePermission:
        await window.hemiVoice?.getMicrophonePermissionStatus?.(),
      // 文本模型配置：无 Key 时对话服务不启动（回退纯转写）。
      modelConfig: await window.hemiVoice?.getTextModelConfig?.(),
      // 非白名单外链必须被拒绝（返回 false，且不会唤起系统浏览器）。
      blockedExternalLink: await window.hemiVoice?.openExternal?.(
        'https://example.com/',
      ),
      // 未配置 Key 时 llm:chat 必须拒绝；拒绝信息供断言，成功则返回文本。
      unconfiguredChatError: await (async () => {
        try {
          const result = await window.hemiVoice?.chatTextModel?.({
            turnId: 1,
            conversationId: 'conv-smoke-unconfigured',
            inputSource: 'text',
            messages: [{ role: 'user', content: '冒烟测试' }],
          });
          // 注意别在外层模板字面量里再嵌模板：拼接即可。
          return result?.text ? 'resolved:' + result.text : 'resolved-empty';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })(),
      // TTS 配置默认可读（无 Key 也有默认音色与开关）。
      ttsConfig: await window.hemiVoice?.getTtsConfig?.(),
      // 未配置 Key 时播报请求必须被明确拒绝（回退纯字幕），且 cancel 空操作安全。
      unconfiguredSpeakError: await (async () => {
        window.hemiVoice?.cancelTts?.(0);
        try {
          const result = await window.hemiVoice?.speakTts?.({
            turnId: 1,
            text: '冒烟测试',
          });
          return result?.ok ? 'resolved-ok' : (result?.message ?? 'rejected-empty');
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })(),
    }))()
  `);
}

/** 悬浮球渲染层：桥、长按提示文案、声波弧、透明背景。 */
function probeOrbDom(orb) {
  return orb.webContents.executeJavaScript(`
    ({
      hasBridge: typeof window.hemiVoice === 'object',
      buttonLabel:
        document.querySelector('button')?.getAttribute('aria-label') ?? '',
      waveCount: document.querySelectorAll('.floating-orb-wave').length,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      buttonBackground: getComputedStyle(
        document.querySelector('.floating-orb-button'),
      ).backgroundColor,
    })
  `);
}

/** 字幕条渲染层：句子切分、版面参数、文字盒是否用满宽度。 */
function probeCaptionDom(caption) {
  return caption.webContents.executeJavaScript(`
    (() => {
      const copy = document.querySelector('[data-floating-caption]');
      const lines = Array.from(
        document.querySelectorAll('[data-floating-caption] span'),
      );
      const copyStyle = getComputedStyle(copy);
      const shell = document.querySelector('.floating-caption-shell');
      const shellStyle = getComputedStyle(shell);
      const lastLineStyle = getComputedStyle(lines.at(-1));
      const copyRect = copy.getBoundingClientRect();
      const anchorX = parseFloat(
        shellStyle.getPropertyValue('--caption-anchor-x'),
      );
      return {
        hasBridge: typeof window.hemiVoice === 'object',
        lines: lines.map((line) => line.textContent ?? ''),
        finalLineCount: lines.filter((line) => line.dataset.final === 'true')
          .length,
        interimLineCount: lines.filter(
          (line) => line.dataset.interim === 'true',
        ).length,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        textAlign: copyStyle.textAlign,
        // maxWidth 是主进程算好的上限（CSS max-width），width 是卡片实际宽度
        // （贴字自适应，短句不会撑出空白）。
        maxWidth: copyStyle.maxWidth,
        width: copyStyle.width,
        anchorX,
        copyLeft: copyRect.left,
        copyRight: copyRect.right,
        copyCenterX: copyRect.left + copyRect.width / 2,
        placement: shell.dataset.placement,
        visible: copy.dataset.visible ?? '',
        lineOpacities: lines.map(
          (line) => parseFloat(getComputedStyle(line).opacity),
        ),
        whiteSpace: lastLineStyle.whiteSpace,
        textOverflow: lastLineStyle.textOverflow,
        wrapped:
          lines.at(-1).scrollHeight > parseFloat(lastLineStyle.lineHeight) * 1.5,
      };
    })()
  `);
}

/** 只读「可见性 + 每行不透明度」，用于轮询淡出过程。 */
function readCaptionFade(caption) {
  return caption.webContents.executeJavaScript(`
    (() => {
      const copy = document.querySelector('[data-floating-caption]');
      return {
        visible: copy?.dataset.visible ?? '',
        lineOpacities: Array.from(
          copy.querySelectorAll('span'),
          (line) => parseFloat(getComputedStyle(line).opacity),
        ),
      };
    })()
  `);
}

/**
 * 长回应几何：卡片必须完整落在窗口内，且可从顶部读起、超出时自动缓慢上滚。
 * 用户报过「回答高了看不见上面」——flex-end + overflow 会把溢出推到
 * 盒子上方、滚动条够不到，这条断言就是防它回归。
 */
async function readCaptionLongReply(caption) {
  return caption.webContents.executeJavaScript(`
    (() => {
      const copy = document.querySelector('[data-floating-caption]');
      const firstLine = copy.querySelector('span');
      const copyRect = copy.getBoundingClientRect();
      const lineRect = firstLine.getBoundingClientRect();
      return {
        copyTop: copyRect.top,
        copyBottom: copyRect.bottom,
        copyHeight: copyRect.height,
        copyWidth: copyRect.width,
        firstLineTop: lineRect.top,
        animating: firstLine.getAnimations().some(animation=>animation.playState==='running'),
        scrollTop: copy.scrollTop,
        scrollHeight: copy.scrollHeight,
        clientHeight: copy.clientHeight,
        windowHeight: window.innerHeight,
      };
    })()
  `);
}

/** 全部 span（含退场副本）+ 定稿/临时行的区分。 */
function readCaptionSpans(caption) {
  return caption.webContents.executeJavaScript(`
    (() => {
      const copy = document.querySelector('[data-floating-caption]');
      const spans = Array.from(copy.querySelectorAll('span'));
      const leaving = spans.filter((span) => span.dataset.leaving === 'true');
      return {
        lineCount: spans.length,
        lines: spans
          .filter((span) => span.dataset.leaving !== 'true')
          .map((span) => span.textContent ?? ''),
        finals: spans
          .filter((span) => span.dataset.final === 'true')
          .map((span) => span.textContent ?? ''),
        interim: spans
          .filter((span) => span.dataset.interim === 'true')
          .map((span) => span.textContent ?? ''),
        leavingText: leaving.map((span) => span.textContent ?? ''),
        leavingOpacity: leaving.map((span) =>
          parseFloat(getComputedStyle(span).opacity),
        ),
        leavingAnimation: leaving.map(
          (span) => getComputedStyle(span).animationName,
        ),
      };
    })()
  `);
}

/**
 * 字幕要自己消失：整卡（文字与背景同时）淡出，轮询到全部透明。
 */
async function probeCaptionAutoFade(context, caption) {
  // 隐藏窗口不会推进 CSS 过渡，量到的透明度不作数，所以先真正显示出来。
  caption.showInactive();
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let fade = await readCaptionFade(caption);

  while (Date.now() < deadline) {
    const state = await readCaptionFade(caption);
    fade = state;
    if (state.lineOpacities.every((opacity) => opacity <= 0.05)) break;
    await sleep(POLL_INTERVAL_MS);
  }

  // 新字幕到达时必须重新亮起来，否则用户会看不到后面的识别结果。
  context.publishUiState(REVEAL_STATE);
  const reveal = await waitForCaptionVisible(caption);
  return { fade, reveal };
}

/**
 * 思考状态必须可见：用户句保持、挂上「正在想」指示行（用户报过「思考没状态」）。
 */
async function probeCaptionThinking(context, caption) {
  context.publishUiState(THINKING_STATE);
  const thinking = await waitForCaptionLines(caption, (spans) => spans.lineCount === 2);
  return { thinking };
}

/** 长回应：2026-10-15 用户已取消自动上滚；入场后保留开头，全文在主窗口阅读。 */
async function probeCaptionLongReply(context, caption) {
  context.publishUiState(LONG_REPLY_STATE);
  await waitForCaptionLines(caption, (spans) => spans.lineCount === 1);
  const atRest = await waitFor(
    () => readCaptionLongReply(caption),
    (state) => !state.animating,
  );
  await sleep(900);
  const later = await readCaptionLongReply(caption);
  return { longReply: atRest, longReplyLater: later };
}

/**
 * 连续对话压测：照着主窗口的推送节奏（临时结果反复改写 → 定稿 → 下一句）连推几句，
 * 字幕行数必须有上限、不能一路往上堆（用户报过这个）。
 */
async function probeCaptionConversationBurst(context, caption) {
  const finals = [];
  let maxLines = 0;

  for (const sentence of BURST_SENTENCES) {
    const partials = [
      ...BURST_PARTIAL_LENGTHS.map((length) => sentence.slice(0, length)),
      sentence,
    ];
    for (const partial of partials) {
      context.publishUiState(burstState(finals, partial));
      maxLines = Math.max(maxLines, await pollCaptionLineCount(caption));
    }

    finals.push(sentence);
    context.publishUiState(burstState(finals, ''));
    maxLines = Math.max(maxLines, await pollCaptionLineCount(caption));
  }

  // 等最后一句的退场副本也跑完动画。此刻临时结果为空、不留占位行，
  // 单轮焦点下稳定下来就是最后一句。
  const settled = await waitForCaptionLines(caption, (spans) => spans.lineCount === 1);
  return { maxLines, ...settled };
}

function burstState(finals, interim) {
  return {
    sessionState: 'listening',
    isSpeaking: true,
    interimText: interim,
    recentLines: finals.slice(-2),
    elapsedSeconds: 5,
  };
}

/** 拖动悬浮球：驱动主进程里的拖动状态机，位置应当改变。 */
async function probeOrbDrag(context, orb) {
  const bounds = orb.getBounds();
  context.dragState.set({
    pointerX: 100,
    pointerY: 100,
    windowX: bounds.x,
    windowY: bounds.y,
    dragging: false,
    timer: null,
  });
  context.dragState.update({ x: 76, y: 72 });
  context.dragState.finish(false);
  return orb.getBounds();
}

/** 主窗口隐藏后，轮询逻辑要能把悬浮球和字幕条重新显示出来。 */
async function probeFloatingRecovery(context, orb, caption) {
  orb.hide();
  caption.hide();
  context.mainWindow.hide();
  await context.showFloatingOrbIfNeeded({ allowSmoke: true });
  const recoveredVisibility = {
    orb: orb.isVisible(),
    caption: caption.isVisible(),
  };
  context.mainWindow.showInactive();
  return recoveredVisibility;
}

async function pollCaptionLineCount(caption) {
  await sleep(POLL_INTERVAL_MS);
  return caption.webContents.executeJavaScript(
    `document.querySelectorAll('[data-floating-caption] span').length`,
  );
}

async function waitForCaptionVisible(caption) {
  return waitFor(
    () => readCaptionFade(caption),
    (state) =>
      state.visible === 'true' &&
      state.lineOpacities.every((opacity) => opacity >= 0.9),
  );
}

async function waitForCaptionLines(caption, predicate) {
  return waitFor(() => readCaptionSpans(caption), predicate);
}

/** 轮询直到满足条件；超时就返回最后一次采样（由断言报错，信息更完整）。 */
async function waitFor(read, predicate) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    value = await read();
  }
  return value;
}

function assertSmokeResult(result, context) {
  const { brandName, windowSizes, orbSize } = context;
  const caption = result.floatingCaption;
  const orb = result.floatingWindow;
  const renderer = caption.renderer;
  const failures = [];
  const expect = (label, ok) => {
    if (!ok) failures.push(label);
  };
  // Windows 分数缩放（如 125%）下 DIP↔物理像素取整往返会让 getBounds 比创建
  // 常量大 1~3px（2026-10-11 win 真机 125% 首跑实测：560→562、980→981、92→94）；
  // 100% 缩放（CI 虚拟屏、mac）仍精确相等。按缩放倍数放宽容差，防真回归
  // （常量级偏差 ≥6px）依旧拦得住。
  const scale = screen.getPrimaryDisplay()?.scaleFactor ?? 1;
  const sizeTolerance = Math.ceil(3 * scale);
  const sizeMatches = (actual, expected) =>
    Math.abs(actual - expected) <= sizeTolerance;

  expect('主窗口 preload 桥', result.hasBridge);
  expect('窗口标题是品牌名', result.documentTitle === brandName);
  // 026 R-01：对话主窗去品牌行（品牌仍可在设置/引导页识别）；侧栏首操作是
  // 新建对话。冒烟环境没有麦克风授权，主窗停在引导页（setup-shell）——品牌
  // 在引导页属于允许保留的位置，两种壳各自断言。
  const setupShell = String(result.mainShellClass ?? '').startsWith('setup-shell');
  if (setupShell) {
    // 040 视觉重构：引导页品牌识别从 .brand-wordmark 元素改为标题文案
    // （「你好，我是 Hemi。」）——断言对齐新形态。
    expect('引导页保留品牌识别（026 R-01；040 改标题形态）',
      result.brandText === brandName || /我是\s*Hemi/.test(String(result.onboardingTitle ?? '')));
  } else {
    expect('主窗顶栏无品牌行（026 R-01）', result.brandText === '');
    expect('侧栏首个操作是新建对话', result.sidebarNewButton === true);
  }
  expect('读得到 resourceId', Boolean(result.config?.resourceId));
  expect(
    '悬浮球开关是布尔值',
    typeof result.preferences?.floatingOrbEnabled === 'boolean',
  );
  expect('麦克风权限状态是字符串', typeof result.microphonePermission === 'string');
  expect(
    '文本模型配置可读（含字符串 baseUrl 与布尔 hasApiKey；032 起空目录＝空串）',
    typeof result.modelConfig?.hasApiKey === 'boolean' &&
      typeof result.modelConfig?.baseUrl === 'string',
  );
  // 未配置模型 Key 时，对话请求必须被明确拒绝（回退纯转写，而不是崩或悬住）。
  if (result.modelConfig && !result.modelConfig.hasApiKey) {
    expect(
      '未配置文本模型时对话请求被拒绝',
      typeof result.unconfiguredChatError === 'string' &&
        result.unconfiguredChatError.includes('未配置'),
    );
  }
  // TTS：默认配置可读；未配置 Key 时播报被拒（回退纯字幕），cancel 空操作不崩。
  expect(
    'TTS 配置可读（开关布尔、音色与 Resource ID 非空）',
    typeof result.ttsConfig?.ttsEnabled === 'boolean' &&
      typeof result.ttsConfig?.ttsVoice === 'string' &&
      result.ttsConfig.ttsVoice.length > 0 &&
      typeof result.ttsConfig?.ttsResourceId === 'string' &&
      result.ttsConfig.ttsResourceId.length > 0,
  );
  if (result.ttsConfig && !result.ttsConfig.hasApiKey) {
    expect(
      '未配置豆包 Key 时播报请求被拒绝',
      typeof result.unconfiguredSpeakError === 'string' &&
        result.unconfiguredSpeakError.includes('未配置'),
    );
  }
  // 外链白名单：`system:open-external` + preload 的 `openExternal`。
  expect(
    '非白名单外链被拒绝',
    result.blockedExternalLink === undefined ||
      result.blockedExternalLink === false,
  );

  expect(
    '紧凑窗口宽度',
    sizeMatches(result.windowLayout.compactBounds.width, windowSizes.compact.width),
  );
  expect(
    '展开窗口宽度',
    sizeMatches(result.windowLayout.expandedBounds.width, windowSizes.expanded.width),
  );

  expect('悬浮球尺寸', sizeMatches(orb.bounds.width, orbSize));
  expect('悬浮球 preload 桥', orb.renderer.hasBridge);
  expect('悬浮球状态文案', orb.renderer.buttonLabel === '正在聆听');
  expect('悬浮球声波弧数量', orb.renderer.waveCount === 3);
  expect('悬浮球窗口透明', orb.renderer.bodyBackground === 'rgba(0, 0, 0, 0)');
  expect('悬浮球按钮透明', orb.renderer.buttonBackground === 'rgba(0, 0, 0, 0)');
  expect('拖动改变了悬浮球位置', orb.draggedBounds.x !== orb.bounds.x);
  expect('拖动改变了悬浮球纵向位置', orb.draggedBounds.y !== orb.bounds.y);

  expect(
    '字幕条宽度',
    sizeMatches(caption.bounds.width, FLOATING_CAPTION_SIZE.width),
  );
  expect('字幕条 preload 桥', renderer.hasBridge);
  // 说话中：单轮焦点只显示正在识别的这句。
  expect('说话中只显示当前这句（1 行）', renderer.lines.length === 1);
  expect('没有定稿行', renderer.finalLineCount === 0);
  expect('一行正在识别', renderer.interimLineCount === 1);
  expect(
    '显示的是临时结果',
    renderer.lines[0].startsWith('正在识别的临时结果'),
  );
  expect('字幕窗口透明', renderer.bodyBackground === 'rgba(0, 0, 0, 0)');
  expect('字幕居中', renderer.textAlign === 'center');
  expect('锚点是有限数', Number.isFinite(renderer.anchorX));
  expect('文字中心是有限数', Number.isFinite(renderer.copyCenterX));
  expect('最大宽度是有限数', Number.isFinite(parseFloat(renderer.maxWidth)));
  expect(
    '最大宽度不低于下限',
    parseFloat(renderer.maxWidth) >= FLOATING_CAPTION_MIN_WIDTH,
  );
  expect(
    '最大宽度不超过上限',
    parseFloat(renderer.maxWidth) <= FLOATING_CAPTION_MAX_WIDTH,
  );
  expect(
    '文字围绕锚点居中',
    Math.abs(renderer.copyCenterX - renderer.anchorX) <= 1,
  );
  // 卡片贴字自适应（短句不撑空白），但不越过主进程算好的上限。
  expect(
    '卡片宽度不超过算好的上限',
    parseFloat(renderer.width) <= parseFloat(renderer.maxWidth) + 1,
  );
  expect(
    '上限不超过常量',
    parseFloat(renderer.maxWidth) <= FLOATING_CAPTION_MAX_WIDTH + 1,
  );
  expect('文字不越出窗口左侧', renderer.copyLeft >= FLOATING_CAPTION_PADDING - 1);
  expect(
    '文字不越出窗口右侧',
    renderer.copyRight <= FLOATING_CAPTION_SIZE.width - FLOATING_CAPTION_PADDING + 1,
  );
  // 宽度策略（2026-09-19）：卡片尽量用满宽度，球心必须落在卡片横向范围内。
  const orbCenterInWindowX = orb.bounds.x + orbSize / 2 - caption.bounds.x;
  expect(
    '球心落在卡片横向范围内',
    orbCenterInWindowX >= renderer.copyLeft - 1 &&
      orbCenterInWindowX <= renderer.copyRight + 1,
  );
  expect('字幕在球上方', renderer.placement === 'above');
  // 换行策略（2026-09-18 评审结论）：超长内容换行展示全文，不用省略号。
  expect('超长内容自动换行', renderer.whiteSpace === 'normal');
  expect('不再用省略号截断', renderer.textOverflow !== 'ellipsis');
  expect('长临时结果换行展示全文', renderer.wrapped);

  expect('新字幕先整句亮着', renderer.visible === 'true');
  expect(
    '新字幕每行都不透明',
    renderer.lineOpacities.every((opacity) => opacity >= 0.9),
  );
  expect('停留后开始淡出', caption.fade.visible === 'false');
  expect('淡出行数与显示行数一致', caption.fade.lineOpacities.length === renderer.lines.length);
  expect(
    '全部句子都淡到透明',
    caption.fade.lineOpacities.every((opacity) => opacity <= 0.05),
  );
  expect('新字幕重新亮起', caption.reveal.visible === 'true');
  expect(
    '重新亮起后每行不透明',
    caption.reveal.lineOpacities.every((opacity) => opacity >= 0.9),
  );

  // 思考状态：用户句保持 + 「正在想」指示行（用户报过「思考没状态」）。
  expect('思考中显示用户句与指示行', caption.thinking.lines.join('|') === '帮我看看今天杭州的天气|正在想');
  expect(
    '思考行挂的是 Hemi 身份',
    caption.thinking.finals.length === 1 && caption.thinking.interim.length === 0,
  );

  // 长回应几何：卡片全在窗口内、从顶部读起、超出时自动缓慢上滚。
  const longReply = caption.longReply;
  expect('长回应卡片不越出窗口上缘', longReply.copyTop >= 0);
  expect('长回应卡片不越出窗口下缘', longReply.copyBottom <= longReply.windowHeight);
  expect(
    '长回应可从顶部读起（起点在滚动顶端）',
    longReply.scrollTop <= 1 &&
      longReply.firstLineTop >= longReply.copyTop - 1,
  );
  expect(
    '长回应内容确实溢出（触发自动上滚）',
    longReply.scrollHeight > longReply.clientHeight + 20,
  );
  expect(
    '超长内容保留开头，不自动回放',
    caption.longReplyLater.scrollTop <= 1 &&
      Math.abs(caption.longReplyLater.firstLineTop-longReply.firstLineTop)<=1,
  );

  expect(`连续对话行数封顶（≤${BURST_MAX_LINES}）`, caption.burst.maxLines <= BURST_MAX_LINES);
  expect('连续对话后稳定单句焦点', caption.burst.lineCount === 1);
  // 临时结果为空时整行不出现：不占位、不亮身份牌（用户反馈的「空白行很奇怪」）。
  expect('识别结束后不保留空临时行', caption.burst.interim.length === 0);
  expect(
    '连续对话后只剩最后一句',
    caption.burst.finals.join('|') === BURST_SENTENCES[3],
  );

  const shouldRecoverFloating = Boolean(result.config.hasApiKey && result.preferences.floatingOrbEnabled);
  expect('主窗口隐藏后悬浮球遵守配置开关', result.recoveredVisibility.orb === shouldRecoverFloating);
  expect('主窗口隐藏后字幕条遵守配置开关', result.recoveredVisibility.caption === shouldRecoverFloating);

  if (failures.length) {
    throw new Error(
      `冒烟测试失败 ${failures.length} 项：${failures.join('；')}\n${JSON.stringify(result)}`,
    );
  }
}
