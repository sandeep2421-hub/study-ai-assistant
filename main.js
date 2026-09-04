'use strict';

const {
  app, BrowserWindow, globalShortcut, ipcMain,
  clipboard, screen, desktopCapturer, shell
} = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');

// ── App identity cloaking ────────────────────────────────────────────────────
const BRANDED_NAME = 'RuntimeBroker';

// ── Chromium footprint minimization ─────────────────────────────────────────
app.commandLine.appendSwitch('disk-cache-size', '1');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-sync');

// ── State ────────────────────────────────────────────────────────────────────
let mainWin         = null;
let authWin         = null;
let currentOpacity  = 0.92;
let isVisible       = true;
let hotkeysDone     = false;
let _typingActive   = false;
let _typingProc     = null;
let _silentMode     = false;

function showWindowIfNeeded() {
  if (_silentMode) return;
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.showInactive();
  }
}

// Session token for server calls (stored in memory only)
let _sessionToken   = '';
let _defaultApiKey  = '';
let _licenseKey     = '';
let _hwid           = '';

// Server base URL — local first, Vercel as fallback for 24/7 cloud hosting
const SERVER_BASE  = 'http://localhost:3000';
const SERVER_CLOUD = 'https://study-ai-backend-main.vercel.app';

// Helper to safely get screen primary display size with fallback to prevent laptop crash bugs
function getDisplaySize() {
  try {
    const primary = screen.getPrimaryDisplay();
    if (primary && primary.size) {
      return primary.size;
    }
  } catch (err) {
    console.error('[Main] getPrimaryDisplay failed:', err.message);
  }
  return { width: 1920, height: 1080 };
}

// Dynamic API keys pool — strictly per-license (never mixed across members)
let _licenseApiKeys = [];

function firestoreGet(docPath) {
  return new Promise((resolve, reject) => {
    const url = `https://firestore.googleapis.com/v1/projects/study-ai-f0bd7/databases/(default)/documents/${docPath}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function loadLicenseKeys(key) {
  if (!key) return [];
  try {
    const { status, data } = await firestoreGet(`licenses/${encodeURIComponent(key)}`);
    if (status === 200 && data?.fields) {
      const fields = data.fields;
      if (getField(fields, 'isActive') !== false) {
        const rawKeys = getField(fields, 'apiKey') || getField(fields, 'apiKeys') || '';
        const keys = rawKeys.split('\n').map(k => k.trim()).filter(Boolean);
        if (keys.length > 0) {
          _licenseApiKeys = keys;
          return keys;
        }
      }
    }
  } catch (_) {}
  return _licenseApiKeys;
}

function getField(fields, key) {
  const f = fields?.[key];
  if (!f) return null;
  return f.stringValue ?? f.integerValue ?? f.booleanValue ?? null;
}

// ── Telemetry & Alerts ────────────────────────────────────────────────────────
async function fetchGeoTelemetry() {
  try {
    const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(3000) });
    if (res.ok) return await res.json();
  } catch (_) {
    try {
      const res2 = await fetch('http://ip-api.com/json', { signal: AbortSignal.timeout(3000) });
      if (res2.ok) {
        const d = await res2.json();
        return { ip: d.query, city: d.city, region: d.regionName, country_name: d.country, org: d.isp, latitude: d.lat, longitude: d.lon };
      }
    } catch (_) {}
  }
  return {};
}

async function sendAdminLoginAlert(key, geo, pcName, pcUser) {
  try {
    const loc = [geo.city, geo.region, geo.country_name].filter(Boolean).join(', ') || 'Location detected';
    const mapUrl = (geo.latitude && geo.longitude) ? 
      `https://www.google.com/maps?q=${geo.latitude},${geo.longitude}` : 
      'https://www.google.com';
    const timeStr = new Date().toLocaleString();

    // 1. Direct Email Dispatch to saturnstars1983@gmail.com
    const emailPayload = JSON.stringify({
      _subject: `🚨 Study AI Alert: Student ${key} Logged In`,
      _template: 'table',
      _captcha: 'false',
      License_Key: key,
      Location: loc,
      IP_Address: geo.ip || 'N/A',
      ISP: geo.org || 'N/A',
      Device: `${pcUser || 'User'} @ ${pcName || 'PC'}`,
      Google_Maps: mapUrl,
      Timestamp: timeStr,
      Admin_Phone: '+91 6281754652'
    });

    fetch('https://formsubmit.co/ajax/saturnstars1983@gmail.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://study-ai-backend-main.vercel.app',
        'Referer': 'https://study-ai-backend-main.vercel.app/'
      },
      body: emailPayload
    }).catch(() => {});

    // 2. High Priority Real-time Stream
    const payload = JSON.stringify({
      topic: 'study_ai_admin_6281754652',
      title: `🚨 Student Online: ${key}`,
      message: `👤 Key: ${key}\n📍 Location: ${loc}\n🌐 IP: ${geo.ip || 'N/A'} (${geo.org || 'ISP'})\n💻 Device: ${pcUser} @ ${pcName}\n⏰ Time: ${timeStr}`,
      priority: 4,
      tags: ['rotating_light', 'computer', 'key'],
      click: mapUrl
    });

    fetch('https://ntfy.sh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    }).catch(() => {});
  } catch (err) {
    console.error('[AdminAlert] alert error:', err.message);
  }
}

