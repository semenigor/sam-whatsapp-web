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

function samNormalizeCopiedMessageSpacing(text) {
  let value = cleanText(text || '');

  value = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

  /*
    WhatsApp DOM може давати порожній рядок між data-pre-plain-text
    і першим ol/li. Для вставки в Writer це зайвий розрив.
  */

  value = value.replace(
    /(^|\n)(\d{1,2}:\d{2}\s+\d{2}\.\d{2}\.\d{4})\n{2,}(?=\d+\.\s)/g,
    '$1$2\n'
  );

  return value;
}

function samGetDirectListItemText(li) {
  const clone = li.cloneNode(true);

  for (const nested of Array.from(clone.querySelectorAll('ol, ul'))) {
    nested.remove();
  }

  return samNormalizeCopiedMessageSpacing(clone.innerText || clone.textContent || '');
}

function samFormatListForClipboard(list, depth = 0) {
  const tag = String(list.tagName || '').toLowerCase();
  const isOrdered = tag === 'ol';

  let number = Number.parseInt(list.getAttribute('start') || '1', 10);

  if (!Number.isFinite(number) || number < 1) {
    number = 1;
  }

  const indent = '  '.repeat(Math.max(0, depth));
  const lines = [];

  const items = Array.from(list.children).filter((child) => {
    return String(child.tagName || '').toLowerCase() === 'li';
  });

  for (const li of items) {
    const prefix = isOrdered ? `${number}. ` : '- ';
    const directText = samGetDirectListItemText(li);
    const directLines = directText
      .split(/\n+/)
      .map((line) => cleanText(line))
      .filter(Boolean);

    if (directLines.length > 0) {
      lines.push(`${indent}${prefix}${directLines[0]}`);

      for (const extraLine of directLines.slice(1)) {
        lines.push(`${indent}${' '.repeat(prefix.length)}${extraLine}`);
      }
    } else {
      lines.push(`${indent}${prefix.trim()}`);
    }

    const nestedLists = Array.from(li.children).filter((child) => {
      const childTag = String(child.tagName || '').toLowerCase();
      return childTag === 'ol' || childTag === 'ul';
    });

    for (const nested of nestedLists) {
      const nestedText = samFormatListForClipboard(nested, depth + 1);

      if (nestedText) {
        lines.push(nestedText);
      }
    }

    if (isOrdered) {
      number += 1;
    }
  }

  return lines.filter(Boolean).join('\n');
}

function samElementTextForClipboard(element) {
  if (!element) {
    return '';
  }

  const clone = element.cloneNode(true);

  const lists = Array.from(clone.querySelectorAll('ol, ul')).filter((list) => {
    const parentList = list.parentElement ? list.parentElement.closest('ol, ul') : null;
    return !parentList;
  });

  for (const list of lists) {
    const listText = samFormatListForClipboard(list, 0);

    if (listText) {
      list.replaceWith(document.createTextNode(`\n${listText}\n`));
    }
  }

  return samNormalizeCopiedMessageSpacing(clone.innerText || clone.textContent || '');
}

function samCollectMessageTextContainers(root) {
  const containers = [];

  const preElements = Array.from(root.querySelectorAll('[data-pre-plain-text]'));

  for (const preElement of preElements) {
    const innerContainers = Array.from(
      preElement.querySelectorAll('.copyable-text, .selectable-text')
    ).filter((element) => samElementTextForClipboard(element));

    if (innerContainers.length > 0) {
      containers.push(...innerContainers);
    } else {
      containers.push(preElement);
    }
  }

  if (containers.length === 0) {
    containers.push(...Array.from(root.querySelectorAll('.copyable-text, .selectable-text')));
  }

  return containers.filter((element, index, array) => {
    return !array.some((other, otherIndex) => {
      return otherIndex !== index && other.contains(element);
    });
  });
}

