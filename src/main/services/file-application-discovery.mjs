import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// NSWorkspace supplies this file's registered handlers and its actual default application.
// The file path is passed as argv, never interpolated into executable source.
const MAC_APPLICATIONS_SCRIPT = `function run(argv) {
  ObjC.import('AppKit');
  var workspace = $.NSWorkspace.sharedWorkspace;
  var file = $.NSURL.fileURLWithPath(argv[0]);
  var applications = workspace.URLsForApplicationsToOpenURL(file);
  var preferred = workspace.URLForApplicationToOpenURL(file);
  var rows = [];
  for (var i = 0; i < applications.count; i++) {
    var url = applications.objectAtIndex(i);
    if (!$.NSFileManager.defaultManager.fileExistsAtPath(url.path)) continue;
    var bundle = $.NSBundle.bundleWithURL(url);
    rows.push({ path: url.path.js,
      name: $.NSFileManager.defaultManager.displayNameAtPath(url.path).js,
      bundleId: ObjC.unwrap(bundle.bundleIdentifier) || url.path.js,
      isDefault: Boolean(preferred && preferred.path.js === url.path.js) });
  }
  return JSON.stringify(rows);
}`;

export function fileApplicationId(filePath, applicationPath) {
  return createHash('sha256').update(JSON.stringify([filePath, applicationPath])).digest('hex').slice(0, 24);
}

const EDITORS = [/^(?:com\.microsoft\.VSCode(?:Insiders)?|Visual Studio Code(?: - Insiders)?|VS Code)$/i,
  /^(?:Cursor|Zed|Sublime Text)(?:$| )/i, /^(?:com\.apple\.TextEdit|TextEdit|文本编辑)$/i,
  /^(?:Typora|Obsidian)$/i];
const BROWSERS = [/^(?:com\.apple\.Safari|Safari)$/i, /^(?:com\.google\.Chrome|Google Chrome)$/i,
  /^(?:Firefox|Microsoft Edge|Arc|Brave Browser)$/i];

/** A few useful shortcuts, not every application claiming a broad file association. */
export function commonFileApplications(filePath, applications) {
  const ext = path.extname(filePath).toLowerCase();
  const patterns = /\.(?:png|jpe?g|gif|webp|svg|heic|tiff?|bmp)$/.test(ext)
    ? [/^(?:com\.apple\.Preview|Preview|预览)$/i, /Photoshop|Pixelmator|Affinity Photo/i]
    : ext === '.pdf' ? [/^(?:com\.apple\.Preview|Preview|预览)$/i, /Acrobat|PDF Expert|PDFpen/i]
    : /\.(?:xlsx?|csv|tsv|ods)$/.test(ext) ? [/Microsoft Excel|^Numbers$|^表格$|LibreOffice/i]
    : /\.(?:docx?|odt|rtf)$/.test(ext) ? [/Microsoft Word|^Pages$|^文稿$|LibreOffice/i, /^(?:com\.apple\.TextEdit|文本编辑|TextEdit)$/i]
    : /\.(?:pptx?|odp)$/.test(ext) ? [/Microsoft PowerPoint|^Keynote$|^演讲$|LibreOffice/i]
    : /\.(?:mp4|mov|webm|m4v|mkv|avi|mp3|wav|m4a|aac|flac|ogg)$/.test(ext) ? [/QuickTime|IINA|^VLC$/i]
    : /\.(?:html?|svgz)$/.test(ext) ? [...BROWSERS, ...EDITORS]
    : /\.(?:zip|7z|rar|gz|tar)$/.test(ext) ? [/Archive Utility|归档实用工具|The Unarchiver|Keka/i]
    : /\.(?:md|markdown|txt|text|log|jsonc?|ya?ml|toml|ini|cfg|conf|xml|[cm]?js|jsx|tsx?|py|rb|go|rs|java|[ch]|cpp|hpp|cs|s?css|sh|zsh|bash|sql|tex)$/.test(ext) ? EDITORS : [];
  const ranked = applications.map(application => ({ application,
    rank: patterns.findIndex(pattern => [application.bundleId ?? '', application.name].some(value => pattern.test(value))),
  })).filter(item => item.rank >= 0);
  if (!ranked.length) return applications.filter(application => application.isDefault).slice(0, 1);
  return ranked.sort((a, b) => Number(b.application.isDefault) - Number(a.application.isDefault) || a.rank - b.rank)
    .slice(0, 4).map(item => item.application);
}

export async function discoverFileApplications(filePath, { platform = process.platform, execFileFn = execFile, home = os.homedir() } = {}) {
  if (platform !== 'darwin') return [];
  const stdout = await new Promise((resolve, reject) => {
    execFileFn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_APPLICATIONS_SCRIPT, filePath],
      { timeout: 10000, maxBuffer: 512 * 1024 }, (error, output) => error ? reject(error) : resolve(output));
  });
  const rows = JSON.parse(String(stdout));
  if (!Array.isArray(rows)) throw new Error('系统应用列表格式不正确');
  const roots = ['/Applications', '/System/Applications', path.join(home, 'Applications')];
  const seen = new Set();
  return rows.sort((a, b) => Number(Boolean(b?.isDefault)) - Number(Boolean(a?.isDefault))).filter(row => {
    if (!row || typeof row.path !== 'string' || typeof row.name !== 'string' || !existsSync(row.path)) return false;
    // Exclude cached test browsers and bundled build tools from everyday file menus.
    if (!row.isDefault && !roots.some(root => row.path.startsWith(`${root}/`))) return false;
    const key = row.bundleId || row.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map(row => ({ ...row, id: fileApplicationId(filePath, row.path) }));
}
