const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const extractZip = require('extract-zip');

const GITHUB_REPO = 'BongiornoND/resync';
const DEFAULT_INSTALL_DIR = path.join(os.homedir(), 'AppData', 'Local', 'Resync');

let mainWindow;
let currentDownloadRequest = null;

// Supports two entry points into "update an existing install": someone
// double-clicks this installer standalone (no args — the default install
// location is checked directly, see findExistingInstall below), or the
// Resync client itself launches it with these flags when the user clicks
// "Update now" in-app, pointing at wherever it's actually installed rather
// than assuming the default location.
function parseCliArgs(argv) {
  // A packaged app's argv has no separate "electron binary" + "script"
  // prefix the way `electron .` in dev does — real args start one
  // position earlier.
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const parsed = { update: false, target: null, relaunch: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--update') parsed.update = true;
    else if (args[i] === '--target') parsed.target = args[++i];
    else if (args[i] === '--relaunch') parsed.relaunch = true;
  }
  return parsed;
}
const cliArgs = parseCliArgs(process.argv);

// Looks in the given directory (or the default install location if none
// given) for an existing install, so both entry points above land on the
// same "offer to update instead of install fresh" behavior.
function findExistingInstall(targetDir) {
  const dir = targetDir || DEFAULT_INSTALL_DIR;
  const exePath = path.join(dir, 'resync.exe');
  if (!fs.existsSync(exePath)) return null;
  let currentVersion = null;
  try {
    // Unpacked electron-packager output (no asar) — package.json sits
    // right there as a plain file.
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'resources', 'app', 'package.json'), 'utf8'));
    currentVersion = pkg.version || null;
  } catch {
    // Installed but version unreadable — still a real existing install,
    // just without a "currently vX" to show.
  }
  return { dir, currentVersion };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 560,
    resizable: false,
    title: 'Install RESYNC Client',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

function sendLog(message) {
  if (mainWindow) mainWindow.webContents.send('installer:log', message);
}

function sendProgress(fraction, label) {
  if (mainWindow) mainWindow.webContents.send('installer:progress', { fraction, label });
}

// --- GitHub Releases lookup ---

function githubApiGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: pathname,
        method: 'GET',
        headers: { 'User-Agent': 'resync-installer', Accept: 'application/vnd.github+json' },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(githubApiGet(res.headers.location.replace('https://api.github.com', '')));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API returned ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('Could not parse GitHub API response: ' + err.message));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

ipcMain.handle('installer:getLatestRelease', async () => {
  try {
    const release = await githubApiGet(`/repos/${GITHUB_REPO}/releases/latest`);
    const asset = (release.assets || []).find((a) => a.name.endsWith('.zip'));
    if (!asset) throw new Error('Latest release has no .zip asset attached');
    return {
      ok: true,
      version: release.tag_name,
      assetUrl: asset.browser_download_url,
      assetSize: asset.size,
      defaultInstallDir: DEFAULT_INSTALL_DIR,
      existingInstall: findExistingInstall(cliArgs.target),
      relaunch: cliArgs.relaunch,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Choose install location ---

ipcMain.handle('installer:chooseLocation', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose install location',
    defaultPath: DEFAULT_INSTALL_DIR,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, path: result.filePaths[0] };
});

// --- Disk space check (Windows-only app — shell to PowerShell rather than
// add a cross-platform dependency for something this app will never need
// to run on macOS/Linux) ---

ipcMain.handle('installer:checkDiskSpace', async (_event, targetPath) => {
  const drive = path.parse(path.resolve(targetPath)).root.replace(/\\$/, '');
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', `(Get-PSDrive -Name '${drive.replace(/:$/, '')}').Free`],
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }
        const freeBytes = Number(stdout.trim());
        resolve({ ok: !Number.isNaN(freeBytes), freeBytes });
      }
    );
  });
});

// --- Install: download, extract, shortcut ---

