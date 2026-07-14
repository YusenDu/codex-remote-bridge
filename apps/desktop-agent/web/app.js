const PREVIEW_QR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges" aria-hidden="true"><rect width="29" height="29" fill="#f7f8f7"/><path fill="#111314" d="M1 1h7v7H1zm2 2v3h3V3zM21 1h7v7h-7zm2 2v3h3V3zM1 21h7v7H1zm2 2v3h3v-3zM10 1h2v2h-2zm4 0h1v3h-1zm3 1h2v2h-2zm-7 4h1v3h-1zm3-1h2v2h-2zm4 1h3v1h-3zm-7 4h2v2h-2zm4-2h1v4h-1zm3 1h2v2h-2zm4 1h3v2h-3zm-18 1h2v2H3zm4-2h1v4H7zm2 5h3v2H9zm4-1h2v1h-2zm3 2h3v2h-3zm5-1h2v3h-2zm4 1h2v2h-2zM1 15h2v3H1zm4 0h2v2H5zm3 3h2v1H8zm3-1h2v3h-2zm4 2h2v2h-2zm3-1h2v2h-2zm3 1h3v1h-3zm5-1h2v3h-2zM10 22h2v2h-2zm3-3h1v5h-1zm3 3h2v2h-2zm4-1h2v3h-2zm3 2h2v2h-2zm3-1h2v2h-2zM9 26h3v2H9zm5-1h2v3h-2zm3 1h3v2h-3zm5-1h1v3h-1zm3 1h3v2h-3z"/></svg>`;

const previewState = {
  serverUrl: 'https://codex-bridge.120.48.173.147.sslip.io',
  webUrl: 'https://codex-bridge.120.48.173.147.sslip.io/',
  deviceId: 'desktop-a8f12c',
  deviceName: 'DESKTOP-8928I4F',
  autoStart: true,
  hasToken: true,
  connectionState: '服务器：已连接',
  updateStatus: {
    currentVersion: '0.1.90',
    latestVersion: '0.1.90',
    updateAvailable: false,
    releaseUrl: 'https://github.com/YusenDu/codex-remote-bridge/releases/tag/v0.1.90',
    publishedAt: '2026-07-14T00:00:00Z',
  },
};

const tauriInvoke = window.__TAURI__?.core?.invoke;
const elements = Object.fromEntries(
  [
    'access-view', 'settings-view', 'open-settings', 'back-to-access', 'status-line',
    'status-text', 'qr-code', 'access-url', 'copy-url', 'open-web', 'access-note',
    'access-error', 'form', 'serverUrl', 'webUrl', 'deviceId', 'deviceName', 'token',
    'autoStart', 'settings-error', 'save', 'cancel', 'window-minimize', 'window-maximize',
    'window-close', 'window-titlebar', 'app-version', 'update-current-version',
    'update-status', 'check-update', 'open-update',
  ].map((id) => [id, document.getElementById(id)]),
);

let currentAccess = null;
let currentUpdate = null;

document.addEventListener('contextmenu', (event) => event.preventDefault());

