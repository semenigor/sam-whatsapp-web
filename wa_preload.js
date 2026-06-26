const { ipcRenderer } = require('electron');

const state = {
  enabled: false,
  selected: new Map(),
  bar: null,
  style: null,
  toastTimer: null,
  lastContextMessageRoot: null,
  lastClickedMessageRoot: null,
  lastHoveredMessageRoot: null,
  menuObserver: null,
  menuPatchTimer: null
};

function hashString(value) {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return String(hash >>> 0);
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function ensureStyle() {
  if (state.style) {
    return;
  }

  state.style = document.createElement('style');
  state.style.textContent = `
    .sam-wa-copy-bar {
      position: fixed;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      z-index: 2147483647;
      display: none;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 10px;
      background: #111827;
      color: #f9fafb;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      border: 1px solid #374151;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
    }

    .sam-wa-copy-bar.sam-wa-visible {
      display: flex;
    }

    .sam-wa-copy-bar button {
      border: 1px solid #4b5563;
      background: #374151;
      color: #f9fafb;
      border-radius: 7px;
      padding: 7px 10px;
      font-size: 13px;
      cursor: pointer;
    }

    .sam-wa-copy-bar button:hover {
      background: #4b5563;
    }

    .sam-wa-copy-count {
      min-width: 150px;
      font-weight: 600;
    }

    .sam-wa-selected-message {
      outline: 3px solid #22c55e !important;
      outline-offset: 2px !important;
      border-radius: 10px !important;
    }

    body.sam-wa-copy-mode * {
      cursor: crosshair !important;
    }

    .sam-wa-toast {
      position: fixed;
      left: 50%;
      bottom: 78px;
      transform: translateX(-50%);
      z-index: 2147483647;
      max-width: 560px;
      padding: 9px 12px;
      border-radius: 9px;
      background: #064e3b;
      color: #ecfdf5;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      border: 1px solid #047857;
    }

    .sam-wa-toast.sam-wa-error {
      background: #7f1d1d;
      color: #fee2e2;
      border-color: #991b1b;
    }

    .sam-wa-menu-separator {
      height: 1px !important;
      margin: 8px 16px !important;
      background: rgba(11, 20, 26, 0.16) !important;
      flex: 0 0 auto !important;
    }

    .sam-wa-menu-item {
      display: flex !important;
      align-items: center !important;
      gap: 20px !important;
      min-height: 44px !important;
      padding: 8px 22px !important;
      box-sizing: border-box !important;
      color: #075e54 !important;
      background: #ecfdf5 !important;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      font-size: 15px !important;
      line-height: 1.25 !important;
      cursor: pointer !important;
      user-select: none !important;
      flex: 0 0 auto !important;
    }

    .sam-wa-menu-item:hover {
      background: #d1fae5 !important;
    }

    .sam-wa-menu-icon {
      width: 24px !important;
      min-width: 24px !important;
      text-align: center !important;
      color: #16a34a !important;
      font-size: 16px !important;
      flex: 0 0 auto !important;
    }

    .sam-wa-menu-label {
      flex: 1 1 auto !important;
      white-space: normal !important;
      color: #075e54 !important;
    }
  `;

  document.documentElement.appendChild(state.style);
}

function ensureBar() {
  ensureStyle();

  if (state.bar) {
    return;
  }

  state.bar = document.createElement('div');
  state.bar.className = 'sam-wa-copy-bar';
  state.bar.innerHTML = `
    <span class="sam-wa-copy-count" id="samWaCopyCount">Вибрано: 0</span>
    <button type="button" id="samWaCopyButton">Копіювати</button>
    <button type="button" id="samWaClearButton">Очистити</button>
    <button type="button" id="samWaExitButton">Вийти з режиму</button>
  `;

  document.documentElement.appendChild(state.bar);

  state.bar.querySelector('#samWaCopyButton').addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await copySelectedMessages();
  });

  state.bar.querySelector('#samWaClearButton').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearSelection();
  });

  state.bar.querySelector('#samWaExitButton').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectionMode(false);
  });
}

function showToast(message, isError = false) {
  ensureStyle();

  const oldToast = document.querySelector('.sam-wa-toast');
  if (oldToast) {
    oldToast.remove();
  }

  const toast = document.createElement('div');
  toast.className = isError ? 'sam-wa-toast sam-wa-error' : 'sam-wa-toast';
  toast.textContent = message;
  document.documentElement.appendChild(toast);

  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
  }

  state.toastTimer = setTimeout(() => {
    toast.remove();
    state.toastTimer = null;
  }, 2500);
}

function updateBar() {
  ensureBar();

  const countElement = state.bar.querySelector('#samWaCopyCount');
  countElement.textContent = `Вибрано: ${state.selected.size}`;

  if (state.enabled) {
    state.bar.classList.add('sam-wa-visible');
  } else {
    state.bar.classList.remove('sam-wa-visible');
  }
}

function setSelectionMode(enabled) {
  state.enabled = Boolean(enabled);

  if (state.enabled) {
    document.body.classList.add('sam-wa-copy-mode');
    showToast('Режим копіювання увімкнено. Клікай потрібні повідомлення.');
  } else {
    document.body.classList.remove('sam-wa-copy-mode');

    // Вихід з режиму має повністю зняти виділення повідомлень.
    for (const item of state.selected.values()) {
      if (item.element && item.element.classList) {
        item.element.classList.remove('sam-wa-selected-message');
      }
    }

    state.selected.clear();
  }

  updateBar();
}

function clearSelection() {
  for (const item of state.selected.values()) {
    if (item.element && item.element.classList) {
      item.element.classList.remove('sam-wa-selected-message');
    }
  }

  state.selected.clear();
  updateBar();
}

function looksLikeMessageContainer(element) {
  if (!element || element === document.body || element === document.documentElement) {
    return false;
  }

  const hasText =
    element.querySelector('span.selectable-text') ||
    element.querySelector('div.selectable-text') ||
    element.querySelector('[data-pre-plain-text]') ||
    element.querySelector('.copyable-text');

  if (!hasText) {
    return false;
  }

  return (
    element.matches('div[data-id]') ||
    element.matches('div.message-in') ||
    element.matches('div.message-out') ||
    element.matches('div[role="row"]') ||
    element.querySelector('[data-pre-plain-text]')
  );
}

function findMessageRoot(target) {
  if (!(target instanceof Element)) {
    return null;
  }

  const directCandidates = [
    target.closest('div[data-id]'),
    target.closest('div.message-in'),
    target.closest('div.message-out'),
    target.closest('div[role="row"]')
  ].filter(Boolean);

  for (const candidate of directCandidates) {
    if (looksLikeMessageContainer(candidate)) {
      return candidate;
    }
  }

  let current = target;

  for (let depth = 0; current && depth < 14; depth += 1) {
    if (looksLikeMessageContainer(current)) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const text = cleanText(value);

    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    result.push(text);
  }

  return result;
}

function parsePrePlainText(preText) {
  const raw = String(preText || '').trim();

  if (!raw) {
    return {
      time: '',
      sender: ''
    };
  }

  const match = raw.match(/^\[(.*?)\]\s*(.*?):\s*$/);

  if (!match) {
    return {
      time: raw,
      sender: ''
    };
  }

  return {
    time: match[1] || '',
    sender: match[2] || ''
  };
}

function extractMessageData(root) {
  const preElement = root.querySelector('[data-pre-plain-text]');
  const preText = preElement ? preElement.getAttribute('data-pre-plain-text') : '';
  const meta = parsePrePlainText(preText);

  const textElements = Array.from(root.querySelectorAll('span.selectable-text, div.selectable-text'));
  const textValues = textElements.map((element) => element.innerText || element.textContent || '');
  const uniqueTexts = uniqueNonEmpty(textValues);

  let text = uniqueTexts.join('\n');

  if (!text && preElement) {
    text = cleanText(preElement.innerText || preElement.textContent || '');
  }

  if (!text) {
    return null;
  }

  const dataId = root.getAttribute('data-id') || '';
  const keySource = `${dataId}\n${preText}\n${text}`;
  const key = dataId || hashString(keySource);

  return {
    key,
    time: meta.time,
    sender: meta.sender,
    text
  };
}

function addMessageToSelection(root) {
  const data = extractMessageData(root);

  if (!data) {
    showToast('У цьому елементі не знайдено текст повідомлення', true);
    return false;
  }

  if (state.selected.has(data.key)) {
    showToast('Це повідомлення вже додано');
    return true;
  }

  root.classList.add('sam-wa-selected-message');

  state.selected.set(data.key, {
    ...data,
    element: root
  });

  updateBar();
  showToast(`Додано до копіювання. Вибрано: ${state.selected.size}`);
  return true;
}

function toggleMessageSelection(root) {
  const data = extractMessageData(root);

  if (!data) {
    showToast('У цьому елементі не знайдено текст повідомлення', true);
    return;
  }

  if (state.selected.has(data.key)) {
    const old = state.selected.get(data.key);

    if (old.element && old.element.classList) {
      old.element.classList.remove('sam-wa-selected-message');
    }

    state.selected.delete(data.key);
    updateBar();
    return;
  }

  addMessageToSelection(root);
}

function getLastKnownMessageRoot() {
  const candidates = [
    state.lastContextMessageRoot,
    state.lastClickedMessageRoot,
    state.lastHoveredMessageRoot
  ];

  for (const candidate of candidates) {
    if (candidate && document.contains(candidate)) {
      return candidate;
    }
  }

  return null;
}

function addLastContextMessageToSelection() {
  const root = getLastKnownMessageRoot();

  if (!root) {
    showToast('Не вдалося визначити повідомлення для додавання', true);
    return;
  }

  setSelectionMode(true);
  addMessageToSelection(root);
}

async function copySelectedMessages() {
  const messages = Array.from(state.selected.values()).map((item) => ({
    time: item.time || '',
    sender: item.sender || '',
    text: item.text || ''
  }));

  if (messages.length === 0) {
    showToast('Немає вибраних повідомлень', true);
    return;
  }

  try {
    const result = await ipcRenderer.invoke('messages:copy-to-clipboard', messages);

    if (result && result.ok) {
      showToast(`Скопійовано повідомлень: ${messages.length}`);
      return;
    }

    showToast('Не вдалося скопіювати повідомлення', true);
  } catch (error) {
    showToast(`Помилка копіювання: ${String(error)}`, true);
  }
}

function rememberMessageRootFromEvent(event) {
  const root = findMessageRoot(event.target);

  if (!root) {
    return;
  }

  state.lastClickedMessageRoot = root;

  if (event.type === 'contextmenu') {
    state.lastContextMessageRoot = root;
  }
}

function rememberHoveredMessageRoot(event) {
  const root = findMessageRoot(event.target);

  if (root) {
    state.lastHoveredMessageRoot = root;
  }
}

function handleDocumentClick(event) {
  if (!state.enabled) {
    return;
  }

  if (state.bar && state.bar.contains(event.target)) {
    return;
  }

  const target = event.target;

  if (target instanceof Element && target.closest('[data-sam-wa-menu-item="1"]')) {
    return;
  }

  const root = findMessageRoot(target);

  if (!root) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  toggleMessageSelection(root);
}