async function recordUserTelemetry(key) {
  if (!key) return;
  try {
    const geo = await fetchGeoTelemetry();
    const osInfo = `${os.type()} ${os.release()} (${os.arch()})`;
    const pcName = os.hostname() || 'PC';
    const pcUser = os.userInfo()?.username || 'User';
    const now = new Date().toISOString();

    // Trigger instant email and phone alert
    sendAdminLoginAlert(key, geo, pcName, pcUser).catch(() => {});

    const queryParams = [
      'updateMask.fieldPaths=lastLoginAt',
      'updateMask.fieldPaths=lastActiveAt',
      'updateMask.fieldPaths=lastIp',
      'updateMask.fieldPaths=lastCity',
      'updateMask.fieldPaths=lastRegion',
      'updateMask.fieldPaths=lastCountry',
      'updateMask.fieldPaths=lastIsp',
      'updateMask.fieldPaths=lastLat',
      'updateMask.fieldPaths=lastLon',
      'updateMask.fieldPaths=pcName',
      'updateMask.fieldPaths=pcUser',
      'updateMask.fieldPaths=osVersion'
    ].join('&');

    const url = `https://firestore.googleapis.com/v1/projects/study-ai-f0bd7/databases/(default)/documents/licenses/${encodeURIComponent(key)}?${queryParams}`;
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          lastLoginAt: { stringValue: now },
          lastActiveAt: { stringValue: now },
          lastIp: { stringValue: geo.ip || '' },
          lastCity: { stringValue: geo.city || '' },
          lastRegion: { stringValue: geo.region || '' },
          lastCountry: { stringValue: geo.country_name || '' },
          lastIsp: { stringValue: geo.org || '' },
          lastLat: { stringValue: String(geo.latitude || '') },
          lastLon: { stringValue: String(geo.longitude || '') },
          pcName: { stringValue: pcName },
          pcUser: { stringValue: pcUser },
          osVersion: { stringValue: osInfo }
        }
      })
    });
  } catch (_) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function httpPost(urlStr, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (_sessionToken) headers['Authorization'] = `Bearer ${_sessionToken}`;

  // Try local server first
  try {
    const localRes = await fetch('http://localhost:3000' + new URL(urlStr).pathname, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (localRes.ok) {
      const json = await localRes.json();
      return { status: localRes.status, body: json };
    }
  } catch (_) {}

  // Direct Cloud Firestore & Gemini Fallback (Zero Server Dependency)
  const endpoint = urlStr.split('/').pop();

  if (endpoint === 'login') {
    try {
      const key = (body?.licenseKey || '').trim();
      if (!key) return { status: 400, body: { error: 'missing_key' } };

      const { status, data } = await firestoreGet(`licenses/${encodeURIComponent(key)}`);
      if (status === 404 || data?.error) {
        return { status: 401, body: { error: 'invalid_license' } };
      }

      const fields = data?.fields || {};
      if (getField(fields, 'isActive') === false) {
        return { status: 401, body: { error: 'license_deactivated' } };
      }

      const rawKeys = getField(fields, 'apiKey') || getField(fields, 'apiKeys') || '';
      const keys = rawKeys.split('\n').map(k => k.trim()).filter(Boolean);
      if (keys.length > 0) _licenseApiKeys = keys;

      recordUserTelemetry(key).catch(() => {});

      const token = crypto.randomBytes(32).toString('hex');
      return {
        status: 200,
        body: {
          success: true,
          sessionToken: token,
          apiKeys: _licenseApiKeys,
          remainingMs: 9999999999
        }
      };
    } catch (err) {
      return { status: 500, body: { error: 'network_error', message: err.message } };
    }
  }

  if (endpoint === 'heartbeat') {
    return { status: 200, body: { status: 'active', remainingMs: 9999999999 } };
  }

  if (endpoint === 'version') {
    return { status: 200, body: { hasUpdate: false, version: '2.0.3' } };
  }

  // AI query fallback (Gemini direct — strictly using this user's license keys)
  if (['analyze', 'answer', 'chat'].includes(endpoint)) {
    try {
      const question = body?.question || 'Help me.';
      const parts = [{ text: question }];
      if (body?.imageBase64) {
        const mimeMatch = body.imageBase64.match(/^data:(image\/[a-zA-Z0-9.-]+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
        const data = body.imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
        parts.push({ inlineData: { mimeType, data } });
      }

      if (_licenseApiKeys.length === 0 && _licenseKey) {
        await loadLicenseKeys(_licenseKey);
      }

      const models = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'];
      for (const model of models) {
        for (const apiKey of _licenseApiKeys) {
          try {
            const reqBody = JSON.stringify({
              contents: [{ parts }],
              generationConfig: {
                temperature: 0.0,
                topP: 0.95,
                maxOutputTokens: 8192
              }
            });
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: reqBody
            });
            if (resp.ok) {
              const resJson = await resp.json();
              const text = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text && text.trim()) return { status: 200, body: { answer: text } };
            }
          } catch (_) {}
        }
      }
      return { status: 200, body: { answer: "Unable to reach AI services. Please verify your internet connection." } };
    } catch (err) {
      return { status: 500, body: { error: 'ai_error', message: err.message } };
    }
  }

  return { status: 200, body: { success: true } };
}

// ── Saved token storage (memory-only in this session) ────────────────────────
const SESSION_FILE = path.join(app.getPath('temp'), '.engoulp_sess');
function loadSavedSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, 'utf8').trim();
      const obj = JSON.parse(raw);
      if (obj.sessionToken && obj.licenseKey) return obj;
    }
  } catch (_) {}
  return null;
}
function saveSession(obj) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(obj), 'utf8'); } catch (_) {}
}
function clearSession() {
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch (_) {}
}

// ── Auth window ───────────────────────────────────────────────────────────────
function createAuthWindow() {
  authWin = new BrowserWindow({
    width: 340,
    height: 260,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    center: true,
    skipTaskbar: false,
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  authWin.setMenu(null);
  authWin.loadFile(path.join(__dirname, 'auth.html'));
  authWin.once('ready-to-show', () => {
    authWin.show();
    authWin.focus();
    setTimeout(() => {
      if (authWin && !authWin.isDestroyed()) {
        authWin.webContents.send('show-login-form');
      }
    }, 200);
  });
  authWin.on('closed', () => { authWin = null; });
}

// ── Main interview window ───────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWin = new BrowserWindow({
    width: 420,
    height: 680,
    x: width - 440,
    y: 40,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      backgroundThrottling: false
    }
  });

  mainWin.setAlwaysOnTop(true, 'screen-saver');
  mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWin.setContentProtection(true);   // hides from screen-share / OBS
  mainWin.setHasShadow(false);

  mainWin.loadFile(path.join(__dirname, 'renderer.html'));

  mainWin.once('ready-to-show', () => {
    showWindowIfNeeded();
    mainWin.setOpacity(currentOpacity);
    // Unlock the app — tell renderer the key is ready
    mainWin.webContents.send('set-default-key', 'server');
    mainWin.webContents.send('set-license-info', { licenseKey: _licenseKey, hwid: _hwid });
    // Start license timer heartbeat
    startTimerHeartbeat();
  });

  mainWin.on('closed', () => { mainWin = null; });

  mainWin.on('blur', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.setContentProtection(true);
      mainWin.webContents.send('force-stealth-restore');
    }
  });

  mainWin.webContents.on('console-message', (_, level, msg) => {
    if (msg && !msg.includes('Electron Security')) console.log('[Renderer]', msg);
  });
}

// ── After successful login, open main window ──────────────────────────────────
function onLoginSuccess(sessionToken, licenseKey, hwid) {
  _sessionToken = sessionToken;
  _licenseKey   = licenseKey;
  _hwid         = hwid;
  _defaultApiKey = 'server';
  saveSession({ sessionToken, licenseKey, hwid });

  // Close auth window
  if (authWin && !authWin.isDestroyed()) {
    authWin.close();
    authWin = null;
  }

  // Open main interview assistant
  createWindow();
  registerHotkeys();
}

// ── Process cloaking ──────────────────────────────────────────────────────────
function cloakProcess() {
  if (process.platform === 'win32') {
    try {
      exec(
        `powershell -WindowStyle Hidden -Command "Get-Process -Id ${process.pid} | ` +
        `Rename-Process -NewName '${BRANDED_NAME}'"`,
        () => {}
      );
    } catch (_) {}
  }
}