function downloadWithProgress(url, destPath, totalSize) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let downloaded = 0;

    function get(u) {
      const req = https.get(u, { headers: { 'User-Agent': 'resync-installer' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          sendProgress(totalSize ? downloaded / totalSize : 0, 'Downloading…');
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      });
      req.on('error', reject);
      currentDownloadRequest = req;
    }

    get(url);
  });
}

// When updating an existing install, the caller (either this installer's
// own "close Resync first" nudge, or the app quitting itself before
// launching this) may not have fully released its file locks the instant
// extraction starts — retry through EBUSY/EPERM for a few seconds rather
// than failing the whole update over a timing race.
async function extractWithRetry(zipPath, dir, attempts = 8, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try {
      await extractZip(zipPath, { dir });
      return;
    } catch (err) {
      const busy = err.code === 'EBUSY' || err.code === 'EPERM' || /EBUSY|EPERM/.test(err.message || '');
      if (i === attempts - 1 || !busy) throw err;
      sendLog(`Waiting for RESYNC Client to close… (${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

ipcMain.handle('installer:install', async (_event, { installDir, createShortcut }) => {
  const tmpZipPath = path.join(app.getPath('temp'), `resync-install-${Date.now()}.zip`);
  try {
    sendLog('Fetching latest release info…');
    const release = await githubApiGet(`/repos/${GITHUB_REPO}/releases/latest`);
    const asset = (release.assets || []).find((a) => a.name.endsWith('.zip'));
    if (!asset) throw new Error('Latest release has no .zip asset attached');

    fs.mkdirSync(installDir, { recursive: true });

    sendLog(`Downloading ${release.tag_name}…`);
    sendProgress(0, 'Downloading…');
    await downloadWithProgress(asset.browser_download_url, tmpZipPath, asset.size);
    sendLog('Download complete');

    sendLog(`Extracting to ${installDir}`);
    sendProgress(0.9, 'Extracting…');
    await extractWithRetry(tmpZipPath, installDir);
    sendLog('Extraction complete');

    const exePath = path.join(installDir, 'resync.exe');
    if (!fs.existsSync(exePath)) throw new Error(`Expected ${exePath} after extraction but it wasn't there`);

    if (createShortcut) {
      sendLog('Creating Desktop shortcut…');
      await createDesktopShortcut(exePath);
      sendLog('Shortcut created');
    }

    sendProgress(1, 'Done');
    return { ok: true, version: release.tag_name, exePath };
  } catch (err) {
    sendLog('Error: ' + err.message);
    return { ok: false, error: err.message };
  } finally {
    fs.rm(tmpZipPath, { force: true }, () => {});
    currentDownloadRequest = null;
  }
});

ipcMain.handle('installer:cancelInstall', async () => {
  if (currentDownloadRequest) currentDownloadRequest.destroy(new Error('Canceled by user'));
  return { ok: true };
});

// Windows has no built-in Node API for .lnk creation — WScript.Shell's
// COM object via PowerShell is the standard, dependency-free way to do it.
function createDesktopShortcut(targetExe) {
  // app.getPath('desktop') resolves the real Windows Known Folder path —
  // os.homedir() + 'Desktop' assumes the default location, which breaks
  // for anyone (like OneDrive users) whose Desktop has been relocated by
  // Known Folder Move; that leaves no Desktop folder at that assumed path
  // at all, so the shortcut save fails with DirectoryNotFoundException.
  const desktop = app.getPath('desktop');
  const shortcutPath = path.join(desktop, 'RESYNC Client.lnk');
  const script = [
    '$WshShell = New-Object -ComObject WScript.Shell',
    `$Shortcut = $WshShell.CreateShortcut('${shortcutPath}')`,
    `$Shortcut.TargetPath = '${targetExe}'`,
    `$Shortcut.WorkingDirectory = '${path.dirname(targetExe)}'`,
    '$Shortcut.Save()',
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-Command', script], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

ipcMain.handle('installer:launch', async (_event, exePath) => {
  try {
    const child = require('child_process').spawn(exePath, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('installer:cancel', async () => {
  app.quit();
});