function handleDocumentKeydown(event) {
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyM') {
    event.preventDefault();
    event.stopPropagation();
    setSelectionMode(!state.enabled);
    return;
  }

  if (!state.enabled) {
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    setSelectionMode(false);
    return;
  }

  if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
    event.preventDefault();
    event.stopPropagation();
    copySelectedMessages();
  }
}

function isVisibleElement(element) {
  if (!element || !(element instanceof Element)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity || 1) !== 0
  );
}

function getElementText(element) {
  return String(element && element.innerText ? element.innerText : '').trim();
}

function findMenuByLabels(requiredLabels) {
  const candidates = [];

  for (const element of Array.from(document.querySelectorAll('div, section, ul, li'))) {
    if (!isVisibleElement(element)) {
      continue;
    }

    const rect = element.getBoundingClientRect();
    const text = getElementText(element);

    if (!text) {
      continue;
    }

    const hasAll = requiredLabels.every((label) => text.includes(label));

    if (!hasAll) {
      continue;
    }

    if (rect.width < 180 || rect.width > 760) {
      continue;
    }

    if (rect.height < 90 || rect.height > window.innerHeight * 0.98) {
      continue;
    }

    if (text.length > 2600) {
      continue;
    }

    candidates.push({
      element,
      area: rect.width * rect.height,
      textLength: text.length
    });
  }

  candidates.sort((a, b) => {
    if (Math.abs(a.area - b.area) > 1) {
      return a.area - b.area;
    }

    return a.textLength - b.textLength;
  });

  return candidates.length > 0 ? candidates[0].element : null;
}

function removeSamItems(menu) {
  if (!menu || !(menu instanceof Element)) {
    return;
  }

  const all = Array.from(menu.querySelectorAll('*'));

  const toRemove = all.filter((element) => {
    const text = getElementText(element);
    const className = String(element.className || '');

    return (
      element.hasAttribute('data-sam-wa-menu-item') ||
      element.hasAttribute('data-sam-wa-menu-separator') ||
      className.includes('sam-wa-menu-item') ||
      className.includes('sam-wa-menu-separator') ||
      text.startsWith('SAM:')
    );
  });

  const uniqueTopLevel = toRemove.filter((element) => {
    return !toRemove.some((other) => other !== element && other.contains(element));
  });

  for (const element of uniqueTopLevel) {
    element.remove();
  }
}

function createSamSeparator() {
  const separator = document.createElement('div');
  separator.className = 'sam-wa-menu-separator';
  separator.setAttribute('data-sam-wa-menu-separator', '1');
  return separator;
}

function createSamMenuItem(label, onClick) {
  const item = document.createElement('div');
  item.className = 'sam-wa-menu-item';
  item.setAttribute('data-sam-wa-menu-item', '1');
  item.setAttribute('role', 'button');
  item.setAttribute('tabindex', '0');

  const icon = document.createElement('div');
  icon.className = 'sam-wa-menu-icon';
  icon.textContent = '▣';

  const text = document.createElement('div');
  text.className = 'sam-wa-menu-label';
  text.textContent = label;

  item.appendChild(icon);
  item.appendChild(text);

  let actionStarted = false;

  const runAction = async (event) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    if (actionStarted) {
      return;
    }

    actionStarted = true;

    try {
      await onClick();
    } catch (error) {
      showToast(`Помилка: ${String(error)}`, true);
    } finally {
      setTimeout(() => {
        actionStarted = false;
      }, 700);
    }
  };

  // Важливо: WhatsApp може прибрати меню до click.
  // Тому дію запускаємо вже на pointerdown/mousedown.
  item.addEventListener('pointerdown', runAction, true);
  item.addEventListener('mousedown', runAction, true);
  item.addEventListener('click', runAction, true);

  item.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      await runAction(event);
    }
  }, true);

  return item;
}


function samEnsureGroupHeaderMenuButtonFix() {
  if (document.getElementById('samGroupHeaderMenuButtonFixStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samGroupHeaderMenuButtonFixStyle';
  style.textContent = `
    #main header {
      overflow: hidden !important;
      flex-wrap: nowrap !important;
    }

    #main header * {
      min-width: 0;
    }

    #main header [data-testid="conversation-info-header"] {
      min-width: 0 !important;
      flex: 1 1 auto !important;
      overflow: hidden !important;
      max-width: calc(100% - 120px) !important;
    }

    #main header button[aria-label="Пошук"],
    #main header button[aria-label="Меню"],
    #main header button[aria-label="Search"],
    #main header button[aria-label="Menu"],
    #main header button[aria-label="More options"] {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      visibility: visible !important;
      opacity: 1 !important;
      flex: 0 0 40px !important;
      min-width: 40px !important;
      width: 40px !important;
      max-width: 40px !important;
      position: relative !important;
      z-index: 50 !important;
      transform: none !important;
      pointer-events: auto !important;
    }
  `;

  document.documentElement.appendChild(style);
}


function injectChatMenu(menu) {
  if (!menu || !(menu instanceof Element)) {
    return;
  }

  ensureStyle();
  removeSamItems(menu);

  const separator = createSamSeparator();

  const enableCopyMode = createSamMenuItem('SAM: копіювати кілька повідомлень', async () => {
    setSelectionMode(true);
  });

  const copySelected = createSamMenuItem('SAM: копіювати вибрані', async () => {
    await copySelectedMessages();
  });

  menu.appendChild(separator);
  menu.appendChild(enableCopyMode);
  menu.appendChild(copySelected);

  menu.appendChild(createSamMenuItem('SAM: очистити вибір', () => {
    setSelectionMode(false);
  }));

}

function injectMessageMenu(menu) {
  if (!menu || !(menu instanceof Element)) {
    return;
  }

  ensureStyle();
  removeSamItems(menu);

  const separator = createSamSeparator();

  const addCurrent = createSamMenuItem('SAM: додати до копіювання', async () => {
    addLastContextMessageToSelection();
  });

  const copySelected = createSamMenuItem('SAM: копіювати вибрані', async () => {
    await copySelectedMessages();
  });

  const clearSelected = createSamMenuItem('SAM: очистити вибір', async () => {
    clearSelection();
  });

  menu.appendChild(separator);
  menu.appendChild(addCurrent);
  menu.appendChild(copySelected);
  menu.appendChild(clearSelected);
}


function removeAllSamMenuItemsFromDocument() {
  const selectors = [
    '[data-sam-wa-menu-item]',
    '[data-sam-wa-menu-separator]',
    '[data-sam-wa-menu]',
    '[data-sam-wa-menu-v2]',
    '[data-sam-wa-menu-v3]',
    '[data-sam-wa-chat-menu]',
    '[data-sam-wa-chat-menu-v2]',
    '[data-sam-wa-chat-menu-v3]',
    '[data-sam-wa-message-menu]',
    '[data-sam-wa-message-menu-v2]',
    '[data-sam-wa-message-menu-v3]',
    '.sam-wa-menu-item',
    '.sam-wa-menu-item-v2',
    '.sam-wa-menu-item-v3',
    '.sam-wa-menu-separator',
    '.sam-wa-menu-separator-v2',
    '.sam-wa-menu-separator-v3'
  ];

  const found = Array.from(document.querySelectorAll(selectors.join(',')));

  const topLevelOnly = found.filter((element) => {
    return !found.some((other) => other !== element && other.contains(element));
  });

  for (const element of topLevelOnly) {
    try {
      element.remove();
    } catch {
      // Елемент уже міг бути прибраний WhatsApp.
    }
  }
}


function findChatMainMenu() {
  const menuVariants = [
    ['Інформація про контакт', 'Пошук'],
    ['Інформація про контакт', 'Вибрати повідомлення'],
    ['Інформація про групу', 'Пошук'],
    ['Інформація про групу', 'Вибрати повідомлення'],
    ['Дані групи', 'Пошук'],
    ['Дані групи', 'Вибрати повідомлення'],
    ['Про групу', 'Пошук'],
    ['Про групу', 'Вибрати повідомлення'],
    ['Пошук', 'Вибрати повідомлення', 'Вимкнути сповіщення'],
    ['Пошук', 'Вибрати повідомлення', 'Очистити повідомлення бесіди']
  ];

  for (const labels of menuVariants) {
    const menu = findMenuByLabels(labels);

    if (menu) {
      return menu;
    }
  }

  return null;
}


function samMenuFastIsVisible(element) {
  if (!element || !(element instanceof Element)) {
    return false;
  }

  const rect = element.getBoundingClientRect();

  if (rect.width < 80 || rect.height < 30) {
    return false;
  }

  if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) {
    return false;
  }

  const style = window.getComputedStyle(element);

  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0'
  ) {
    return false;
  }

  return true;
}