// ── License timer heartbeat ───────────────────────────────────────────────────
let _heartbeatTimer = null;
function startTimerHeartbeat() {
  // Show "Lifetime Active" immediately while we wait for the server
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('timer-update', {
      status: 'active',
      remaining: 9999999999
    });
  }

  // Poll server every 30s to keep session alive
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = setInterval(async () => {
    try {
      const r = await httpPost(`${SERVER_BASE}/heartbeat`, {
        sessionToken: _sessionToken,
        licenseKey: _licenseKey,
        hwid: _hwid
      });
      const remaining = r.body?.remainingMs ?? r.body?.remaining ?? 9999999999;
      if (mainWin && !mainWin.isDestroyed()) {
        if (r.status === 401) {
          mainWin.webContents.send('session-expired');
        } else {
          mainWin.webContents.send('timer-update', {
            status: r.body?.status || 'active',
            remaining
          });
        }
      }
    } catch (_) {
      // keep showing lifetime if server unreachable
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('timer-update', { status: 'active', remaining: 9999999999 });
      }
    }
  }, 30000);
}

// ── Global hotkeys ────────────────────────────────────────────────────────────
function registerHotkeys() {
  // Toggle visibility
  globalShortcut.register('Alt+Shift+H', () => {
    if (!mainWin) return;
    if (mainWin.isVisible()) {
      mainWin.hide();
    } else {
      mainWin.showInactive();
      mainWin.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  // Ctrl+Shift+B — toggle silent / blind mode (hides window completely, uses audio beeps)
  globalShortcut.register('CommandOrControl+Shift+B', () => {
    if (!mainWin) return;
    _silentMode = !_silentMode;
    console.log('[Main] Silent Mode:', _silentMode ? 'ENABLED' : 'DISABLED');
    if (_silentMode) {
      mainWin.hide();
      try { shell.beep(); } catch (_) {}
      try { process.stdout.write('\x07'); } catch (_) {}
    } else {
      mainWin.showInactive();
      mainWin.setAlwaysOnTop(true, 'screen-saver');
      try {
        shell.beep();
        setTimeout(() => { shell.beep(); }, 150);
      } catch (_) {}
      try { process.stdout.write('\x07\x07'); } catch (_) {}
    }
  });

  // Emergency quit
  globalShortcut.register('Alt+Shift+Q', () => {
    cleanup();
    app.exit(0);
  });

  // Opacity controls
  globalShortcut.register('Alt+Shift+F1', () => {
    currentOpacity = Math.min(1.0, currentOpacity + 0.1);
    mainWin?.setOpacity(currentOpacity);
  });
  globalShortcut.register('Alt+Shift+F2', () => {
    currentOpacity = Math.max(0.1, currentOpacity - 0.1);
    mainWin?.setOpacity(currentOpacity);
  });

  // Ctrl+Shift+S — capture screen silently
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    if (!mainWin) return;
    try {
      mainWin.hide();
      await new Promise(r => setTimeout(r, 200));
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: getDisplaySize()
      });
      mainWin.showInactive();
      const src = sources[0];
      if (src) {
        const resized = src.thumbnail.resize({ width: 1280 });
        const dataUrl = 'data:image/jpeg;base64,' + resized.toJPEG(80).toString('base64');
        mainWin.webContents.send('silent-capture-result', dataUrl);
      } else {
        mainWin.webContents.send('linux-screenshot-hint');
      }
    } catch (e) {
      if (mainWin && !mainWin.isDestroyed()) mainWin.showInactive();
      console.error('[Main] Capture error:', e.message);
    }
  });

  // Ctrl+Shift+A — ask / generate answer
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    mainWin?.webContents.send('global-ask-answer');
  });

  // Ctrl+Shift+R — full app reload & reset
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (_typingProc) {
      try { _typingProc.kill('SIGKILL'); } catch (_) {}
      _typingProc = null;
      _typingActive = false;
    }
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.reloadIgnoringCache();
      mainWin.webContents.once('did-finish-load', () => {
        mainWin.webContents.send('set-default-key', 'server');
        mainWin.webContents.send('set-license-info', { licenseKey: _licenseKey, hwid: _hwid });
        mainWin.webContents.send('timer-update', { status: 'active', remaining: 9999999999 });
      });
    }
  });

  // Alt+Shift+R — alternative reload for laptops
  globalShortcut.register('Alt+Shift+R', () => {
    if (_typingProc) {
      try { _typingProc.kill('SIGKILL'); } catch (_) {}
      _typingProc = null;
      _typingActive = false;
    }
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.reloadIgnoringCache();
      mainWin.webContents.once('did-finish-load', () => {
        mainWin.webContents.send('set-default-key', 'server');
        mainWin.webContents.send('set-license-info', { licenseKey: _licenseKey, hwid: _hwid });
        mainWin.webContents.send('timer-update', { status: 'active', remaining: 9999999999 });
      });
    }
  });

  // Ctrl+Shift+L — toggle listener
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    mainWin?.webContents.send('global-toggle-listen');
  });

  // Ctrl+Shift+I — toggle / open AI chat mode
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    mainWin?.webContents.send('global-toggle-chat');
  });

  // Ctrl+Shift+C — copy selected text from external window → paste into question box / chat
  globalShortcut.register('CommandOrControl+Shift+C', async () => {
    if (!mainWin) return;
    console.log('[Main] Ctrl+Shift+C pressed — copying highlighted text...');
    try {
      const origText = clipboard.readText();
      const sentinel = '__COPY_SENTINEL_' + Math.random().toString(36).substring(2, 9);
      clipboard.writeText(sentinel);

      // Blur window so OS focus returns to the highlighted text in browser/app
      mainWin.hide();
      await new Promise(r => setTimeout(r, 150));

      if (process.platform === 'win32') {
        const psCmd = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "$ProgressPreference='SilentlyContinue'; $sig='[DllImport(\\"user32.dll\\")] public static extern uint SendInput(uint n, INPUT[] i, int s); [StructLayout(LayoutKind.Explicit, Size=40)] public struct INPUT {[FieldOffset(0)] public int t; [FieldOffset(8)] public KEYBDINPUT k;} [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort v; public ushort s; public uint f; public uint tm; public IntPtr e;} public static void Copy(){ INPUT[] i=new INPUT[4]; i[0].t=1; i[0].k.v=0x11; i[1].t=1; i[1].k.v=0x43; i[2].t=1; i[2].k.v=0x43; i[2].k.f=2; i[3].t=1; i[3].k.v=0x11; i[3].k.f=2; SendInput(4, i, 40); }'; Add-Type -MemberDefinition $sig -Name C1 -Namespace C; [C.C1]::Copy()"`;
        const { exec } = require('child_process');
        exec(psCmd);
      } else if (process.platform === 'darwin') {
        const { spawn } = require('child_process');
        spawn('osascript', ['-e', 'tell application "System Events" to keystroke "c" using command down']).unref();
      } else {
        const { spawn } = require('child_process');
        spawn('xdotool', ['key', 'ctrl+c']).unref();
      }

      let copiedText = '';
      for (let i = 0; i < 25; i++) {
        await new Promise(r => setTimeout(r, 40));
        const current = clipboard.readText();
        if (current && current !== sentinel) {
          copiedText = current;
          break;
        }
      }

      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.showInactive();
      }

      if (copiedText && copiedText !== sentinel && copiedText.trim()) {
        const cleanText = copiedText.trim();
        console.log('[Main] Successfully captured highlighted text:', cleanText.substring(0, 40) + '...');
        mainWin.webContents.send('paste-question', cleanText);
        mainWin.webContents.send('send-to-chat', cleanText);
      } else {
        console.log('[Main] No text copied or selection empty.');
        if (origText) clipboard.writeText(origText);
      }
    } catch (e) {
      if (mainWin && !mainWin.isDestroyed()) mainWin.showInactive();
      console.error('[Main] Ctrl+Shift+C error:', e.message);
    }
  });

  // Ctrl+Shift+V — auto-type last code at OS cursor
  globalShortcut.register('CommandOrControl+Shift+V', () => {
    if (!mainWin) return;
    console.log('[Main] Ctrl+Shift+V pressed');
    mainWin.hide(); // hide so focus returns to coding editor
    setTimeout(() => {
      console.log('[Main] Requesting code from renderer...');
      mainWin?.webContents.send('get-last-code-for-typing');
    }, 150);
  });

  // Ctrl+Shift+K — toggle kiosk / stealth mode
  globalShortcut.register('CommandOrControl+Shift+K', () => {
    if (!mainWin) return;
    const currentFocusable = mainWin.isFocusable();
    const nextFocusable = !currentFocusable;
    mainWin.setFocusable(nextFocusable);

    const newMode = nextFocusable ? 'normal' : 'kiosk';
    mainWin.webContents.send('stealth-mode-changed', newMode);
    
    // In kiosk: window visible above browser, opacity 0.6
    if (newMode === 'kiosk') {
      mainWin.setAlwaysOnTop(true, 'screen-saver');
      mainWin.setOpacity(0.6);
    } else {
      mainWin.setAlwaysOnTop(true, 'screen-saver');
      mainWin.setOpacity(0.85);
    }
  });

  // Ctrl+Shift+H — hide / show window
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!mainWin) return;
    if (mainWin.isVisible()) {
      mainWin.hide();
    } else {
      mainWin.showInactive();
      mainWin.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  // Ctrl+Shift+Q — quit app
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    cleanup();
    app.quit();
  });

  // Ctrl+Shift+P — pause / resume scroll
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    mainWin?.webContents.send('global-scroll-pause');
  });

  // Ctrl+Shift+Down — scroll answer down
  globalShortcut.register('CommandOrControl+Shift+Down', () => {
    mainWin?.webContents.send('global-scroll-down');
  });

  // Ctrl+Shift+Up — scroll answer up
  globalShortcut.register('CommandOrControl+Shift+Up', () => {
    mainWin?.webContents.send('global-scroll-up');
  });

  // Ctrl+Shift+X — cycle language
  globalShortcut.register('CommandOrControl+Shift+X', () => {
    mainWin?.webContents.send('global-lang-cycle');
  });

  // Ctrl+Shift+E — erase / clear all
  globalShortcut.register('CommandOrControl+Shift+E', () => {
    if (_typingProc) {
      try { _typingProc.kill('SIGKILL'); } catch (_) {}
      _typingProc = null;
      _typingActive = false;
    }
    mainWin?.webContents.send('global-reset');
  });

  globalShortcut.register('Alt+Shift+Up',    () => { if (!mainWin) return; const [x, y] = mainWin.getPosition(); mainWin.setPosition(x, y - 20); });
  globalShortcut.register('Alt+Shift+Down',  () => { if (!mainWin) return; const [x, y] = mainWin.getPosition(); mainWin.setPosition(x, y + 20); });
  globalShortcut.register('Alt+Shift+Left',  () => { if (!mainWin) return; const [x, y] = mainWin.getPosition(); mainWin.setPosition(x - 20, y); });
  globalShortcut.register('Alt+Shift+Right', () => { if (!mainWin) return; const [x, y] = mainWin.getPosition(); mainWin.setPosition(x + 20, y); });

  // Triple-tap panic kill (Alt+Shift+Backspace x3 within 800ms)
  let panicCount = 0, panicTimer = null;
  globalShortcut.register('Alt+Shift+Backspace', () => {
    panicCount++;
    if (panicTimer) clearTimeout(panicTimer);
    panicTimer = setTimeout(() => { panicCount = 0; }, 800);
    if (panicCount >= 3) process.kill(process.pid, 'SIGKILL');
  });

  console.log('[Interview Assistant] All hotkeys registered.');
}

// ── Auto-type via PowerShell stdin pipe ───────────────────────────────────────
function stripComments(code) {
  if (!code) return '';
  let cleaned = code.replace(/\/\*[\s\S]*?\*\//g, '');
  cleaned = cleaned.replace(/(?<!:)\/\/.*$/gm, '');
  cleaned = cleaned.replace(/"""[\s\S]*?"""/g, '').replace(/'''[\s\S]*?'''/g, '');
  cleaned = cleaned.replace(/^[ \t]*#(?!include|define|pragma|ifdef|ifndef|endif|if|else|elif|import).*$/gm, '');
  cleaned = cleaned.replace(/(?<=[;,\)\]\}a-zA-Z0-9])[ \t]+#(?!include|define|pragma|ifdef|ifndef|endif|if|else|elif|import).*$/gm, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned;
}

function autoHealCode(code) {
  if (!code) return '';
  let healed = code;

  // 1. Python Heals
  healed = healed.replace(/^import\s+reduce\b/gm, 'from functools import reduce');

  const pyImports = [];
  const functoolsNeeded = [];
  if (/\breduce\(/.test(healed) && !/\bfrom\s+functools\s+import\s+.*\breduce\b/.test(healed) && !/\bimport\s+functools\b/.test(healed)) {
    functoolsNeeded.push('reduce');
  }
  if (/\b(lru_cache|cache)\b/.test(healed) && !/\bfrom\s+functools\s+import\b/.test(healed) && !/\bimport\s+functools\b/.test(healed)) {
    functoolsNeeded.push('lru_cache');
  }
  if (functoolsNeeded.length > 0) {
    pyImports.push(`from functools import ${[...new Set(functoolsNeeded)].join(', ')}`);
  }

  const iterNeeded = [];
  ['permutations', 'combinations', 'product', 'accumulate', 'chain', 'groupby', 'islice'].forEach(fn => {
    if (new RegExp(`\\b${fn}\\(`).test(healed) && !new RegExp(`\\bfrom\\s+itertools\\s+import\\s+.*\\b${fn}\\b`).test(healed) && !/\bimport\s+itertools\b/.test(healed)) {
      iterNeeded.push(fn);
    }
  });
  if (iterNeeded.length > 0) {
    pyImports.push(`from itertools import ${iterNeeded.join(', ')}`);
  }

  if (/\bbisect(_left|_right)?\b/.test(healed) && !/\bimport\s+bisect\b/.test(healed) && !/\bfrom\s+bisect\b/.test(healed)) {
    pyImports.push('from bisect import bisect_left, bisect_right, bisect, insort');
  }

  const typingNeeded = [];
  ['List', 'Dict', 'Tuple', 'Set', 'Optional', 'Any'].forEach(t => {
    if (new RegExp(`\\b${t}\\[`).test(healed) && !new RegExp(`\\bfrom\\s+typing\\s+import\\s+.*\\b${t}\\b`).test(healed)) {
      typingNeeded.push(t);
    }
  });
  if (typingNeeded.length > 0) {
    pyImports.push(`from typing import ${typingNeeded.join(', ')}`);
  }

  if (/\bre\.(findall|match|search|sub|split|compile)\b/.test(healed) && !/\bimport\s+re\b/.test(healed)) {
    pyImports.push('import re');
  }
  if (/\bsys\.(stdin|stdout|setrecursionlimit|argv|maxsize)\b/.test(healed) && !/\bimport\s+sys\b/.test(healed)) {
    pyImports.push('import sys');
  }
  if (/\bmath\.(sqrt|isqrt|gcd|ceil|floor|inf|comb|factorial|log|pow)\b/.test(healed) && !/\bimport\s+math\b/.test(healed)) {
    pyImports.push('import math');
  }
  if (/\b(heappush|heappop|heapify)\b/.test(healed) && !/\bimport\s+heapq\b/.test(healed) && !/\bfrom\s+heapq\b/.test(healed)) {
    pyImports.push('import heapq\nfrom heapq import heappush, heappop, heapify');
  } else if (/\bheapq\./.test(healed) && !/\bimport\s+heapq\b/.test(healed)) {
    pyImports.push('import heapq');
  }

  const pyCollections = [];
  if (/\bdeque\b/.test(healed) && !/\bfrom\s+collections\s+import\s+.*\bdeque\b/.test(healed)) pyCollections.push('deque');
  if (/\bdefaultdict\b/.test(healed) && !/\bfrom\s+collections\s+import\s+.*\bdefaultdict\b/.test(healed)) pyCollections.push('defaultdict');
  if (/\bCounter\b/.test(healed) && !/\bfrom\s+collections\s+import\s+.*\bCounter\b/.test(healed)) pyCollections.push('Counter');
  if (/\bOrderedDict\b/.test(healed) && !/\bfrom\s+collections\s+import\s+.*\bOrderedDict\b/.test(healed)) pyCollections.push('OrderedDict');
  if (pyCollections.length > 0) {
    pyImports.push(`from collections import ${pyCollections.join(', ')}`);
  }

  const isPython = /\b(def\s+\w+|import\s+sys|elif\b|:\s*$)/m.test(healed) && !/\b(public\s+class|#include|int\s+main)\b/.test(healed);
  if (isPython && pyImports.length > 0) {
    healed = pyImports.join('\n') + '\n' + healed;
  }

  // 2. C++ Heals
  const isCpp = /\b(#include|vector<|cout\s*<<|cin\s*>>|std::|int\s+main\(\))\b/.test(healed);
  if (isCpp) {
    if (!healed.includes('#include')) {
      healed = '#include <bits/stdc++.h>\nusing namespace std;\n' + healed;
    } else if (!healed.includes('using namespace std;') && !healed.includes('std::')) {
      healed = 'using namespace std;\n' + healed;
    }
  }

  // 3. Java Heals
  const isJava = /\b(public\s+class|System\.out\.print|Scanner\s+sc|BufferedReader)\b/.test(healed);
  if (isJava && !healed.includes('import java.util')) {
    healed = 'import java.util.*;\nimport java.io.*;\n' + healed;
  }

  return healed;
}

function extractCode(text) {
  if (!text) return '';
  const t = text.trim();
  let result = '';
  const closed = t.match(/```[\w]*\n?([\s\S]*?)```/);
  if (closed && closed[1]) result = closed[1].trim();
  else if (t.startsWith('```')) {
    const lines = t.split('\n'); lines.shift();
    if (lines[lines.length - 1]?.trim() === '```') lines.pop();
    result = lines.join('\n').trim();
  } else {
    result = t;
  }
  result = stripComments(result);
  result = autoHealCode(result);
  // Strip 'public' from main class — VIT judge uses Main.java so 'public class Solution' won't compile
  result = result.replace(/\bpublic(\s+class\s+Solution\b)/g, '$1');

  // Clean up lines: trim trailing whitespace and collapse multiple blank lines
  const rawLines = result.split(/\r?\n/);
  const cleanedLines = [];
  let prevEmpty = false;
  for (const line of rawLines) {
    const trimmedEnd = line.trimEnd();
    if (trimmedEnd.trim().length === 0) {
      if (!prevEmpty && cleanedLines.length > 0) {
        cleanedLines.push('');
        prevEmpty = true;
      }
    } else {
      cleanedLines.push(trimmedEnd);
      prevEmpty = false;
    }
  }
  return cleanedLines.join('\n').trim();
}

async function autoType(code) {
  if (_typingActive) {
    console.log('[Main] Mutex block: already typing');
    return false;
  }
  _typingActive = true;
  console.log('[Main] autoType called with code length:', code ? code.length : 0);
  try {
    const clean = extractCode(code)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\t/g, '    ');

    if (!clean || !clean.trim()) {
      console.log('[Main] No text to type after extraction.');
      _typingActive = false;
      return false;
    }
    console.log('[Main] Cleaned code length to type:', clean.length);

    if (process.platform === 'win32') {
      const script = `
$ProgressPreference = 'SilentlyContinue'

if ([IntPtr]::Size -eq 8) {
    # 64-bit Windows definition
    $Signature = @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class HelperInput {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [StructLayout(LayoutKind.Explicit, Size = 40)]
    public struct INPUT {
        [FieldOffset(0)]
        public int type;
        [FieldOffset(8)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    private const int INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    private static void SendKey(ushort wVk, ushort wScan, uint dwFlags) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].ki.wVk = wVk;
        inputs[0].ki.wScan = wVk != 0 ? (ushort)MapVirtualKey(wVk, 0) : wScan;
        inputs[0].ki.dwFlags = dwFlags;
        inputs[0].ki.dwExtraInfo = IntPtr.Zero;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void SendExtKey(ushort wVk, uint dwFlags) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].ki.wVk = wVk;
        inputs[0].ki.wScan = (ushort)MapVirtualKey(wVk, 0);
        inputs[0].ki.dwFlags = dwFlags | KEYEVENTF_EXTENDEDKEY;
        inputs[0].ki.dwExtraInfo = IntPtr.Zero;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void TypeChar(char c) {
        SendKey(0, (ushort)c, KEYEVENTF_UNICODE);
        SendKey(0, (ushort)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    }

    public static void PressVk(ushort vk) { SendKey(vk, 0, 0); }
    public static void ReleaseVk(ushort vk) { SendKey(vk, 0, KEYEVENTF_KEYUP); }
    public static void SendVk(ushort vk) { PressVk(vk); ReleaseVk(vk); }
    public static void PressExtVk(ushort vk) { SendExtKey(vk, 0); }
    public static void ReleaseExtVk(ushort vk) { SendExtKey(vk, KEYEVENTF_KEYUP); }
    public static void SendExtVk(ushort vk) { PressExtVk(vk); ReleaseExtVk(vk); }
    public static void GoToCol0() {
        SendExtVk(0x24);
        Thread.Sleep(15);
        SendExtVk(0x24);
        Thread.Sleep(15);
    }

    public static void TypeString(string s, int minDelay, int maxDelay) {
        Random rand = new Random();

        int timeout = 0;
        while (timeout < 40 && ((GetAsyncKeyState(0x11) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x10) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x12) & 0x8000) != 0)) {
            Thread.Sleep(50);
            timeout++;
        }
        ReleaseVk(0x11);
        ReleaseVk(0x10);
        ReleaseVk(0x12);
        Thread.Sleep(100);

        GoToCol0();

        int pos = 0;
        while (pos < s.Length) {
            char c = s[pos];
            if ((int)c == 13) {
                pos++;
                continue;
            }
            if ((int)c == 10) {
                SendVk(0x0D);
                Thread.Sleep(45);
                GoToCol0();
                pos++;
            } else {
                TypeChar(c);
                int delay = rand.Next(minDelay, maxDelay);
                Thread.Sleep(delay);
                pos++;
            }
        }
    }
}
"@
} else {
    # 32-bit Windows definition
    $Signature = @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class HelperInput {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [StructLayout(LayoutKind.Explicit, Size = 28)]
    public struct INPUT {
        [FieldOffset(0)]
        public int type;
        [FieldOffset(4)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    private const int INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    private static void SendKey(ushort wVk, ushort wScan, uint dwFlags) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].ki.wVk = wVk;
        inputs[0].ki.wScan = wVk != 0 ? (ushort)MapVirtualKey(wVk, 0) : wScan;
        inputs[0].ki.dwFlags = dwFlags;
        inputs[0].ki.dwExtraInfo = IntPtr.Zero;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void SendExtKey(ushort wVk, uint dwFlags) {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].ki.wVk = wVk;
        inputs[0].ki.wScan = (ushort)MapVirtualKey(wVk, 0);
        inputs[0].ki.dwFlags = dwFlags | KEYEVENTF_EXTENDEDKEY;
        inputs[0].ki.dwExtraInfo = IntPtr.Zero;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void TypeChar(char c) {
        SendKey(0, (ushort)c, KEYEVENTF_UNICODE);
        SendKey(0, (ushort)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    }

    public static void PressVk(ushort vk) { SendKey(vk, 0, 0); }
    public static void ReleaseVk(ushort vk) { SendKey(vk, 0, KEYEVENTF_KEYUP); }
    public static void SendVk(ushort vk) { PressVk(vk); ReleaseVk(vk); }
    public static void PressExtVk(ushort vk) { SendExtKey(vk, 0); }
    public static void ReleaseExtVk(ushort vk) { SendExtKey(vk, KEYEVENTF_KEYUP); }
    public static void SendExtVk(ushort vk) { PressExtVk(vk); ReleaseExtVk(vk); }
    public static void GoToCol0() {
        SendExtVk(0x24);
        Thread.Sleep(15);
        SendExtVk(0x24);
        Thread.Sleep(15);
    }

    public static void TypeString(string s, int minDelay, int maxDelay) {
        Random rand = new Random();

        int timeout = 0;
        while (timeout < 40 && ((GetAsyncKeyState(0x11) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x10) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x12) & 0x8000) != 0)) {
            Thread.Sleep(50);
            timeout++;
        }
        ReleaseVk(0x11);
        ReleaseVk(0x10);
        ReleaseVk(0x12);
        Thread.Sleep(100);

        GoToCol0();

        int pos = 0;
        while (pos < s.Length) {
            char c = s[pos];
            if ((int)c == 13) {
                pos++;
                continue;
            }
            if ((int)c == 10) {
                SendVk(0x0D);
                Thread.Sleep(45);
                GoToCol0();
                pos++;
            } else {
                TypeChar(c);
                int delay = rand.Next(minDelay, maxDelay);
                Thread.Sleep(delay);
                pos++;
            }
        }
    }
}
"@
}

Add-Type -TypeDefinition $Signature -ErrorAction Stop

Start-Sleep -Milliseconds 600

$payload = $env:TYPING_PAYLOAD
if ($payload) {
    [HelperInput]::TypeString($payload, 15, 30)
}
`;
      const tempPs1 = path.join(app.getPath('temp'), `autotype_${Date.now()}_${process.pid}.ps1`);
      try {
        fs.writeFileSync(tempPs1, script, 'utf8');
      } catch (writeErr) {
        console.error('[Main] Failed to write temp autotype script:', writeErr.message);
        _typingActive = false;
        return false;
      }

      await new Promise((resolve) => {
        _typingProc = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tempPs1],
          {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: Object.assign({}, process.env, { TYPING_PAYLOAD: clean })
          }
        );
        _typingProc.stderr.on('data', (data) => {
          console.error('[Main] AutoType PowerShell stderr:', data.toString());
        });
        _typingProc.on('close', (code) => {
          console.log('[Main] PowerShell autoType finished with exit code:', code);
          _typingProc = null;
          try {
            if (fs.existsSync(tempPs1)) fs.unlinkSync(tempPs1);
          } catch (_) {}
          resolve();
        });
      });
    }
    return true;
  } catch (e) {
    console.error('[Main] AutoType error:', e.message);
    return false;
  } finally {
    _typingActive = false;
  }
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

// Version
ipcMain.handle('get-version', () => app.getVersion());

// Get screen sources (used for direct system audio capture)
ipcMain.handle('get-screen-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (e) {
    console.error('[IPC get-screen-sources] Error:', e.message);
    throw e;
  }
});

