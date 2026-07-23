const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  session,
  nativeImage,
  dialog,
  ipcMain,
  clipboard} = require('electron');


const SAM_DISABLE_GPU = process.env.SAM_DISABLE_GPU === '1';

if (SAM_DISABLE_GPU) {
  app.disableHardwareAcceleration();

  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
  app.commandLine.appendSwitch('disable-accelerated-video-decode');
  app.commandLine.appendSwitch('disable-features', 'Vulkan,UseOzonePlatform,CanvasOopRasterization,VaapiVideoDecoder');

  console.log('[SAM] DIAGNOSTIC GPU MODE: hardware acceleration disabled');
}

const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const electronLog = require('electron-log');

const APP_NAME = 'SAM WhatsApp Web';

let samUnreadBadgeCount = 0;

const SAM_UNREAD_OVERLAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAvUlEQVR42u2XwQ2AIAxFnYGr67AK03h1B0ZiDE89Y0lqYoxGUGn/wSYvJqj5XyylDMMfL2PxXlXMMYGJTGKIyXJNMl7uu6+FR2YWsVrK8+MX4mH3pa2U98Ib8emh8JHJUrzdhEx77kCoTTjqZIBuE/NBtrcy363zrIDT/vd1uSCVTMNAvDKQlAykKwOkZIBOdzUl8Q2wGUDJAfNVYF4HbCuh+V4AsRua9wMQHRFETwjRFUOcCyBORjBnwx6xAoJ+vR7dfMtvAAAAAElFTkSuQmCC';

function normalizeSamUnreadCount(value) {
  const count = Number.parseInt(String(value ?? '0'), 10);

  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }

  return Math.min(count, 999);
}

function createSamUnreadOverlayIcon() {
  return nativeImage.createFromDataURL(SAM_UNREAD_OVERLAY_ICON_DATA_URL);
}

function setSamUnreadBadgeCount(rawCount) {
  const count = normalizeSamUnreadCount(rawCount);

  if (samUnreadBadgeCount === count) {
    return {
      ok: true,
      changed: false,
      count
    };
  }

  samUnreadBadgeCount = count;

  try {
    app.setBadgeCount(count);
  } catch (error) {
    electronLog.warn('Failed to set app badge count:', error);
  }

  try {
    if (process.platform === 'darwin' && app.dock && typeof app.dock.setBadge === 'function') {
      app.dock.setBadge(count > 0 ? String(count) : '');
    }
  } catch (error) {
    electronLog.warn('Failed to set macOS dock badge:', error);
  }

  try {
    if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
      if (count > 0) {
        mainWindow.setOverlayIcon(createSamUnreadOverlayIcon(), `${count} unread messages`);
      } else {
        mainWindow.setOverlayIcon(null, '');
      }
    }
  } catch (error) {
    electronLog.warn('Failed to set Windows overlay icon:', error);
  }

  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.flashFrame(count > 0 && !mainWindow.isFocused());
    }
  } catch (error) {
    electronLog.warn('Failed to update taskbar flash state:', error);
  }

  return {
    ok: true,
    changed: true,
    count
  };
}



function parseSamUnreadCountFromTitle(title) {
  const text = String(title || '');

  let match = text.match(/^\((\d+)\)\s*/);

  if (!match) {
    match = text.match(/\((\d+)\)\s*WhatsApp/i);
  }

  if (!match) {
    return 0;
  }

  return normalizeSamUnreadCount(match[1]);
}

function registerSamUnreadTitleObserver(webContents) {
  if (!webContents || webContents.__samUnreadTitleObserverRegistered) {
    return;
  }

  webContents.__samUnreadTitleObserverRegistered = true;

  const updateFromTitle = (title) => {
    const count = parseSamUnreadCountFromTitle(title);
    setSamUnreadBadgeCount(count);
  };

  webContents.on('page-title-updated', (_event, title) => {
    updateFromTitle(title);
  });

  webContents.on('did-finish-load', () => {
    webContents.executeJavaScript('document.title', true)
      .then((title) => {
        updateFromTitle(title);
      })
      .catch((error) => {
        electronLog.warn('Failed to read WhatsApp title for unread badge:', error);
      });
  });
}

function registerSamUnreadBadgeIpcHandlers() {
  ipcMain.handle('sam-unread:set-count', async (_event, payload = {}) => {
    return setSamUnreadBadgeCount(payload && payload.count);
  });
}



function getAppWindowTitle() {
  return `${APP_NAME} v${getPublicAppVersion()}`;
}

function getPublicAppVersion() {
  return String(app.getVersion() || '').replace(/\.0$/, '');
}
const WHATSAPP_URL = 'https://web.whatsapp.com/';
const CHROME_USER_AGENT = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const SAM_DISABLE_PRELOAD = process.env.SAM_DISABLE_PRELOAD === '1';
const SESSION_PARTITION = 'persist:sam-whatsapp-web';

const AUTO_OPEN_OFFICE_DOWNLOADS = false;
const PREVIEW_OFFICE_DOWNLOADS = true;
const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.ods',
  '.odt',
  '.csv'
]);

let mainWindow = null;
let tray = null;
let isQuitting = false;

let settingsWindow = null;
let appSettings = null;

const DEFAULT_SETTINGS = {
  officeDownloadLocation: 'cache',
  replaceSameFilename: true,
  previewOfficeDownloads: true,
  autoOpenOfficeDownloads: false,
  attachmentCacheDays: 7,
  previewCacheDays: 7,
  uiScaleMode: 'ultra'
};

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function ensureDirectory(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  return directory;
}

function normalizeSettings(raw) {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(raw && typeof raw === 'object' ? raw : {})
  };

  if (!['cache', 'downloads'].includes(settings.officeDownloadLocation)) {
    settings.officeDownloadLocation = DEFAULT_SETTINGS.officeDownloadLocation;
  }

  settings.replaceSameFilename = Boolean(settings.replaceSameFilename);
  settings.previewOfficeDownloads = Boolean(settings.previewOfficeDownloads);
  settings.autoOpenOfficeDownloads = Boolean(settings.autoOpenOfficeDownloads);

  settings.attachmentCacheDays = Number(settings.attachmentCacheDays);
  settings.previewCacheDays = Number(settings.previewCacheDays);

  if (!Number.isFinite(settings.attachmentCacheDays) || settings.attachmentCacheDays < 1) {
    settings.attachmentCacheDays = DEFAULT_SETTINGS.attachmentCacheDays;
  }

  if (!Number.isFinite(settings.previewCacheDays) || settings.previewCacheDays < 1) {
    settings.previewCacheDays = DEFAULT_SETTINGS.previewCacheDays;
  }


  const validUiScaleModes = new Set(['normal', 'compact', 'ultra', 'max']);

  if (!validUiScaleModes.has(settings.uiScaleMode)) {
    settings.uiScaleMode = DEFAULT_SETTINGS.uiScaleMode;
  }

  return settings;
}

function loadSettings() {
  if (appSettings) {
    return appSettings;
  }

  try {
    const settingsPath = getSettingsPath();

    if (!fs.existsSync(settingsPath)) {
      appSettings = normalizeSettings(DEFAULT_SETTINGS);
      saveSettings(appSettings);
      return appSettings;
    }

    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    appSettings = normalizeSettings(raw);
    return appSettings;
  } catch {
    appSettings = normalizeSettings(DEFAULT_SETTINGS);
    return appSettings;
  }
}

function saveSettings(partial) {
  const next = normalizeSettings({
    ...(appSettings || DEFAULT_SETTINGS),
    ...(partial && typeof partial === 'object' ? partial : {})
  });

  ensureDirectory(app.getPath('userData'));
  fs.writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');

  appSettings = next;
  cleanupCachesBySettings();

  return appSettings;
}

function getAttachmentCacheDir() {
  return ensureDirectory(path.join(app.getPath('userData'), 'attachments'));
}

function getPreviewCacheDir() {
  return ensureDirectory(path.join(app.getPath('userData'), 'previews'));
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Якщо файл зайнятий, не падаємо. Далі буде fallback.
  }
}

function getOfficeDownloadSavePath(filename) {
  const settings = loadSettings();
  const safeName = sanitizeFilename(filename);

  if (settings.officeDownloadLocation === 'downloads') {
    return getUniqueDownloadPath(app.getPath('downloads'), safeName);
  }

  const dir = getAttachmentCacheDir();
  const targetPath = path.join(dir, safeName);

  if (settings.replaceSameFilename) {
    removeFileIfExists(targetPath);

    if (!fs.existsSync(targetPath)) {
      return targetPath;
    }
  }

  return getUniqueDownloadPath(dir, safeName);
}

function cleanupOldFilesInDirectory(directory, maxAgeDays) {
  const result = {
    deletedFiles: 0
  };

  try {
    if (!fs.existsSync(directory)) {
      return result;
    }

    const maxAgeMs = Number(maxAgeDays) * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const name of fs.readdirSync(directory)) {
      const filePath = path.join(directory, name);

      try {
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
          const nested = cleanupOldFilesInDirectory(filePath, maxAgeDays);
          result.deletedFiles += nested.deletedFiles;

          try {
            if (fs.readdirSync(filePath).length === 0) {
              fs.rmdirSync(filePath);
            }
          } catch {
            // Не критично.
          }

          continue;
        }

        if (!stat.isFile()) {
          continue;
        }

        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          result.deletedFiles += 1;
        }
      } catch {
        // Один проблемний файл не має зупиняти очистку.
      }
    }
  } catch {
    // Не критично.
  }

  return result;
}

function clearDirectoryFiles(directory) {
  const result = {
    deletedFiles: 0
  };

  try {
    if (!fs.existsSync(directory)) {
      return result;
    }

    for (const name of fs.readdirSync(directory)) {
      const filePath = path.join(directory, name);

      try {
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
          const nested = clearDirectoryFiles(filePath);
          result.deletedFiles += nested.deletedFiles;

          try {
            fs.rmdirSync(filePath);
          } catch {
            // Якщо не порожня — залишаємо.
          }

          continue;
        }

        if (stat.isFile()) {
          fs.unlinkSync(filePath);
          result.deletedFiles += 1;
        }
      } catch {
        // Пропускаємо зайняті або недоступні файли.
      }
    }
  } catch {
    // Не критично.
  }

  return result;
}

function cleanupCachesBySettings() {
  const settings = loadSettings();

  const a = cleanupOldFilesInDirectory(getAttachmentCacheDir(), settings.attachmentCacheDays);
  const p = cleanupOldFilesInDirectory(getPreviewCacheDir(), settings.previewCacheDays);

  return {
    deletedFiles: a.deletedFiles + p.deletedFiles
  };
}