function extractMessageData(root) {
  const preElement = root.querySelector('[data-pre-plain-text]');
  const preText = preElement ? preElement.getAttribute('data-pre-plain-text') : '';

  const textContainers = samCollectMessageTextContainers(root);

  const textValues = textContainers
    .map((element) => samElementTextForClipboard(element))
    .map((value) => cleanText(value))
    .filter(Boolean);

  let text = samNormalizeCopiedMessageSpacing(textValues.join('\n'));

  if (!text && preElement) {
    text = samNormalizeCopiedMessageSpacing(samElementTextForClipboard(preElement));
  }

  if (!text) {
    text = samNormalizeCopiedMessageSpacing(root.innerText || root.textContent || '');
  }

  const keySource = cleanText(`${preText}\n${text}`) || cleanText(root.innerText || root.textContent || '');
  const key = keySource.slice(0, 800);

  return {
    key,
    text,
    preText
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
const SAM_LOCAL_PINNED_MAX = 15;

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
  try {
    if (typeof samNotesEnsurePanel === 'function') {
      samNotesEnsurePanel();
    }
  } catch (_error) {
    // ignore
  }

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

    document.body.appendChild(trigger);

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
    document.body.appendChild(trigger);
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


function samEnsureChatListPolishStyle() {
  if (document.getElementById('samChatListPolishStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samChatListPolishStyle';
  style.textContent = `
    /*
      SAM UI polish:
      1. природніша висота рядків у списку чатів;
      2. повністю невидимий splitter-hit-area;
      3. без зайвої вертикальної риски.
    */

    :root {
      --sam-list-row-height: 54px;
      --sam-list-row-padding-y: 2px;
    }

    html[data-sam-ui-scale-mode="normal"] {
      --sam-list-row-height: 66px;
      --sam-list-row-padding-y: 6px;
    }

    html[data-sam-ui-scale-mode="compact"] {
      --sam-list-row-height: 58px;
      --sam-list-row-padding-y: 4px;
    }

    html[data-sam-ui-scale-mode="ultra"] {
      --sam-list-row-height: 54px;
      --sam-list-row-padding-y: 2px;
    }

    html[data-sam-ui-scale-mode="max"] {
      --sam-list-row-height: 50px;
      --sam-list-row-padding-y: 1px;
    }

    #pane-side [role="listitem"],
    #pane-side [role="row"],
    #side [role="listitem"],
    #side [role="row"] {
      min-height: var(--sam-list-row-height) !important;
      height: var(--sam-list-row-height) !important;
    }

    #pane-side [role="listitem"] > div,
    #pane-side [role="row"] > div,
    #side [role="listitem"] > div,
    #side [role="row"] > div {
      min-height: var(--sam-list-row-height) !important;
      height: var(--sam-list-row-height) !important;
      padding-top: var(--sam-list-row-padding-y) !important;
      padding-bottom: var(--sam-list-row-padding-y) !important;
      box-sizing: border-box !important;
    }

    #pane-side [role="listitem"] span,
    #pane-side [role="row"] span,
    #side [role="listitem"] span,
    #side [role="row"] span {
      line-height: 1.16 !important;
    }

    /*
      Splitter лишається робочим як прозора зона перетягування,
      але сама вертикальна риска/підсвітка не показується.
    */

    #samInternalChatSplitterV4,
    #samInternalChatSplitterV4:hover,
    #samInternalChatSplitterV4:active {
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
      outline: 0 !important;
      opacity: 0 !important;
    }

    /*
      Прибираємо службові вертикальні borders біля межі лівої/правої панелі,
      якщо WhatsApp або старий layout їх домалював.
    */

    #side,
    #pane-side,
    #main,
    section[data-testid="intro-panel"] {
      border-left: 0 !important;
      border-right: 0 !important;
      box-shadow: none !important;
    }
  `;

  document.documentElement.appendChild(style);
}

const SAM_REACTION_TONE_MODIFIER_RE = /[🏻🏼🏽🏾🏿]/gu;

function samNormalizeReactionEmojiTextNode(node) {
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    return;
  }

  const oldValue = String(node.nodeValue || '');

  if (!oldValue) {
    return;
  }

  /*
    На деяких Linux-системах emoji з модифікатором тону шкіри
    показується як два окремі значки. Для preview/реакцій у SAM
    прибираємо modifier і лишаємо один базовий emoji.
  */

  const newValue = oldValue.replace(SAM_REACTION_TONE_MODIFIER_RE, '');

  if (newValue !== oldValue) {
    node.nodeValue = newValue;
  }
}

function samNormalizeReactionEmojiRoot(root) {
  if (!root) {
    return;
  }

  try {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      null
    );

    const nodes = [];

    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    for (const node of nodes) {
      samNormalizeReactionEmojiTextNode(node);
    }
  } catch (_error) {
    // ignore
  }
}

function samNormalizeReactionEmojiOnce() {
  const side = document.querySelector('#pane-side') || document.querySelector('#side');

  if (side) {
    samNormalizeReactionEmojiRoot(side);
  }

  const reactionRoots = document.querySelectorAll(
    '#main [data-testid*="reaction"], ' +
    '#main [aria-label*="reaction"], ' +
    '#main [aria-label*="Reaction"], ' +
    '#main [aria-label*="реакц"], ' +
    '#main [aria-label*="Реакц"]'
  );

  for (const root of reactionRoots) {
    samNormalizeReactionEmojiRoot(root);
  }
}

function samStartReactionEmojiNormalizer() {
  if (window.__samReactionEmojiNormalizerStarted) {
    return;
  }

  window.__samReactionEmojiNormalizerStarted = true;

  const runSoon = () => {
    setTimeout(samNormalizeReactionEmojiOnce, 100);
    setTimeout(samNormalizeReactionEmojiOnce, 600);
    setTimeout(samNormalizeReactionEmojiOnce, 1500);
  };

  runSoon();

  if (!document.body) {
    setTimeout(samStartReactionEmojiNormalizer, 500);
    return;
  }

  let timer = null;

  const observer = new MutationObserver((mutations) => {
    let relevant = false;

    for (const mutation of mutations) {
      const target = mutation.target;

      if (!target || !target.closest) {
        continue;
      }

      if (
        target.closest('#pane-side') ||
        target.closest('#side') ||
        target.closest('#main [data-testid*="reaction"]') ||
        target.closest('#main [aria-label*="reaction"]') ||
        target.closest('#main [aria-label*="Reaction"]') ||
        target.closest('#main [aria-label*="реакц"]') ||
        target.closest('#main [aria-label*="Реакц"]')
      ) {
        relevant = true;
        break;
      }
    }

    if (!relevant) {
      return;
    }

    clearTimeout(timer);
    timer = setTimeout(samNormalizeReactionEmojiOnce, 150);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function samStartUiPolishFixes() {
  samEnsureChatListPolishStyle();
  samStartReactionEmojiNormalizer();
}

if (!window.__samUiPolishFixesScheduled) {
  window.__samUiPolishFixesScheduled = true;

  setTimeout(samStartUiPolishFixes, 0);
  setTimeout(samStartUiPolishFixes, 800);
  setTimeout(samStartUiPolishFixes, 2000);
}

// ===== SAM chat list spacing v3 =====
// Безпечне ущільнення списку чатів без накопичення translate.


function samEnsureChatRowAvatarCompactStyle() {
  if (document.getElementById('samChatRowAvatarCompactStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samChatRowAvatarCompactStyle';
  style.textContent = `
    /*
      Компактніший список чатів:
      зменшуємо аватарку і внутрішню висоту рядка,
      щоб рядки виглядали природно, а не розтягнуто.
    */

    :root {
      --sam-chat-row-avatar-size: 42px;
      --sam-chat-row-inner-height: 58px;
    }

    html[data-sam-ui-scale-mode="normal"] {
      --sam-chat-row-avatar-size: 46px;
      --sam-chat-row-inner-height: 64px;
    }

    html[data-sam-ui-scale-mode="compact"] {
      --sam-chat-row-avatar-size: 42px;
      --sam-chat-row-inner-height: 60px;
    }

    html[data-sam-ui-scale-mode="ultra"] {
      --sam-chat-row-avatar-size: 38px;
      --sam-chat-row-inner-height: 56px;
    }

    html[data-sam-ui-scale-mode="max"] {
      --sam-chat-row-avatar-size: 34px;
      --sam-chat-row-inner-height: 52px;
    }

    #pane-side [data-testid^="list-item-"],
    #side [data-testid^="list-item-"],
    #pane-side [role="row"],
    #side [role="row"] {
      min-height: var(--sam-chat-row-inner-height) !important;
      height: var(--sam-chat-row-inner-height) !important;
    }

    #pane-side [data-testid^="list-item-"] > div,
    #side [data-testid^="list-item-"] > div,
    #pane-side [role="row"] > div,
    #side [role="row"] > div {
      min-height: var(--sam-chat-row-inner-height) !important;
      height: var(--sam-chat-row-inner-height) !important;
      padding-top: 2px !important;
      padding-bottom: 2px !important;
      box-sizing: border-box !important;
    }

    /*
      Аватарки. WhatsApp може малювати їх як img або як div із background-image.
    */

    #pane-side [data-testid^="list-item-"] img:not(.emoji),
    #side [data-testid^="list-item-"] img:not(.emoji),
    #pane-side [role="row"] img:not(.emoji),
    #side [role="row"] img:not(.emoji) {
      width: var(--sam-chat-row-avatar-size) !important;
      height: var(--sam-chat-row-avatar-size) !important;
      min-width: var(--sam-chat-row-avatar-size) !important;
      min-height: var(--sam-chat-row-avatar-size) !important;
      max-width: var(--sam-chat-row-avatar-size) !important;
      max-height: var(--sam-chat-row-avatar-size) !important;
      object-fit: cover !important;
      border-radius: 50% !important;
      transform: none !important;
    }

    #pane-side [data-testid^="list-item-"] [style*="background-image"],
    #side [data-testid^="list-item-"] [style*="background-image"],
    #pane-side [role="row"] [style*="background-image"],
    #side [role="row"] [style*="background-image"] {
      width: var(--sam-chat-row-avatar-size) !important;
      height: var(--sam-chat-row-avatar-size) !important;
      min-width: var(--sam-chat-row-avatar-size) !important;
      min-height: var(--sam-chat-row-avatar-size) !important;
      max-width: var(--sam-chat-row-avatar-size) !important;
      max-height: var(--sam-chat-row-avatar-size) !important;
      border-radius: 50% !important;
      background-size: cover !important;
      background-position: center center !important;
    }

    #pane-side [data-testid^="list-item-"] span,
    #side [data-testid^="list-item-"] span,
    #pane-side [role="row"] span,
    #side [role="row"] span {
      line-height: 1.12 !important;
    }
  `;

  document.documentElement.appendChild(style);
}

function samChatRowsSpacingV3GetRows() {
  const side = document.querySelector('#pane-side') || document.querySelector('#side');

  if (!side) {
    return [];
  }

  return Array.from(side.querySelectorAll('[data-testid^="list-item-"], [role="row"]'))
    .filter((row) => {
      if (!row || !row.getBoundingClientRect) {
        return false;
      }

      const rect = row.getBoundingClientRect();

      return rect.width > 180 && rect.height >= 40;
    })
    .sort((a, b) => {
      return a.getBoundingClientRect().y - b.getBoundingClientRect().y;
    });
}

function samChatRowsSpacingV3TargetStep() {
  const mode = window.__samUiScaleMode || 'ultra';

  /*
    Реальний WhatsApp зараз дає крок приблизно 76 px при висоті рядка 54 px.
    Зменшуємо обережно: без злипання і без обрізання тексту.
  */

  if (mode === 'normal') {
    return 68;
  }

  if (mode === 'compact') {
    return 64;
  }

  if (mode === 'max') {
    return 58;
  }

  return 62;
}

function samChatRowsSpacingV3Reset(rows) {
  for (const row of rows) {
    if (row && row.style) {
      row.style.removeProperty('translate');
      row.style.removeProperty('will-change');
    }
  }
}

function samApplyChatRowsSpacingV3() {
  samEnsureChatRowAvatarCompactStyle();

  let rows = samChatRowsSpacingV3GetRows();

  if (rows.length < 2) {
    return;
  }

  /*
    ВАЖЛИВО:
    спочатку скидаємо попередній translate, щоб зсув не накопичувався.
  */

  samChatRowsSpacingV3Reset(rows);

  rows = samChatRowsSpacingV3GetRows();

  if (rows.length < 2) {
    return;
  }

  const firstTop = rows[0].getBoundingClientRect().y;
  const secondTop = rows[1].getBoundingClientRect().y;
  const originalStep = Math.round(secondTop - firstTop);
  const targetStep = samChatRowsSpacingV3TargetStep();

  if (!Number.isFinite(originalStep) || originalStep <= 0) {
    return;
  }

  /*
    Якщо WhatsApp уже сам зробив нормальний крок — не чіпаємо.
  */

  if (originalStep <= targetStep + 1) {
    return;
  }

  rows.forEach((row, index) => {
    const currentTop = row.getBoundingClientRect().y;
    const desiredTop = firstTop + index * targetStep;
    const shift = Math.round(desiredTop - currentTop);

    row.style.setProperty('translate', `0 ${shift}px`, 'important');
    row.style.setProperty('will-change', 'translate', 'important');
  });
}

function samStartChatRowsSpacingV3() {
  if (window.__samChatRowsSpacingV3Started) {
    return;
  }

  window.__samChatRowsSpacingV3Started = true;

  const run = () => {
    try {
      samApplyChatRowsSpacingV3();
    } catch (_error) {
      // ignore
    }
  };

  run();
  setTimeout(run, 300);
  setTimeout(run, 1000);
  setTimeout(run, 2500);

  window.addEventListener('resize', run);
  window.addEventListener('focus', run);
  document.addEventListener('scroll', run, true);

  if (document.body) {
    let timer = null;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(run, 120);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'data-testid']
    });
  }

  setInterval(run, 2000);
}

if (!window.__samChatRowsSpacingV3Scheduled) {
  window.__samChatRowsSpacingV3Scheduled = true;

  setTimeout(samStartChatRowsSpacingV3, 0);
  setTimeout(samStartChatRowsSpacingV3, 800);
  setTimeout(samStartChatRowsSpacingV3, 2000);
}

// ===== SAM reaction preview emoji size fix =====
// Emoji у preview останнього повідомлення не повинні масштабуватися як аватарки.

function samEnsureReactionPreviewEmojiSizeStyle() {
  if (document.getElementById('samReactionPreviewEmojiSizeStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samReactionPreviewEmojiSizeStyle';
  style.textContent = `
    #pane-side [data-testid^="list-item-"] [data-testid="last-msg-status"] img.emoji,
    #side [data-testid^="list-item-"] [data-testid="last-msg-status"] img.emoji,
    #pane-side [role="row"] [data-testid="last-msg-status"] img.emoji,
    #side [role="row"] [data-testid="last-msg-status"] img.emoji {
      width: 20px !important;
      height: 20px !important;
      min-width: 20px !important;
      min-height: 20px !important;
      max-width: 20px !important;
      max-height: 20px !important;
      display: inline-block !important;
      object-fit: initial !important;
      border-radius: 0 !important;
      transform: none !important;
      vertical-align: -4px !important;
      overflow: hidden !important;
      background-repeat: no-repeat !important;
    }

    #pane-side [data-testid^="list-item-"] [data-testid="last-msg-status"],
    #side [data-testid^="list-item-"] [data-testid="last-msg-status"],
    #pane-side [role="row"] [data-testid="last-msg-status"],
    #side [role="row"] [data-testid="last-msg-status"] {
      align-items: center !important;
      line-height: 20px !important;
    }
  `;

  document.documentElement.appendChild(style);
}

function samFixReactionPreviewEmojiSizesOnce() {
  samEnsureReactionPreviewEmojiSizeStyle();

  const roots = document.querySelectorAll(
    '#pane-side [data-testid="last-msg-status"], ' +
    '#side [data-testid="last-msg-status"]'
  );

  for (const root of roots) {
    const emojis = Array.from(root.querySelectorAll('img.emoji'));

    for (const emoji of emojis) {
      emoji.style.setProperty('width', '20px', 'important');
      emoji.style.setProperty('height', '20px', 'important');
      emoji.style.setProperty('min-width', '20px', 'important');
      emoji.style.setProperty('min-height', '20px', 'important');
      emoji.style.setProperty('max-width', '20px', 'important');
      emoji.style.setProperty('max-height', '20px', 'important');
      emoji.style.setProperty('display', 'inline-block', 'important');
      emoji.style.setProperty('object-fit', 'initial', 'important');
      emoji.style.setProperty('border-radius', '0', 'important');
      emoji.style.setProperty('transform', 'none', 'important');
      emoji.style.setProperty('vertical-align', '-4px', 'important');
      emoji.style.setProperty('overflow', 'hidden', 'important');
    }
  }
}

function samStartReactionPreviewEmojiSizeFix() {
  if (window.__samReactionPreviewEmojiSizeFixStarted) {
    return;
  }

  window.__samReactionPreviewEmojiSizeFixStarted = true;

  const run = () => {
    try {
      samFixReactionPreviewEmojiSizesOnce();
    } catch (_error) {
      // ignore
    }
  };

  run();
  setTimeout(run, 300);
  setTimeout(run, 1000);
  setTimeout(run, 2500);

  if (document.body) {
    let timer = null;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(run, 100);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'data-testid', 'title']
    });
  }

  setInterval(run, 2000);
}

if (!window.__samReactionPreviewEmojiSizeFixScheduled) {
  window.__samReactionPreviewEmojiSizeFixScheduled = true;

  setTimeout(samStartReactionPreviewEmojiSizeFix, 0);
  setTimeout(samStartReactionPreviewEmojiSizeFix, 800);
  setTimeout(samStartReactionPreviewEmojiSizeFix, 2000);
}

// ===== SAM all chat-list emoji size fix =====
// Усі emoji-спрайти в лівому списку чатів мають бути малими.
// Це не чіпає аватарки, бо аватарки не мають class="emoji".

function samEnsureAllChatListEmojiSizeStyle() {
  if (document.getElementById('samAllChatListEmojiSizeStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samAllChatListEmojiSizeStyle';
  style.textContent = `
    #pane-side img.emoji,
    #side img.emoji {
      width: 20px !important;
      height: 20px !important;
      min-width: 20px !important;
      min-height: 20px !important;
      max-width: 20px !important;
      max-height: 20px !important;
      display: inline-block !important;
      object-fit: initial !important;
      border-radius: 0 !important;
      transform: none !important;
      vertical-align: -4px !important;
      overflow: hidden !important;
      background-repeat: no-repeat !important;
    }

    #pane-side span:has(> img.emoji),
    #side span:has(> img.emoji) {
      display: inline-block !important;
      width: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      height: 20px !important;
      min-height: 20px !important;
      max-height: 20px !important;
      overflow: visible !important;
      line-height: 20px !important;
      vertical-align: middle !important;
    }
  `;

  document.documentElement.appendChild(style);
}

function samFixAllChatListEmojiSizesOnce() {
  samEnsureAllChatListEmojiSizeStyle();

  const roots = [
    document.querySelector('#pane-side'),
    document.querySelector('#side')
  ].filter(Boolean);

  for (const root of roots) {
    const emojis = Array.from(root.querySelectorAll('img.emoji'));

    for (const emoji of emojis) {
      emoji.style.setProperty('width', '20px', 'important');
      emoji.style.setProperty('height', '20px', 'important');
      emoji.style.setProperty('min-width', '20px', 'important');
      emoji.style.setProperty('min-height', '20px', 'important');
      emoji.style.setProperty('max-width', '20px', 'important');
      emoji.style.setProperty('max-height', '20px', 'important');
      emoji.style.setProperty('display', 'inline-block', 'important');
      emoji.style.setProperty('object-fit', 'initial', 'important');
      emoji.style.setProperty('border-radius', '0', 'important');
      emoji.style.setProperty('transform', 'none', 'important');
      emoji.style.setProperty('vertical-align', '-4px', 'important');
      emoji.style.setProperty('overflow', 'hidden', 'important');

      const parent = emoji.parentElement;

      if (parent && parent.style) {
        parent.style.setProperty('width', 'auto', 'important');
        parent.style.setProperty('min-width', '0', 'important');
        parent.style.setProperty('max-width', 'none', 'important');
        parent.style.setProperty('height', '20px', 'important');
        parent.style.setProperty('min-height', '20px', 'important');
        parent.style.setProperty('max-height', '20px', 'important');
        parent.style.setProperty('overflow', 'visible', 'important');
        parent.style.setProperty('line-height', '20px', 'important');
      }
    }
  }
}

function samStartAllChatListEmojiSizeFix() {
  if (window.__samAllChatListEmojiSizeFixStarted) {
    return;
  }

  window.__samAllChatListEmojiSizeFixStarted = true;

  const run = () => {
    try {
      samFixAllChatListEmojiSizesOnce();
    } catch (_error) {
      // ignore
    }
  };

  run();
  setTimeout(run, 300);
  setTimeout(run, 1000);
  setTimeout(run, 2500);

  if (document.body) {
    let timer = null;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(run, 100);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'data-testid', 'title', 'alt']
    });
  }

  setInterval(run, 2000);
}

if (!window.__samAllChatListEmojiSizeFixScheduled) {
  window.__samAllChatListEmojiSizeFixScheduled = true;

  setTimeout(samStartAllChatListEmojiSizeFix, 0);
  setTimeout(samStartAllChatListEmojiSizeFix, 800);
  setTimeout(samStartAllChatListEmojiSizeFix, 2000);
}

// ===== SAM drawer middle border fix =====
// Прибирає вертикальну риску WhatsApp між лівим drawer і правою областю.
// Реальна причина: data-testid="drawer-middle" має border-left: 1px solid rgba(255,255,255,0.1).

function samEnsureDrawerMiddleBorderFixStyle() {
  if (document.getElementById('samDrawerMiddleBorderFixStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samDrawerMiddleBorderFixStyle';
  style.textContent = `
    [data-testid="drawer-middle"],
    [data-testid="drawer-left"],
    [data-testid="drawer-fullscreen"] {
      border-left: 0 !important;
      border-right: 0 !important;
      box-shadow: none !important;
      outline: 0 !important;
    }

    [data-testid="drawer-middle"]::before,
    [data-testid="drawer-middle"]::after,
    [data-testid="drawer-left"]::before,
    [data-testid="drawer-left"]::after,
    [data-testid="drawer-fullscreen"]::before,
    [data-testid="drawer-fullscreen"]::after {
      content: none !important;
      display: none !important;
      border: 0 !important;
      box-shadow: none !important;
      background: transparent !important;
    }
  `;

  document.documentElement.appendChild(style);
}

function samFixDrawerMiddleBorderOnce() {
  samEnsureDrawerMiddleBorderFixStyle();

  const nodes = document.querySelectorAll(
    '[data-testid="drawer-middle"], ' +
    '[data-testid="drawer-left"], ' +
    '[data-testid="drawer-fullscreen"]'
  );

  for (const node of nodes) {
    if (!node || !node.style) {
      continue;
    }

    node.style.setProperty('border-left', '0', 'important');
    node.style.setProperty('border-right', '0', 'important');
    node.style.setProperty('box-shadow', 'none', 'important');
    node.style.setProperty('outline', '0', 'important');
  }
}

function samStartDrawerMiddleBorderFix() {
  if (window.__samDrawerMiddleBorderFixStarted) {
    return;
  }

  window.__samDrawerMiddleBorderFixStarted = true;

  const run = () => {
    try {
      samFixDrawerMiddleBorderOnce();
    } catch (_error) {
      // ignore
    }
  };

  run();
  setTimeout(run, 300);
  setTimeout(run, 1000);
  setTimeout(run, 2500);

  window.addEventListener('resize', run);
  window.addEventListener('focus', run);

  if (document.body) {
    let timer = null;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(run, 120);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'data-testid']
    });
  }

  setInterval(run, 2000);
}

if (!window.__samDrawerMiddleBorderFixScheduled) {
  window.__samDrawerMiddleBorderFixScheduled = true;

  setTimeout(samStartDrawerMiddleBorderFix, 0);
  setTimeout(samStartDrawerMiddleBorderFix, 800);
  setTimeout(samStartDrawerMiddleBorderFix, 2000);
}

// ===== SAM mini notes panel step 1 =====
// Кнопка SAM 📝 під кнопкою локальних закріплених чатів.
// Перший етап: панель, ручне додавання нотаток, копіювання, видалення.
// Збереження поки що в localStorage; інтеграцію з повідомленнями додамо окремо.

const SAM_NOTES_STORAGE_KEY = 'samMiniNotesV1';
const SAM_NOTES_PANEL_COLLAPSED_KEY = 'samMiniNotesPanelCollapsedV1';

const SAM_NOTES_TRIGGER_LEFT = 5;
const SAM_NOTES_TRIGGER_TOP = 235;

function samNotesLoad() {
  try {
    const raw = localStorage.getItem(SAM_NOTES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];

    if (Array.isArray(parsed)) {
      return parsed.filter((item) => item && typeof item.text === 'string');
    }
  } catch (_error) {
    // ignore
  }

  return [];
}

function samNotesSave(notes) {
  try {
    localStorage.setItem(SAM_NOTES_STORAGE_KEY, JSON.stringify(Array.isArray(notes) ? notes : []));
  } catch (_error) {
    // ignore
  }
}

function samNotesIsPanelOpen() {
  return localStorage.getItem(SAM_NOTES_PANEL_COLLAPSED_KEY) === '0';
}

function samNotesSetPanelOpen(open) {
  try {
    localStorage.setItem(SAM_NOTES_PANEL_COLLAPSED_KEY, open ? '0' : '1');
  } catch (_error) {
    // ignore
  }
}

function samNotesFormatDate(iso) {
  try {
    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) {
      return '';
    }

    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');

    return `${dd}.${mm} ${hh}:${mi}`;
  } catch (_error) {
    return '';
  }
}

function samNotesCopyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(text || ''));
      return;
    }
  } catch (_error) {
    // fallback below
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = String(text || '');
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  } catch (_error) {
    // ignore
  }
}

function samNotesEnsureStyle() {
  if (document.getElementById('samMiniNotesStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samMiniNotesStyle';
  style.textContent = `
    #samMiniNotesTrigger {
      position: fixed !important;
      left: ${SAM_NOTES_TRIGGER_LEFT}px !important;
      top: ${SAM_NOTES_TRIGGER_TOP}px !important;
      width: 52px !important;
      height: 42px !important;
      z-index: 2147483646 !important;
      border: 1px solid rgba(255, 255, 255, 0.18) !important;
      border-radius: 10px !important;
      background: rgba(32, 35, 35, 0.96) !important;
      color: #fafafa !important;
      font-family: "Segoe UI", Arial, sans-serif !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      line-height: 15px !important;
      cursor: pointer !important;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35) !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      flex-direction: column !important;
      user-select: none !important;
      white-space: pre-line !important;
    }

    #samMiniNotesTrigger:hover {
      background: rgba(44, 48, 48, 0.98) !important;
      border-color: rgba(255, 255, 255, 0.32) !important;
    }

    #samMiniNotesPanel {
      position: fixed !important;
      left: 74px !important;
      top: 230px !important;
      width: 370px !important;
      max-height: 70vh !important;
      z-index: 2147483645 !important;
      background: rgba(22, 23, 23, 0.98) !important;
      color: #f5f5f5 !important;
      border: 1px solid rgba(255, 255, 255, 0.16) !important;
      border-radius: 12px !important;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.48) !important;
      font-family: "Segoe UI", Arial, sans-serif !important;
      overflow: hidden !important;
    }

    #samMiniNotesPanel.sam-hidden {
      display: none !important;
    }

    .sam-notes-header {
      height: 38px !important;
      padding: 0 10px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      background: rgba(32, 35, 35, 0.98) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.10) !important;
      box-sizing: border-box !important;
      font-size: 13px !important;
      font-weight: 700 !important;
    }

    .sam-notes-close {
      width: 26px !important;
      height: 26px !important;
      border: 0 !important;
      border-radius: 7px !important;
      background: transparent !important;
      color: #f5f5f5 !important;
      cursor: pointer !important;
      font-size: 18px !important;
      line-height: 22px !important;
    }

    .sam-notes-close:hover {
      background: rgba(255, 255, 255, 0.10) !important;
    }

    .sam-notes-body {
      padding: 10px !important;
      box-sizing: border-box !important;
    }

    #samMiniNotesInput {
      width: 100% !important;
      height: 88px !important;
      resize: vertical !important;
      min-height: 70px !important;
      max-height: 180px !important;
      box-sizing: border-box !important;
      border: 1px solid rgba(255, 255, 255, 0.16) !important;
      border-radius: 8px !important;
      background: rgba(12, 13, 13, 0.96) !important;
      color: #f5f5f5 !important;
      padding: 8px !important;
      font-family: "Segoe UI", Arial, sans-serif !important;
      font-size: 13px !important;
      line-height: 18px !important;
      outline: none !important;
    }

    #samMiniNotesInput:focus {
      border-color: rgba(37, 211, 102, 0.75) !important;
    }

    .sam-notes-actions {
      display: flex !important;
      gap: 8px !important;
      margin-top: 8px !important;
    }

    .sam-notes-button {
      border: 1px solid rgba(255, 255, 255, 0.14) !important;
      border-radius: 8px !important;
      background: rgba(37, 211, 102, 0.18) !important;
      color: #f5f5f5 !important;
      cursor: pointer !important;
      padding: 6px 9px !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      line-height: 16px !important;
    }

    .sam-notes-button:hover {
      background: rgba(37, 211, 102, 0.28) !important;
    }

    .sam-notes-button.secondary {
      background: rgba(255, 255, 255, 0.06) !important;
    }

    .sam-notes-button.secondary:hover {
      background: rgba(255, 255, 255, 0.12) !important;
    }

    #samMiniNotesList {
      margin-top: 10px !important;
      max-height: calc(70vh - 190px) !important;
      overflow-y: auto !important;
      padding-right: 3px !important;
    }

    .sam-note-item {
      border: 1px solid rgba(255, 255, 255, 0.10) !important;
      border-radius: 9px !important;
      background: rgba(255, 255, 255, 0.045) !important;
      padding: 8px !important;
      margin-bottom: 8px !important;
      box-sizing: border-box !important;
    }

    .sam-note-meta {
      color: rgba(245, 245, 245, 0.62) !important;
      font-size: 11px !important;
      line-height: 14px !important;
      margin-bottom: 5px !important;
    }

    .sam-note-text {
      white-space: pre-wrap !important;
      word-break: break-word !important;
      color: #f5f5f5 !important;
      font-size: 12px !important;
      line-height: 17px !important;
      max-height: 110px !important;
      overflow: auto !important;
    }

    .sam-note-controls {
      display: flex !important;
      gap: 6px !important;
      margin-top: 7px !important;
    }

    .sam-note-small-button {
      border: 0 !important;
      border-radius: 7px !important;
      background: rgba(255, 255, 255, 0.08) !important;
      color: #f5f5f5 !important;
      cursor: pointer !important;
      padding: 4px 7px !important;
      font-size: 11px !important;
      line-height: 14px !important;
    }

    .sam-note-small-button:hover {
      background: rgba(255, 255, 255, 0.16) !important;
    }

    .sam-note-small-button.delete:hover {
      background: rgba(220, 53, 69, 0.40) !important;
    }

    .sam-notes-empty {
      color: rgba(245, 245, 245, 0.52) !important;
      font-size: 12px !important;
      line-height: 18px !important;
      padding: 12px 4px !important;
      text-align: center !important;
    }
  `;

  document.documentElement.appendChild(style);
}

function samNotesRenderList() {
  const list = document.getElementById('samMiniNotesList');

  if (!list) {
    return;
  }

  const notes = samNotesLoad();

  list.innerHTML = '';

  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 'sam-notes-empty';
    empty.textContent = 'Нотаток ще немає';
    list.appendChild(empty);
    return;
  }

  notes
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .forEach((note) => {
      const item = document.createElement('div');
      item.className = 'sam-note-item';

      const meta = document.createElement('div');
      meta.className = 'sam-note-meta';
      meta.textContent = samNotesFormatDate(note.createdAt) || 'Без дати';

      const text = document.createElement('div');
      text.className = 'sam-note-text';
      text.textContent = note.text || '';

      const controls = document.createElement('div');
      controls.className = 'sam-note-controls';

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'sam-note-small-button';
      copy.textContent = 'Копіювати';
      copy.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        samNotesCopyText(note.text || '');
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sam-note-small-button delete';
      del.textContent = 'Видалити';
      del.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const next = samNotesLoad().filter((item) => item.id !== note.id);
        samNotesSave(next);
        samNotesRenderList();
      });

      controls.appendChild(copy);
      controls.appendChild(del);

      item.appendChild(meta);
      item.appendChild(text);
      item.appendChild(controls);

      list.appendChild(item);
    });
}

