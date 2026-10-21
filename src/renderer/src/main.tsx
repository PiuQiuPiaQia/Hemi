import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { FloatingCaption } from '@/windows/caption/floating-caption';
import { FloatingOrb } from '@/windows/orb/floating-orb';
import { TaskPopover } from '@/windows/orb/task-popover';
import Home from '@/windows/voice/page';
import { installNativeInput } from '@/lib/native-input';
import '@/globals.css';
import '@/styles/index.css';
import '@/appearance/appearance.css';
import {initializeAppearance} from '@/appearance/runtime';
import {StartupStage} from '@/appearance/startup-stage';

installNativeInput();

const root = document.getElementById('root');

if (!root) {
  throw new Error('Hemi 渲染容器不存在。');
}

const windowMode = new URLSearchParams(window.location.search).get('mode');
document.documentElement.dataset.window =
  windowMode === 'orb' || windowMode === 'caption' || windowMode === 'task-popover'
    ? windowMode
    : 'main';

void initializeAppearance().then(()=>createRoot(root).render(
  <StrictMode>
    {windowMode === 'orb' ? (
      <FloatingOrb />
    ) : windowMode === 'caption' ? (
      <FloatingCaption />
    ) : windowMode === 'task-popover' ? (
      <TaskPopover />
    ) : (
      <StartupStage><Home /></StartupStage>
    )}
  </StrictMode>,
));
