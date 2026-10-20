import { rendererIndexPath } from '../paths.mjs';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

export function rendererUrl(mode = 'main') {
  if (isDevelopment) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    if (mode !== 'main') url.searchParams.set('mode', mode);
    return { type: 'url', value: url.toString() };
  }

  return {
    type: 'file',
    value: rendererIndexPath,
    options: mode !== 'main' ? { query: { mode } } : undefined,
  };
}

export async function loadRenderer(window, mode) {
  const target = rendererUrl(mode);
  if (target.type === 'url') {
    await window.loadURL(target.value);
    return;
  }
  await window.loadFile(target.value, target.options);
}