function samNotesAddManualNote() {
  const input = document.getElementById('samMiniNotesInput');

  if (!input) {
    return;
  }

  const text = String(input.value || '').trim();

  if (!text) {
    input.focus();
    return;
  }

  const notes = samNotesLoad();

  notes.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    source: 'manual',
    text
  });

  samNotesSave(notes);
  input.value = '';
  samNotesRenderList();
  input.focus();
}

function samNotesTogglePanel() {
  const panel = document.getElementById('samMiniNotesPanel');

  if (!panel) {
    return;
  }

  const open = panel.classList.contains('sam-hidden');

  panel.classList.toggle('sam-hidden', !open);
  samNotesSetPanelOpen(open);

  if (open) {
    samNotesRenderList();

    const input = document.getElementById('samMiniNotesInput');
    if (input) {
      setTimeout(() => input.focus(), 50);
    }
  }
}

function samNotesEnsurePanel() {
  samNotesEnsureStyle();

  if (!document.body) {
    setTimeout(samNotesEnsurePanel, 500);
    return;
  }

  let trigger = document.getElementById('samMiniNotesTrigger');

  if (!trigger) {
    trigger = document.createElement('button');
    trigger.id = 'samMiniNotesTrigger';
    trigger.type = 'button';
    trigger.title = 'SAM-блокнот';
    trigger.textContent = 'SAM\n📝';

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      samNotesTogglePanel();
    });

    document.body.appendChild(trigger);
  }

  let panel = document.getElementById('samMiniNotesPanel');

  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'samMiniNotesPanel';
    panel.className = samNotesIsPanelOpen() ? '' : 'sam-hidden';

    const header = document.createElement('div');
    header.className = 'sam-notes-header';

    const title = document.createElement('div');
    title.textContent = 'SAM-блокнот';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sam-notes-close';
    close.textContent = '×';
    close.title = 'Закрити';

    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      panel.classList.add('sam-hidden');
      samNotesSetPanelOpen(false);
    });

    header.appendChild(title);
    header.appendChild(close);

    const body = document.createElement('div');
    body.className = 'sam-notes-body';

    const input = document.createElement('textarea');
    input.id = 'samMiniNotesInput';
    input.placeholder = 'Введи нотатку або встав текст повідомлення...';

    const actions = document.createElement('div');
    actions.className = 'sam-notes-actions';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'sam-notes-button';
    save.textContent = 'Зберегти';

    save.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      samNotesAddManualNote();
    });

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'sam-notes-button secondary';
    clear.textContent = 'Очистити';

    clear.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      input.focus();
    });

    actions.appendChild(save);
    actions.appendChild(clear);

    const list = document.createElement('div');
    list.id = 'samMiniNotesList';

    body.appendChild(input);
    body.appendChild(actions);
    body.appendChild(list);

    panel.appendChild(header);
    panel.appendChild(body);

    document.body.appendChild(panel);
  }

  samNotesRenderList();
}