function clearAllCaches() {
  const a = clearDirectoryFiles(getAttachmentCacheDir());
  const p = clearDirectoryFiles(getPreviewCacheDir());

  return {
    deletedFiles: a.deletedFiles + p.deletedFiles
  };
}

function getPreviewPdfPathForFile(filePath) {
  const stat = fs.statSync(filePath);
  const parsed = path.parse(filePath);
  const safeBase = sanitizeFilename(parsed.name).slice(0, 80) || 'preview';
  const key = sha1(`${filePath}|${stat.size}|${stat.mtimeMs}`);

  return path.join(getPreviewCacheDir(), `${safeBase}_${key}.pdf`);
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 820,
    height: 640,
    minWidth: 560,
    minHeight: 420,
    title: 'Налаштування',
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'settings_preload.js')
    }
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  settingsWindow.loadFile('settings.html').catch((error) => {
    dialog.showErrorBox('Помилка відкриття налаштувань', String(error));
  });
}

function registerSettingsIpcHandlers() {
  ipcMain.handle('settings:load', async () => {
    return loadSettings();
  });

  ipcMain.handle('settings:save', async (_event, settings) => {
    return saveSettings(settings);
  });

  ipcMain.handle('settings:clear-caches', async () => {
    return clearAllCaches();
  });

  ipcMain.handle('settings:open-attachment-cache', async () => {
    const dir = getAttachmentCacheDir();
    shell.openPath(dir).catch(() => {});
    return true;
  });

  ipcMain.handle('settings:open-preview-cache', async () => {
    const dir = getPreviewCacheDir();
    shell.openPath(dir).catch(() => {});
    return true;
  });
}



function isWhatsAppWebUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && url.hostname === 'web.whatsapp.com';
  } catch {
    return false;
  }
}

function isTrustedWhatsAppPermissionOrigin(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === 'https:' &&
      (
        url.hostname === 'web.whatsapp.com' ||
        url.hostname.endsWith('.whatsapp.com') ||
        url.hostname.endsWith('.whatsapp.net')
      )
    );
  } catch {
    return false;
  }
}

function getIconPath() {
  return path.join(__dirname, 'assets', 'icon.png');
}

function getTrayIconPath() {
  return path.join(__dirname, 'assets', 'tray.png');
}


function sendToWhatsAppPreload(channel) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildMessagesClipboardPayload(messages) {
  const plain = (Array.isArray(messages) ? messages : [])
    .map((message) => String(message && message.text ? message.text : '').trim())
    .filter(Boolean)
    .join('\n\n');

  return {
    plain
  };
}

function registerMessageCopyIpcHandlers() {
  ipcMain.handle('messages:copy-to-clipboard', async (_event, messages) => {
    const payload = buildMessagesClipboardPayload(messages);

    if (payload.count === 0) {
      return {
        ok: false,
        count: 0
      };
    }

    clipboard.writeText(payload.plain);

    return {
      ok: true,
      count: payload.count
    };
  });
}


const SAM_HELP_TEXT = `
SAM WhatsApp Web

Це програма для роботи з WhatsApp Web у вигляді окремого desktop-вікна з додатковими SAM-функціями.

Основні можливості:

1. SAM Encrypt

Кнопка SAM Encrypt розташована зліва у вертикальній панелі WhatsApp.

Основний сценарій:
- натиснути кнопку SAM Encrypt;
- вибрати файл;
- вибрати отримувача або групу отримувачів;
- програма створить зашифрований файл .samenc;
- Finder / файловий менеджер відкриє папку з готовим файлом;
- цей .samenc файл потрібно вручну прикріпити у WhatsApp як документ.

Автоматичне прикріплення до WhatsApp у цій версії не використовується, щоб не втручатися у внутрішній механізм відправки файлів WhatsApp Web.

Отримані .samenc файли після завантаження автоматично розшифровуються, якщо на цьому компʼютері є відповідний приватний ключ.

2. Вхід у WhatsApp

Після першого входу через QR-код програма запамʼятовує сесію.
Під час наступного запуску повторно сканувати QR-код зазвичай не потрібно.

3. Робота з файлами Word та Excel

Файли Word, Excel та інші офісні вкладення можна відкривати через LibreOffice або системну програму за замовчуванням.
Якщо увімкнений попередній перегляд, програма створює PDF-preview і показує документ у внутрішньому вікні.

У вікні перегляду є кнопки:
- Відкрити файл
- Показати в папці
- Закрити

4. Вставка тексту

У полі введення повідомлення працює контекстне меню правою кнопкою миші.

Основні пункти:
- Вставити як текст
- Вставити
- Вирізати
- Копіювати
- Виділити все

Якщо скопіювати таблицю з Excel або LibreOffice Calc, звичайна вставка WhatsApp може вставити її як зображення.
Щоб вставити саме текст, натисніть правою кнопкою в полі повідомлення і виберіть:

Вставити як текст

5. Копіювання кількох повідомлень

У чаті відкрийте меню WhatsApp у правому верхньому куті чату.
У меню доступні пункти:

SAM: копіювати кілька повідомлень
SAM: копіювати вибрані

Як користуватися:

1. Відкрийте потрібний чат або групу.
2. Натисніть меню чату.
3. Виберіть "SAM: копіювати кілька повідомлень".
4. Клацайте по повідомленнях, які потрібно скопіювати.
5. Вибрані повідомлення будуть позначені зеленою рамкою.
6. Унизу буде показано кількість вибраних повідомлень.
7. Знову відкрийте меню і виберіть "SAM: копіювати вибрані".

У буфер обміну копіюється тільки текст повідомлень.
Час, автор, таблиці та службові елементи WhatsApp не додаються.

Щоб вийти з режиму вибору, натисніть кнопку "Вийти з режиму" на нижній панелі.

6. SAM-закріплені чати

WhatsApp має власне обмеження на кількість офіційно закріплених чатів.
SAM-закріплення — це окремий локальний список у цій програмі.

Кнопка SAM-закріплень розташована зліва у вертикальній панелі WhatsApp.

Що можна робити:
- додати поточний чат у SAM-закріплені;
- швидко відкрити SAM-закріплений чат;
- видалити чат із SAM-закріплених.

Ліміт SAM-закріплень: 7 чатів.

Ці закріплення зберігаються локально у програмі.
Вони не змінюють офіційні закріплення WhatsApp і не синхронізуються з телефоном.

7. Зміна ширини списку чатів

Межу між списком чатів і відкритим чатом можна перетягувати мишею.

Якщо потягнути межу:
- вліво — список чатів стане вужчим;
- вправо — список чатів стане ширшим.

Ширина зберігається після перезапуску програми.

8. Вікно програми

Вікно можна:
- змінювати за розміром;
- приклеювати до країв екрана стандартними засобами Linux Mint;
- згортати;
- відкривати через іконку в системному треї.

Одинарний лівий клік по іконці в треї показує головне вікно.
Правий клік по іконці в треї відкриває меню програми.

9. Налаштування

У меню програми є пункт "Налаштування".

Там можна керувати:
- місцем збереження офісних вкладень;
- попереднім переглядом офісних файлів;
- автоматичним відкриттям офісних файлів;
- строком зберігання кешу вкладень і preview.

10. Що важливо знати

SAM WhatsApp Web не є окремим месенджером.
Це оболонка над WhatsApp Web із додатковими зручними функціями.

Якщо WhatsApp змінить внутрішню структуру сайту, деякі SAM-функції можуть потребувати оновлення програми.
`;