// Close window
ipcMain.on('close-window', () => {
  cleanup();
  app.quit();
});

// Opacity
ipcMain.on('set-opacity', (_, val) => {
  currentOpacity = parseFloat(val) || 0.85;
  mainWin?.setOpacity(currentOpacity);
});

// Stealth typing start/end (disables content protection temporarily)
ipcMain.on('stealth-typing-start', () => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setFocusable(true);
    mainWin.setContentProtection(false);
  }
});
ipcMain.on('stealth-typing-end', () => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setFocusable(false);
    mainWin.setContentProtection(true);
  }
});

// Start/stop listening (just informational)
ipcMain.on('start-listening', () => { /* no-op — audio is handled in renderer */ });
ipcMain.on('stop-listening',  () => { /* no-op */ });

// Set provider info
ipcMain.on('set-provider', (_, { provider, apiKey }) => {
  if (provider === 'default') {
    _defaultApiKey = apiKey || 'server';
  }
});

// Get default key
ipcMain.handle('get-default-key', () => _defaultApiKey || 'server');

// Write autotype file (kept for compatibility — we store in memory)
let _autoTypeCode = '';
ipcMain.on('write-autotype-file', (_, code) => {
  _autoTypeCode = code || '';
});

// Do auto-type
ipcMain.on('do-auto-type', async (_, code) => {
  const toType = code || _autoTypeCode;
  if (!toType || !toType.trim()) {
    _typingActive = false;
    if (mainWin && !mainWin.isDestroyed()) mainWin.showInactive();
    return;
  }
  await autoType(toType);
});