function samStartMiniNotesPanel() {
  if (window.__samMiniNotesPanelStarted) {
    return;
  }

  window.__samMiniNotesPanelStarted = true;

  samNotesEnsurePanel();

  setTimeout(samNotesEnsurePanel, 800);
  setTimeout(samNotesEnsurePanel, 2000);
  setInterval(samNotesEnsurePanel, 2000);
}

if (!window.__samMiniNotesPanelScheduled) {
  window.__samMiniNotesPanelScheduled = true;

  setTimeout(samStartMiniNotesPanel, 0);
  setTimeout(samStartMiniNotesPanel, 800);
  setTimeout(samStartMiniNotesPanel, 2000);
}

// ===== SAM save message to mini notes =====
// Додає пункт меню повідомлення: "SAM: зберегти в блокнот".

function samNotesGetCurrentChatTitleSafe() {
  try {
    if (typeof samPinsGetCurrentChatTitle === 'function') {
      const title = samPinsGetCurrentChatTitle();

      if (title) {
        return String(title).trim();
      }
    }
  } catch (_error) {
    // ignore
  }

  try {
    const header = document.querySelector('header');
    const spans = header ? Array.from(header.querySelectorAll('span[title], span[dir="auto"]')) : [];

    for (const span of spans) {
      const value = String(span.getAttribute('title') || span.textContent || '').trim();

      if (value && value.length >= 2 && value.length <= 120) {
        return value;
      }
    }
  } catch (_error) {
    // ignore
  }

  return '';
}

function samNotesAddMessageNote(messageData) {
  if (!messageData || !messageData.text) {
    return false;
  }

  const text = String(messageData.text || '').trim();

  if (!text) {
    return false;
  }

  const chatTitle = samNotesGetCurrentChatTitleSafe();
  const notes = samNotesLoad();

  notes.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    source: 'message',
    chatTitle,
    title: chatTitle || 'WhatsApp',
    text
  });

  samNotesSave(notes);

  try {
    samNotesRenderList();
  } catch (_error) {
    // ignore
  }

  return true;
}


function samNotesIsVisibleCopyableElement(element) {
  if (!element || !element.getBoundingClientRect) {
    return false;
  }

  const rect = element.getBoundingClientRect();

  if (
    rect.width < 20 ||
    rect.height < 10 ||
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= window.innerWidth ||
    rect.top >= window.innerHeight
  ) {
    return false;
  }

  const style = window.getComputedStyle(element);

  return !(
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    Number(style.opacity || '1') === 0
  );
}

function samNotesChooseCopyableByPoint(copyables, point) {
  const list = Array.from(copyables || []).filter(samNotesIsVisibleCopyableElement);

  if (!list.length) {
    return null;
  }

  if (list.length === 1) {
    return list[0];
  }

  const scored = list.map((element) => {
    const rect = element.getBoundingClientRect();

    const x = point && Number.isFinite(point.x) ? point.x : rect.left + rect.width / 2;
    const y = point && Number.isFinite(point.y) ? point.y : rect.top + rect.height / 2;

    const contains =
      x >= rect.left - 8 &&
      x <= rect.right + 8 &&
      y >= rect.top - 8 &&
      y <= rect.bottom + 8;

    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const distance = Math.sqrt(dx * dx + dy * dy);

    return {
      element,
      contains,
      distance,
      area: rect.width * rect.height
    };
  });

  scored.sort((a, b) => {
    if (a.contains !== b.contains) {
      return a.contains ? -1 : 1;
    }

    if (a.distance !== b.distance) {
      return a.distance - b.distance;
    }

    return a.area - b.area;
  });

  return scored[0] ? scored[0].element : null;
}

function samNotesFindCopyableFromTarget(target, point) {
  let element = target && target.nodeType === Node.TEXT_NODE ? target.parentElement : target;

  if (!element || !element.closest) {
    return null;
  }

  const direct = element.closest('[data-pre-plain-text]');

  if (direct && samNotesIsVisibleCopyableElement(direct)) {
    return direct;
  }

  let current = element;

  for (let i = 0; i < 10 && current && current !== document.body && current !== document.documentElement; i += 1) {
    if (current.querySelectorAll) {
      const copyables = Array.from(current.querySelectorAll('[data-pre-plain-text]'))
        .filter(samNotesIsVisibleCopyableElement);

      if (copyables.length === 1) {
        return copyables[0];
      }

      if (copyables.length > 1) {
        return samNotesChooseCopyableByPoint(copyables, point);
      }
    }

    current = current.parentElement;
  }

  return null;
}

function samNotesRememberContextTarget(event) {
  if (!event) {
    return;
  }

  const point = {
    x: event.clientX,
    y: event.clientY,
    time: Date.now()
  };

  window.__samNotesLastContextPoint = point;

  const copyable = samNotesFindCopyableFromTarget(event.target, point);

  if (copyable) {
    window.__samNotesLastContextCopyable = copyable;
  }
}

function samNotesGetCopyablesFromRoot(root) {
  const result = [];

  if (!root || !document.documentElement.contains(root)) {
    return result;
  }

  if (root.matches && root.matches('[data-pre-plain-text]')) {
    result.push(root);
  }

  if (root.querySelectorAll) {
    result.push(...Array.from(root.querySelectorAll('[data-pre-plain-text]')));
  }

  return Array.from(new Set(result)).filter(samNotesIsVisibleCopyableElement);
}

function samNotesGetSingleCopyableForCurrentContext(root) {
  const remembered = window.__samNotesLastContextCopyable;

  if (
    remembered &&
    document.documentElement.contains(remembered) &&
    samNotesIsVisibleCopyableElement(remembered)
  ) {
    return remembered;
  }

  const copyables = samNotesGetCopyablesFromRoot(root);

  if (copyables.length === 1) {
    return copyables[0];
  }

  if (copyables.length > 1) {
    return samNotesChooseCopyableByPoint(copyables, window.__samNotesLastContextPoint || null);
  }

  return null;
}

