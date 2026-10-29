import { APP_MENU_GROUPS } from '../../shared/app-menu.mjs';

export function buildWindowMenuTemplate({ menu, enabledCommands, select }) {
  const enabled = new Set(enabledCommands);
  const groupTemplate = group => group.items.map(item => {
    if (!item.command) return { ...item };
    const { command, ...options } = item;
    return { ...options, id: command, enabled: enabled.has(command), click: () => select(command) };
  });
  if (menu === 'all') return APP_MENU_GROUPS.map(group => ({
    label: `${group.label}(&${group.accessKey.toUpperCase()})`, submenu: groupTemplate(group),
  }));
  const group = APP_MENU_GROUPS.find(group => group.id === menu);
  if (!group) throw new Error('INVALID_MENU');
  return groupTemplate(group);
}

/** Native popups retain OS edit commands, focus/selection and dismissal behavior. */
export function showWindowMenu({ Menu, window, request }) {
  if (!request || !Number.isFinite(request.x) || !Number.isFinite(request.y) || !Array.isArray(request.enabledCommands)) {
    throw new Error('INVALID_MENU_REQUEST');
  }
  const bounds = window.getContentBounds();
  return new Promise(resolve => {
    let selected = null;
    const template = buildWindowMenuTemplate({ ...request, select: command => { selected = command; } });
    const menu = Menu.buildFromTemplate(template);
    const close = () => { menu.closePopup(); resolve(null); };
    window.once('closed', close);
    window.focus();
    menu.popup({ window, x: Math.round(Math.max(0, Math.min(request.x, bounds.width))),
      y: Math.round(Math.max(0, Math.min(request.y, bounds.height))),
      callback: () => { window.removeListener('closed', close); resolve(selected); },
    });
  });
}
