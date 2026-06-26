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

function getAppWindowTitle() {
  return `${APP_NAME} v${app.getVersion()}`;
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

Це програма для роботи з WhatsApp Web у вигляді окремого вікна Linux-програми.

Основні можливості:

1. Вхід у WhatsApp

Після першого входу через QR-код програма запамʼятовує сесію.
Під час наступного запуску повторно сканувати QR-код зазвичай не потрібно.

2. Робота з файлами Word та Excel

Файли Word, Excel та інші офісні вкладення можна відкривати через LibreOffice.
Якщо увімкнений попередній перегляд, програма створює PDF-preview і показує документ у внутрішньому вікні.

У вікні перегляду є кнопки:
- Відкрити в LibreOffice
- Показати в папці
- Закрити

3. Вставка тексту

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

4. Копіювання кількох повідомлень

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

5. SAM-закріплені чати

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

6. Зміна ширини списку чатів

Межу між списком чатів і відкритим чатом можна перетягувати мишею.

Якщо потягнути межу:
- вліво — список чатів стане вужчим;
- вправо — список чатів стане ширшим.

Ширина зберігається після перезапуску програми.

7. Вікно програми

Вікно можна:
- змінювати за розміром;
- приклеювати до країв екрана стандартними засобами Linux Mint;
- згортати;
- відкривати через іконку в системному треї.

Одинарний лівий клік по іконці в треї показує головне вікно.
Правий клік по іконці в треї відкриває меню програми.

8. Налаштування

У меню програми є пункт "Налаштування".

Там можна керувати:
- місцем збереження офісних вкладень;
- попереднім переглядом офісних файлів;
- автоматичним відкриттям офісних файлів;
- строком зберігання кешу вкладень і preview.

9. Що важливо знати

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

  const html = `
<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <title>Довідка — SAM WhatsApp Web</title>
  <style>
    body {
      margin: 0;
      padding: 28px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f7f5f3;
      color: #111b21;
      line-height: 1.55;
    }

    h1 {
      margin-top: 0;
      font-size: 26px;
    }

    h2 {
      margin-top: 28px;
      font-size: 20px;
      border-bottom: 1px solid #d1d7db;
      padding-bottom: 6px;
    }

    p {
      margin: 8px 0;
    }

    ul, ol {
      margin-top: 8px;
      padding-left: 28px;
    }

    code {
      background: #e9edef;
      padding: 2px 5px;
      border-radius: 4px;
    }

    pre {
      white-space: pre-wrap;
      background: #ffffff;
      border: 1px solid #d1d7db;
      border-radius: 8px;
      padding: 16px;
      font-family: inherit;
    }
  </style>
</head>
<body>
  <h1>SAM WhatsApp Web</h1>
  <pre>${SAM_HELP_TEXT.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body>
</html>
`;

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
              detail: 'Окрема Linux-програма для роботи з WhatsApp Web з додатковими SAM-функціями: копіювання кількох повідомлень, локальні закріплені чати, робота з офісними файлами, вставка як текст та зручне керування вікном.'
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
    await dialog.showMessageBox({
      type: 'warning',
      title: getAppWindowTitle(),
      message: 'LibreOffice не знайдено',
      detail: 'Буде використано системну програму за замовчуванням.',
      buttons: ['OK']
    });

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


function runProcessAndWait(command, args, timeoutMs = 90000) {
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

      reject(new Error('Перевищено час очікування конвертації документа'));
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

      reject(new Error(`LibreOffice завершився з кодом ${code}\n${stderrText}`));
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

async function convertOfficeDocumentToPdf(filePath) {
  const officeBinary = findExecutable(['libreoffice', 'soffice']);

  if (!officeBinary) {
    throw new Error('LibreOffice не знайдено');
  }

  const cachedPdf = getPreviewPdfPathForFile(filePath);

  if (fs.existsSync(cachedPdf)) {
    return cachedPdf;
  }

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
    await runProcessAndWait(officeBinary, args);

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

    throw error;
  }
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
      detail: `${String(error)}\n\nФайл можна відкрити напряму в LibreOffice.`,
      buttons: ['Відкрити в LibreOffice', 'Показати в папці', 'OK'],
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

        if (isOfficeDocument(savePath)) {
          cleanupCachesBySettings();

          const settings = loadSettings();

          if (settings.previewOfficeDownloads) {
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
    createAppMenu();
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