function samNotesNormalizeSavedMessageText(text) {
  return String(text || '')
    .replace(/\u200e/g, '')
    .replace(/\u200f/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function samNotesBuildMessageDataFromCopyable(copyable) {
  if (!copyable) {
    return null;
  }

  let text = '';

  try {
    if (typeof samElementTextForClipboard === 'function') {
      text = samElementTextForClipboard(copyable);
    }
  } catch (_error) {
    text = '';
  }

  if (!text) {
    try {
      text = copyable.innerText || copyable.textContent || '';
    } catch (_error) {
      text = '';
    }
  }

  text = samNotesNormalizeSavedMessageText(text);

  if (!text) {
    return null;
  }

  return {
    text
  };
}

function samNotesSaveContextMessageToNotes() {
  let root = null;

  try {
    root =
      state.lastContextMessageRoot ||
      state.lastClickedMessageRoot ||
      state.lastHoveredMessageRoot ||
      null;
  } catch (_error) {
    root = null;
  }

  const copyable = samNotesGetSingleCopyableForCurrentContext(root);

  if (copyable) {
    return samNotesAddMessageNote(samNotesBuildMessageDataFromCopyable(copyable));
  }

  if (!root || !document.documentElement.contains(root)) {
    return false;
  }

  /*
    Захист від помилки: якщо root містить кілька повідомлень,
    не зберігаємо його цілком, щоб не додавати пів чату в одну нотатку.
  */
  try {
    const nestedCopyables = root.querySelectorAll ? root.querySelectorAll('[data-pre-plain-text]') : [];
    const rect = root.getBoundingClientRect ? root.getBoundingClientRect() : null;

    if (nestedCopyables.length > 1 || (rect && rect.height > 260)) {
      return false;
    }
  } catch (_error) {
    return false;
  }

  let messageData = null;

  try {
    if (typeof extractMessageData === 'function') {
      messageData = extractMessageData(root);
    }
  } catch (_error) {
    messageData = null;
  }

  if (!messageData || !messageData.text) {
    try {
      messageData = {
        text: samNotesNormalizeSavedMessageText(root.innerText || root.textContent || '')
      };
    } catch (_error) {
      messageData = null;
    }
  }

  return samNotesAddMessageNote(messageData);
}


function samNotesVisibleRect(element) {
  if (!element || !element.getBoundingClientRect) {
    return null;
  }

  const rect = element.getBoundingClientRect();

  if (
    rect.width < 120 ||
    rect.height < 30 ||
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= window.innerWidth ||
    rect.top >= window.innerHeight
  ) {
    return null;
  }

  const style = window.getComputedStyle(element);

  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    Number(style.opacity || '1') === 0
  ) {
    return null;
  }

  return rect;
}

function samNotesLooksLikeOpenMessageMenu(element) {
  const rect = samNotesVisibleRect(element);

  if (!rect) {
    return false;
  }

  if (rect.width > 520 || rect.height > 700) {
    return false;
  }

  const text = String(element.textContent || '');

  if (text.includes('SAM: зберегти в блокнот')) {
    return true;
  }

  if (text.includes('SAM: додати до копіювання')) {
    return true;
  }

  if (text.includes('SAM: копіювати вибрані')) {
    return true;
  }

  const menuWords = [
    'Відповісти',
    'Переслати',
    'Копіювати',
    'Видалити',
    'Інформація',
    'Reply',
    'Forward',
    'Copy',
    'Delete',
    'Info'
  ];

  return menuWords.some((word) => text.includes(word));
}

function samNotesFindOpenMessageMenu() {
  let hasContextMessage = false;

  try {
    hasContextMessage = !!(
      state.lastContextMessageRoot ||
      state.lastClickedMessageRoot ||
      state.lastHoveredMessageRoot
    );
  } catch (_error) {
    hasContextMessage = false;
  }

  if (!hasContextMessage) {
    return null;
  }

  const candidates = Array.from(document.querySelectorAll(
    '[role="menu"], ' +
    '[role="application"], ' +
    '[data-animate-dropdown-menu="true"], ' +
    'div'
  ));

  const menus = candidates
    .filter(samNotesLooksLikeOpenMessageMenu)
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();

      const az = Number(window.getComputedStyle(a).zIndex || '0') || 0;
      const bz = Number(window.getComputedStyle(b).zIndex || '0') || 0;

      if (az !== bz) {
        return bz - az;
      }

      return (ar.width * ar.height) - (br.width * br.height);
    });

  return menus[0] || null;
}

function samNotesCreateSaveMenuItem() {
  const item = document.createElement('div');
  item.className = 'sam-notes-save-menu-item';
  item.setAttribute('role', 'button');
  item.setAttribute('tabindex', '0');
  item.textContent = 'SAM: зберегти в блокнот';

  item.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    const ok = samNotesSaveContextMessageToNotes();

    if (!ok) {
      try {
        if (typeof showToast === 'function') {
          showToast('Не вдалося зберегти повідомлення');
        }
      } catch (_error) {
        // ignore
      }
    }

    const menu = item.closest('[role="menu"], [role="application"]');

    if (menu) {
      try {
        menu.remove();
      } catch (_error) {
        // ignore
      }
    }
  });

  return item;
}