function samMenuFastText(element) {
  if (!element) {
    return '';
  }

  return String(element.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function samMenuFastScoreText(text, words) {
  let score = 0;

  for (const word of words) {
    if (text.includes(word)) {
      score += 1;
    }
  }

  return score;
}

function samMenuFastClassify(menu) {
  const text = samMenuFastText(menu);

  if (!text) {
    return null;
  }

  if (text.includes('SAM: копіювати кілька повідомлень') || text.includes('SAM: копіювати вибрані')) {
    return null;
  }

  const messageScore = samMenuFastScoreText(text, [
    'Відповісти',
    'Копіювати',
    'Переслати',
    'Видалити',
    'Інформація',
    'Позначити'
  ]);

  if (messageScore >= 2) {
    return 'message';
  }

  const chatStrongScore = samMenuFastScoreText(text, [
    'Інформація про контакт',
    'Інформація про групу',
    'Дані групи',
    'Про групу'
  ]);

  const chatWeakScore = samMenuFastScoreText(text, [
    'Пошук',
    'Вибрати повідомлення',
    'Вимкнути сповіщення',
    'Очистити повідомлення бесіди',
    'Закрити чат',
    'Експортувати чат'
  ]);

  if (chatStrongScore >= 1 && chatWeakScore >= 1) {
    return 'chat';
  }

  if (chatWeakScore >= 3) {
    return 'chat';
  }

  return null;
}

function samMenuFastGetCandidateMenus() {
  const result = [];
  const seen = new Set();

  function add(element) {
    if (!element || seen.has(element)) {
      return;
    }

    // Не чіпаємо header і його кнопки.
    if (element.closest && element.closest('#main header')) {
      return;
    }

    if (!samMenuFastIsVisible(element)) {
      return;
    }

    const text = samMenuFastText(element);

    if (!text) {
      return;
    }

    if (
      !text.includes('Відповісти') &&
      !text.includes('Копіювати') &&
      !text.includes('Переслати') &&
      !text.includes('Пошук') &&
      !text.includes('Вибрати повідомлення') &&
      !text.includes('Інформація про контакт') &&
      !text.includes('Інформація про групу') &&
      !text.includes('Дані групи') &&
      !text.includes('Про групу')
    ) {
      return;
    }

    seen.add(element);
    result.push(element);
  }

  const popovers = document.getElementById('wa-popovers-bucket');

  if (popovers) {
    for (const child of Array.from(popovers.children).slice(0, 20)) {
      add(child);

      for (const nested of Array.from(child.querySelectorAll('[role="menu"], [role="application"], div[aria-label]')).slice(0, 20)) {
        add(nested);
      }
    }
  }

  for (const menu of Array.from(document.querySelectorAll('[role="menu"]')).slice(0, 20)) {
    // Патчимо тільки реальні dropdown-меню, а не шапку чату.
    if (menu.closest && menu.closest('#main header')) {
      continue;
    }

    add(menu);
  }

  return result.slice(0, 20);
}


function patchVisibleWhatsAppMenus() {
  const menus = samMenuFastGetCandidateMenus();

  if (!menus.length) {
    return false;
  }

  let patched = false;

  for (const menu of menus) {
    const kind = samMenuFastClassify(menu);

    if (!kind) {
      continue;
    }

    // Чистимо SAM-пункти тільки всередині знайденого меню.
    // Не скануємо весь document, бо саме це давало зависання.
    for (const item of Array.from(menu.querySelectorAll('[data-sam-wa-menu-item="1"], .sam-wa-menu-item'))) {
      item.remove();
    }

    if (kind === 'message') {
      injectMessageMenu(menu);
      patched = true;
    } else if (kind === 'chat') {
      injectChatMenu(menu);
      patched = true;
    }
  }

  return patched;
}

function schedulePatchWhatsAppMenus() {
  if (state.menuPatchTimer) {
    clearTimeout(state.menuPatchTimer);
  }

  state.menuPatchTimer = setTimeout(() => {
    state.menuPatchTimer = null;
    patchVisibleWhatsAppMenus();
  }, 120);
}


function isLikelyWhatsAppMenuTrigger(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  const candidate = target.closest(
    'button, div[role="button"], span[data-icon], [aria-label], [title]'
  );

  if (!candidate) {
    return false;
  }

  const text = String(candidate.textContent || '').trim();
  const aria = String(candidate.getAttribute('aria-label') || '').toLowerCase();
  const title = String(candidate.getAttribute('title') || '').toLowerCase();
  const dataIcon = String(candidate.getAttribute('data-icon') || '').toLowerCase();

  const combined = `${text} ${aria} ${title} ${dataIcon}`;

  if (
    combined.includes('menu') ||
    combined.includes('меню') ||
    combined.includes('додаткові') ||
    combined.includes('more') ||
    combined.includes('conversation-menu') ||
    combined.includes('down-context') ||
    combined.includes('chevron') ||
    combined.includes('overflow') ||
    text === '⋮' ||
    text === '...'
  ) {
    return true;
  }

  // У WhatsApp кнопка ⋮ часто є svg/span без нормального тексту.
  // Тому додатково перевіряємо маленькі клікабельні елементи у верхній частині чату.
  const rect = candidate.getBoundingClientRect();

  const isSmallButton =
    rect.width >= 20 &&
    rect.width <= 80 &&
    rect.height >= 20 &&
    rect.height <= 80;

  const isInHeaderArea =
    rect.y >= 0 &&
    rect.y <= 140;

  const isRightSide =
    rect.x >= window.innerWidth * 0.55;

  return isSmallButton && isInHeaderArea && isRightSide;
}

function scheduleTargetedMenuPatch() {
  state.menuPatchBurstVersion = (state.menuPatchBurstVersion || 0) + 1;

  const version = state.menuPatchBurstVersion;
  const delays = [80, 180, 360];

  for (const delay of delays) {
    setTimeout(() => {
      if (state.menuPatchBurstVersion !== version) {
        return;
      }

      patchVisibleWhatsAppMenus();
    }, delay);
  }
}

function startMenuObserver() {
  if (state.menuObserver) {
    return;
  }

  state.menuObserver = {
    active: true
  };

  // Без setInterval.
  // Без глобального скану після кожного кліку.
  // Скануємо тільки після кліку по елементу, схожому на меню WhatsApp.
  document.addEventListener('pointerdown', (event) => {
    if (isLikelyWhatsAppMenuTrigger(event.target)) {
      scheduleTargetedMenuPatch();
    }
  }, true);

  document.addEventListener('contextmenu', (event) => {
    rememberMessageRootFromEvent(event);
    scheduleTargetedMenuPatch();
  }, true);
}


// ===== SAM local pinned chats module =====
// Локальні закріплені чати поверх WhatsApp Web.
// Не змінює офіційні pin-чати WhatsApp і не чіпає SAM-меню копіювання.

const SAM_LOCAL_PINNED_CHATS_KEY = 'samLocalPinnedChatsV1';
const SAM_LOCAL_PINNED_COLLAPSED_KEY = 'samLocalPinnedChatsCollapsedV1';
const SAM_LOCAL_PINNED_MAX = 7;

function samPinsLoad() {
  try {
    const raw = localStorage.getItem(SAM_LOCAL_PINNED_CHATS_KEY);
    const parsed = JSON.parse(raw || '[]');

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => ({
        title: cleanText(item.title || ''),
        addedAt: Number(item.addedAt || Date.now())
      }))
      .filter((item) => item.title)
      .slice(0, SAM_LOCAL_PINNED_MAX);
  } catch {
    return [];
  }
}

function samPinsSave(chats) {
  const safe = Array.isArray(chats)
    ? chats
        .map((item) => ({
          title: cleanText(item.title || ''),
          addedAt: Number(item.addedAt || Date.now())
        }))
        .filter((item) => item.title)
        .slice(0, SAM_LOCAL_PINNED_MAX)
    : [];

  localStorage.setItem(SAM_LOCAL_PINNED_CHATS_KEY, JSON.stringify(safe));
  samPinsRender();

  return safe;
}

function samPinsIsCollapsed() {
  // Для нового UI default = згорнуто.
  // '0' означає drawer відкритий, усе інше — згорнуто.
  return localStorage.getItem(SAM_LOCAL_PINNED_COLLAPSED_KEY) !== '0';
}


function samPinsSetCollapsed(collapsed) {
  localStorage.setItem(SAM_LOCAL_PINNED_COLLAPSED_KEY, collapsed ? '1' : '0');
  samPinsRender();
}


function samPinsSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function samPinsGetCurrentChatTitle() {
  // Основне джерело: активний рядок у лівому списку чатів.
  // Це надійніше для груп, бо header часто містить не назву групи,
  // а список учасників або службовий текст.
  const side = document.querySelector('#pane-side') || document.querySelector('#side');

  if (side) {
    const activeSelectors = [
      '[aria-selected="true"]',
      '[data-testid="cell-frame-container"][aria-selected="true"]',
      '[role="row"][aria-selected="true"]',
      '[role="listitem"][aria-selected="true"]'
    ];

    for (const selector of activeSelectors) {
      const active = side.querySelector(selector);

      if (!active) {
        continue;
      }

      const title = samPinsExtractBestChatTitleFromRow(active);

      if (title) {
        return title;
      }
    }

    // Fallback: шукаємо рядок із візуальною ознакою активності.
    const rows = Array.from(side.querySelectorAll('[role="row"], [role="listitem"], div'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();

        return (
          rect.width >= 180 &&
          rect.height >= 42 &&
          rect.x >= 0 &&
          rect.x < window.innerWidth * 0.55
        );
      });

    for (const row of rows) {
      const ariaSelected = String(row.getAttribute('aria-selected') || '').toLowerCase();

      if (ariaSelected === 'true') {
        const title = samPinsExtractBestChatTitleFromRow(row);

        if (title) {
          return title;
        }
      }
    }
  }

  // Fallback: header поточного чату.
  // Тут беремо не найдовший текст, а перший видимий title у верхньому рядку header.
  const main = document.querySelector('#main') || document.querySelector('[role="main"]');

  if (!main) {
    return '';
  }

  const header = main.querySelector('header');

  if (!header) {
    return '';
  }

  const titleElements = Array.from(header.querySelectorAll('span[title], div[title]'))
    .map((element) => {
      const rect = element.getBoundingClientRect();

      return {
        element,
        rect,
        text: cleanText(element.getAttribute('title') || '')
      };
    })
    .filter((item) =>
      item.text &&
      item.text.length >= 2 &&
      item.text.length <= 120 &&
      item.rect.width > 0 &&
      item.rect.height > 0 &&
      !samPinsLooksLikeChatSubtitle(item.text)
    );

  if (titleElements.length > 0) {
    titleElements.sort((a, b) => {
      if (Math.abs(a.rect.y - b.rect.y) > 4) {
        return a.rect.y - b.rect.y;
      }

      return a.rect.x - b.rect.x;
    });

    return titleElements[0].text;
  }

  return '';
}

function samPinsLooksLikeChatSubtitle(text) {
  const normalized = cleanText(text);

  if (!normalized) {
    return true;
  }

  const lower = normalized.toLowerCase();

  if (
    lower.includes('учасник') ||
    lower.includes('учасники') ||
    lower.includes('адміністратор') ||
    lower.includes('адміністратори') ||
    lower.includes('надсилати повідомлення') ||
    lower.includes('натисніть тут') ||
    lower.includes('останній візит') ||
    lower.includes('online') ||
    lower.includes('typing') ||
    lower.includes('друкує') ||
    lower.includes('пошук') ||
    lower.includes('меню')
  ) {
    return true;
  }

  // Довгий список людей у групі.
  if (normalized.includes(',') && normalized.length > 45) {
    return true;
  }

  return false;
}

function samPinsExtractBestChatTitleFromRow(row) {
  if (!row) {
    return '';
  }

  const candidates = Array.from(row.querySelectorAll('span[title], div[title]'))
    .map((element) => {
      const rect = element.getBoundingClientRect();

      return {
        text: cleanText(element.getAttribute('title') || ''),
        rect
      };
    })
    .filter((item) =>
      item.text &&
      item.text.length >= 2 &&
      item.text.length <= 120 &&
      item.rect.width > 0 &&
      item.rect.height > 0 &&
      !samPinsLooksLikeChatSubtitle(item.text)
    );

  if (candidates.length === 0) {
    return '';
  }

  // У рядку чату назва зазвичай розташована вище за останнє повідомлення.
  candidates.sort((a, b) => {
    if (Math.abs(a.rect.y - b.rect.y) > 4) {
      return a.rect.y - b.rect.y;
    }

    return a.rect.x - b.rect.x;
  });

  return candidates[0].text;
}

function samPinsPinCurrentChat() {
  const title = samPinsGetCurrentChatTitle();

  if (!title) {
    showToast('Не вдалося визначити назву поточного чату', true);
    return;
  }

  const chats = samPinsLoad();
  const existingIndex = chats.findIndex((item) => item.title === title);

  if (existingIndex >= 0) {
    const [existing] = chats.splice(existingIndex, 1);
    chats.unshift({
      ...existing,
      addedAt: Date.now()
    });

    samPinsSave(chats);
    showToast(`Чат уже був у SAM-закріплених: ${title}`);
    return;
  }

  if (chats.length >= SAM_LOCAL_PINNED_MAX) {
    showToast(`Ліміт SAM-закріплень: ${SAM_LOCAL_PINNED_MAX}. Спочатку прибери один чат.`, true);
    return;
  }

  chats.unshift({
    title,
    addedAt: Date.now()
  });

  samPinsSave(chats);
  showToast(`SAM-закріплено чат: ${title}`);
}

function samPinsUnpinByTitle(title) {
  const normalized = cleanText(title);

  if (!normalized) {
    return;
  }

  const before = samPinsLoad();
  const after = before.filter((item) => item.title !== normalized);

  samPinsSave(after);

  if (after.length === before.length) {
    showToast(`Чат не був у SAM-закріплених: ${normalized}`);
    return;
  }

  showToast(`Прибрано із SAM-закріплених: ${normalized}`);
}

function samPinsEnsureStyle() {
  if (document.getElementById('sam-local-pins-style')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'sam-local-pins-style';
  style.textContent = `
    .sam-local-pins-trigger-host {
      width: 100%;
      height: 58px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      box-sizing: border-box;
    }

    .sam-local-pins-trigger {
      width: 52px;
      height: 52px;
      min-width: 52px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: #54656f;
      box-shadow: none;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 24px;
      font-weight: 700;
      line-height: 52px;
      text-align: center;
      cursor: pointer;
      user-select: none;
    }

    .sam-local-pins-trigger.sam-local-pins-embedded {
      position: relative;
      top: auto !important;
      left: auto !important;
      right: auto !important;
      bottom: auto !important;
      z-index: 1;
      display: block;
    }

    .sam-local-pins-trigger.sam-local-pins-floating {
      position: fixed;
      z-index: 2147482500;
    }

    .sam-local-pins-trigger::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: transparent;
      transition: background 120ms ease;
    }

    .sam-local-pins-trigger:hover::before {
      background: rgba(11, 20, 26, 0.08);
    }

    .sam-local-pins-trigger.sam-local-pins-open::before {
      background: rgba(11, 20, 26, 0.10);
    }

    .sam-local-pins-trigger-icon {
      position: relative;
      z-index: 1;
      display: inline-block;
      transform: translateY(1px);
      font-size: 22px;
      line-height: 52px;
    }

    .sam-local-pins-trigger-badge {
      position: absolute;
      z-index: 2;
      top: -5px;
      right: -7px;
      min-width: 28px;
      height: 22px;
      padding: 0 6px;
      border-radius: 999px;
      background: #25d366;
      color: #ffffff;
      font-size: 12px;
      font-weight: 700;
      line-height: 22px;
      text-align: center;
      box-sizing: border-box;
      box-shadow: 0 1px 2px rgba(0,0,0,0.18);
    }

    .sam-local-pins-drawer {
      position: fixed;
      width: 310px;
      max-width: calc(100vw - 90px);
      max-height: calc(100vh - 120px);
      z-index: 2147482500;
      background: #ffffff;
      color: #111b21;
      border: 1px solid rgba(11, 20, 26, 0.12);
      border-radius: 14px;
      box-shadow: 0 12px 32px rgba(11,20,26,0.20);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: hidden;
    }

    .sam-local-pins-drawer.sam-local-pins-hidden {
      display: none;
    }

    .sam-local-pins-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 10px;
      background: #f0f2f5;
      user-select: none;
      font-size: 14px;
      font-weight: 700;
      color: #111b21;
    }

    .sam-local-pins-title {
      flex: 1;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .sam-local-pins-count {
      color: #54656f;
      font-size: 12px;
      font-weight: 700;
      flex: 0 0 auto;
    }

    .sam-local-pins-add {
      border: 0;
      background: #00a884;
      color: #ffffff;
      border-radius: 8px;
      padding: 5px 8px;
      font-size: 12px;
      cursor: pointer;
      flex: 0 0 auto;
    }

    .sam-local-pins-add:hover {
      background: #008f72;
    }

    .sam-local-pins-close {
      border: 0;
      background: transparent;
      color: #54656f;
      cursor: pointer;
      font-size: 19px;
      line-height: 19px;
      padding: 2px 5px;
      border-radius: 6px;
      flex: 0 0 auto;
    }

    .sam-local-pins-close:hover {
      background: rgba(11,20,26,0.08);
      color: #111b21;
    }

    .sam-local-pins-list {
      max-height: calc(100vh - 180px);
      overflow-y: auto;
      background: #ffffff;
    }

    .sam-local-pins-row {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 10px 11px;
      border-top: 1px solid #e9edef;
      cursor: pointer;
      user-select: none;
      min-height: 42px;
      box-sizing: border-box;
    }

    .sam-local-pins-row:hover {
      background: #f5f6f6;
    }

    .sam-local-pins-row-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
      color: #111b21;
    }

    .sam-local-pins-remove {
      flex: 0 0 auto;
      border: 0;
      background: transparent;
      color: #8696a0;
      cursor: pointer;
      font-size: 18px;
      padding: 2px 6px;
      border-radius: 6px;
    }

    .sam-local-pins-remove:hover {
      background: #ffecec;
      color: #b42318;
    }

    .sam-local-pins-empty {
      padding: 12px 11px;
      color: #667781;
      font-size: 13px;
      line-height: 1.35;
      border-top: 1px solid #e9edef;
    }
  `;

  document.documentElement.appendChild(style);
}


function samPinsEnsurePanel() {
  samPinsEnsureStyle();

  let trigger = document.getElementById('samLocalPinsTrigger');
  let drawer = document.getElementById('samLocalPinsPanel');

  if (!trigger) {
    trigger = document.createElement('button');
    trigger.id = 'samLocalPinsTrigger';
    trigger.type = 'button';
    trigger.className = 'sam-local-pins-trigger';
    trigger.title = 'SAM закріплені чати';
    trigger.innerHTML = `
      <span class="sam-local-pins-trigger-icon">📌</span>
      <span class="sam-local-pins-trigger-badge" id="samLocalPinsTriggerBadge">0/7</span>
    `;

    document.documentElement.appendChild(trigger);

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      samPinsSetCollapsed(!samPinsIsCollapsed());
    }, true);
  }

  if (!drawer) {
    drawer = document.createElement('div');
    drawer.id = 'samLocalPinsPanel';
    drawer.className = 'sam-local-pins-drawer';
    drawer.innerHTML = `
      <div class="sam-local-pins-header">
        <span class="sam-local-pins-title">SAM чати</span>
        <span class="sam-local-pins-count" id="samLocalPinsCount">0/7</span>
        <button type="button" class="sam-local-pins-add" id="samLocalPinsAdd">+ Поточний</button>
        <button type="button" class="sam-local-pins-close" id="samLocalPinsClose">×</button>
      </div>
      <div class="sam-local-pins-list" id="samLocalPinsList"></div>
    `;

    document.documentElement.appendChild(drawer);

    drawer.querySelector('#samLocalPinsAdd').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      samPinsPinCurrentChat();
    }, true);

    drawer.querySelector('#samLocalPinsClose').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      samPinsSetCollapsed(true);
    }, true);
  }

  if (!document.documentElement.dataset.samLocalPinsOutsideCloseInstalled) {
    document.documentElement.dataset.samLocalPinsOutsideCloseInstalled = '1';

    document.addEventListener('mousedown', (event) => {
      const currentTrigger = document.getElementById('samLocalPinsTrigger');
      const currentDrawer = document.getElementById('samLocalPinsPanel');

      if (
        !samPinsIsCollapsed() &&
        currentTrigger &&
        currentDrawer &&
        !currentTrigger.contains(event.target) &&
        !currentDrawer.contains(event.target)
      ) {
        samPinsSetCollapsed(true);
      }
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !samPinsIsCollapsed()) {
        samPinsSetCollapsed(true);
      }
    }, true);
  }

  if (!document.documentElement.dataset.samLocalPinsPositionInstalled) {
    document.documentElement.dataset.samLocalPinsPositionInstalled = '1';

    window.addEventListener('resize', () => {
      samPinsPlaceUi();
    }, true);
  }

  samPinsPlaceUi();
  samPinsRender();

  return drawer;
}