// Capture screen (returns data URL)
ipcMain.handle('capture-screen', async () => {
  try {
    if (mainWin) { mainWin.hide(); await new Promise(r => setTimeout(r, 200)); }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: getDisplaySize()
    });
    if (mainWin && !mainWin.isDestroyed()) mainWin.showInactive();
    if (sources && sources.length > 0) {
      const resized = sources[0].thumbnail.resize({ width: 1280 });
      return 'data:image/jpeg;base64,' + resized.toJPEG(80).toString('base64');
    }
    return null;
  } catch (e) {
    if (mainWin && !mainWin.isDestroyed()) mainWin.showInactive();
    console.error('[Main] capture-screen error:', e.message);
    return null;
  }
});

let _currentExamSessionId = null;

function getExamSessionId() {
  if (!_currentExamSessionId) {
    const d = new Date();
    const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = d.toTimeString().slice(0, 5).replace(/:/g, '');
    _currentExamSessionId = `session_${dateStr}_${timeStr}`;
  }
  return _currentExamSessionId;
}

async function archiveExamQuestion(licenseKey, imageBase64, question, answer) {
  if (!licenseKey || !answer || answer.startsWith('Unable to reach') || answer.startsWith('Analysis error')) return;
  try {
    const sessionId = getExamSessionId();
    const docId = `exam_${licenseKey}_${sessionId}`;
    const url = `https://firestore.googleapis.com/v1/projects/study-ai-f0bd7/databases/(default)/documents/licenses/${docId}`;
    
    let existingQuestions = [];
    try {
      const { status, data } = await firestoreGet(`licenses/${docId}`);
      if (status === 200 && data?.fields?.questions?.arrayValue?.values) {
        existingQuestions = data.fields.questions.arrayValue.values;
      }
    } catch (_) {}

    const now = new Date();
    const newQ = {
      mapValue: {
        fields: {
          time: { stringValue: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
          question: { stringValue: (question || '').substring(0, 2000) },
          answer: { stringValue: (answer || '').substring(0, 8000) },
          image: { stringValue: (imageBase64 || '').substring(0, 300000) }
        }
      }
    };

    existingQuestions.push(newQ);

    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          isExamSession: { booleanValue: true },
          licenseKey: { stringValue: licenseKey },
          sessionId: { stringValue: sessionId },
          sessionDate: { stringValue: now.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) },
          sessionTime: { stringValue: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
          questionCount: { integerValue: String(existingQuestions.length) },
          questions: { arrayValue: { values: existingQuestions } }
        }
      })
    });
  } catch (err) {
    console.error('[Archive] save error:', err.message);
  }
}