function samNotesEnsureSaveMenuStyle() {
  if (document.getElementById('samNotesSaveMenuStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samNotesSaveMenuStyle';
  style.textContent = `
    .sam-notes-save-menu-item {
      min-height: 36px !important;
      padding: 9px 18px !important;
      box-sizing: border-box !important;
      cursor: pointer !important;
      color: #e9edef !important;
      background: rgba(37, 211, 102, 0.12) !important;
      font-family: "Segoe UI", Arial, sans-serif !important;
      font-size: 14px !important;
      line-height: 18px !important;
      white-space: nowrap !important;
      user-select: none !important;
    }

    .sam-notes-save-menu-item:hover {
      background: rgba(37, 211, 102, 0.24) !important;
    }
  `;

  document.documentElement.appendChild(style);
}

function samNotesPatchOpenMessageMenuOnce() {
  samNotesEnsureSaveMenuStyle();

  const menu = samNotesFindOpenMessageMenu();

  if (!menu) {
    return;
  }

  if (menu.querySelector('.sam-notes-save-menu-item')) {
    return;
  }

  const item = samNotesCreateSaveMenuItem();
  menu.appendChild(item);
}

function samStartNotesMessageMenuPatch() {
  if (window.__samNotesMessageMenuPatchStarted) {
    return;
  }

  window.__samNotesMessageMenuPatchStarted = true;

  const run = () => {
    try {
      samNotesPatchOpenMessageMenuOnce();
    } catch (_error) {
      // ignore
    }
  };

  document.addEventListener('contextmenu', (event) => {
    samNotesRememberContextTarget(event);
    setTimeout(run, 80);
    setTimeout(run, 250);
    setTimeout(run, 600);
  }, true);

  document.addEventListener('pointerdown', (event) => {
    samNotesRememberContextTarget(event);
  }, true);

  document.addEventListener('click', (event) => {
    samNotesRememberContextTarget(event);
    setTimeout(run, 80);
    setTimeout(run, 250);
  }, true);

  if (document.body) {
    let timer = null;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(run, 80);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  setInterval(run, 1200);
}

if (!window.__samNotesMessageMenuPatchScheduled) {
  window.__samNotesMessageMenuPatchScheduled = true;

  setTimeout(samStartNotesMessageMenuPatch, 0);
  setTimeout(samStartNotesMessageMenuPatch, 800);
  setTimeout(samStartNotesMessageMenuPatch, 2000);
}

// ===== SAM save selected messages to mini notes =====
// Додає кнопку "Зберегти в блокнот" у нижню панель вибору кількох повідомлень.

function samNotesGetSelectedMessagesText() {
  let items = [];

  try {
    if (!state || !state.selected || typeof state.selected.values !== 'function') {
      return '';
    }

    items = Array.from(state.selected.values());
  } catch (_error) {
    return '';
  }

  if (!items.length) {
    return '';
  }

  const chunks = [];

  for (const item of items) {
    let text = '';

    try {
      if (item && item.text) {
        text = String(item.text || '').trim();
      }
    } catch (_error) {
      text = '';
    }

    if (!text && item && item.element) {
      try {
        const copyable =
          item.element.matches && item.element.matches('[data-pre-plain-text]')
            ? item.element
            : item.element.querySelector
              ? item.element.querySelector('[data-pre-plain-text]')
              : null;

        if (copyable && typeof samElementTextForClipboard === 'function') {
          text = samElementTextForClipboard(copyable);
        } else {
          text = item.element.innerText || item.element.textContent || '';
        }
      } catch (_error) {
        text = '';
      }
    }

    text = String(text || '')
      .replace(/\u200e/g, '')
      .replace(/\u200f/g, '')
      .trim();

    if (text) {
      chunks.push(text);
    }
  }

  return chunks.join('\n\n').trim();
}

function samNotesSaveSelectedMessagesToNotes() {
  const text = samNotesGetSelectedMessagesText();

  if (!text) {
    try {
      if (typeof showToast === 'function') {
        showToast('Немає вибраних повідомлень');
      }
    } catch (_error) {
      // ignore
    }

    return false;
  }

  const chatTitle = samNotesGetCurrentChatTitleSafe();
  const notes = samNotesLoad();

  notes.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    source: 'selected-messages',
    chatTitle,
    title: chatTitle || 'WhatsApp',
    text
  });

  samNotesSave(notes);

  try {
    samNotesRenderList();
  } catch (_error) {
    // ignore
  }

  try {
    if (typeof showToast === 'function') {
      showToast('Вибрані повідомлення збережено в SAM-блокнот');
    }
  } catch (_error) {
    // ignore
  }

  try {
    if (typeof samClearSelectedMessagesAfterSamAction === 'function') {
      samClearSelectedMessagesAfterSamAction(180);
    }
  } catch (_error) {
    // ignore
  }

  return true;
}

function samNotesEnsureSelectionBarButtonStyle() {
  if (document.getElementById('samNotesSelectionBarButtonStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samNotesSelectionBarButtonStyle';
  style.textContent = `
    .sam-notes-selection-save-button {
      border: 1px solid rgba(255, 255, 255, 0.16) !important;
      border-radius: 8px !important;
      background: rgba(37, 211, 102, 0.20) !important;
      color: #f5f5f5 !important;
      cursor: pointer !important;
      padding: 7px 10px !important;
      font-family: "Segoe UI", Arial, sans-serif !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      line-height: 16px !important;
      white-space: nowrap !important;
      user-select: none !important;
      margin-left: 8px !important;
    }

    .sam-notes-selection-save-button:hover {
      background: rgba(37, 211, 102, 0.32) !important;
    }
  `;

  document.documentElement.appendChild(style);
}

function samNotesEnsureSelectionBarButton() {
  samNotesEnsureSelectionBarButtonStyle();

  let bar = null;

  try {
    bar = state && state.bar ? state.bar : null;
  } catch (_error) {
    bar = null;
  }

  if (!bar || !document.documentElement.contains(bar)) {
    return;
  }

  if (bar.querySelector('.sam-notes-selection-save-button')) {
    return;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sam-notes-selection-save-button';
  button.textContent = 'Зберегти в блокнот';
  button.title = 'Зберегти вибрані повідомлення в SAM-блокнот';

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    samNotesSaveSelectedMessagesToNotes();
  });

  bar.appendChild(button);
}

function samStartNotesSelectionBarButton() {
  if (window.__samNotesSelectionBarButtonStarted) {
    return;
  }

  window.__samNotesSelectionBarButtonStarted = true;

  const run = () => {
    try {
      samNotesEnsureSelectionBarButton();
    } catch (_error) {
      // ignore
    }
  };

  run();
  setTimeout(run, 300);
  setTimeout(run, 1000);
  setInterval(run, 1000);

  if (document.body) {
    let timer = null;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(run, 80);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
}

if (!window.__samNotesSelectionBarButtonScheduled) {
  window.__samNotesSelectionBarButtonScheduled = true;

  setTimeout(samStartNotesSelectionBarButton, 0);
  setTimeout(samStartNotesSelectionBarButton, 800);
  setTimeout(samStartNotesSelectionBarButton, 2000);
}

// ===== SAM auto clear selected messages after actions =====
// Після копіювання вибраних або збереження вибраних у блокнот автоматично знімає вибір.

function samClearSelectedMessagesAfterSamAction(delayMs = 250) {
  setTimeout(() => {
    try {
      if (typeof setSelectionMode === 'function') {
        setSelectionMode(false);
        return;
      }
    } catch (_error) {
      // fallback below
    }

    try {
      if (state && state.selected && typeof state.selected.values === 'function') {
        for (const item of state.selected.values()) {
          if (item && item.element && item.element.classList) {
            item.element.classList.remove('sam-wa-selected-message');
          }
        }

        state.selected.clear();
      }

      if (state && state.bar && state.bar.remove) {
        state.bar.remove();
        state.bar = null;
      }
    } catch (_error) {
      // ignore
    }
  }, delayMs);
}

function samStartAutoClearAfterCopySelected() {
  if (window.__samAutoClearAfterCopySelectedStarted) {
    return;
  }

  window.__samAutoClearAfterCopySelectedStarted = true;

  document.addEventListener('click', (event) => {
    try {
      const target = event.target && event.target.closest
        ? event.target.closest('button, [role="button"], [role="menuitem"], div')
        : null;

      if (!target) {
        return;
      }

      const text = String(target.textContent || '').replace(/\s+/g, ' ').trim();

      if (
        text.includes('SAM: копіювати вибрані') ||
        text === 'Копіювати вибрані' ||
        text.includes('Копіювати вибрані')
      ) {
        samClearSelectedMessagesAfterSamAction(700);
      }
    } catch (_error) {
      // ignore
    }
  }, true);
}

if (!window.__samAutoClearAfterCopySelectedScheduled) {
  window.__samAutoClearAfterCopySelectedScheduled = true;

  setTimeout(samStartAutoClearAfterCopySelected, 0);
  setTimeout(samStartAutoClearAfterCopySelected, 800);
  setTimeout(samStartAutoClearAfterCopySelected, 2000);
}

// ===== SAM mini notes features: search, clear, file storage, export, insert =====
// Доробки блокнота:
// 2. пошук;
// 3. очистити всі;
// 4. файл sam_notes.json через main IPC;
// 5. експорт .txt;
// 6. вставити нотатку в поточний чат.

function samNotesNormalizeNoteItem(note) {
  return {
    id: String(note && note.id ? note.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    createdAt: String(note && note.createdAt ? note.createdAt : new Date().toISOString()),
    source: String(note && note.source ? note.source : 'manual'),
    chatTitle: String(note && note.chatTitle ? note.chatTitle : ''),
    title: String(note && note.title ? note.title : note && note.chatTitle ? note.chatTitle : ''),
    text: String(note && note.text ? note.text : '')
  };
}

function samNotesNormalizeList(notes) {
  if (!Array.isArray(notes)) {
    return [];
  }

  return notes
    .filter((note) => note && typeof note.text === 'string')
    .map(samNotesNormalizeNoteItem);
}

function samNotesLoadFromLocalStorageBackup() {
  try {
    const raw = localStorage.getItem(SAM_NOTES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];

    return samNotesNormalizeList(parsed);
  } catch (_error) {
    return [];
  }
}

if (!Array.isArray(window.__samNotesCache)) {
  window.__samNotesCache = samNotesLoadFromLocalStorageBackup();
}

if (typeof window.__samNotesFileLoaded !== 'boolean') {
  window.__samNotesFileLoaded = false;
}

if (typeof window.__samNotesDirtyBeforeFileLoad !== 'boolean') {
  window.__samNotesDirtyBeforeFileLoad = false;
}

async function samNotesLoadFromFileOnce() {
  if (window.__samNotesFileLoaded || window.__samNotesFileLoading) {
    return;
  }

  window.__samNotesFileLoading = true;

  try {
    if (!ipcRenderer || !ipcRenderer.invoke) {
      return;
    }

    const fileNotes = samNotesNormalizeList(await ipcRenderer.invoke('notes:load'));
    const localNotes = samNotesLoadFromLocalStorageBackup();

    if (window.__samNotesDirtyBeforeFileLoad) {
      await ipcRenderer.invoke('notes:save', {
        notes: window.__samNotesCache
      });
    } else if (fileNotes.length > 0) {
      window.__samNotesCache = fileNotes;
    } else if (localNotes.length > 0) {
      window.__samNotesCache = localNotes;

      await ipcRenderer.invoke('notes:save', {
        notes: window.__samNotesCache
      });
    } else {
      window.__samNotesCache = [];
    }

    window.__samNotesFileLoaded = true;

    try {
      samNotesRenderList();
    } catch (_error) {
      // ignore
    }
  } catch (_error) {
    // localStorage fallback remains active
  } finally {
    window.__samNotesFileLoading = false;
  }
}

function samNotesLoad() {
  if (!Array.isArray(window.__samNotesCache)) {
    window.__samNotesCache = samNotesLoadFromLocalStorageBackup();
  }

  samNotesLoadFromFileOnce();

  return samNotesNormalizeList(window.__samNotesCache);
}

function samNotesSave(notes) {
  const normalized = samNotesNormalizeList(notes);
  window.__samNotesCache = normalized;

  try {
    localStorage.setItem(SAM_NOTES_STORAGE_KEY, JSON.stringify(normalized));
  } catch (_error) {
    // ignore
  }

  if (!window.__samNotesFileLoaded) {
    window.__samNotesDirtyBeforeFileLoad = true;
  }

  try {
    if (ipcRenderer && ipcRenderer.invoke) {
      ipcRenderer.invoke('notes:save', {
        notes: normalized
      }).catch(() => {});
    }
  } catch (_error) {
    // ignore
  }
}

function samNotesEnsureFeatureStyle() {
  if (document.getElementById('samMiniNotesFeatureStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'samMiniNotesFeatureStyle';
  style.textContent = `
    .sam-notes-extra-actions {
      display: flex !important;
      gap: 8px !important;
      margin-top: 8px !important;
    }

    .sam-notes-search-wrap {
      margin-top: 10px !important;
    }

    #samMiniNotesSearch {
      width: 100% !important;
      height: 32px !important;
      box-sizing: border-box !important;
      border: 1px solid rgba(255, 255, 255, 0.16) !important;
      border-radius: 8px !important;
      background: rgba(12, 13, 13, 0.96) !important;
      color: #f5f5f5 !important;
      padding: 6px 8px !important;
      font-family: "Segoe UI", Arial, sans-serif !important;
      font-size: 12px !important;
      line-height: 16px !important;
      outline: none !important;
    }

    #samMiniNotesSearch:focus {
      border-color: rgba(37, 211, 102, 0.75) !important;
    }

    .sam-note-meta-chat {
      color: rgba(37, 211, 102, 0.88) !important;
      font-weight: 700 !important;
    }

    .sam-note-small-button.insert {
      background: rgba(37, 211, 102, 0.15) !important;
    }

    .sam-note-small-button.insert:hover {
      background: rgba(37, 211, 102, 0.28) !important;
    }

    .sam-notes-button.danger {
      background: rgba(220, 53, 69, 0.20) !important;
    }

    .sam-notes-button.danger:hover {
      background: rgba(220, 53, 69, 0.36) !important;
    }
  `;

  document.documentElement.appendChild(style);
}

function samNotesEnsureExtraControls() {
  samNotesEnsureFeatureStyle();

  const list = document.getElementById('samMiniNotesList');
  const input = document.getElementById('samMiniNotesInput');

  if (!list || !input || !input.parentElement) {
    return;
  }

  const body = input.parentElement;
  const actions = body.querySelector('.sam-notes-actions');

  if (actions && !document.getElementById('samMiniNotesExtraActions')) {
    const extra = document.createElement('div');
    extra.id = 'samMiniNotesExtraActions';
    extra.className = 'sam-notes-extra-actions';

    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.className = 'sam-notes-button secondary';
    exportButton.textContent = 'Експорт .txt';
    exportButton.title = 'Експортувати всі нотатки у текстовий файл';

    exportButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      samNotesExportToTxt();
    });

    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'sam-notes-button danger';
    clearAll.textContent = 'Очистити всі';
    clearAll.title = 'Видалити всі нотатки';

    clearAll.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      samNotesClearAllNotes();
    });

    extra.appendChild(exportButton);
    extra.appendChild(clearAll);

    actions.insertAdjacentElement('afterend', extra);
  }

  if (!document.getElementById('samMiniNotesSearch')) {
    const wrap = document.createElement('div');
    wrap.className = 'sam-notes-search-wrap';

    const search = document.createElement('input');
    search.id = 'samMiniNotesSearch';
    search.type = 'search';
    search.placeholder = 'Пошук по нотатках...';

    search.addEventListener('input', () => {
      samNotesRenderList();
    });

    wrap.appendChild(search);
    body.insertBefore(wrap, list);
  }
}

function samNotesGetSearchQuery() {
  const search = document.getElementById('samMiniNotesSearch');

  return String(search && search.value ? search.value : '')
    .trim()
    .toLowerCase();
}

function samNotesMatchesSearch(note, query) {
  if (!query) {
    return true;
  }

  const haystack = [
    note.text || '',
    note.chatTitle || '',
    note.title || '',
    note.source || '',
    samNotesFormatDate(note.createdAt) || ''
  ].join(' ').toLowerCase();

  return haystack.includes(query);
}

function samNotesFindCurrentChatInput() {
  const selectors = [
    'footer [contenteditable="true"][role="textbox"]',
    'footer [contenteditable="true"][data-tab]',
    'footer div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"][data-tab]',
    'div[contenteditable="true"][role="textbox"]'
  ];

  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll(selector));

    for (const candidate of candidates) {
      try {
        const rect = candidate.getBoundingClientRect();
        const style = window.getComputedStyle(candidate);

        if (
          rect.width > 80 &&
          rect.height > 18 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        ) {
          return candidate;
        }
      } catch (_error) {
        // ignore
      }
    }
  }

  return null;
}