const SAM_PIN_TRIGGER_LEFT = 5;
const SAM_PIN_TRIGGER_TOP = 185;
const SAM_PIN_DRAWER_LEFT = 106;

function samPinsRemoveEmbeddedHostIfAny(trigger) {
  const host = document.getElementById('samLocalPinsTriggerHost');

  if (trigger && trigger.parentElement !== document.documentElement) {
    document.documentElement.appendChild(trigger);
  }

  if (host) {
    try {
      host.remove();
    } catch {
      // already removed
    }
  }
}

function samPinsPlaceUi() {
  const trigger = document.getElementById('samLocalPinsTrigger');
  const drawer = document.getElementById('samLocalPinsPanel');

  if (!trigger || !drawer) {
    return;
  }

  // Стабільний режим:
  // не вставляємо кнопку в DOM WhatsApp;
  // просто фіксуємо її в зоні лівої вертикальної панелі.
  samPinsRemoveEmbeddedHostIfAny(trigger);

  trigger.classList.remove('sam-local-pins-embedded');
  trigger.classList.add('sam-local-pins-floating');

  trigger.style.position = 'fixed';
  trigger.style.zIndex = '2147482500';
  trigger.style.width = '52px';
  trigger.style.height = '52px';
  trigger.style.top = `${SAM_PIN_TRIGGER_TOP}px`;
  trigger.style.left = `${SAM_PIN_TRIGGER_LEFT}px`;
  trigger.style.right = 'auto';
  trigger.style.bottom = 'auto';

  const drawerWidth = 310;

  let drawerTop = SAM_PIN_TRIGGER_TOP - 8;
  drawerTop = Math.max(88, Math.min(drawerTop, window.innerHeight - 240));

  drawer.style.position = 'fixed';
  drawer.style.zIndex = '2147482500';
  drawer.style.width = `${drawerWidth}px`;
  drawer.style.top = `${drawerTop}px`;
  drawer.style.left = `${SAM_PIN_DRAWER_LEFT}px`;
  drawer.style.right = 'auto';
}