function previewAccessUrl() {
  const base = previewState.webUrl.replace(/[?#].*$/u, '').replace(/\/+$/u, '');
  return `${base}/#/device/${previewState.deviceId}`;
}

async function invoke(command, args) {
  if (tauriInvoke) return tauriInvoke(command, args);

  if (command === 'get_config') return { ...previewState };
  if (command === 'get_status') {
    return { connectionState: previewState.connectionState, desktopState: 'ready' };
  }
  if (command === 'get_mobile_access') {
    return {
      accessUrl: previewAccessUrl(),
      qrSvg: PREVIEW_QR,
      isPublic: true,
      configured: true,
      hasToken: true,
      deviceName: previewState.deviceName,
      connectionState: previewState.connectionState,
      desktopState: 'ready',
    };
  }
  if (command === 'get_app_version') return '0.1.90';
  if (command === 'check_for_update') return { ...previewState.updateStatus };
  if (command === 'open_update_release') return null;
  if (command === 'save_config') {
    Object.assign(previewState, args.input, { hasToken: true, connectionState: '服务器：已连接' });
    return null;
  }
  return null;
}

async function controlWindow(action) {
  const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!appWindow) return;
  if (action === 'minimize') await appWindow.minimize();
  if (action === 'maximize') await appWindow.toggleMaximize();
  if (action === 'close') await appWindow.close();
  if (action === 'drag') await appWindow.startDragging();
}

function showView(name) {
  const settings = name === 'settings';
  elements['access-view'].hidden = settings;
  elements['settings-view'].hidden = !settings;
  elements['open-settings'].hidden = settings;
}

function readiness(value) {
  if (!value.configured || !value.hasToken) {
    return { state: 'configuration-required', text: '需要完成连接设置' };
  }
  if (value.connectionState.includes('正在')) {
    return { state: 'connecting', text: '正在连接云端服务' };
  }
  if (!value.connectionState.includes('已连接')) {
    return { state: 'server-offline', text: '云端服务未连接' };
  }
  if (value.desktopState !== 'ready') {
    return { state: 'desktop-unavailable', text: '云端已连接，等待 Codex Desktop' };
  }
  return { state: 'ready', text: '已连接，可以访问' };
}

function renderAccess(value) {
  currentAccess = value;
  const status = readiness(value);
  elements['status-line'].dataset.state = status.state;
  elements['status-text'].textContent = status.text;
  elements['access-url'].textContent = value.accessUrl;
  elements['access-url'].title = value.accessUrl;
  elements['qr-code'].innerHTML = value.qrSvg;
  elements['copy-url'].disabled = !value.accessUrl;
  elements['open-web'].disabled = !value.configured || !value.accessUrl;
  elements['access-note'].textContent = value.isPublic
    ? '可通过任意网络访问'
    : '本机预览地址，手机访问需配置公网网页地址';
  elements['access-error'].textContent = '';
}

async function loadAccess() {
  try {
    renderAccess(await invoke('get_mobile_access'));
  } catch (reason) {
    elements['status-line'].dataset.state = 'configuration-required';
    elements['status-text'].textContent = '无法生成访问入口';
    elements['access-error'].textContent = String(reason);
  }
}

async function loadVersion() {
  const version = await invoke('get_app_version');
  elements['app-version'].textContent = `v${version}`;
  elements['update-current-version'].textContent = `v${version}`;
}

function renderUpdateStatus(value) {
  currentUpdate = value;
  elements['update-current-version'].textContent = `v${value.currentVersion}`;
  elements['update-status'].textContent = value.updateAvailable
    ? `发现新版本 v${value.latestVersion}`
    : '当前已是最新版本';
  elements['update-status'].dataset.state = value.updateAvailable ? 'available' : 'current';
  elements['open-update'].hidden = !value.updateAvailable;
}

async function checkForUpdates({ silent = false } = {}) {
  elements['check-update'].disabled = true;
  if (!silent) {
    elements['update-status'].textContent = '正在检查更新...';
    elements['update-status'].dataset.state = 'checking';
  }
  try {
    renderUpdateStatus(await invoke('check_for_update'));
  } catch (reason) {
    currentUpdate = null;
    elements['open-update'].hidden = true;
    elements['update-status'].dataset.state = 'error';
    elements['update-status'].textContent = `暂时无法检查更新：${String(reason)}`;
  } finally {
    elements['check-update'].disabled = false;
  }
}

async function openAvailableUpdate() {
  if (!currentUpdate?.updateAvailable || !currentUpdate.releaseUrl) return;
  await invoke('open_update_release', { releaseUrl: currentUpdate.releaseUrl });
}

async function loadSettings() {
  const value = await invoke('get_config');
  for (const key of ['serverUrl', 'webUrl', 'deviceId', 'deviceName']) {
    elements[key].value = value[key] || '';
  }
  elements.autoStart.checked = value.autoStart === true;
  elements.token.value = '';
}

async function refreshStatus() {
  if (!currentAccess) return;
  const status = await invoke('get_status');
  renderAccess({
    ...currentAccess,
    connectionState: status.connectionState,
    desktopState: status.desktopState,
  });
}

async function copyAccessUrl() {
  if (!currentAccess?.accessUrl) return;
  elements['copy-url'].textContent = '已复制';
  window.setTimeout(() => { elements['copy-url'].textContent = '复制'; }, 1200);
  try {
    await navigator.clipboard.writeText(currentAccess.accessUrl);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(elements['access-url']);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('copy');
    selection.removeAllRanges();
  }
}

elements['open-settings'].addEventListener('click', async () => {
  elements['settings-error'].textContent = '';
  try {
    await loadSettings();
    showView('settings');
  } catch (reason) {
    elements['access-error'].textContent = String(reason);
  }
});

elements['back-to-access'].addEventListener('click', () => showView('access'));
elements['copy-url'].addEventListener('click', copyAccessUrl);
elements['open-web'].addEventListener('click', () => invoke('open_mobile_access'));
elements['check-update'].addEventListener('click', () => checkForUpdates());
elements['open-update'].addEventListener('click', () => openAvailableUpdate());
elements.cancel.addEventListener('click', () => invoke('hide_settings'));
elements['window-minimize'].addEventListener('click', () => controlWindow('minimize'));
elements['window-maximize'].addEventListener('click', () => controlWindow('maximize'));
elements['window-close'].addEventListener('click', () => controlWindow('close'));
elements['window-titlebar'].addEventListener('mousedown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return;
  controlWindow('drag');
});
elements['window-titlebar'].addEventListener('dblclick', (event) => {
  if (event.target.closest('button')) return;
  controlWindow('maximize');
});

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['settings-error'].textContent = '';
  elements.save.disabled = true;
  try {
    const input = Object.fromEntries(
      ['serverUrl', 'webUrl', 'deviceId', 'deviceName'].map((key) => [key, elements[key].value.trim()]),
    );
    input.token = elements.token.value;
    input.autoStart = elements.autoStart.checked;
    await invoke('save_config', { input });
    elements.token.value = '';
    await loadAccess();
    showView('access');
  } catch (reason) {
    elements['settings-error'].textContent = String(reason);
  } finally {
    elements.save.disabled = false;
  }
});

loadVersion().catch(() => {});
checkForUpdates({ silent: true });
loadAccess();
window.setInterval(() => refreshStatus().catch(() => {}), 2000);