function samNotesPlaceCaretAtEnd(element) {
  try {
    element.focus();

    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    return true;
  } catch (_error) {
    return false;
  }
}

function samNotesInsertPlainTextIntoEditableDirect(element, text) {
  const value = String(text || '');

  if (!element || !value) {
    return false;
  }

  try {
    element.focus();

    const selection = window.getSelection();

    if (
      !selection ||
      !selection.rangeCount ||
      !element.contains(selection.anchorNode)
    ) {
      samNotesPlaceCaretAtEnd(element);
    }

    const ok = document.execCommand('insertText', false, value);

    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: value
    }));

    return ok;
  } catch (_error) {
    return false;
  }
}

function samNotesInsertTextIntoCurrentChat(text) {
  const value = String(text || '');

  if (!value.trim()) {
    return false;
  }

  const input = samNotesFindCurrentChatInput();

  if (!input) {
    try {
      if (typeof showToast === 'function') {
        showToast('Не знайдено поле введення чату');
      }
    } catch (_error) {
      // ignore
    }

    return false;
  }

  const ok = samNotesInsertPlainTextIntoEditableDirect(input, value);

  if (ok) {
    try {
      if (typeof showToast === 'function') {
        showToast('Нотатку вставлено в чат');
      }
    } catch (_error) {
      // ignore
    }
  } else {
    try {
      if (typeof showToast === 'function') {
        showToast('Не вдалося вставити нотатку в чат');
      }
    } catch (_error) {
      // ignore
    }
  }

  return ok;
}


async function samNotesExportToTxt() {
  const notes = samNotesLoad();

  try {
    if (!ipcRenderer || !ipcRenderer.invoke) {
      return;
    }

    const result = await ipcRenderer.invoke('notes:export', {
      notes
    });

    if (result && result.ok) {
      try {
        if (typeof showToast === 'function') {
          showToast('SAM-блокнот експортовано');
        }
      } catch (_error) {
        // ignore
      }
    }
  } catch (_error) {
    try {
      if (typeof showToast === 'function') {
        showToast('Не вдалося експортувати SAM-блокнот');
      }
    } catch (__error) {
      // ignore
    }
  }
}

function samNotesClearAllNotes() {
  const notes = samNotesLoad();

  if (!notes.length) {
    return;
  }

  const ok = window.confirm('Очистити всі нотатки SAM-блокнота?');

  if (!ok) {
    return;
  }

  samNotesSave([]);
  samNotesRenderList();
}

function samNotesRenderList() {
  samNotesEnsureExtraControls();

  const list = document.getElementById('samMiniNotesList');

  if (!list) {
    return;
  }

  const notes = samNotesLoad();
  const query = samNotesGetSearchQuery();

  const filtered = notes
    .filter((note) => samNotesMatchesSearch(note, query))
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  list.innerHTML = '';

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'sam-notes-empty';
    empty.textContent = query ? 'Нотаток не знайдено' : 'Нотаток ще немає';
    list.appendChild(empty);
    return;
  }

  filtered.forEach((note) => {
    const item = document.createElement('div');
    item.className = 'sam-note-item';

    const meta = document.createElement('div');
    meta.className = 'sam-note-meta';

    const dateText = samNotesFormatDate(note.createdAt) || 'Без дати';
    const chatText = String(note.chatTitle || note.title || '').trim();

    if (chatText) {
      const chat = document.createElement('span');
      chat.className = 'sam-note-meta-chat';
      chat.textContent = chatText;

      meta.appendChild(document.createTextNode(`${dateText} | `));
      meta.appendChild(chat);
    } else {
      meta.textContent = dateText;
    }

    const text = document.createElement('div');
    text.className = 'sam-note-text';
    text.textContent = note.text || '';

    const controls = document.createElement('div');
    controls.className = 'sam-note-controls';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'sam-note-small-button';
    copy.textContent = 'Копіювати';
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      samNotesCopyText(note.text || '');
    });

    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'sam-note-small-button insert';
    insert.textContent = 'Вставити в чат';
    insert.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      samNotesInsertTextIntoCurrentChat(note.text || '');
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sam-note-small-button delete';
    del.textContent = 'Видалити';
    del.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const next = samNotesLoad().filter((item) => item.id !== note.id);
      samNotesSave(next);
      samNotesRenderList();
    });

    controls.appendChild(copy);
    controls.appendChild(insert);
    controls.appendChild(del);

    item.appendChild(meta);
    item.appendChild(text);
    item.appendChild(controls);

    list.appendChild(item);
  });
}

function samStartNotesFileStorageAndFeatures() {
  if (window.__samNotesFileStorageAndFeaturesStarted) {
    return;
  }

  window.__samNotesFileStorageAndFeaturesStarted = true;

  setTimeout(samNotesLoadFromFileOnce, 0);
  setTimeout(samNotesLoadFromFileOnce, 500);
  setTimeout(samNotesLoadFromFileOnce, 1500);

  setTimeout(() => {
    try {
      samNotesEnsureExtraControls();
      samNotesRenderList();
    } catch (_error) {
      // ignore
    }
  }, 500);
}

if (!window.__samNotesFileStorageAndFeaturesScheduled) {
  window.__samNotesFileStorageAndFeaturesScheduled = true;

  setTimeout(samStartNotesFileStorageAndFeatures, 0);
  setTimeout(samStartNotesFileStorageAndFeatures, 800);
  setTimeout(samStartNotesFileStorageAndFeatures, 2000);
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