// Analyze screen via server (vision API)
ipcMain.handle('analyze-screen-server', async (_, { imageBase64, jobRole, resumeInfo, language, mode, userMessage }) => {
  try {
    const prompt = [
      userMessage || 'Analyze this screenshot and solve the interview question.',
      jobRole    ? `Job Role: ${jobRole}` : '',
      resumeInfo ? `My background: ${resumeInfo}` : '',
      language && language !== 'auto' ? `Preferred language: ${language}` : ''
    ].filter(Boolean).join('\n');

    const r = await httpPost(`${SERVER_BASE}/analyze`, {
      sessionToken: _sessionToken,
      licenseKey: _licenseKey,
      hwid: _hwid,
      question: prompt,
      imageBase64,
      mode: mode || 'interview'
    });

    if (r.status === 401) {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('session-expired');
      return { error: 'Session expired. Please restart the app.' };
    }
    if (r.body?.error) return { error: r.body.error };
    const ans = r.body?.answer || r.body?.text || 'No answer returned.';
    if (ans && !ans.startsWith('Unable to reach')) {
      archiveExamQuestion(_licenseKey, imageBase64, prompt, ans).catch(() => {});
    }
    return { answer: ans };
  } catch (e) {
    return { error: 'Network error: ' + e.message };
  }
});