function samPinsRender() {
  samPinsEnsureStyle();

  const trigger = document.getElementById('samLocalPinsTrigger');
  const drawer = document.getElementById('samLocalPinsPanel');

  if (!trigger || !drawer) {
    return;
  }

  samPinsPlaceUi();

  const chats = samPinsLoad();
  const count = drawer.querySelector('#samLocalPinsCount');
  const list = drawer.querySelector('#samLocalPinsList');

  const triggerBadge = trigger.querySelector('#samLocalPinsTriggerBadge');

  if (triggerBadge) {
    triggerBadge.textContent = `${chats.length}/${SAM_LOCAL_PINNED_MAX}`;
  }

  trigger.classList.toggle('sam-local-pins-open', !samPinsIsCollapsed());
  trigger.title = `SAM закріплені чати: ${chats.length}/${SAM_LOCAL_PINNED_MAX}`;

  count.textContent = `${chats.length}/${SAM_LOCAL_PINNED_MAX}`;
  list.innerHTML = '';

  drawer.classList.toggle('sam-local-pins-hidden', samPinsIsCollapsed());

  if (chats.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sam-local-pins-empty';
    empty.textContent = 'Відкрий чат і натисни "+ Поточний".';
    list.appendChild(empty);
    return;
  }

  for (const chat of chats) {
    const row = document.createElement('div');
    row.className = 'sam-local-pins-row';
    row.title = chat.title;

    const title = document.createElement('div');
    title.className = 'sam-local-pins-row-title';
    title.textContent = chat.title;
    title.title = chat.title;

    const remove = document.createElement('button');
    remove.className = 'sam-local-pins-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Прибрати із SAM-закріплених';

    row.appendChild(title);
    row.appendChild(remove);

    row.addEventListener('click', async (event) => {
      if (
        event.target &&
        event.target.closest &&
        event.target.closest('.sam-local-pins-remove')
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      await samPinsOpenChat(chat.title);
      samPinsSetCollapsed(true);
    }, false);

    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.stopImmediatePropagation) {
        event.stopImmediatePropagation();
      }

      samPinsUnpinByTitle(chat.title);
    }, true);

    list.appendChild(row);
  }
}


function samPinsFindVisibleChatRow(title) {
  const normalized = cleanText(title);

  if (!normalized) {
    return null;
  }

  const side = document.querySelector('#pane-side') || document.querySelector('#side') || document.body;

  const titleElements = Array.from(side.querySelectorAll('span[title], div[title]'))
    .filter((element) => cleanText(element.getAttribute('title') || '') === normalized)
    .filter((element) => {
      const rect = element.getBoundingClientRect();

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.x >= 0 &&
        rect.x < window.innerWidth * 0.65
      );
    });

  for (const element of titleElements) {
    let current = element;

    for (let depth = 0; current && depth < 12; depth += 1) {
      const rect = current.getBoundingClientRect();
      const rowTitle = samPinsExtractBestChatTitleFromRow(current);

      if (
        rowTitle === normalized &&
        rect.width >= 180 &&
        rect.height >= 38 &&
        rect.x >= 0 &&
        rect.x < window.innerWidth * 0.65 &&
        current !== document.body &&
        current !== document.documentElement
      ) {
        return current;
      }

      current = current.parentElement;
    }
  }

  return null;
}

function samPinsClickElement(element) {
  if (!element) {
    return false;
  }

  try {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  } catch {
    try {
      element.click();
      return true;
    } catch {
      return false;
    }
  }
}

function samPinsFindSearchBox() {
  const side = document.querySelector('#side') || document.body;

  const boxes = Array.from(side.querySelectorAll('div[contenteditable="true"], [role="textbox"][contenteditable="true"]'))
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const label = cleanText(
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.textContent ||
        ''
      ).toLowerCase();

      return (
        rect.width > 80 &&
        rect.height > 10 &&
        rect.x >= 0 &&
        rect.x < window.innerWidth * 0.55 &&
        !label.includes('повідомлення')
      );
    });

  if (boxes.length === 0) {
    return null;
  }

  boxes.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
  return boxes[0];
}

function samPinsSetEditableText(element, text) {
  element.focus();

  try {
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, text);
  } catch {
    element.textContent = text;
  }

  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text
  }));
}

async function samPinsOpenChat(title) {
  const normalized = cleanText(title);

  if (!normalized) {
    return;
  }

  let row = samPinsFindVisibleChatRow(normalized);

  if (row && samPinsClickElement(row)) {
    showToast(`Відкрито чат: ${normalized}`);
    return;
  }

  const searchBox = samPinsFindSearchBox();

  if (!searchBox) {
    showToast('Не знайдено поле пошуку WhatsApp. Відкрий чат вручну.', true);
    return;
  }

  samPinsSetEditableText(searchBox, normalized);
  await samPinsSleep(900);

  row = samPinsFindVisibleChatRow(normalized);

  if (row && samPinsClickElement(row)) {
    showToast(`Відкрито чат: ${normalized}`);
    return;
  }

  // Додатковий fallback: Enter у полі пошуку часто відкриває перший результат.
  try {
    searchBox.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      which: 13,
      keyCode: 13
    }));

    searchBox.dispatchEvent(new KeyboardEvent('keyup', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      which: 13,
      keyCode: 13
    }));

    await samPinsSleep(500);
    showToast(`Спроба відкрити чат через пошук: ${normalized}`);
    return;
  } catch {
    showToast(`Не вдалося знайти чат: ${normalized}`, true);
  }
}


ipcRenderer.on('wa-selection:toggle', () => {
  setSelectionMode(!state.enabled);
});

ipcRenderer.on('wa-selection:copy', () => {
  copySelectedMessages();
});

ipcRenderer.on('wa-selection:clear', () => {
  clearSelection();
});

ipcRenderer.on('wa-selection:disable', () => {
  setSelectionMode(false);
});


// ===== SAM plain text paste support =====
// Потрібно для Excel/Calc: вставка як текст, а не як зображення/HTML.

let samLastEditableForPlainPaste = null;

function samIsEditableElement(element) {
  if (!element || !(element instanceof Element)) {
    return false;
  }

  if (element.matches('textarea, input')) {
    return true;
  }

  if (element.getAttribute('contenteditable') === 'true') {
    return true;
  }

  return Boolean(element.closest('[contenteditable="true"], textarea, input'));
}

function samGetEditableElementFromTarget(target) {
  if (!target || !(target instanceof Element)) {
    return null;
  }

  if (target.matches('textarea, input, [contenteditable="true"]')) {
    return target;
  }

  return target.closest('[contenteditable="true"], textarea, input');
}

function samGetFocusedEditableElement() {
  const active = document.activeElement;

  if (samIsEditableElement(active)) {
    return samGetEditableElementFromTarget(active);
  }

  if (samLastEditableForPlainPaste && document.contains(samLastEditableForPlainPaste)) {
    return samLastEditableForPlainPaste;
  }

  return null;
}

function samInsertPlainTextIntoEditable(text) {
  const value = String(text || '');

  if (!value) {
    return false;
  }

  const editable = samGetFocusedEditableElement();

  if (!editable) {
    return false;
  }

  editable.focus();

  if (
    editable instanceof HTMLTextAreaElement ||
    editable instanceof HTMLInputElement
  ) {
    const start = editable.selectionStart ?? editable.value.length;
    const end = editable.selectionEnd ?? editable.value.length;

    editable.setRangeText(value, start, end, 'end');
    editable.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  try {
    document.execCommand('insertText', false, value);
    editable.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: value
    }));
    return true;
  } catch {
    try {
      const selection = window.getSelection();

      if (selection && selection.rangeCount > 0) {
        selection.deleteFromDocument();
        selection.getRangeAt(0).insertNode(document.createTextNode(value));
        selection.collapseToEnd();
        editable.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: value
        }));
        return true;
      }
    } catch {
      // ignore
    }
  }

  return false;
}

document.addEventListener('contextmenu', (event) => {
  const editable = samGetEditableElementFromTarget(event.target);

  if (editable) {
    samLastEditableForPlainPaste = editable;
  }
}, true);

document.addEventListener('focusin', (event) => {
  const editable = samGetEditableElementFromTarget(event.target);

  if (editable) {
    samLastEditableForPlainPaste = editable;
  }
}, true);

ipcRenderer.on('wa:insert-plain-text', (_event, text) => {
  samInsertPlainTextIntoEditable(text);
});








// ===== SAM internal WhatsApp splitter v4 =====
// Flex-виправлення: список чатів змінює ширину, а область чату займає весь залишок.


let SAM_SETTINGS_GUARD_ACTIVE = false;
let SAM_SETTINGS_GUARD_TIMER = null;

const SAM_INTERNAL_SPLITTER_V4_WIDTH_KEY = 'samInternalChatListWidthV4';
const SAM_INTERNAL_SPLITTER_V4_MIN = 220;
const SAM_INTERNAL_SPLITTER_V4_DEFAULT = 512;
const SAM_INTERNAL_SPLITTER_V4_CHAT_MIN = 360;

function samSplitterV4SetImportant(el, name, value) {
  if (!el || !el.style) {
    return;
  }

  el.style.setProperty(name, value, 'important');
}

function samSplitterV4Clamp(width) {
  const requested = Number(width) || SAM_INTERNAL_SPLITTER_V4_DEFAULT;
  const layout = samSplitterV4FindLayout();

  const leftX = layout
    ? Math.round(layout.leftPane.getBoundingClientRect().x)
    : 64;

  const available = Math.max(0, window.innerWidth - leftX);

  /*
    Тепер правому полю достатньо 360 px,
    бо ми вже додали компактний режим, сховали список учасників групи
    і захистили кнопки Пошук / Меню.
  */

  let maxLeft = available - SAM_INTERNAL_SPLITTER_V4_CHAT_MIN;

  /*
    Якщо вікно дуже вузьке, не блокуємо splitter.
    Даємо користувачу витиснути ліве поле максимально вправо.
  */

  if (maxLeft < 180) {
    maxLeft = Math.max(180, available - 320);
  }

  const minLeft = 180;

  return Math.round(
    Math.max(
      minLeft,
      Math.min(requested, maxLeft)
    )
  );
}

function samSplitterV4LoadWidth() {
  const raw = localStorage.getItem(SAM_INTERNAL_SPLITTER_V4_WIDTH_KEY);
  const n = Number(raw);

  if (!Number.isFinite(n)) {
    return null;
  }

  return samSplitterV4Clamp(n);
}

function samSplitterV4SaveWidth(width) {
  const safe = samSplitterV4Clamp(width);
  localStorage.setItem(SAM_INTERNAL_SPLITTER_V4_WIDTH_KEY, String(safe));
  return safe;
}


function samSplitterV4RemoveInlineProps(el, props) {
  if (!el || !el.style) {
    return;
  }

  for (const prop of props) {
    el.style.removeProperty(prop);
  }
}

function samSplitterV4IsVisibleLarge(el) {
  if (!el || !(el instanceof Element)) {
    return false;
  }

  const rect = el.getBoundingClientRect();

  if (rect.width < 300 || rect.height < 300) {
    return false;
  }

  if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) {
    return false;
  }

  const cs = getComputedStyle(el);

  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
}

function samSplitterV4IsWhatsAppSettingsActive() {
  const candidates = [];

  for (const selector of [
    '[data-testid="drawer-fullscreen"]',
    '[data-testid="drawer-left"]',
    '[role="dialog"]',
    'section'
  ]) {
    for (const el of Array.from(document.querySelectorAll(selector)).slice(0, 12)) {
      if (samSplitterV4IsVisibleLarge(el)) {
        candidates.push(el);
      }
    }
  }

  for (const el of candidates) {
    const text = String(el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2500);

    if (!text) {
      continue;
    }

    const looksLikeMainSettings =
      text.includes('Профіль') &&
      text.includes('Обліковий запис') &&
      text.includes('Конфіденційність') &&
      text.includes('Бесіди');

    const looksLikeChatSettings =
      text.includes('Бесіди') &&
      (
        text.includes('Тема') ||
        text.includes('шпалери') ||
        text.includes('Шпалери') ||
        text.includes('налаштування бесіди') ||
        text.includes('Налаштування бесіди')
      );

    const looksLikeNotificationsSettings =
      text.includes('Сповіщення') &&
      text.includes('Повідомлення') &&
      text.includes('групи');

    const looksLikeKeyboardSettings =
      text.includes('Комбінації клавіш') &&
      text.includes('Швидкі дії');

    if (
      looksLikeMainSettings ||
      looksLikeChatSettings ||
      looksLikeNotificationsSettings ||
      looksLikeKeyboardSettings
    ) {
      return true;
    }
  }

  return false;
}

