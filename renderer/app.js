const screens = {
  welcome: document.getElementById('screen-welcome'),
  location: document.getElementById('screen-location'),
  progress: document.getElementById('screen-progress'),
  success: document.getElementById('screen-success'),
  failure: document.getElementById('screen-failure'),
};

function showScreen(name) {
  for (const key in screens) screens[key].hidden = key !== name;
}

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const state = {
  version: null,
  assetSize: 0,
  installDir: null,
  createShortcut: true,
  freeBytes: null,
  exePath: null,
  log: [],
};

// A packed zip generally unpacks to a few times its compressed size — this
// app's assets (three.js, occt-import-js wasm, etc.) aren't highly
// compressible, so 3x is a reasonable safety margin rather than an exact
// prediction of the real unpacked size.
const SPACE_SAFETY_MULTIPLIER = 3;

function appendLog(message) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  state.log.push({ time, message });
  const panel = document.getElementById('log-panel');
  const line = document.createElement('div');
  line.innerHTML = `<span class="log-line-time">[${time}]</span> ${message}`;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
}

// --- Welcome ---

async function initWelcome() {
  const res = await window.api.getLatestRelease();
  if (!res.ok) {
    document.getElementById('failure-error').textContent = res.error;
    showScreen('failure');
    return;
  }
  state.version = res.version;
  state.assetSize = res.assetSize;
  state.installDir = res.defaultInstallDir;
  document.getElementById('welcome-text').textContent =
    `This will install the RESYNC Client (${res.version}) on your computer. You'll be able to sync CAD files, images, and documents across your team's projects.`;
  const continueBtn = document.getElementById('welcome-continue-btn');
  continueBtn.removeAttribute('disabled');
}

document.getElementById('welcome-cancel-btn').addEventListener('click', () => window.api.cancel());
document.getElementById('welcome-continue-btn').addEventListener('click', () => {
  if (document.getElementById('welcome-continue-btn').hasAttribute('disabled')) return;
  showScreen('location');
  refreshLocationScreen();
});

// --- Choose location ---

async function refreshLocationScreen() {
  document.getElementById('location-path').textContent = state.installDir;
  document.getElementById('space-required').textContent = formatBytes(state.assetSize * SPACE_SAFETY_MULTIPLIER);
  const disk = await window.api.checkDiskSpace(state.installDir);
  const warningEl = document.getElementById('space-warning');
  const installBtn = document.getElementById('location-install-btn');
  if (disk.ok) {
    state.freeBytes = disk.freeBytes;
    document.getElementById('space-available').textContent = formatBytes(disk.freeBytes);
    const insufficient = disk.freeBytes < state.assetSize * SPACE_SAFETY_MULTIPLIER;
    warningEl.hidden = !insufficient;
    if (insufficient) installBtn.setAttribute('disabled', '');
    else installBtn.removeAttribute('disabled');
  } else {
    document.getElementById('space-available').textContent = '—';
    warningEl.hidden = true;
    installBtn.removeAttribute('disabled');
  }
}

document.getElementById('location-browse-btn').addEventListener('click', async () => {
  const res = await window.api.chooseLocation();
  if (!res.ok) return;
  state.installDir = res.path;
  refreshLocationScreen();
});

document.getElementById('location-back-btn').addEventListener('click', () => window.api.cancel());

document.getElementById('location-install-btn').addEventListener('click', () => {
  if (document.getElementById('location-install-btn').hasAttribute('disabled')) return;
  state.createShortcut = document.getElementById('location-shortcut-checkbox').checked;
  runInstall();
});

// --- Progress + log ---

let downloadStartedAt = null;

function resetProgressScreen() {
  document.getElementById('log-panel').innerHTML = '';
  state.log = [];
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-pct').textContent = '0%';
  document.getElementById('progress-label').textContent = 'Starting…';
  document.getElementById('progress-eta').textContent = '';
  downloadStartedAt = null;
}

window.api.onLog((message) => appendLog(message));

window.api.onProgress(({ fraction, label }) => {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-pct').textContent = pct + '%';
  document.getElementById('progress-label').textContent = label;

  if (label === 'Downloading…') {
    if (!downloadStartedAt) downloadStartedAt = Date.now();
    const elapsedSec = (Date.now() - downloadStartedAt) / 1000;
    if (fraction > 0.02 && elapsedSec > 1) {
      const remainingSec = Math.max(0, Math.round((elapsedSec / fraction) * (1 - fraction)));
      document.getElementById('progress-eta').textContent = `Est. ${remainingSec}s remaining`;
    }
  } else {
    document.getElementById('progress-eta').textContent = '';
  }
});

async function runInstall() {
  showScreen('progress');
  resetProgressScreen();
  const res = await window.api.install(state.installDir, state.createShortcut);
  if (res.ok) {
    state.version = res.version;
    state.exePath = res.exePath;
    document.getElementById('success-subtitle').textContent =
      `RESYNC Client ${res.version} is ready. Sign in to connect your workspace and start syncing.`;
    showScreen('success');
  } else {
    document.getElementById('failure-error').textContent = res.error;
    showScreen('failure');
  }
}

document.getElementById('progress-cancel-btn').addEventListener('click', () => window.api.cancelInstall());

document.getElementById('log-copy-btn').addEventListener('click', () => {
  const text = state.log.map((l) => `[${l.time}] ${l.message}`).join('\n');
  navigator.clipboard.writeText(text);
});

// --- Success ---

document.getElementById('success-finish-btn').addEventListener('click', async () => {
  if (document.getElementById('success-launch-checkbox').checked && state.exePath) {
    await window.api.launch(state.exePath);
  }
  window.api.cancel();
});

// --- Failure ---

document.getElementById('failure-log-btn').addEventListener('click', () => showScreen('progress'));
document.getElementById('failure-relocate-btn').addEventListener('click', () => {
  showScreen('location');
  refreshLocationScreen();
});
document.getElementById('failure-retry-btn').addEventListener('click', () => runInstall());

initWelcome();