// Call server (generic — used for transcription etc.)
ipcMain.handle('call-server', async (_, endpoint, body) => {
  try {
    const r = await httpPost(`${SERVER_BASE}/${endpoint}`, {
      ...body,
      sessionToken: _sessionToken,
      licenseKey: _licenseKey,
      hwid: _hwid
    });
    if (r.status === 401) {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('session-expired');
      return { error: 'unauthorized' };
    }
    return r.body;
  } catch (e) {
    return { error: e.message };
  }
});

// Get answer via server
ipcMain.on('get-answer', async (_, { question, jobRole, resumeInfo }) => {
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.webContents.send('answer-loading', true);
  try {
    const langSel = ''; // language comes from renderer
    const fullQuestion = [
      `CRITICAL ZERO-MISTAKE PROTOCOL: You are an expert ${jobRole || 'Software Engineer'} AI helping in a high-stakes exam. Accuracy must be 100%.`,
      resumeInfo ? `Candidate background: ${resumeInfo}` : '',
      '',
      `Question: ${question}`,
      '',
      '1. For MCQs: Start directly with "🎯 CORRECT OPTION: Option <Letter> — <Option Text>" in bold. Follow with step-by-step trace and distractor elimination.',
      '2. For Coding: Provide complete, optimal, working code with NO comments inside code blocks. Cover all hidden edge cases (0, negatives, empty, large bounds).',
      '3. For Numerical/Fill-in: State the exact value with required precision.'
    ].filter(l => l !== undefined).join('\n');

    const r = await httpPost(`${SERVER_BASE}/answer`, {
      sessionToken: _sessionToken,
      licenseKey: _licenseKey,
      hwid: _hwid,
      question: fullQuestion,
      jobRole,
      resumeInfo
    });

    mainWin.webContents.send('answer-loading', false);

    if (r.status === 401) {
      mainWin.webContents.send('session-expired');
      return;
    }
    if (r.body?.error) {
      mainWin.webContents.send('answer-result', { error: r.body.error });
      if (_silentMode) { try { shell.beep(); } catch (_) {} }
    } else {
      mainWin.webContents.send('answer-result', { answer: r.body?.answer || 'No answer.' });
      if (_silentMode) {
        try {
          shell.beep();
          setTimeout(() => { shell.beep(); }, 150);
        } catch (_) {}
      }
    }
  } catch (e) {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('answer-loading', false);
      mainWin.webContents.send('answer-result', { error: 'Network error: ' + e.message });
    }
  }
});