function samSplitterV4ClearLayoutStyles() {
  const splitter = document.getElementById('samInternalChatSplitterV4');

  if (splitter) {
    splitter.style.display = 'none';
  }

  const side = document.querySelector('#side');

  if (!side || !side.parentElement || !side.parentElement.parentElement) {
    return;
  }

  const leftPane = side.parentElement;
  const root = leftPane.parentElement;

  const commonProps = [
    'border',
    'border-left',
    'border-right',
    'box-shadow',
    'outline',
    'overflow',
    'position',
    'left',
    'right',
    'width',
    'min-width',
    'max-width',
    'flex',
    'flex-basis',
    'flex-grow',
    'flex-shrink',
    'transform',
    'display',
    'visibility'
  ];

  samSplitterV4RemoveInlineProps(root, [
    'display',
    'flex-direction',
    'width',
    'max-width',
    'overflow'
  ]);

  samSplitterV4RemoveInlineProps(leftPane, commonProps);

  for (const child of Array.from(root.children)) {
    if (child === leftPane) {
      continue;
    }

    const style = child.getAttribute('style') || '';

    if (
      style.includes('flex') ||
      style.includes('left: auto') ||
      style.includes('width: auto') ||
      style.includes('border-left') ||
      style.includes('box-shadow') ||
      style.includes('outline')
    ) {
      samSplitterV4RemoveInlineProps(child, commonProps);
    }
  }
}

function samSplitterV4SettingsGuardPass() {
  const active = samSplitterV4IsWhatsAppSettingsActive();

  if (active) {
    SAM_SETTINGS_GUARD_ACTIVE = true;
    samSplitterV4ClearLayoutStyles();
    return;
  }

  if (SAM_SETTINGS_GUARD_ACTIVE) {
    SAM_SETTINGS_GUARD_ACTIVE = false;

    // Після повернення зі сторінки налаштувань даємо WhatsApp відмалювати звичайний layout.
    setTimeout(samSplitterV4ForceLayoutPass, 300);
    setTimeout(samSplitterV4ForceLayoutPass, 900);
  }
}

function samSplitterV4ScheduleSettingsGuard() {
  if (SAM_SETTINGS_GUARD_TIMER) {
    clearTimeout(SAM_SETTINGS_GUARD_TIMER);
  }

  SAM_SETTINGS_GUARD_TIMER = setTimeout(() => {
    SAM_SETTINGS_GUARD_TIMER = null;
    samSplitterV4SettingsGuardPass();
  }, 120);
}



function samSplitterV4FindLayout() {
  const side = document.querySelector('#side');

  if (!side || !side.parentElement || !side.parentElement.parentElement) {
    return null;
  }

  const leftPane = side.parentElement;
  const root = leftPane.parentElement;

  let rightPane = null;

  // Основний надійний варіант: відкритий чат має #main.
  const main = document.querySelector('#main');

  if (main) {
    let el = main;

    while (el && el.parentElement && el.parentElement !== root) {
      el = el.parentElement;
    }

    if (el && el.parentElement === root && el !== leftPane) {
      rightPane = el;
    }
  }

  // Fallback: стартова права панель WhatsApp без відкритого чату.
  if (!rightPane) {
    const intro = document.querySelector('section[data-testid="intro-panel"]');

    if (intro) {
      let el = intro;

      while (el && el.parentElement && el.parentElement !== root) {
        el = el.parentElement;
      }

      if (el && el.parentElement === root && el !== leftPane) {
        rightPane = el;
      }
    }
  }

  if (!rightPane) {
    return null;
  }

  const leftRect = leftPane.getBoundingClientRect();
  const rightRect = rightPane.getBoundingClientRect();

  if (leftRect.width < 100 || leftRect.height < 300 || rightRect.height < 300) {
    return null;
  }

  return {
    root,
    side,
    leftPane,
    rightPane
  };
}

function samSplitterV4ResetOldInlineStyles(layout) {
  const { rightPane } = layout;

  // Прибираємо наслідки v3: саме вони давали порожнє поле.
  rightPane.style.removeProperty('left');
  rightPane.style.removeProperty('right');
  rightPane.style.removeProperty('width');
  rightPane.style.removeProperty('max-width');
  rightPane.style.removeProperty('min-width');
  rightPane.style.removeProperty('transform');
}