function showHelpWindow() {
  const helpWindow = new BrowserWindow({
    title: 'Довідка — SAM WhatsApp Web',
    autoHideMenuBar: true,
    width: 860,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    parent: mainWindow || undefined,
    modal: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  helpWindow.setMenu(null);
  helpWindow.setMenuBarVisibility(false);

  const html = `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <title>Довідка — SAM WhatsApp Web</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #111827;
      color: #e5e7eb;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.55;
    }

    body {
      padding: 22px;
      box-sizing: border-box;
    }

    h1 {
      margin: 0 0 16px;
      color: #f9fafb;
      font-size: 24px;
    }

    h2 {
      margin: 26px 0 10px;
      color: #f9fafb;
      font-size: 18px;
      border-bottom: 1px solid #374151;
      padding-bottom: 6px;
    }

    h3 {
      margin: 18px 0 8px;
      color: #d1d5db;
      font-size: 15px;
    }

    p {
      margin: 8px 0;
    }

    ul, ol {
      margin: 8px 0 12px 22px;
      padding: 0;
    }

    li {
      margin: 5px 0;
    }

    .box {
      border: 1px solid #374151;
      background: #1f2937;
      border-radius: 10px;
      padding: 12px 14px;
      margin: 12px 0;
    }

    .ok {
      border-color: #065f46;
      background: #064e3b;
    }

    .warn {
      border-color: #92400e;
      background: #451a03;
    }

    .danger {
      border-color: #7f1d1d;
      background: #450a0a;
    }

    .muted {
      color: #9ca3af;
    }

    code {
      background: #020617;
      border: 1px solid #334155;
      border-radius: 5px;
      padding: 1px 5px;
      color: #e0f2fe;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
    }

    .toc a {
      color: #93c5fd;
      text-decoration: none;
    }

    .toc a:hover {
      text-decoration: underline;
    }

    .steps {
      counter-reset: step;
      list-style: none;
      margin-left: 0;
    }

    .steps li {
      counter-increment: step;
      position: relative;
      padding-left: 34px;
      margin: 8px 0;
    }

    .steps li::before {
      content: counter(step);
      position: absolute;
      left: 0;
      top: 0;
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: #2563eb;
      color: #fff;
      text-align: center;
      line-height: 22px;
      font-size: 12px;
      font-weight: 700;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 10px 0 14px;
    }

    th, td {
      border: 1px solid #374151;
      padding: 8px;
      vertical-align: top;
    }

    th {
      background: #111827;
      color: #f9fafb;
      text-align: left;
    }
  </style>
</head>
<body>
  <h1>Довідка — SAM WhatsApp Web</h1>

  <div class="box">
    <p><strong>SAM WhatsApp Web</strong> — це desktop-програма для роботи з WhatsApp Web з додатковими функціями: локальні закріплені чати, SAM Encrypt, автоматичне розшифрування отриманих <code>.samenc</code>, робота з Word/Excel, preview, вставка файлів як текст і зручніше керування вікном.</p>
    <p class="muted">Програма не замінює WhatsApp. Вона відкриває WhatsApp Web і додає власні локальні інструменти поверх нього.</p>
  </div>

  <h2>Зміст</h2>
  <div class="box toc">
    <ul>
      <li><a href="#first-start">Перший запуск</a></li>
      <li><a href="#pinned">Закріплені чати</a></li>
      <li><a href="#encrypt-main">SAM Encrypt: що це і для чого</a></li>
      <li><a href="#encrypt-setup">Підготовка ключів, контактів і груп</a></li>
      <li><a href="#encrypt-button">Шифрування через кнопку SAM Encrypt</a></li>
      <li><a href="#encrypt-drag">Шифрування перетягуванням файлу в чат</a></li>
      <li><a href="#decrypt">Отримання і розшифрування .samenc</a></li>
      <li><a href="#office">Word/Excel і preview</a></li>
      <li><a href="#copy-text">Копіювання повідомлень і вставка як текст</a></li>
      <li><a href="#notepad">Блокнот</a></li>
      <li><a href="#settings">Налаштування</a></li>
      <li><a href="#troubleshooting">Типові ситуації і що робити</a></li>
    </ul>
  </div>

  <h2 id="first-start">1. Перший запуск</h2>
  <ol class="steps">
    <li>Запусти SAM WhatsApp Web.</li>
    <li>Якщо WhatsApp просить авторизацію, відскануй QR-код телефоном через WhatsApp.</li>
    <li>Після входу відкриється звичайний інтерфейс WhatsApp Web.</li>
    <li>Зліва або в меню програми будуть доступні додаткові SAM-функції.</li>
  </ol>

  <div class="warn box">
    <p><strong>Важливо:</strong> якщо WhatsApp Web не завантажився або просить повторний вхід, це не обовʼязково помилка програми. WhatsApp може сам завершити сесію або вимагати повторної авторизації.</p>
  </div>

  <h2 id="pinned">2. Закріплені чати</h2>
  <p>Закріплений чат у SAM WhatsApp Web — це локальна швидка кнопка для відкриття потрібного WhatsApp-чату.</p>

  <div class="box ok">
    <p><strong>Можна закріпити до 15 чатів.</strong></p>
  </div>

  <h3>Що важливо розуміти</h3>
  <ul>
    <li>Це не те саме, що закріпити чат всередині WhatsApp.</li>
    <li>Закріплення зберігається локально в SAM WhatsApp Web.</li>
    <li>Закріплений чат допомагає швидко перейти до потрібної переписки.</li>
    <li>Якщо чат перейменували або WhatsApp змінив структуру сторінки, може знадобитися відкрити чат вручну і закріпити його повторно.</li>
  </ul>

  <h3>Як користуватися</h3>
  <ol class="steps">
    <li>Відкрий потрібний чат у WhatsApp Web.</li>
    <li>Використай кнопку або пункт меню для закріплення поточного чату.</li>
    <li>Після цього чат зʼявиться у списку швидкого доступу.</li>
    <li>Щоб перейти в чат, натисни його закріплену кнопку.</li>
  </ol>

  <h2 id="encrypt-main">3. SAM Encrypt: що це і для чого</h2>
  <p><strong>SAM Encrypt</strong> шифрує файл перед відправкою через WhatsApp або інтернет. Отримувач зможе розшифрувати файл тільки якщо має відповідний приватний ключ.</p>

  <table>
    <tr>
      <th>Формат</th>
      <th>Що це</th>
    </tr>
    <tr>
      <td><code>.sampub</code></td>
      <td>Публічний ключ користувача. Його можна передавати іншим людям, щоб вони могли шифрувати файли для тебе.</td>
    </tr>
    <tr>
      <td><code>.samkey</code></td>
      <td>Приватний ключ. Він має залишатися тільки на компʼютері власника. Його не можна передавати іншим.</td>
    </tr>
    <tr>
      <td><code>.samgroup</code></td>
      <td>Файл групи отримувачів. Дозволяє швидко шифрувати один файл одразу для кількох людей.</td>
    </tr>
    <tr>
      <td><code>.samenc</code></td>
      <td>Зашифрований файл. Його можна відправляти через WhatsApp, пошту або інший канал.</td>
    </tr>
    <tr>
      <td><code>.samenc.zip</code></td>
      <td>Архів із зашифрованим файлом. Використовується, коли треба передати зашифрований контейнер у zip-формі.</td>
    </tr>
  </table>

  <div class="danger box">
    <p><strong>Приватний ключ не передавати нікому.</strong> Якщо інша людина отримає твій приватний ключ, вона зможе розшифровувати файли, призначені для тебе.</p>
  </div>

  <h2 id="encrypt-setup">4. Підготовка ключів, контактів і груп</h2>

  <h3>4.1. Створення власних ключів</h3>
  <ol class="steps">
    <li>Відкрий <strong>Налаштування</strong>.</li>
    <li>У блоці <strong>SAM Encrypt</strong> введи імʼя власника ключів.</li>
    <li>Натисни <strong>Створити мої ключі</strong>.</li>
    <li>Програма створить приватний і публічний ключі.</li>
  </ol>

  <p>Публічний ключ можна експортувати і передати іншим користувачам. Приватний ключ залишається на цьому компʼютері.</p>

  <h3>4.2. Експорт публічного ключа</h3>
  <ol class="steps">
    <li>Відкрий <strong>Налаштування</strong>.</li>
    <li>Натисни <strong>Експортувати публічний ключ</strong>.</li>
    <li>Отриманий файл <code>.sampub</code> передай тим людям, які мають шифрувати файли для тебе.</li>
  </ol>

  <h3>4.3. Імпорт публічного ключа іншої людини</h3>
  <ol class="steps">
    <li>Отримай від іншого користувача його файл <code>.sampub</code>.</li>
    <li>Відкрий <strong>Налаштування</strong>.</li>
    <li>Натисни <strong>Імпортувати публічний ключ</strong>.</li>
    <li>Вибери файл <code>.sampub</code>.</li>
    <li>Після імпорту контакт зʼявиться у списку отримувачів SAM Encrypt.</li>
  </ol>

  <h3>4.4. Створення групи</h3>
  <ol class="steps">
    <li>Імпортуй публічні ключі всіх потрібних людей.</li>
    <li>У <strong>Налаштуваннях</strong> відміть контакти, які мають входити в групу.</li>
    <li>Введи назву групи.</li>
    <li>Натисни <strong>Створити групу з вибраних контактів</strong>.</li>
  </ol>

  <p>Після цього при шифруванні можна буде вибрати не окрему людину, а групу.</p>

  <h3>4.5. Експорт та імпорт групи</h3>
  <ul>
    <li><strong>Експорт групи</strong> створює файл <code>.samgroup</code>, який можна передати іншому користувачу.</li>
    <li><strong>Імпорт групи</strong> додає групу до локального списку груп.</li>
    <li>Повторний імпорт тієї самої групи не повинен створювати дублікати.</li>
    <li>Видалення групи не видаляє контакти.</li>
    <li>Видалення контакту не видаляє групи автоматично, але група може перестати бути повною, якщо в ній був цей контакт.</li>
  </ul>

  <h2 id="encrypt-button">5. Шифрування через кнопку SAM Encrypt</h2>
  <p>Цей спосіб підходить, коли файл уже лежить на диску і ти хочеш вибрати його через системне вікно вибору файлу.</p>

  <ol class="steps">
    <li>Відкрий потрібний чат у WhatsApp Web.</li>
    <li>Натисни кнопку <strong>SAM Encrypt</strong> або кнопку із замком.</li>
    <li>Вибери файл, який треба зашифрувати.</li>
    <li>Вибери отримувача або групу.</li>
    <li>Програма створить файл <code>.samenc</code>.</li>
    <li>Якщо файл не прикріпився автоматично, відкрий папку із зашифрованим файлом і прикріпи <code>.samenc</code> вручну як документ.</li>
  </ol>

  <p>У цьому сценарії програма може відкривати папку з готовим <code>.samenc</code>, щоб користувач міг легко знайти файл.</p>

  <h2 id="encrypt-drag">6. Шифрування перетягуванням файлу в чат</h2>
  <p>Це основний швидкий спосіб для відправки зашифрованого файлу в конкретний чат.</p>

  <ol class="steps">
    <li>Відкрий потрібний чат.</li>
    <li>Перетягни звичайний файл у вікно WhatsApp.</li>
    <li>Програма запитає: чи потрібно шифрувати файл перед прикріпленням.</li>
    <li>Якщо натиснути <strong>Cancel / Скасувати</strong>, файл піде у WhatsApp звичайним способом, без шифрування.</li>
    <li>Якщо натиснути <strong>OK</strong>, відкриється вибір отримувача або групи SAM Encrypt.</li>
    <li>Після вибору програма зашифрує файл.</li>
    <li>Папка Finder у цьому режимі не відкривається.</li>
    <li>Готовий <code>.samenc</code> автоматично потрапить у WhatsApp preview.</li>
    <li>Перевір, що у preview саме <code>.samenc</code>, і натисни кнопку відправки вручну.</li>
  </ol>

  <div class="box ok">
    <p><strong>Програма не натискає Send автоматично.</strong> Це зроблено навмисно: користувач має сам побачити, який файл прикріплений, і тільки після цього відправити його.</p>
  </div>

  <h3>Нюанси drag-шифрування</h3>
  <ul>
    <li>Drag-flow розрахований на один файл за раз.</li>
    <li>Якщо перетягнути вже готовий <code>.samenc</code> або <code>.samenc.zip</code>, програма не буде шифрувати його повторно.</li>
    <li>Якщо вибрати групу, файл буде зашифрований для всіх учасників цієї групи.</li>
    <li>Якщо WhatsApp preview не зʼявився, не відправляй повідомлення. Перевір статус SAM Encrypt або повтори дію.</li>
    <li>Якщо натиснути <strong>Cancel</strong> на першому питанні, програма не втручається, і WhatsApp прикріплює оригінальний файл.</li>
  </ul>

  <h2 id="decrypt">7. Отримання і розшифрування .samenc</h2>
  <p>Коли ти отримуєш файл <code>.samenc</code> у WhatsApp, його треба завантажити.</p>

  <ol class="steps">
    <li>Натисни download у WhatsApp для отриманого <code>.samenc</code>.</li>
    <li>Після завершення завантаження SAM WhatsApp Web автоматично спробує розшифрувати файл.</li>
    <li>Якщо файл зашифрований для тебе, програма розшифрує його і відкриє папку з результатом.</li>
    <li>Якщо файл не для твого ключа або пошкоджений, розшифрування не вдасться.</li>
  </ol>

  <h3>Де шукати розшифрований файл</h3>
  <p>Розшифровані файли зберігаються у службовій папці SAM Encrypt, зазвичай у підпапці <code>decrypted</code>. Її можна відкрити через <strong>Налаштування → Відкрити папку SAM Encrypt</strong>.</p>

  <h3>Чому файл може не розшифруватися</h3>
  <ul>
    <li>Файл був зашифрований не для тебе.</li>
    <li>На цьому компʼютері немає потрібного приватного ключа.</li>
    <li>Файл пошкодився під час передачі або завантаження.</li>
    <li>Було видалено або замінено ключі SAM Encrypt.</li>
  </ul>

  <h2 id="office">8. Word/Excel і preview</h2>
  <p>Програма має окремі налаштування для роботи з Word/Excel файлами.</p>

  <ul>
    <li><strong>Куди зберігати Word/Excel перед відкриттям</strong> — службова папка програми або папка Завантаження.</li>
    <li><strong>Замінювати файл з такою ж назвою</strong> — корисно, якщо не треба створювати копії з однаковими назвами.</li>
    <li><strong>Показувати preview Word/Excel</strong> — відкриває попередній перегляд перед роботою з файлом.</li>
    <li><strong>Якщо preview вимкнено — автоматично відкривати Word/Excel у LibreOffice</strong>.</li>
  </ul>

  <h3>Очищення тимчасових файлів</h3>
  <p>У Налаштуваннях можна задати, скільки днів зберігати завантажені файли і PDF preview. Також можна вручну очистити тимчасові файли.</p>

  <h2 id="copy-text">9. Копіювання повідомлень і вставка як текст</h2>
  <p>Програма додає зручні функції для роботи з текстом і файлами в WhatsApp Web.</p>

  <ul>
    <li>Можна копіювати кілька повідомлень, якщо ця функція доступна в поточному інтерфейсі.</li>
    <li>Можна вставляти деякі файли як текст, якщо це підтримується для відповідного типу файлу.</li>
    <li>Якщо файл не може бути перетворений у текст, його треба прикріпити як звичайний документ.</li>
  </ul>

  <div class="warn box">
    <p><strong>Порада:</strong> перед відправкою довгого тексту перевір, що WhatsApp вставив його повністю і без пошкодженого форматування.</p>
  </div>

  <h2 id="notepad">10. Блокнот</h2>
  <p><strong>Блокнот</strong> — це простий вбудований інструмент для тимчасових нотаток під час роботи з WhatsApp. Він потрібний, щоб користувач міг швидко записати або підготувати текст, не відкриваючи окрему програму.</p>

  <h3>Для чого використовувати Блокнот</h3>
  <ul>
    <li>тимчасово зберегти текст перед відправкою;</li>
    <li>підготувати повідомлення перед вставкою в WhatsApp;</li>
    <li>скопіювати кілька фрагментів і зібрати їх в один текст;</li>
    <li>перевірити або відредагувати текст перед відправкою;</li>
    <li>зберегти коротку службову нотатку під час роботи з чатами.</li>
  </ul>

  <h3>Як працювати з Блокнотом</h3>
  <ol class="steps">
    <li>Відкрий Блокнот через кнопку або пункт меню програми.</li>
    <li>Введи або встав потрібний текст.</li>
    <li>За потреби відредагуй текст прямо в Блокноті.</li>
    <li>Скопіюй готовий текст.</li>
    <li>Встав його у потрібний чат WhatsApp.</li>
  </ol>

  <div class="box">
    <p><strong>Важливо:</strong> Блокнот не відправляє повідомлення самостійно. Він лише допомагає підготувати або тимчасово зберегти текст. Відправлення у WhatsApp користувач виконує вручну.</p>
  </div>

  <h3>Коли Блокнот особливо корисний</h3>
  <ul>
    <li>коли треба спочатку обдумати текст, а вже потім вставити його в чат;</li>
    <li>коли треба обʼєднати текст із різних повідомлень;</li>
    <li>коли WhatsApp-поле введення незручне для довгого тексту;</li>
    <li>коли треба тимчасово не втратити текст під час переходу між чатами.</li>
  </ul>

  <div class="warn box">
    <p><strong>Порада:</strong> перед відправкою важливого тексту після вставки в WhatsApp ще раз перевір його в полі повідомлення. Блокнот допомагає підготувати текст, але остаточну перевірку перед Send краще робити вже у WhatsApp preview або полі введення.</p>
  </div>

  <h2 id="settings">11. Налаштування</h2>

  <h3>Масштаб інтерфейсу WhatsApp</h3>
  <p>Можна вибрати звичайний, компактний, дуже компактний або максимально компактний режим. Це змінює щільність списку чатів, розмір аватарок, тексту і повідомлень.</p>

  <h3>SAM Encrypt</h3>
  <ul>
    <li><strong>Оновити статус</strong> — перевіряє, чи готовий SAM Encrypt.</li>
    <li><strong>Створити мої ключі</strong> — створює ключі для цього компʼютера.</li>
    <li><strong>Експортувати публічний ключ</strong> — створює <code>.sampub</code> для передачі іншим.</li>
    <li><strong>Імпортувати публічний ключ</strong> — додає контакт, для якого можна шифрувати файли.</li>
    <li><strong>Відкрити папку SAM Encrypt</strong> — відкриває службову папку ключів, груп, зашифрованих і розшифрованих файлів.</li>
    <li><strong>Імпорт групи .samgroup</strong> — додає готову групу отримувачів.</li>
    <li><strong>Видалити контакт</strong> — прибирає контакт із локального списку.</li>
    <li><strong>Видалити групу</strong> — прибирає групу, але не видаляє контакти.</li>
  </ul>

  <h2 id="troubleshooting">12. Типові ситуації і що робити</h2>

  <h3>Не бачу SAM Encrypt отримувача</h3>
  <ul>
    <li>Перевір, чи імпортовано його <code>.sampub</code>.</li>
    <li>Відкрий Налаштування і натисни <strong>Оновити статус</strong>.</li>
    <li>Якщо контакту немає, імпортуй публічний ключ повторно.</li>
  </ul>

  <h3>Не бачу групу</h3>
  <ul>
    <li>Перевір, чи групу створено або імпортовано.</li>
    <li>Натисни <strong>Оновити список груп</strong>.</li>
    <li>Якщо група була передана файлом, імпортуй <code>.samgroup</code>.</li>
  </ul>

  <h3>Після drag-шифрування не зʼявився WhatsApp preview</h3>
  <ul>
    <li>Не натискай Send.</li>
    <li>Перевір статус SAM Encrypt у нижній частині вікна.</li>
    <li>Спробуй повторити перетягування файлу.</li>
    <li>Як запасний варіант скористайся кнопкою SAM Encrypt і прикріпи створений <code>.samenc</code> вручну.</li>
  </ul>

  <h3>Отримувач не може розшифрувати файл</h3>
  <ul>
    <li>Переконайся, що файл був зашифрований саме для цього отримувача або для групи, де він є.</li>
    <li>Перевір, чи отримувач не перевстановив ключі після передачі тобі свого <code>.sampub</code>.</li>
    <li>Якщо ключі змінювалися, потрібно отримати новий <code>.sampub</code> і зашифрувати файл повторно.</li>
  </ul>

  <h3>WhatsApp прикріпив не той файл</h3>
  <ul>
    <li>Перед відправкою завжди дивись на preview.</li>
    <li>Для зашифрованого відправлення назва файлу має закінчуватися на <code>.samenc</code> або <code>.samenc.zip</code>.</li>
    <li>Якщо бачиш оригінальний <code>.docx</code>, <code>.pdf</code>, <code>.jpg</code> тощо — це не зашифрована відправка.</li>
  </ul>

  <h3>Що можна безпечно передавати іншим</h3>
  <ul>
    <li><code>.sampub</code> — так, це публічний ключ.</li>
    <li><code>.samgroup</code> — так, якщо треба передати склад групи.</li>
    <li><code>.samenc</code> — так, це зашифрований файл.</li>
    <li><code>.samkey</code> — ні, це приватний ключ.</li>
  </ul>

  <div class="box">
    <p><strong>Головне правило:</strong> якщо файл треба передати захищено — у WhatsApp preview перед відправкою має бути саме <code>.samenc</code>, а не оригінальний файл.</p>
  </div>

  <script>
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('.toc a[href^="#"]').forEach((link) => {
        link.addEventListener('click', (event) => {
          event.preventDefault();

          const href = link.getAttribute('href') || '';
          const id = href.slice(1);

          if (!id) {
            return;
          }

          const target = document.getElementById(id);

          if (!target) {
            return;
          }

          target.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
          });

          history.replaceState(null, '', '#' + id);
        });
      });
    });
  </script>
</body>
</html>`;

  helpWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}


function createAppMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Файл',
      submenu: [
        {
          label: 'Показати',
          click: () => showMainWindow()
        },
        {
          label: 'Сховати в трей',
          click: () => {
            if (mainWindow) {
              mainWindow.hide();
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Вийти',
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Повідомлення',
      submenu: [
        {
          label: 'Режим вибору повідомлень',
          accelerator: 'Ctrl+Shift+M',
          click: () => {
            sendToWhatsAppPreload('wa-selection:toggle');
          }
        },
        {
          label: 'Копіювати вибрані повідомлення',
          accelerator: 'Ctrl+Shift+C',
          click: () => {
            sendToWhatsAppPreload('wa-selection:copy');
          }
        },
        {
          label: 'Очистити вибір',
          click: () => {
            sendToWhatsAppPreload('wa-selection:clear');
          }
        }
      ]
    },
    {
      label: 'Налаштування',
      submenu: [
        {
          label: 'Відкрити налаштування',
          click: () => {
            createSettingsWindow();
          }
        },
        {
          label: 'Очистити тимчасові файли',
          click: () => {
            const result = clearAllCaches();

            dialog.showMessageBox({
              type: 'info',
              title: getAppWindowTitle(),
              message: 'Тимчасові файли очищено',
              detail: `Видалено файлів: ${result.deletedFiles}`,
              buttons: ['OK']
            }).catch(() => {});
          }
        },
        {
          label: 'Відкрити папку Word/Excel',
          click: () => {
            shell.openPath(getAttachmentCacheDir()).catch(() => {});
          }
        },
        {
          label: 'Відкрити папку preview',
          click: () => {
            shell.openPath(getPreviewCacheDir()).catch(() => {});
          }
        }
      ]
    },
    {
      label: 'Вид',
      submenu: [
        {
          label: 'Перезавантажити WhatsApp Web',
          accelerator: 'Ctrl+R',
          click: () => {
            if (mainWindow) {
              mainWindow.reload();
            }
          }
        },
        {
          label: 'Збільшити',
          role: 'zoomIn'
        },
        {
          label: 'Зменшити',
          role: 'zoomOut'
        },
        {
          label: 'Скинути масштаб',
          role: 'resetZoom'
        },
        { type: 'separator' },
        {
          label: 'DevTools',
          accelerator: 'Ctrl+Shift+I',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.openDevTools({ mode: 'detach' });
            }
          }
        }
      ]
    },

    {
      label: 'Довідка',
      submenu: [
        {
          label: 'Як користуватися SAM WhatsApp Web',
          click: () => {
            showHelpWindow();
          }
        },
        { type: 'separator' },
        {
          label: 'Про програму',
          click: () => {
            dialog.showMessageBox(mainWindow || undefined, {
              type: 'info',
              title: 'SAM WhatsApp Web',
              message: 'SAM WhatsApp Web',
              detail: 'Desktop-програма для роботи з WhatsApp Web з додатковими SAM-функціями: SAM Encrypt, автоматичне розшифрування .samenc, копіювання кількох повідомлень, локальні закріплені чати, робота з офісними файлами, вставка як текст та зручне керування вікном.'
            });
          }
        }
      ]
    },

]);

  Menu.setApplicationMenu(menu);
}