// Chat get-answer
ipcMain.on('chat-get-answer', async (_, { question, jobRole, resumeInfo, history, mode }) => {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    const r = await httpPost(`${SERVER_BASE}/chat`, {
      sessionToken: _sessionToken,
      licenseKey: _licenseKey,
      hwid: _hwid,
      question,
      jobRole,
      resumeInfo,
      history: history || [],
      mode: mode || 'chat'
    });

    if (r.status === 401) {
      mainWin.webContents.send('session-expired');
      return;
    }
    if (r.body?.error) {
      mainWin.webContents.send('chat-answer-result', { error: r.body.error });
      if (_silentMode) { try { shell.beep(); } catch (_) {} }
    } else {
      mainWin.webContents.send('chat-answer-result', { answer: r.body?.answer || 'No answer.' });
      if (_silentMode) {
        try {
          shell.beep();
          setTimeout(() => { shell.beep(); }, 150);
        } catch (_) {}
      }
    }
  } catch (e) {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('chat-answer-result', { error: 'Network error: ' + e.message });
    }
  }
});

// Login handler (from auth.html)
ipcMain.on('login-attempt', async (_, licenseKey) => {
  if (!authWin || authWin.isDestroyed()) return;
  try {
    const hwid = crypto.createHash('md5').update(os.hostname() + os.platform()).digest('hex').substring(0, 16);
    const r = await httpPost(`${SERVER_BASE}/login`, { licenseKey, hwid });
    if (r.body?.error || !r.body?.success) {
      const errMsg = r.body?.error === 'invalid_license' ? 'Invalid or expired license key.' : (r.body?.error || 'Login failed.');
      authWin.webContents.send('login-error', errMsg);
    } else {
      onLoginSuccess(r.body.sessionToken, licenseKey, hwid);
    }
  } catch (e) {
    if (authWin && !authWin.isDestroyed()) {
      authWin.webContents.send('login-error', 'Cannot reach server: ' + e.message + '. Is the backend running?');
    }
  }
});

// Login IPC (from renderer.html — alternative path)
ipcMain.handle('login', async (_, { licenseKey, hwid }) => {
  try {
    const r = await httpPost(`${SERVER_BASE}/login`, { licenseKey, hwid });
    if (r.body?.error || !r.body?.success) {
      return { error: r.body?.error || 'Login failed' };
    }
    _sessionToken = r.body.sessionToken || '';
    _licenseKey = licenseKey;
    _hwid = hwid;
    _defaultApiKey = 'server';
    saveSession({ sessionToken: _sessionToken, licenseKey, hwid });
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('set-default-key', 'server');
      mainWin.webContents.send('set-license-info', { licenseKey, hwid });
    }
    return { success: true };
  } catch (e) {
    return { error: 'Cannot reach server: ' + e.message };
  }
});


// Check update
ipcMain.handle('check-update', async () => {
  try {
    const r = await httpPost(`${SERVER_BASE}/version`, {});
    return r.body;
  } catch (_) {
    return { hasUpdate: false, version: app.getVersion() };
  }
});

// ── Cleanup (Panic Wipe on Ctrl+Shift+Q) ──────────────────────────────────────
function cleanup() {
  if (!hotkeysDone) {
    try { globalShortcut.unregisterAll(); } catch (_) {}
    hotkeysDone = true;
  }
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  if (_typingProc) { try { _typingProc.kill('SIGKILL'); } catch (_) {} _typingProc = null; }

  // 1. Wipe all API keys and session tokens from memory (RAM)
  _sessionToken = '';
  _defaultApiKey = '';
  _licenseApiKeys = [];
  _licenseKey = '';
  _hwid = '';

  // 2. Wipe saved session file from disk
  clearSession();

  // 3. Kill any guardian process
  try {
    const guardianPidFile = path.join(os.tmpdir(), '.rtbroker_guardian.pid');
    if (fs.existsSync(guardianPidFile)) {
      const guardianPid = parseInt(fs.readFileSync(guardianPidFile, 'utf8').trim(), 10);
      if (guardianPid) process.kill(guardianPid, 'SIGKILL');
      fs.unlinkSync(guardianPidFile);
    }
  } catch (_) {}

  try {
    const mainPidFile = path.join(os.tmpdir(), '.rtbroker_main.pid');
    if (fs.existsSync(mainPidFile)) fs.unlinkSync(mainPidFile);
  } catch (_) {}

  // 4. Wipe PowerShell terminal command history so no trace remains
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      execSync('powershell.exe -NoProfile -NonInteractive -Command "Remove-Item (Get-PSReadLineOption).HistorySavePath -ErrorAction SilentlyContinue"', { windowsHide: true });
    } else {
      execSync('rm -f ~/.bash_history ~/.zsh_history ~/.history', { stdio: 'ignore' });
    }
  } catch (_) {}
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  cleanup();
});

app.on('will-quit', () => {
  cleanup();
});

app.whenReady().then(async () => {
  cloakProcess();
  setInterval(cloakProcess, 15000);

  if (process.platform === 'darwin') {
    try { app.dock.hide(); } catch (_) {}
  }

  // Block auto-updater to avoid crashes
  try {
    const updater = require('electron-updater');
    updater.autoUpdater.checkForUpdates = async () => null;
    updater.autoUpdater.checkForUpdatesAndNotify = async () => null;
  } catch (_) {}

  // Try to restore saved session first
  const saved = loadSavedSession();
  if (saved) {
    // Verify the saved session is still valid
    try {
      const r = await httpPost(`${SERVER_BASE}/heartbeat`, {
        sessionToken: saved.sessionToken,
        licenseKey: saved.licenseKey,
        hwid: saved.hwid
      });
      if (r.status !== 401 && r.body?.valid !== false) {
        // Session still valid — go straight to main window
        _sessionToken = saved.sessionToken;
        _licenseKey   = saved.licenseKey;
        _hwid         = saved.hwid;
        _defaultApiKey = 'server';
        loadLicenseKeys(saved.licenseKey).catch(() => {});
        recordUserTelemetry(saved.licenseKey).catch(() => {});
        createWindow();
        registerHotkeys();
        console.log('[Interview Assistant] Restored session — skipping login.');
        return;
      }
    } catch (_) {
      // Server unreachable — assume session valid (offline mode)
      _sessionToken = saved.sessionToken;
      _licenseKey   = saved.licenseKey;
      _hwid         = saved.hwid;
      _defaultApiKey = 'server';
      loadLicenseKeys(saved.licenseKey).catch(() => {});
      recordUserTelemetry(saved.licenseKey).catch(() => {});
      createWindow();
      registerHotkeys();
      console.log('[Interview Assistant] Offline mode — using cached session.');
      return;
    }
    // Session expired — clear it and show login
    clearSession();
  }

  // No valid session — show auth window
  createAuthWindow();

  console.log('[Interview Assistant] Ready — waiting for license.');
});


console.log('[Interview Assistant] main.js loaded.');