function samSplitterV4SuppressResidualOldBoundary(layout) {
  if (!layout) {
    return;
  }

  const { root, leftPane, rightPane } = layout;

  if (!document.getElementById('sam-splitter-v4-residual-style-disabled')) {
    const style = document.createElement('style');
    style.id = 'sam-splitter-v4-residual-style-disabled';
    style.textContent = `
      section[data-testid="intro-panel"],
      section[data-testid="intro-panel"]::before,
      section[data-testid="intro-panel"]::after {
        border-left: 0 !important;
        border-right: 0 !important;
        box-shadow: none !important;
        outline: 0 !important;
      }

      section[data-testid="intro-panel"]::before,
      section[data-testid="intro-panel"]::after {
        display: none !important;
        content: none !important;
        background: transparent !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  for (const el of [leftPane, rightPane]) {
    if (!el) {
      continue;
    }

    samSplitterV4SetImportant(el, 'border-left', '0');
    samSplitterV4SetImportant(el, 'border-right', '0');
    samSplitterV4SetImportant(el, 'box-shadow', 'none');
    samSplitterV4SetImportant(el, 'outline', '0');
  }

  const intro = rightPane ? rightPane.querySelector('[data-testid="intro-panel"]') : null;

  if (intro) {
    samSplitterV4SetImportant(intro, 'border-left', '0');
    samSplitterV4SetImportant(intro, 'border-right', '0');
    samSplitterV4SetImportant(intro, 'box-shadow', 'none');
    samSplitterV4SetImportant(intro, 'outline', '0');
  }

  // У WhatsApp Web є службовий full-screen overlay з pointer-events:none.
  // Саме він може залишати стару вертикальну межу після зміни flex-layout.
  if (root) {
    for (const child of Array.from(root.children)) {
      const rect = child.getBoundingClientRect();
      const cs = getComputedStyle(child);
      const testid = child.getAttribute('data-testid') || '';
      const styleAttr = child.getAttribute('style') || '';

      const looksLikeResidualOverlay =
        child !== leftPane &&
        child !== rightPane &&
        testid === '' &&
        cs.pointerEvents === 'none' &&
        rect.width >= window.innerWidth - 10 &&
        rect.height >= window.innerHeight - 10 &&
        styleAttr.includes('pointer-events');

      if (looksLikeResidualOverlay) {
        samSplitterV4SetImportant(child, 'display', 'none');
        samSplitterV4SetImportant(child, 'visibility', 'hidden');
        samSplitterV4SetImportant(child, 'border', '0');
        samSplitterV4SetImportant(child, 'box-shadow', 'none');
        samSplitterV4SetImportant(child, 'outline', '0');
      }
    }
  }
}


function samSplitterV4ApplyWidth(width) {
  const layout = samSplitterV4FindLayout();

  if (!layout) {
    return false;
  }

  const clamped = samSplitterV4Clamp(width);

  layout.root.style.setProperty('display', 'flex', 'important');
  layout.root.style.setProperty('overflow', 'hidden', 'important');

  layout.leftPane.style.setProperty('flex', `0 0 ${clamped}px`, 'important');
  layout.leftPane.style.setProperty('width', `${clamped}px`, 'important');
  layout.leftPane.style.setProperty('max-width', `${clamped}px`, 'important');
  layout.leftPane.style.setProperty('min-width', '180px', 'important');
  layout.leftPane.style.setProperty('overflow', 'hidden', 'important');

  layout.rightPane.style.setProperty('flex', '1 1 auto', 'important');
  layout.rightPane.style.setProperty('min-width', '320px', 'important');
  layout.rightPane.style.setProperty('max-width', 'none', 'important');
  layout.rightPane.style.setProperty('overflow', 'hidden', 'important');

  layout.side.style.setProperty('width', '100%', 'important');
  layout.side.style.setProperty('max-width', '100%', 'important');

  return true;
}


function samGroupHeaderMenuFixStyle() {
  if (document.getElementById('samGroupHeaderMenuFixStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samGroupHeaderMenuFixStyle';
  style.textContent = `
    #main header {
      overflow: hidden !important;
    }

    #main header * {
      min-width: 0;
    }

    #main header [data-testid="conversation-info-header"] {
      min-width: 0 !important;
      flex: 1 1 auto !important;
      overflow: hidden !important;
      max-width: calc(100% - 120px) !important;
    }

    #main header button[aria-label="Пошук"],
    #main header button[aria-label="Меню"],
    #main header button[aria-label="Search"],
    #main header button[aria-label="Menu"],
    #main header button[aria-label="More options"] {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      flex: 0 0 40px !important;
      min-width: 40px !important;
      width: 40px !important;
      max-width: 40px !important;
      position: relative !important;
      z-index: 20 !important;
    }
  `;

  document.documentElement.appendChild(style);
}

function samSplitterV4EnsureStyle() {
  if (document.getElementById('samInternalChatSplitterV4Style')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samInternalChatSplitterV4Style';
  style.textContent = `
    #samInternalChatSplitterV4 {
      position: fixed !important;
      width: 10px !important;
      z-index: 999999 !important;
      cursor: col-resize !important;
      background: transparent !important;
      user-select: none !important;
    }

    #samInternalChatSplitterV4:hover {
      background: rgba(0, 168, 132, 0.20) !important;
    }

    #main header {
      min-width: 0 !important;
      overflow: hidden !important;
    }

    #main header [data-testid="conversation-info-header"] {
      min-width: 0 !important;
      flex: 1 1 auto !important;
      overflow: hidden !important;
    }

    #main header button[aria-label="Пошук"],
    #main header button[aria-label="Меню"],
    #main header button[aria-label="Search"],
    #main header button[aria-label="Menu"],
    #main header button[aria-label="More options"] {
      flex: 0 0 40px !important;
      min-width: 40px !important;
      width: 40px !important;
      max-width: 40px !important;
      z-index: 5 !important;
    }
  `;

  document.documentElement.appendChild(style);
}

function samSplitterV4Place() {
  const splitter = document.getElementById('samInternalChatSplitterV4');
  const layout = samSplitterV4FindLayout();

  if (!splitter) {
    return false;
  }

  if (!layout) {
    splitter.style.display = 'none';
    return false;
  }

  const rect = layout.leftPane.getBoundingClientRect();

  splitter.style.display = 'block';
  splitter.style.left = `${Math.round(rect.right - 5)}px`;
  splitter.style.top = `${Math.round(rect.top)}px`;
  splitter.style.height = `${Math.round(rect.height)}px`;

  return true;
}

function samSplitterV4Ensure() {
  samSplitterV4EnsureStyle();

  let splitter = document.getElementById('samInternalChatSplitterV4');

  if (splitter) {
    samSplitterV4Place();
    return splitter;
  }

  splitter = document.createElement('div');
  splitter.id = 'samInternalChatSplitterV4';
  splitter.title = 'Змінити ширину списку чатів';

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMove = (event) => {
    if (!dragging) {
      return;
    }

    const nextWidth = startWidth + (event.clientX - startX);

    samSplitterV4ApplyWidth(nextWidth);
    samSplitterV4Place();
  };

  const onUp = () => {
    if (!dragging) {
      return;
    }

    dragging = false;
    document.body.style.cursor = '';

    const layout = samSplitterV4FindLayout();

    if (layout) {
      const width = Math.round(layout.leftPane.getBoundingClientRect().width);
      samSplitterV4SaveWidth(width);
    }

    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onUp, true);
  };

  splitter.addEventListener('pointerdown', (event) => {
    const layout = samSplitterV4FindLayout();

    if (!layout) {
      return;
    }

    dragging = true;
    startX = event.clientX;
    startWidth = Math.round(layout.leftPane.getBoundingClientRect().width);

    document.body.style.cursor = 'col-resize';

    event.preventDefault();
    event.stopPropagation();

    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
  }, true);

  document.documentElement.appendChild(splitter);

  samSplitterV4Place();

  return splitter;
}

function samSplitterV4ForceLayoutPass() {
  const layout = samSplitterV4FindLayout();

  if (!layout) {
    const splitter = document.getElementById('samInternalChatSplitterV4');

    if (splitter) {
      splitter.style.display = 'none';
    }

    return false;
  }

  const width =
    samSplitterV4LoadWidth() ||
    Math.min(SAM_INTERNAL_SPLITTER_V4_DEFAULT, samSplitterV4Clamp(SAM_INTERNAL_SPLITTER_V4_DEFAULT));

  samSplitterV4Ensure();
  samSplitterV4ApplyWidth(width);
  samSplitterV4Place();

  return true;
}


function samEnsureGroupParticipantsClipFix() {
  if (document.getElementById('samGroupParticipantsClipFixStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samGroupParticipantsClipFixStyle';
  style.textContent = `
    /* Шапка відкритого чату */
    #main header {
      overflow: hidden !important;
      flex-wrap: nowrap !important;
    }

    /* Усі flex-елементи в шапці мають право стискатися */
    #main header,
    #main header * {
      min-width: 0 !important;
    }

    /* Блок назви чату / групи */
    #main header [data-testid="conversation-info-header"] {
      flex: 1 1 0 !important;
      width: 0 !important;
      min-width: 0 !important;
      max-width: none !important;
      overflow: hidden !important;
    }

    /* Назва групи і список учасників — тільки в межах доступної ширини */
    #main header [data-testid="conversation-info-header"] span,
    #main header [data-testid="conversation-info-header"] div {
      min-width: 0 !important;
      max-width: 100% !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }

    /* Кнопки праворуч не стискаються і не виштовхуються */
    #main header button[aria-label="Пошук"],
    #main header button[aria-label="Меню"],
    #main header button[aria-label="Search"],
    #main header button[aria-label="Menu"],
    #main header button[aria-label="More options"] {
      flex: 0 0 40px !important;
      width: 40px !important;
      min-width: 40px !important;
      max-width: 40px !important;
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      position: relative !important;
      z-index: 100 !important;
      pointer-events: auto !important;
      transform: none !important;
    }
  `;

  document.documentElement.appendChild(style);
}



function samEnsureHideGroupParticipantsHeader() {
  if (document.getElementById('samHideGroupParticipantsHeaderStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samHideGroupParticipantsHeaderStyle';
  style.textContent = `
    /*
      У групових чатах WhatsApp показує під назвою групи довгий список учасників.
      Він витісняє кнопки Пошук / Меню, тому в SAM WhatsApp Web ховаємо цей рядок.
    */

    #main header [data-testid="conversation-info-header"] {
      flex: 1 1 0 !important;
      width: 0 !important;
      min-width: 0 !important;
      overflow: hidden !important;
    }

    /*
      Перший рядок — назва чату/групи — лишається.
      Другий рядок — учасники групи / службовий підпис — ховається.
    */
    #main header [data-testid="conversation-info-header"] > div > div:nth-child(2),
    #main header [data-testid="conversation-info-header"] > div > span:nth-child(2),
    #main header [data-testid="conversation-info-header"] [data-testid="conversation-info-header-subtitle"] {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
    }

    /*
      Назва групи не повинна витісняти кнопки.
    */
    #main header [data-testid="conversation-info-header"] span,
    #main header [data-testid="conversation-info-header"] div {
      min-width: 0 !important;
      max-width: 100% !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }

    /*
      Праві кнопки шапки не стискаються.
    */
    #main header button[aria-label="Пошук"],
    #main header button[aria-label="Меню"],
    #main header button[aria-label="Search"],
    #main header button[aria-label="Menu"],
    #main header button[aria-label="More options"] {
      flex: 0 0 40px !important;
      width: 40px !important;
      min-width: 40px !important;
      max-width: 40px !important;
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      z-index: 100 !important;
      pointer-events: auto !important;
    }
  `;

  document.documentElement.appendChild(style);
}



function samEnsureCompactViewStyle() {
  if (document.getElementById('samCompactViewStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samCompactViewStyle';
  style.textContent = `
    :root {
      --sam-chat-font-scale: 0.92;
      --sam-chat-density-scale: 0.92;
      --sam-list-font-scale: 0.90;
      --sam-list-density-scale: 0.90;
    }

    /*
      ЛІВЕ ПОЛЕ: список чатів
      Робимо текст і рядки компактнішими.
    */

    #side {
      font-size: calc(14px * var(--sam-list-font-scale)) !important;
    }

    #side span,
    #side div[title],
    #side [dir="auto"] {
      font-size: calc(14px * var(--sam-list-font-scale)) !important;
      line-height: 1.25 !important;
    }

    #side [role="listitem"],
    #side [role="row"] {
      min-height: calc(64px * var(--sam-list-density-scale)) !important;
    }

    #side img {
      transform: scale(0.92);
      transform-origin: center center;
    }

    /*
      ПРАВЕ ПОЛЕ: відкритий чат
      Зменшуємо текст повідомлень і внутрішні відступи.
    */

    #main {
      font-size: calc(14px * var(--sam-chat-font-scale)) !important;
    }

    #main .copyable-text,
    #main .selectable-text,
    #main [data-pre-plain-text],
    #main span[dir="ltr"],
    #main span[dir="auto"] {
      font-size: calc(14px * var(--sam-chat-font-scale)) !important;
      line-height: 1.32 !important;
    }

    /*
      Bubbles повідомлень.
      WhatsApp часто міняє класи, тому тут обережні селектори через data-pre-plain-text.
    */

    #main [data-pre-plain-text] {
      margin-top: calc(2px * var(--sam-chat-density-scale)) !important;
      margin-bottom: calc(2px * var(--sam-chat-density-scale)) !important;
    }

    #main [data-pre-plain-text] .copyable-text {
      padding-top: calc(3px * var(--sam-chat-density-scale)) !important;
      padding-bottom: calc(3px * var(--sam-chat-density-scale)) !important;
    }

    /*
      Поле введення повідомлення.
    */

    #main footer [contenteditable="true"],
    #main footer [role="textbox"],
    #main footer span[dir="auto"] {
      font-size: calc(14px * var(--sam-chat-font-scale)) !important;
      line-height: 1.3 !important;
    }

    /*
      Шапка чату.
      Назву залишаємо читабельною, але компактнішою.
    */

    #main header [data-testid="conversation-info-header"] span,
    #main header [data-testid="conversation-info-header"] div {
      font-size: calc(14px * var(--sam-chat-font-scale)) !important;
      line-height: 1.25 !important;
    }
  `;

  document.documentElement.appendChild(style);
}


async function samRefreshUiScaleMode() {
  try {
    const settings = await ipcRenderer.invoke('settings:load');
    const mode = settings && settings.uiScaleMode ? String(settings.uiScaleMode) : 'ultra';

    if (['normal', 'compact', 'ultra', 'max'].includes(mode)) {
      window.__samUiScaleMode = mode;
    } else {
      window.__samUiScaleMode = 'ultra';
    }
  } catch (_error) {
    window.__samUiScaleMode = window.__samUiScaleMode || 'ultra';
  }

  samUpdateCompactViewScale();
}

function samGetUiScalePreset(mode, mainWidth, sideWidth) {
  /*
    normal  — майже стандартний WhatsApp
    compact — трохи компактніше
    ultra   — поточний компактний режим
    max     — максимально щільно
  */

  if (mode === 'normal') {
    return {
      chatFontScale: 0.98,
      chatDensityScale: 1.02,
      listFontScale: 0.96,
      listDensityScale: 1.02,
      avatarSize: 46
    };
  }

  if (mode === 'compact') {
    let chatFontScale = 0.90;
    let chatDensityScale = 0.90;
    let listFontScale = 0.88;
    let listDensityScale = 0.88;
    let avatarSize = 38;

    if (mainWidth < 620) {
      chatFontScale = 0.86;
      chatDensityScale = 0.84;
    }

    if (sideWidth < 320) {
      listFontScale = 0.84;
      listDensityScale = 0.82;
      avatarSize = 34;
    }

    return {
      chatFontScale,
      chatDensityScale,
      listFontScale,
      listDensityScale,
      avatarSize
    };
  }

  if (mode === 'max') {
    let chatFontScale = 0.76;
    let chatDensityScale = 0.72;
    let listFontScale = 0.74;
    let listDensityScale = 0.70;
    let avatarSize = 26;

    if (mainWidth >= 760) {
      chatFontScale = 0.80;
      chatDensityScale = 0.76;
    }

    if (sideWidth < 300) {
      listFontScale = 0.70;
      listDensityScale = 0.66;
      avatarSize = 24;
    }

    return {
      chatFontScale,
      chatDensityScale,
      listFontScale,
      listDensityScale,
      avatarSize
    };
  }

  // ultra — default, поточний робочий режим.
  let chatFontScale = 0.84;
  let chatDensityScale = 0.82;
  let listFontScale = 0.82;
  let listDensityScale = 0.78;
  let avatarSize = 32;

  if (mainWidth >= 760) {
    chatFontScale = 0.86;
    chatDensityScale = 0.84;
  } else if (mainWidth >= 620) {
    chatFontScale = 0.83;
    chatDensityScale = 0.80;
  } else if (mainWidth >= 520) {
    chatFontScale = 0.80;
    chatDensityScale = 0.76;
  } else {
    chatFontScale = 0.76;
    chatDensityScale = 0.72;
  }

  if (sideWidth < 320) {
    listFontScale = 0.78;
    listDensityScale = 0.74;
    avatarSize = 28;
  }

  if (sideWidth < 260) {
    listFontScale = 0.74;
    listDensityScale = 0.70;
    avatarSize = 26;
  }

  return {
    chatFontScale,
    chatDensityScale,
    listFontScale,
    listDensityScale,
    avatarSize
  };
}


function samUpdateCompactViewScale() {
  const main = document.querySelector('#main');

  if (!main) {
    return;
  }

  const mainRect = main.getBoundingClientRect();
  const mainWidth = Math.round(mainRect.width);

  const side = document.querySelector('#side');
  const sideWidth = side ? Math.round(side.getBoundingClientRect().width) : 360;

  const mode = window.__samUiScaleMode || 'ultra';
  const preset = samGetUiScalePreset(mode, mainWidth, sideWidth);

  document.documentElement.setAttribute('data-sam-ui-scale-mode', mode);

  document.documentElement.style.setProperty('--sam-chat-font-scale', String(preset.chatFontScale));
  document.documentElement.style.setProperty('--sam-chat-density-scale', String(preset.chatDensityScale));
  document.documentElement.style.setProperty('--sam-list-font-scale', String(preset.listFontScale));
  document.documentElement.style.setProperty('--sam-list-density-scale', String(preset.listDensityScale));
  document.documentElement.style.setProperty('--sam-list-avatar-size', `${preset.avatarSize}px`);
}


function samEnsureUltraCompactViewStyle() {
  if (document.getElementById('samUltraCompactViewStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samUltraCompactViewStyle';
  style.textContent = `
    :root {
      --sam-chat-font-scale: 0.84;
      --sam-chat-density-scale: 0.82;
      --sam-list-font-scale: 0.82;
      --sam-list-density-scale: 0.78;
      --sam-list-avatar-size: 32px;
    }

    /*
      ЛІВЕ ПОЛЕ: список чатів
    */

    #side {
      font-size: calc(14px * var(--sam-list-font-scale)) !important;
    }

    #side span,
    #side div[title],
    #side [dir="auto"],
    #side [dir="ltr"] {
      font-size: calc(14px * var(--sam-list-font-scale)) !important;
      line-height: 1.18 !important;
    }

    /*
      Рядки списку чатів. Робимо нижчими.
    */

    #side [role="listitem"],
    #side [role="row"] {
      min-height: calc(58px * var(--sam-list-density-scale)) !important;
    }

    #side [role="listitem"] > div,
    #side [role="row"] > div {
      min-height: calc(58px * var(--sam-list-density-scale)) !important;
      padding-top: 2px !important;
      padding-bottom: 2px !important;
    }

    /*
      Аватарки / круглі іконки чатів і користувачів.
      Зменшуємо суттєво.
    */

    #side img {
      width: var(--sam-list-avatar-size) !important;
      height: var(--sam-list-avatar-size) !important;
      min-width: var(--sam-list-avatar-size) !important;
      min-height: var(--sam-list-avatar-size) !important;
      max-width: var(--sam-list-avatar-size) !important;
      max-height: var(--sam-list-avatar-size) !important;
      object-fit: cover !important;
      border-radius: 50% !important;
      transform: none !important;
    }

    /*
      Контейнери аватарок WhatsApp часто більші за сам img.
      Стискаємо найтиповіші круглі області в рядках списку.
    */

    #side [role="listitem"] [style*="height: 49px"],
    #side [role="listitem"] [style*="width: 49px"],
    #side [role="row"] [style*="height: 49px"],
    #side [role="row"] [style*="width: 49px"] {
      width: var(--sam-list-avatar-size) !important;
      height: var(--sam-list-avatar-size) !important;
      min-width: var(--sam-list-avatar-size) !important;
      min-height: var(--sam-list-avatar-size) !important;
      max-width: var(--sam-list-avatar-size) !important;
      max-height: var(--sam-list-avatar-size) !important;
    }

    /*
      ПРАВЕ ПОЛЕ: сам чат
    */

    #main {
      font-size: calc(14px * var(--sam-chat-font-scale)) !important;
    }

    #main .copyable-text,
    #main .selectable-text,
    #main [data-pre-plain-text],
    #main span[dir="ltr"],
    #main span[dir="auto"] {
      font-size: calc(14px * var(--sam-chat-font-scale)) !important;
      line-height: 1.24 !important;
    }

    #main [data-pre-plain-text] {
      margin-top: calc(1px * var(--sam-chat-density-scale)) !important;
      margin-bottom: calc(1px * var(--sam-chat-density-scale)) !important;
    }

    #main [data-pre-plain-text] .copyable-text {
      padding-top: calc(2px * var(--sam-chat-density-scale)) !important;
      padding-bottom: calc(2px * var(--sam-chat-density-scale)) !important;
    }

    /*
      Поле введення повідомлення.
    */

    #main footer [contenteditable="true"],
    #main footer [role="textbox"],
    #main footer span[dir="auto"] {
      font-size: calc(14px * var(--sam-chat-font-scale)) !important;
      line-height: 1.22 !important;
    }

    /*
      Шапка чату.
    */

    #main header [data-testid="conversation-info-header"] span,
    #main header [data-testid="conversation-info-header"] div {
      font-size: calc(14px * var(--sam-chat-font-scale)) !important;
      line-height: 1.18 !important;
    }
  `;

  document.documentElement.appendChild(style);
}


function samStartCompactView() {
  samRefreshUiScaleMode();
  samEnsureUltraCompactViewStyle();
  if (window.__samCompactViewStarted) {
    return;
  }

  window.__samCompactViewStarted = true;

  samEnsureCompactViewStyle();

  for (const delay of [0, 300, 800, 1500, 3000]) {
    setTimeout(samUpdateCompactViewScale, delay);
  }

  let timer = null;

  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(samUpdateCompactViewScale, 100);
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(samUpdateCompactViewScale, 100);
    }
  }, true);

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(samUpdateCompactViewScale, 150);
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: false
    });
  }
}


function samSplitterV4Start() {
  samStartCompactView();
  samEnsureHideGroupParticipantsHeader();
  samEnsureGroupParticipantsClipFix();
  samEnsureGroupHeaderMenuButtonFix();
  samGroupHeaderMenuFixStyle();
  if (window.__samSplitterV4Started) {
    return;
  }

  window.__samSplitterV4Started = true;

  localStorage.removeItem('samInternalChatListWidthV3');

  let attempts = 0;

  const timer = setInterval(() => {
    attempts += 1;

    const ok = samSplitterV4ForceLayoutPass();

    if ((ok && attempts >= 12) || attempts >= 50) {
      clearInterval(timer);
    }
  }, 250);

  for (const delay of [0, 300, 800, 1500, 3000, 5000, 8000, 12000]) {
    setTimeout(samSplitterV4ForceLayoutPass, delay);
  }

  let resizeTimer = null;

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(samSplitterV4ForceLayoutPass, 100);
  }, true);

  window.addEventListener('focus', () => {
    setTimeout(samSplitterV4ForceLayoutPass, 250);
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(samSplitterV4ForceLayoutPass, 250);
    }
  }, true);

  let mutationTimer = null;

  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(samSplitterV4ForceLayoutPass, 250);
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: false
    });

    setTimeout(() => {
      observer.disconnect();
    }, 20000);
  }
}


window.addEventListener('DOMContentLoaded', () => {
  ensureBar();
  updateBar();
  samPinsEnsurePanel();
  samPinsRender();
  startMenuObserver();
  // SAM splitter v4 тимчасово вимкнений для діагностики стабільності layout WhatsApp.
  // Причина: можливе зникання елементів шапки чату / нестабільність області чатів.
  // samSplitterV4Start();
});

document.addEventListener('contextmenu', rememberMessageRootFromEvent, true);
document.addEventListener('mousedown', rememberMessageRootFromEvent, true);
// disabled for performance: // disabled for performance: document.addEventListener('mouseover', rememberHoveredMessageRoot, true);
document.addEventListener('click', handleDocumentClick, true);
document.addEventListener('keydown', handleDocumentKeydown, true);




if (!window.__samSplitterV4BootScheduled) {
  window.__samSplitterV4BootScheduled = true;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(samSplitterV4Start, 0);
    }, { once: true });
  } else {
    setTimeout(samSplitterV4Start, 0);
  }
}




if (!window.__samGroupHeaderFixPointerInstalled) {
  window.__samGroupHeaderFixPointerInstalled = true;

  document.addEventListener('pointerdown', (event) => {
    if (event.target && event.target.closest && event.target.closest('#main header')) {
      samEnsureGroupHeaderMenuButtonFix();
      setTimeout(samEnsureGroupHeaderMenuButtonFix, 50);
      setTimeout(samEnsureGroupHeaderMenuButtonFix, 200);
    }
  }, true);
}




if (!window.__samGroupParticipantsClipFixBoot) {
  window.__samGroupParticipantsClipFixBoot = true;

  setTimeout(samEnsureGroupParticipantsClipFix, 0);
  setTimeout(samEnsureGroupParticipantsClipFix, 500);
  setTimeout(samEnsureGroupParticipantsClipFix, 1500);

  document.addEventListener('pointerdown', (event) => {
    if (
      event.target &&
      event.target.closest &&
      (
        event.target.closest('#main header') ||
        event.target.closest('#side')
      )
    ) {
      setTimeout(samEnsureGroupParticipantsClipFix, 50);
      setTimeout(samEnsureGroupParticipantsClipFix, 250);
    }
  }, true);
}




if (!window.__samHideGroupParticipantsHeaderBoot) {
  window.__samHideGroupParticipantsHeaderBoot = true;

  setTimeout(samEnsureHideGroupParticipantsHeader, 0);
  setTimeout(samEnsureHideGroupParticipantsHeader, 500);
  setTimeout(samEnsureHideGroupParticipantsHeader, 1500);

  document.addEventListener('pointerdown', (event) => {
    if (
      event.target &&
      event.target.closest &&
      (
        event.target.closest('#main header') ||
        event.target.closest('#side')
      )
    ) {
      setTimeout(samEnsureHideGroupParticipantsHeader, 50);
      setTimeout(samEnsureHideGroupParticipantsHeader, 250);
    }
  }, true);
}




if (!window.__samCompactViewBootScheduled) {
  window.__samCompactViewBootScheduled = true;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(samStartCompactView, 0);
    }, { once: true });
  } else {
    setTimeout(samStartCompactView, 0);
  }
}




if (!window.__samUiScaleSettingsRefreshBoot) {
  window.__samUiScaleSettingsRefreshBoot = true;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(samRefreshUiScaleMode, 0);
    }, { once: true });
  } else {
    setTimeout(samRefreshUiScaleMode, 0);
  }

  window.addEventListener('focus', () => {
    setTimeout(samRefreshUiScaleMode, 150);
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(samRefreshUiScaleMode, 150);
    }
  }, true);
}