function showMainWindowFromTray() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }

  if (mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.focus();
  mainWindow.setTitle(getAppWindowTitle());
}

function createTray() {
  const trayImage = nativeImage
    .createFromPath(getTrayIconPath())
    .resize({ width: 22, height: 22 });

  tray = new Tray(trayImage);
  tray.setToolTip(APP_NAME);

  tray.on('click', () => {
    showMainWindowFromTray();
  });

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Показати',
      click: () => showMainWindow()
    },
    {
      label: 'Сховати',
      click: () => {
        if (mainWindow) {
          mainWindow.hide();
        }
      }
    },
    {
      label: 'Перезавантажити',
      click: () => {
        if (mainWindow) {
          mainWindow.reload();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Вийти',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    showMainWindow();
  });
}


function sanitizeFilename(name) {
  const fallbackName = 'whatsapp-download';
  const rawName = String(name || fallbackName).trim() || fallbackName;

  return rawName
    .replace(/[\\/]/g, '_')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/^\.+$/, fallbackName)
    .slice(0, 180);
}

function getUniqueDownloadPath(directory, filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(directory, filename);

  if (!fs.existsSync(candidate)) {
    return candidate;
  }

  for (let i = 1; i < 1000; i += 1) {
    const nextName = `${parsed.name} (${i})${parsed.ext}`;
    candidate = path.join(directory, nextName);

    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  return path.join(directory, `${parsed.name}_${timestamp}${parsed.ext}`);
}

function isOfficeDocument(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return OFFICE_EXTENSIONS.has(ext);
}


function findExecutable(names) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);

  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);

      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Пробуємо наступний шлях.
      }
    }
  }

  return null;
}

function runDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WINEDEBUG: '-all'
    }
  });

  child.unref();
}

async function openOfficeDocument(filePath) {
  const officeBinary = findExecutable(['libreoffice', 'soffice']);

  if (!officeBinary) {
    await openExternalFile(filePath);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();

  const writerExtensions = new Set(['.doc', '.docx', '.odt']);
  const calcExtensions = new Set(['.xls', '.xlsx', '.xlsm', '.ods', '.csv']);

  const args = ['--nologo'];

  if (writerExtensions.has(ext)) {
    args.push('--writer');
  } else if (calcExtensions.has(ext)) {
    args.push('--calc');
  }

  args.push(filePath);

  try {
    runDetached(officeBinary, args);
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: getAppWindowTitle(),
      message: 'Не вдалося відкрити документ через LibreOffice',
      detail: String(error),
      buttons: ['OK']
    });
  }
}


function runProcessAndWait(command, args, timeoutMs = 90000, label = 'процес') {
  return new Promise((resolve, reject) => {
    let finished = false;
    let stderrText = '';

    const child = spawn(command, args, {
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        WINEDEBUG: '-all'
      }
    });

    const timer = setTimeout(() => {
      if (finished) {
        return;
      }

      finished = true;

      try {
        child.kill('SIGKILL');
      } catch {
        // Процес уже міг завершитися.
      }

      reject(new Error(`Перевищено час очікування конвертації документа: ${label}`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      if (stderrText.length < 4000) {
        stderrText += chunk.toString();
      }
    });

    child.on('error', (error) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${label} завершився з кодом ${code}\n${stderrText}`));
    });
  });
}

function findPdfInDirectory(directory) {
  try {
    const files = fs.readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith('.pdf'))
      .map((name) => path.join(directory, name));

    if (files.length > 0) {
      return files[0];
    }
  } catch {
    // Директорія може бути недоступна.
  }

  return null;
}


function getMicrosoftOfficeConverterKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const wordExtensions = new Set(['.doc', '.docx', '.docm', '.rtf', '.odt']);
  const excelExtensions = new Set(['.xls', '.xlsx', '.xlsm', '.xlsb', '.ods', '.csv']);

  if (wordExtensions.has(ext)) {
    return 'word';
  }

  if (excelExtensions.has(ext)) {
    return 'excel';
  }

  return null;
}

function getWindowsPowerShellBinary() {
  return findExecutable(['powershell.exe', 'powershell']) || 'powershell.exe';
}

function writeMicrosoftOfficePdfConverterScript(scriptPath) {
  const script = [
    'param(',
    '  [Parameter(Mandatory=$true)][string]$InputPath,',
    '  [Parameter(Mandatory=$true)][string]$OutputPath,',
    '  [Parameter(Mandatory=$true)][string]$Kind',
    ')',
    '',
    '$ErrorActionPreference = "Stop"',
    '$inputFull = [System.IO.Path]::GetFullPath($InputPath)',
    '$outputFull = [System.IO.Path]::GetFullPath($OutputPath)',
    '',
    'if ($Kind -eq "word") {',
    '  $word = $null',
    '  $doc = $null',
    '  try {',
    '    $word = New-Object -ComObject Word.Application',
    '    $word.Visible = $false',
    '    $word.DisplayAlerts = 0',
    '    $doc = $word.Documents.Open($inputFull, $false, $true)',
    '    $doc.ExportAsFixedFormat($outputFull, 17)',
    '  } finally {',
    '    if ($doc -ne $null) {',
    '      $doc.Close($false) | Out-Null',
    '      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null',
    '    }',
    '    if ($word -ne $null) {',
    '      $word.Quit() | Out-Null',
    '      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null',
    '    }',
    '    [GC]::Collect()',
    '    [GC]::WaitForPendingFinalizers()',
    '  }',
    '  exit 0',
    '}',
    '',
    'if ($Kind -eq "excel") {',
    '  $excel = $null',
    '  $workbook = $null',
    '  try {',
    '    $excel = New-Object -ComObject Excel.Application',
    '    $excel.Visible = $false',
    '    $excel.DisplayAlerts = $false',
    '    $workbook = $excel.Workbooks.Open($inputFull, 3, $true)',
    '    $workbook.ExportAsFixedFormat(0, $outputFull)',
    '  } finally {',
    '    if ($workbook -ne $null) {',
    '      $workbook.Close($false) | Out-Null',
    '      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) | Out-Null',
    '    }',
    '    if ($excel -ne $null) {',
    '      $excel.Quit() | Out-Null',
    '      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null',
    '    }',
    '    [GC]::Collect()',
    '    [GC]::WaitForPendingFinalizers()',
    '  }',
    '  exit 0',
    '}',
    '',
    'throw "Unsupported Microsoft Office converter kind: $Kind"',
    ''
  ].join('\n');

  fs.writeFileSync(scriptPath, script, 'utf8');
}

async function convertOfficeDocumentToPdfWithMicrosoftOffice(filePath, cachedPdf) {
  if (process.platform !== 'win32') {
    throw new Error('Microsoft Office preview fallback доступний тільки у Windows');
  }

  const kind = getMicrosoftOfficeConverterKind(filePath);

  if (!kind) {
    throw new Error(`Microsoft Office preview не підтримує цей тип файла: ${path.extname(filePath)}`);
  }

  const workDir = fs.mkdtempSync(path.join(getPreviewCacheDir(), 'ms-office-convert-'));
  const scriptPath = path.join(workDir, 'convert-office-to-pdf.ps1');
  const powershellBinary = getWindowsPowerShellBinary();

  try {
    writeMicrosoftOfficePdfConverterScript(scriptPath);

    await runProcessAndWait(
      powershellBinary,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-InputPath',
        filePath,
        '-OutputPath',
        cachedPdf,
        '-Kind',
        kind
      ],
      120000,
      'Microsoft Office'
    );

    if (!fs.existsSync(cachedPdf)) {
      throw new Error('Microsoft Office не створив PDF-файл для попереднього перегляду');
    }

    return cachedPdf;
  } finally {
    try {
      clearDirectoryFiles(workDir);
      fs.rmdirSync(workDir);
    } catch {
      // Не критично.
    }
  }
}

async function convertOfficeDocumentToPdf(filePath) {
  const cachedPdf = getPreviewPdfPathForFile(filePath);

  if (fs.existsSync(cachedPdf)) {
    return cachedPdf;
  }

  const officeBinary = findExecutable(['libreoffice', 'soffice']);

  if (officeBinary) {
    const workDir = fs.mkdtempSync(path.join(getPreviewCacheDir(), 'convert-'));

    const args = [
      '--headless',
      '--nologo',
      '--nolockcheck',
      '--nodefault',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      workDir,
      filePath
    ];

    try {
      await runProcessAndWait(officeBinary, args, 90000, 'LibreOffice');

      const expectedPdf = path.join(workDir, `${path.parse(filePath).name}.pdf`);
      const foundPdf = fs.existsSync(expectedPdf) ? expectedPdf : findPdfInDirectory(workDir);

      if (!foundPdf) {
        throw new Error('LibreOffice не створив PDF-файл для попереднього перегляду');
      }

      fs.copyFileSync(foundPdf, cachedPdf);

      try {
        clearDirectoryFiles(workDir);
        fs.rmdirSync(workDir);
      } catch {
        // Не критично.
      }

      return cachedPdf;
    } catch (error) {
      try {
        clearDirectoryFiles(workDir);
        fs.rmdirSync(workDir);
      } catch {
        // Не критично.
      }

      if (process.platform !== 'win32') {
        throw error;
      }

      console.warn('LibreOffice preview failed, trying Microsoft Office fallback:', error);
    }
  }

  if (process.platform === 'win32') {
    return convertOfficeDocumentToPdfWithMicrosoftOffice(filePath, cachedPdf);
  }

  throw new Error('LibreOffice не знайдено');
}


function createPreviewWindow(originalPath, pdfPath) {
  const previewWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 560,
    minHeight: 420,
    title: `Попередній перегляд - ${path.basename(originalPath)}`,
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preview_preload.js')
    }
  });

  previewWindow.loadFile('preview.html', {
    query: {
      title: path.basename(originalPath),
      originalPath,
      pdfUrl: pathToFileURL(pdfPath).href
    }
  }).catch((error) => {
    dialog.showErrorBox('Помилка попереднього перегляду', String(error));
  });

  return previewWindow;
}

async function showOfficePreview(filePath) {
  try {
    const pdfPath = await convertOfficeDocumentToPdf(filePath);
    createPreviewWindow(filePath, pdfPath);
  } catch (error) {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: getAppWindowTitle(),
      message: 'Не вдалося створити попередній перегляд',
      detail: `${String(error)}\n\nФайл можна відкрити у системній програмі за замовчуванням.`,
      buttons: ['Відкрити файл', 'Показати в папці', 'OK'],
      defaultId: 0,
      cancelId: 2
    });

    if (result.response === 0) {
      await openOfficeDocument(filePath);
      return;
    }

    if (result.response === 1) {
      shell.showItemInFolder(filePath);
    }
  }
}

function registerPreviewIpcHandlers() {
  ipcMain.handle('preview:open-original', async (_event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) {
      return false;
    }

    await openOfficeDocument(filePath);
    return true;
  });

  ipcMain.handle('preview:show-in-folder', async (_event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) {
      return false;
    }

    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle('preview:close-window', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);

    if (window) {
      window.close();
    }

    return true;
  });
}

async function openExternalFile(filePath) {
  try {
    const errorMessage = await shell.openPath(filePath);

    if (errorMessage) {
      await dialog.showMessageBox({
        type: 'warning',
        title: getAppWindowTitle(),
        message: 'Не вдалося автоматично відкрити файл',
        detail: `${filePath}\n\n${errorMessage}`,
        buttons: ['OK']
      });
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: getAppWindowTitle(),
      message: 'Помилка відкриття файлу',
      detail: String(error),
      buttons: ['OK']
    });
  }
}

async function showDownloadActions(filePath) {
  const result = await dialog.showMessageBox({
    type: 'info',
    title: getAppWindowTitle(),
    message: 'Файл завантажено',
    detail: filePath,
    buttons: ['Відкрити', 'Показати в папці', 'OK'],
    defaultId: 0,
    cancelId: 2
  });

  if (result.response === 0) {
    await openExternalFile(filePath);
    return;
  }

  if (result.response === 1) {
    shell.showItemInFolder(filePath);
  }
}

function configureSession() {
  const waSession = session.fromPartition(SESSION_PARTITION, { cache: true });

  waSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = CHROME_USER_AGENT;
    callback({ requestHeaders: details.requestHeaders });
  });

  waSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details && details.requestingUrl ? details.requestingUrl : webContents.getURL();

    const allowedPermissions = new Set([
      'media',
      'microphone',
      'camera',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'fullscreen'
    ]);

    const allowed =
      allowedPermissions.has(permission) &&
      isTrustedWhatsAppPermissionOrigin(requestingUrl);

    callback(allowed);
  });

  waSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const allowedPermissions = new Set([
      'media',
      'microphone',
      'camera',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'fullscreen'
    ]);

    return (
      allowedPermissions.has(permission) &&
      isTrustedWhatsAppPermissionOrigin(requestingOrigin)
    );
  });

  waSession.on('will-download', (event, item) => {
    try {
      const originalName = item.getFilename() || 'whatsapp-download';
      const safeName = sanitizeFilename(originalName);
      const isOfficeByName = OFFICE_EXTENSIONS.has(path.extname(safeName).toLowerCase());

      const savePath = isOfficeByName
        ? getOfficeDownloadSavePath(safeName)
        : getUniqueDownloadPath(app.getPath('downloads'), safeName);

      item.setSavePath(savePath);

      item.once('done', async (_event, state) => {
        if (state !== 'completed') {
          return;
        }

        const samEncryptDownloadResult = await handleSamEncryptDownloadedFile(savePath);

        if (samEncryptDownloadResult && samEncryptDownloadResult.handled) {
          return;
        }

        if (isOfficeDocument(savePath)) {
          cleanupCachesBySettings();

          const settings = loadSettings();

          if (settings.previewOfficeDownloads) {
            if (process.platform === 'win32') {
              await openOfficeDocument(savePath);
              return;
            }

            await showOfficePreview(savePath);
            return;
          }

          if (settings.autoOpenOfficeDownloads) {
            await openOfficeDocument(savePath);
            return;
          }
        }

        await showDownloadActions(savePath);
      });
    } catch (error) {
      item.cancel();
      dialog.showErrorBox('Помилка завантаження', String(error));
    }
  });
}


function isSamEncryptDownloadFile(filePath) {
  return path.extname(String(filePath || '')).toLowerCase() === '.samenc';
}

function getSamEncryptDecryptedDir() {
  const decryptedDir = path.join(getSamEncryptHomeDir(), 'decrypted');
  fs.mkdirSync(decryptedDir, { recursive: true });
  return decryptedDir;
}

async function handleSamEncryptDownloadedFile(filePath) {
  if (!isSamEncryptDownloadFile(filePath)) {
    return {
      handled: false
    };
  }

  const inputPath = String(filePath || '');

  if (!inputPath || !fs.existsSync(inputPath)) {
    return {
      handled: true,
      ok: false,
      error: `SAM Encrypt файл не знайдено: ${inputPath}`
    };
  }

  const outputDir = getSamEncryptDecryptedDir();

  const result = await runSamEncryptCli([
    'decrypt',
    '--input',
    inputPath,
    '--output-dir',
    outputDir
  ]);

  if (!result || !result.ok) {
    const message = result && result.error
      ? result.error
      : 'невідома помилка розшифрування';

    await dialog.showMessageBox({
      type: 'error',
      title: getAppWindowTitle(),
      message: 'Не вдалося автоматично розшифрувати SAM Encrypt файл',
      detail: `${message}\n\nЗавантажений файл:\n${inputPath}`,
      buttons: ['Показати .samenc', 'OK'],
      defaultId: 0,
      cancelId: 1
    }).then((response) => {
      if (response.response === 0) {
        shell.showItemInFolder(inputPath);
      }
    });

    return {
      handled: true,
      ok: false,
      error: message,
      inputPath
    };
  }

  const outputPath = result.output_path || result.outputPath || result.file_path || result.filePath || null;

  if (outputPath && fs.existsSync(outputPath)) {
    shell.showItemInFolder(outputPath);
  } else {
    shell.showItemInFolder(outputDir);
  }

  return {
    handled: true,
    ok: true,
    inputPath,
    outputDir,
    outputPath,
    result
  };
}


function registerWhatsAppContextMenu(win) {
  if (!win || win.__samContextMenuRegistered) {
    return;
  }

  win.__samContextMenuRegistered = true;

  win.webContents.on('context-menu', (event, params) => {
    const template = [];

    if (params.isEditable) {
      template.push({
        label: 'Вставити як текст',
        enabled: clipboard.readText().length > 0,
        click: () => {
          const text = clipboard.readText();

          if (text) {
            win.webContents.send('wa:insert-plain-text', text);
          }
        }
      });

      template.push({
        label: 'Вставити',
        role: 'paste',
        enabled: params.editFlags ? params.editFlags.canPaste : true
      });

      template.push({ type: 'separator' });

      template.push({
        label: 'Вирізати',
        role: 'cut',
        enabled: params.editFlags ? params.editFlags.canCut : true
      });

      template.push({
        label: 'Копіювати',
        role: 'copy',
        enabled: params.editFlags ? params.editFlags.canCopy : true
      });

      template.push({
        label: 'Виділити все',
        role: 'selectAll',
        enabled: params.editFlags ? params.editFlags.canSelectAll : true
      });
    } else {
      template.push({
        label: 'Копіювати',
        role: 'copy',
        enabled: Boolean(params.selectionText)
      });

      template.push({
        label: 'Виділити все',
        role: 'selectAll'
      });
    }

    if (template.length === 0) {
      return;
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: win
    });
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
  transparent: false,
  alwaysOnTop: false,
  skipTaskbar: false,

  resizable: true,
  maximizable: true,
  minimizable: true,
  movable: true,
  fullscreenable: true,
  frame: true,

    width: 1280,
    height: 820,
    minWidth: 560,
    minHeight: 420,
    title: getAppWindowTitle(),
    icon: getIconPath(),
    show: false,
    webPreferences: {
      partition: SESSION_PARTITION,
      preload: SAM_DISABLE_PRELOAD ? undefined : path.join(__dirname, 'wa_preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  });

  if (SAM_DISABLE_PRELOAD) {
    console.log('[SAM] DIAGNOSTIC SAFE MODE: wa_preload.js disabled');
  }

  mainWindow.setTitle(getAppWindowTitle());

  mainWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(getAppWindowTitle());
  });

  mainWindow.setResizable(true);
  mainWindow.setMovable(true);
  mainWindow.setMaximizable(true);
  registerSamUnreadTitleObserver(mainWindow.webContents);
  mainWindow.setMinimizable(true);
  mainWindow.setFullScreenable(true);
  mainWindow.setMinimumSize(560, 420);

  registerWhatsAppContextMenu(mainWindow);

  mainWindow.webContents.setUserAgent(CHROME_USER_AGENT);

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isWhatsAppWebUrl(url)) {
      return { action: 'allow' };
    }

    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isWhatsAppWebUrl(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(WHATSAPP_URL, { userAgent: CHROME_USER_AGENT }).catch((error) => {
    dialog.showErrorBox('Помилка запуску WhatsApp Web', String(error));
  });
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  
function getSamNotesFilePath() {
  return path.join(app.getPath('userData'), 'sam_notes.json');
}

function normalizeSamNotesForFile(notes) {
  if (!Array.isArray(notes)) {
    return [];
  }

  return notes
    .filter((note) => note && typeof note.text === 'string')
    .map((note) => ({
      id: String(note.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
      createdAt: String(note.createdAt || new Date().toISOString()),
      source: String(note.source || 'manual'),
      chatTitle: String(note.chatTitle || ''),
      title: String(note.title || note.chatTitle || ''),
      text: String(note.text || '')
    }));
}

function readSamNotesFromFile() {
  const filePath = getSamNotesFilePath();

  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = raw ? JSON.parse(raw) : [];

    return normalizeSamNotesForFile(parsed);
  } catch (error) {
    electronLog.warn('Failed to read SAM notes file', error);
    return [];
  }
}

function writeSamNotesToFile(notes) {
  const filePath = getSamNotesFilePath();
  const normalized = normalizeSamNotesForFile(notes);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');

  return normalized;
}

function formatSamNotesExportDate(value) {
  try {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return '';
    }

    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = String(date.getFullYear());
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');

    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
  } catch (_error) {
    return '';
  }
}

function buildSamNotesExportText(notes) {
  const normalized = normalizeSamNotesForFile(notes);

  if (!normalized.length) {
    return 'SAM-блокнот\n\nНотаток немає.\n';
  }

  const lines = ['SAM-блокнот', ''];

  normalized
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .forEach((note, index) => {
      lines.push(`=== ${index + 1}. ${formatSamNotesExportDate(note.createdAt) || 'Без дати'} ===`);

      if (note.chatTitle) {
        lines.push(`Чат: ${note.chatTitle}`);
      }

      if (note.source) {
        lines.push(`Джерело: ${note.source}`);
      }

      lines.push('');
      lines.push(note.text || '');
      lines.push('');
    });

  return lines.join('\n');
}

function registerNotesIpcHandlers() {
  ipcMain.handle('notes:load', async () => {
    return readSamNotesFromFile();
  });

  ipcMain.handle('notes:save', async (_event, payload) => {
    const notes = payload && Array.isArray(payload.notes) ? payload.notes : [];
    return writeSamNotesToFile(notes);
  });

  ipcMain.handle('notes:export', async (_event, payload) => {
    const notes = payload && Array.isArray(payload.notes) ? payload.notes : readSamNotesFromFile();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultPath = path.join(app.getPath('documents'), `SAM-блокнот-${stamp}.txt`);

    const result = await dialog.showSaveDialog({
      title: 'Експорт SAM-блокнота',
      defaultPath,
      filters: [
        { name: 'Text files', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return {
        ok: false,
        canceled: true
      };
    }

    fs.writeFileSync(result.filePath, buildSamNotesExportText(notes), 'utf8');

    return {
      ok: true,
      filePath: result.filePath
    };
  });
}

function setupAutoUpdater() {
  // Поки GitHub Release містить тільки Linux AppImage.
  // На macOS electron-updater шукає latest-mac.yml і показує 404.
  if (process.platform !== 'linux') {
    electronLog.info(`Auto-update disabled on platform: ${process.platform}`);
    return;
  }


  if (!app.isPackaged) {
    return;
  }

  autoUpdater.logger = electronLog;
  autoUpdater.logger.transports.file.level = 'info';

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    console.log('[auto-update] checking for update');
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[auto-update] update not available');
  });

  autoUpdater.on('update-available', async (info) => {
    console.log('[auto-update] update available', info && info.version);

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Завантажити', 'Пізніше'],
      defaultId: 0,
      cancelId: 1,
      title: 'Доступне оновлення',
      message: `Доступна нова версія SAM WhatsApp Web ${info.version || ''}.`,
      detail: 'Завантажити оновлення зараз?'
    });

    if (result.response === 0) {
      autoUpdater.downloadUpdate().catch((err) => {
        console.error('[auto-update] download error', err);
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = progress && typeof progress.percent === 'number'
      ? progress.percent.toFixed(1)
      : '?';

    console.log(`[auto-update] download progress: ${percent}%`);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    console.log('[auto-update] update downloaded', info && info.version);

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Перезапустити зараз', 'Пізніше'],
      defaultId: 0,
      cancelId: 1,
      title: 'Оновлення завантажено',
      message: 'Оновлення SAM WhatsApp Web завантажено.',
      detail: 'Перезапустити програму і встановити оновлення?'
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[auto-update] error', err);

    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['OK'],
      title: 'Помилка оновлення',
      message: 'Не вдалося перевірити або завантажити оновлення.',
      detail: err && err.message ? err.message : String(err || '')
    }).catch(() => {});
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[auto-update] check error', err);
    });
  }, 8000);
}


app.whenReady().then(() => {
    app.setName(APP_NAME);

    loadSettings();
    cleanupCachesBySettings();
    configureSession();
    registerSettingsIpcHandlers();
    registerMessageCopyIpcHandlers();
  registerNotesIpcHandlers();
    registerPreviewIpcHandlers();
  registerSamEncryptIpcHandlers();
  registerSamEncryptSettingsIpcHandlers();
  registerSamUnreadBadgeIpcHandlers();
    createAppMenu();
  ensureStandardEditMenuForClipboard();
    createTray();
    createMainWindow();
    setupAutoUpdater();
  }).catch((error) => {
    dialog.showErrorBox('Помилка ініціалізації', String(error));
  });

  app.on('activate', () => {
    showMainWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('window-all-closed', () => {
    // Для Linux залишаємо процес активним у tray.
  });
}

function getSamEncryptHelperRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'helpers', 'sam_encrypt');
  }

  return path.join(__dirname, 'helpers', 'sam_encrypt');
}

function getSamEncryptCliPath() {
  return path.join(getSamEncryptHelperRoot(), 'sam_encrypt_cli.py');
}

function getSamEncryptCliBinaryPath() {
  const binaryName = process.platform === 'win32'
    ? 'sam_encrypt_cli_bin.exe'
    : 'sam_encrypt_cli_bin';

  return path.join(getSamEncryptHelperRoot(), binaryName);
}

function getSamEncryptHomeDir() {
  return path.join(app.getPath('userData'), 'sam-encrypt');
}

function getSamEncryptPythonExecutable() {
  const helperRoot = getSamEncryptHelperRoot();

  const candidates = process.platform === 'win32'
    ? [
        path.join(helperRoot, '.venv', 'Scripts', 'python.exe'),
        'python'
      ]
    : [
        path.join(helperRoot, '.venv', 'bin', 'python3'),
        path.join(helperRoot, '.venv', 'bin', 'python'),
        'python3',
        'python'
      ];

  for (const candidate of candidates) {
    if (candidate === 'python3' || candidate === 'python') {
      return candidate;
    }

    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

function runSamEncryptCli(args) {
  return new Promise((resolve) => {
    const helperRoot = getSamEncryptHelperRoot();
    const cliPath = getSamEncryptCliPath();
    const binaryPath = getSamEncryptCliBinaryPath();
    const useBinary = fs.existsSync(binaryPath);
    const executablePath = useBinary
      ? binaryPath
      : getSamEncryptPythonExecutable();
    const executableArgs = useBinary
      ? args
      : [cliPath, ...args];
    const samHome = getSamEncryptHomeDir();

    if (!useBinary && !fs.existsSync(cliPath)) {
      resolve({
        ok: false,
        error: `SAM Encrypt CLI не знайдено: ${cliPath}`,
        helperRoot,
        cliPath,
        binaryPath,
        useBinary,
        samHome
      });
      return;
    }

    fs.mkdirSync(samHome, { recursive: true });

    const child = spawn(executablePath, executableArgs, {
      cwd: helperRoot,
      env: {
        ...process.env,
        SAM_ENCRYPT_HOME: samHome
      },
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      resolve({
        ok: false,
        error: error.message,
        helperRoot,
        cliPath,
        binaryPath,
        executablePath,
        executableArgs,
        useBinary,
        samHome,
        stdout,
        stderr
      });
    });

    child.on('close', (code) => {
      const text = stdout.trim();

      let parsed = null;

      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          parsed = {
            ok: false,
            error: `Не вдалося прочитати JSON від SAM Encrypt CLI: ${error.message}`,
            raw_stdout: stdout
          };
        }
      } else {
        parsed = {
          ok: code === 0,
          error: code === 0 ? null : 'SAM Encrypt CLI завершився без JSON-виводу.'
        };
      }

      resolve({
        ...parsed,
        exitCode: code,
        helperRoot,
        cliPath,
        binaryPath,
        executablePath,
        executableArgs,
        useBinary,
        samHome,
        stderr
      });
    });
  });
}


function registerSamEncryptIpcHandlers() {
  ipcMain.handle('sam-encrypt:read-file-for-synthetic-drop', async (_event, payload) => {
    try {
      const filePath = payload && payload.filePath ? String(payload.filePath) : '';

      if (!filePath) {
        return {
          ok: false,
          error: 'Не передано шлях до файлу для synthetic drop.'
        };
      }

      const resolvedPath = path.resolve(filePath);

      if (!fs.existsSync(resolvedPath)) {
        return {
          ok: false,
          error: `Файл не знайдено: ${resolvedPath}`
        };
      }

      const stat = fs.statSync(resolvedPath);

      if (!stat.isFile()) {
        return {
          ok: false,
          error: `Це не файл: ${resolvedPath}`
        };
      }

      const maxBytes = 300 * 1024 * 1024;

      if (stat.size > maxBytes) {
        return {
          ok: false,
          error: `Файл завеликий для synthetic drop: ${stat.size} bytes`
        };
      }

      const buffer = fs.readFileSync(resolvedPath);

      return {
        ok: true,
        filePath: resolvedPath,
        fileName: path.basename(resolvedPath),
        size: stat.size,
        mimeType: 'application/octet-stream',
        base64: buffer.toString('base64')
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message || String(error)
      };
    }
  });


  ipcMain.handle('sam-encrypt:status', async () => {
    return runSamEncryptCli(['status']);
  });

  ipcMain.handle('sam-encrypt:list-contacts', async () => {
    return runSamEncryptCli(['list-contacts']);
  });

  ipcMain.handle('sam-encrypt-settings:list-groups', async () => {
    return runSamEncryptCli(['list-groups']);
  });

  ipcMain.handle('sam-encrypt-settings:import-group', async () => {
    return chooseSamEncryptGroupFileAndImport();
  });

  ipcMain.handle('sam-encrypt-settings:delete-contact', async (_event, payload = {}) => {
    const contactId = Number.parseInt(String(payload.contactId || payload.id || ''), 10);
    const keyId = String(payload.keyId || '').trim();

    const args = ['delete-contact'];

    if (Number.isInteger(contactId) && contactId > 0) {
      args.push('--id', String(contactId));
    } else if (keyId) {
      args.push('--key-id', keyId);
    } else {
      return {
        ok: false,
        error: 'Не задано contactId або keyId.'
      };
    }

    return runSamEncryptCli(args);
  });

  ipcMain.handle('sam-encrypt-settings:delete-group', async (_event, payload = {}) => {
    const groupId = String(payload.groupId || '').trim();

    if (!groupId) {
      return {
        ok: false,
        error: 'Не задано groupId.'
      };
    }

    return runSamEncryptCli(['delete-group', '--group-id', groupId]);
  });

  ipcMain.handle('sam-encrypt:list-groups', async () => {
    return runSamEncryptCli(['list-groups']);
  });

  ipcMain.handle('sam-encrypt:choose-file-for-encryption', async () => {
    return chooseFileForSamEncryption();
  });

  ipcMain.handle('sam-encrypt:choose-file-and-encrypt', async (_event, payload = {}) => {
    return chooseFileAndEncrypt(payload);
  });

  ipcMain.handle('sam-encrypt:encrypt-self', async (_event, payload = {}) => {
    if (!payload.inputPath) {
      return {
        ok: false,
        error: 'Не задано inputPath.'
      };
    }

    const args = [
      'encrypt-self',
      '--input',
      String(payload.inputPath)
    ];

    if (payload.outputDir) {
      args.push('--output-dir', String(payload.outputDir));
    }

    return runSamEncryptCli(args);
  });

  ipcMain.handle('sam-encrypt:decrypt', async (_event, payload = {}) => {
    if (!payload.inputPath) {
      return {
        ok: false,
        error: 'Не задано inputPath.'
      };
    }

    const args = [
      'decrypt',
      '--input',
      String(payload.inputPath)
    ];

    if (payload.outputDir) {
      args.push('--output-dir', String(payload.outputDir));
    }

    return runSamEncryptCli(args);
  });
}

function ensureStandardEditMenuForClipboard() {
  const currentMenu = Menu.getApplicationMenu();

  if (!currentMenu) {
    return;
  }

  const hasEditMenu = currentMenu.items.some((item) => {
    const label = String(item.label || '').toLowerCase();
    return item.role === 'editMenu'
      || label === 'edit'
      || label === 'редагування'
      || label.includes('edit');
  });

  if (hasEditMenu) {
    return;
  }

  const editMenu = Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'pasteAndMatchStyle', label: 'Paste and Match Style' },
        { role: 'delete', label: 'Delete' },
        { type: 'separator' },
        { role: 'selectAll', label: 'Select All' }
      ]
    }
  ]).items[0];

  const insertIndex = process.platform === 'darwin'
    ? Math.min(1, currentMenu.items.length)
    : 0;

  currentMenu.insert(insertIndex, editMenu);
  Menu.setApplicationMenu(currentMenu);
}

async function chooseSamEncryptGroupFileAndImport() {
  const ownerWindow = BrowserWindow.getFocusedWindow() || mainWindow || undefined;

  const dialogResult = await dialog.showOpenDialog(ownerWindow, {
    title: 'Імпорт групи SAM Encrypt',
    properties: ['openFile'],
    buttonLabel: 'Імпортувати групу',
    filters: [
      {
        name: 'SAM Encrypt group',
        extensions: ['samgroup']
      },
      {
        name: 'All files',
        extensions: ['*']
      }
    ]
  });

  if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length < 1) {
    return {
      ok: false,
      cancelled: true,
      error: null
    };
  }

  const inputPath = dialogResult.filePaths[0];

  const result = await runSamEncryptCli([
    'import-group',
    '--file',
    inputPath
  ]);

  if (!result || !result.ok) {
    return {
      ...(result || {}),
      ok: false,
      inputPath
    };
  }

  const groupsResult = await runSamEncryptCli(['list-groups']);

  return {
    ...result,
    inputPath,
    groups: groupsResult && groupsResult.ok && Array.isArray(groupsResult.groups)
      ? groupsResult.groups
      : []
  };
}


function getSamEncryptOutboxDir() {
  const outboxDir = path.join(getSamEncryptHomeDir(), 'outbox');
  fs.mkdirSync(outboxDir, { recursive: true });
  return outboxDir;
}

async function chooseFileForSamEncryption() {
  const ownerWindow = BrowserWindow.getFocusedWindow() || mainWindow || undefined;

  const dialogResult = await dialog.showOpenDialog(ownerWindow, {
    title: 'Вибрати файл для шифрування',
    properties: ['openFile'],
    buttonLabel: 'Далі'
  });

  if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length < 1) {
    return {
      ok: false,
      cancelled: true,
      error: null
    };
  }

  return {
    ok: true,
    inputPath: dialogResult.filePaths[0]
  };
}


async function chooseFileAndEncrypt(payload = {}) {
  let inputPath = payload.inputPath ? String(payload.inputPath) : '';

  if (!inputPath) {
    const selected = await chooseFileForSamEncryption();

    if (!selected || selected.cancelled || !selected.inputPath) {
      return {
        ok: false,
        cancelled: true,
        error: null
      };
    }

    inputPath = selected.inputPath;
  }

  const outputDir = payload.outputDir
    ? String(payload.outputDir)
    : getSamEncryptOutboxDir();

  const mode = String(payload.mode || 'self');

  let args = [];

  if (mode === 'self') {
    args = [
      'encrypt-self',
      '--input',
      inputPath,
      '--output-dir',
      outputDir
    ];
  } else if (mode === 'contact') {
    const recipientKeyId = String(payload.recipientKeyId || '').trim();

    if (!recipientKeyId) {
      return {
        ok: false,
        error: 'Не задано recipientKeyId для контакту.'
      };
    }

    args = [
      'encrypt',
      '--input',
      inputPath,
      '--output-dir',
      outputDir,
      '--recipient-key-id',
      recipientKeyId
    ];
  } else if (mode === 'group') {
    const groupId = String(payload.groupId || '').trim();

    if (!groupId) {
      return {
        ok: false,
        error: 'Не задано groupId для групи.'
      };
    }

    args = [
      'encrypt',
      '--input',
      inputPath,
      '--output-dir',
      outputDir,
      '--group-id',
      groupId
    ];
  } else {
    return {
      ok: false,
      error: `Невідомий режим шифрування: ${mode}`
    };
  }

  const result = await runSamEncryptCli(args);

  if (result && result.ok && result.output_path && payload.revealInFolder) {
    shell.showItemInFolder(result.output_path);
  }

  return {
    ...result,
    inputPath,
    outputDir,
    mode,
    recipientLabel: payload.recipientLabel || null,
    revealInFolder: Boolean(payload.revealInFolder)
  };
}




function getSamEncryptDecryptedDir() {
  const decryptedDir = path.join(getSamEncryptHomeDir(), 'decrypted');
  fs.mkdirSync(decryptedDir, { recursive: true });
  return decryptedDir;
}



function registerSamEncryptSettingsIpcHandlers() {
  ipcMain.handle('sam-encrypt-settings:status', async () => {
    const status = await runSamEncryptCli(['status']);
    const contacts = await runSamEncryptCli(['list-contacts']);
    const groups = await runSamEncryptCli(['list-groups']);

    return {
      ...status,
      contacts: contacts && contacts.ok ? contacts.contacts || [] : [],
      contacts_error: contacts && !contacts.ok ? contacts.error : null,
      groups: groups && groups.ok ? groups.groups || [] : [],
      groups_error: groups && !groups.ok ? groups.error : null
    };
  });

  ipcMain.handle('sam-encrypt-settings:generate-keys', async (_event, payload = {}) => {
    const ownerName = String(payload.ownerName || '').trim();

    if (!ownerName) {
      return {
        ok: false,
        error: 'Не задано імʼя власника ключа.'
      };
    }

    const args = [
      'generate-my-keys',
      '--owner-name',
      ownerName
    ];

    if (payload.overwrite) {
      args.push('--overwrite');
    }

    return runSamEncryptCli(args);
  });

  ipcMain.handle('sam-encrypt-settings:export-public', async () => {
    const ownerWindow = BrowserWindow.getFocusedWindow() || mainWindow || undefined;

    const dialogResult = await dialog.showOpenDialog(ownerWindow, {
      title: 'Вибрати папку для експорту публічного ключа',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Експортувати'
    });

    if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length < 1) {
      return {
        ok: false,
        cancelled: true,
        error: null
      };
    }

    const outputDir = dialogResult.filePaths[0];

    const result = await runSamEncryptCli([
      'export-public',
      '--output-dir',
      outputDir
    ]);

    if (result && result.ok && result.output_path) {
      shell.showItemInFolder(result.output_path);
    }

    return {
      ...result,
      outputDir
    };
  });

  ipcMain.handle('sam-encrypt-settings:import-public', async () => {
    const ownerWindow = BrowserWindow.getFocusedWindow() || mainWindow || undefined;

    const dialogResult = await dialog.showOpenDialog(ownerWindow, {
      title: 'Вибрати .sampub публічний ключ',
      properties: ['openFile'],
      filters: [
        { name: 'SAM public keys', extensions: ['sampub'] },
        { name: 'All files', extensions: ['*'] }
      ],
      buttonLabel: 'Імпортувати'
    });

    if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length < 1) {
      return {
        ok: false,
        cancelled: true,
        error: null
      };
    }

    return runSamEncryptCli([
      'import-public',
      '--file',
      dialogResult.filePaths[0]
    ]);
  });

  ipcMain.handle('sam-encrypt-settings:create-group', async (_event, payload = {}) => {
    const groupName = String(payload.groupName || '').trim();
    const memberKeyIds = Array.isArray(payload.memberKeyIds)
      ? payload.memberKeyIds.map((item) => String(item).trim()).filter(Boolean)
      : [];

    if (!groupName) {
      return {
        ok: false,
        error: 'Не задано назву групи.'
      };
    }

    if (memberKeyIds.length < 1) {
      return {
        ok: false,
        error: 'Не вибрано учасників групи.'
      };
    }

    const args = [
      'create-group',
      '--name',
      groupName
    ];

    for (const keyId of memberKeyIds) {
      args.push('--member-key-id', keyId);
    }

    return runSamEncryptCli(args);
  });

  ipcMain.handle('sam-encrypt-settings:export-group', async (_event, payload = {}) => {
    const groupId = String(payload.groupId || '').trim();

    if (!groupId) {
      return {
        ok: false,
        error: 'Не вибрано групу для експорту.'
      };
    }

    const ownerWindow = BrowserWindow.getFocusedWindow() || mainWindow || undefined;

    const dialogResult = await dialog.showOpenDialog(ownerWindow, {
      title: 'Вибрати папку для експорту групи .samgroup',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Експортувати'
    });

    if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length < 1) {
      return {
        ok: false,
        cancelled: true,
        error: null
      };
    }

    const outputDir = dialogResult.filePaths[0];

    const result = await runSamEncryptCli([
      'export-group',
      '--group-id',
      groupId,
      '--output-dir',
      outputDir
    ]);

    if (result && result.ok && result.output_path) {
      shell.showItemInFolder(result.output_path);
    }

    return {
      ...result,
      outputDir
    };
  });

  ipcMain.handle('sam-encrypt-settings:open-home', async () => {
    const homeDir = getSamEncryptHomeDir();
    fs.mkdirSync(homeDir, { recursive: true });
    const result = await shell.openPath(homeDir);

    return {
      ok: !result,
      error: result || null,
      path: homeDir
    };
  });
}


