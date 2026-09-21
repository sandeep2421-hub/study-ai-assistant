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

// ── Model & AI Configuration (Shared Module with Circuit Breakers) ─────────────
const {
  GEMINI_TIMEOUT_MS,
  TOTAL_REQUEST_DEADLINE_MS,
  MODEL_CONFIG,
  isKeyAvailable,
  recordKeySuccess,
  recordKeyError,
  isModelAvailable,
  recordModelUnavailable,
  recordModelBusy,
  recordModelSuccess,
  getMimeTypeFromBase64
} = require('./gemini-config');

async function executeGeminiDirect(body) {
  if (_licenseApiKeys.length === 0 && _licenseKey) {
    await loadLicenseKeys(_licenseKey);
  }

  if (!_licenseApiKeys || _licenseApiKeys.length === 0) {
    return { status: 401, body: { error: 'no_api_keys', answer: 'No API keys configured for this license.' } };
  }

  // Filter keys through circuit breaker
  const activeKeys = _licenseApiKeys.filter(isKeyAvailable);
  const keysToUse = activeKeys.length > 0 ? activeKeys : _licenseApiKeys;

  const question = body?.question || 'Help me.';
  const currentParts = [{ text: question }];

  if (body?.imageBase64) {
    const mimeType = getMimeTypeFromBase64(body.imageBase64);
    const data = body.imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    if (data) currentParts.push({ inlineData: { mimeType, data } });
  }

  if (Array.isArray(body?.extraImages)) {
    for (const extraImg of body.extraImages.slice(0, 3)) {
      if (!extraImg) continue;
      const mimeType = getMimeTypeFromBase64(extraImg);
      const data = extraImg.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
      if (data) currentParts.push({ inlineData: { mimeType, data } });
    }
  }

  // Multi-turn conversation history (bounded to last 4 turns)
  let contents = [];
  if (Array.isArray(body?.history) && body.history.length > 0) {
    const recentHistory = body.history.slice(-4);
    let expectedRole = 'user';
    for (const h of recentHistory) {
      const role = (h.role === 'assistant' || h.role === 'model' || h.role === 'ai') ? 'model' : 'user';
      const text = (h.content || '').trim();
      if (!text) continue;
      if (role === expectedRole) {
        contents.push({ role, parts: [{ text }] });
        expectedRole = expectedRole === 'user' ? 'model' : 'user';
      } else if (contents.length > 0 && role === contents[contents.length - 1].role) {
        contents[contents.length - 1].parts[0].text += '\n' + text;
      }
    }
    while (contents.length > 0 && contents[0].role !== 'user') contents.shift();
    while (contents.length > 0 && contents[contents.length - 1].role !== 'model') contents.pop();
  }

  contents.push({ role: 'user', parts: currentParts });

  const allModels = [MODEL_CONFIG.primary, ...MODEL_CONFIG.fallbacks];
  const candidateModels = allModels.filter(isModelAvailable);
  const modelsToTry = candidateModels.length > 0 ? candidateModels : allModels;

  const reqBody = JSON.stringify({
    contents,
    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      maxOutputTokens: 8192
    }
  });

  let lastErrorMsg = '';
  let attemptCount = 0;
  const overallStart = Date.now();

  // Deterministic Key + Model Matrix: Key -> Primary Model -> Fallback Model
  keyLoop:
  for (let keyIdx = 0; keyIdx < keysToUse.length; keyIdx++) {
    const apiKey = keysToUse[keyIdx];
    const keyDisplay = `...${apiKey.slice(-6)}`;

    for (let modelIdx = 0; modelIdx < modelsToTry.length; modelIdx++) {
      // Check total request deadline
      const elapsedTotal = Date.now() - overallStart;
      const remainingTotal = TOTAL_REQUEST_DEADLINE_MS - elapsedTotal;
      if (remainingTotal <= 1500) {
        console.warn(`[Gemini Direct] ⏱ Total request deadline (${TOTAL_REQUEST_DEADLINE_MS / 1000}s) reached -> aborting further fallbacks`);
        break keyLoop;
      }

      const model = modelsToTry[modelIdx];
      if (!isModelAvailable(model)) continue;

      attemptCount++;
      const apiStart = Date.now();
      const currentAttemptTimeout = Math.min(GEMINI_TIMEOUT_MS, remainingTotal);

      try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(currentAttemptTimeout),
          body: reqBody
        });

        const apiDuration = Date.now() - apiStart;
        const totalDuration = Date.now() - overallStart;

        if (resp.ok) {
          const resJson = await resp.json();
          const text = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text && text.trim()) {
            recordKeySuccess(apiKey);
            recordModelSuccess(model);
            console.log(`[Gemini Direct] ✓ SUCCESS | Model: ${model} | Key: ${keyDisplay} | API: ${apiDuration}ms | Total: ${totalDuration}ms | Attempts: ${attemptCount}`);
            return { status: 200, body: { answer: text } };
          }
        }

        const httpStatus = resp.status;
        const errJson = await resp.json().catch(() => ({}));
        const errMsg = errJson?.error?.message || `HTTP ${httpStatus}`;
        lastErrorMsg = errMsg;
        console.warn(`[Gemini Direct] ⚠️ Error ${httpStatus} | Model: ${model} | Key: ${keyDisplay} | API: ${apiDuration}ms: ${errMsg}`);

        // Deterministic Error Handling & Circuit Breaking
        // 1. Model Not Found (404 / 400 not found) -> permanent session breaker
        if (httpStatus === 404 || (httpStatus === 400 && errMsg.toLowerCase().includes('not found'))) {
          recordModelUnavailable(model, errMsg);
          continue;
        }

        // 2. High Demand / 503 / Server Overloaded -> 30s model cooldown, immediately switch model
        if (httpStatus === 503 || httpStatus === 500 || errMsg.toLowerCase().includes('high demand') || errMsg.toLowerCase().includes('overloaded')) {
          recordModelBusy(model, 30000, errMsg);
          console.warn(`[Gemini Direct] Model ${model} high demand (503) -> switching immediately to fallback model`);
          continue;
        }

        // 3. Quota / Rate Limited on Key (429) -> 60s key cooldown, rotate key
        if (httpStatus === 429) {
          recordKeyError(apiKey, 429, errMsg);
          console.warn(`[Gemini Direct] Key ${keyDisplay} rate-limited (429) -> rotating to next key`);
          break; // Break model loop, switch to next key
        }

        // 4. Bad / Unauthorized Key (401 / 403) -> permanent session disable
        if (httpStatus === 401 || httpStatus === 403) {
          recordKeyError(apiKey, httpStatus, errMsg);
          console.warn(`[Gemini Direct] Key ${keyDisplay} invalid (${httpStatus}) -> disabling key`);
          break; // Break model loop, switch to next key
        }

        // 5xx or other transient errors: continue to next fallback model
      } catch (err) {
        const apiDuration = Date.now() - apiStart;
        const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
        lastErrorMsg = isTimeout ? `Request timed out after ${Math.round(currentAttemptTimeout / 1000)}s` : err.message;
        console.warn(`[Gemini Direct] ❌ Network/Timeout | Model: ${model} | Key: ${keyDisplay} | API: ${apiDuration}ms: ${lastErrorMsg}`);
      }
    }
  }

  const totalDuration = Date.now() - overallStart;
  console.error(`[Gemini Direct] ❌ All attempts exhausted (${attemptCount} attempts, ${totalDuration}ms). Last error: ${lastErrorMsg}`);

  return {
    status: 200,
    body: {
      answer: `Unable to generate answer (${lastErrorMsg || 'All models and API keys failed'}). Please check your connection and API key quota.`
    }
  };
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
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
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
      return await executeGeminiDirect(body);
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
        const dataUrl = 'data:image/jpeg;base64,' + resized.toJPEG(85).toString('base64');
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

    // Ctrl+Shift+V / Alt+Shift+V — auto-type last code at OS cursor
  const triggerAutoType = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    console.log('[Main] Auto-Type triggered');
    mainWin.hide(); // hide so focus returns to coding editor
    setTimeout(() => {
      console.log('[Main] Requesting code from renderer...');
      mainWin?.webContents.send('get-last-code-for-typing');
    }, 150);
  };
  globalShortcut.register('CommandOrControl+Shift+V', triggerAutoType);
  globalShortcut.register('Alt+Shift+V', triggerAutoType);

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
    if (panicCount >= 3) {
      cleanup();
      process.kill(process.pid, 'SIGKILL');
    }
  });

  console.log('[Interview Assistant] All hotkeys registered.');
}

// ── Auto-type via PowerShell stdin pipe ────────────────────────────────────────
function detectLanguage(code) {
  if (!code) return 'unknown';
  if (/#include\b|std::|vector\s*<|cout\s*<<|cin\s*>>|nullptr\b|\bpublic:\b|\bprivate:\b/.test(code)) return 'cpp';
  if (/\b(public\s+static|System\.out\.print|Scanner\s+\w+|BufferedReader|String\[\]\s+args|ArrayList\s*<|HashMap\s*<)\b/.test(code)) return 'java';
  if (/\b(public|private|protected)\s+(int|void|boolean|String|double|float|long|char|List|Map|Set)\s+\w+\(/.test(code)) return 'java';
  if (/\b(def\s+\w+|elif\b|self\b|class\s+\w+:|import\s+sys|from\s+\w+\s+import)\b|:\s*$/m.test(code)) return 'python';
  if (/\b(function\s+\w+|var\s+\w+|const\s+\w+|let\s+\w+|console\.log)\b/.test(code)) return 'javascript';
  if (/\b(int|void|bool|double|float|long\s+long)\s+\w+\(/.test(code)) return 'cpp';
  return 'unknown';
}

function autoHealCode(code) {
  if (!code) return '';
  let healed = code.trim();
  const lang = detectLanguage(healed);

  // Strip 'public' from 'public class Solution' so javac Main.java compiles
  healed = healed.replace(/\bpublic\s+class\s+Solution\b/g, 'class Solution');

  if (lang === 'java') {
    if (!healed.includes('import java.util.') && !healed.includes('import java.util.*;')) {
      healed = 'import java.util.*;\nimport java.io.*;\n\n' + healed;
    }
  } else if (lang === 'cpp') {
    if (!healed.includes('#include')) {
      healed = '#include <bits/stdc++.h>\nusing namespace std;\n\n' + healed;
    } else if (!healed.includes('using namespace std;') && !healed.includes('std::')) {
      healed = 'using namespace std;\n' + healed;
    }
  } else if (lang === 'python') {
    const pyImports = [];
    if (/\breduce\(/.test(healed) && !healed.includes('reduce')) pyImports.push('from functools import reduce');
    if (/\b(deque|defaultdict|Counter|OrderedDict)\b/.test(healed) && !healed.includes('from collections import')) {
      pyImports.push('from collections import deque, defaultdict, Counter');
    }
    if (/\b(heappush|heappop|heapify|heapq)\b/.test(healed) && !healed.includes('heapq')) {
      pyImports.push('import heapq\nfrom heapq import heappush, heappop, heapify');
    }
    if (/\bbisect/.test(healed) && !healed.includes('bisect')) {
      pyImports.push('import bisect\nfrom bisect import bisect_left, bisect_right');
    }
    if (/\bmath\./.test(healed) && !healed.includes('import math')) pyImports.push('import math');
    if (/\bsys\./.test(healed) && !healed.includes('import sys')) pyImports.push('import sys');
    if (/\bre\./.test(healed) && !healed.includes('import re')) pyImports.push('import re');
    if (/\b(List|Dict|Tuple|Set|Optional|Any)\[/.test(healed) && !healed.includes('typing')) {
      pyImports.push('from typing import List, Dict, Tuple, Set, Optional, Any');
    }
    if (pyImports.length > 0) {
      healed = [...new Set(pyImports)].join('\n') + '\n\n' + healed;
    }
  }

  return healed;
}

function extractCode(text) {
  if (!text) return '';
  const t = text.trim();
  let result = '';

  // Extract ALL code blocks and pick the largest complete solution
  const allMatches = [...t.matchAll(/\`\`\`(?:[\w]*)?[ \t]*\n?([\s\S]*?)\`\`\`/g)];
  if (allMatches.length > 0) {
    result = allMatches.reduce((best, m) => m[1].trim().length > best.length ? m[1].trim() : best, '');
  } else if (t.startsWith('```')) {
    const lines = t.split('\n'); lines.shift();
    if (lines[lines.length - 1]?.trim() === '```') lines.pop();
    result = lines.join('\n').trim();
  } else {
    result = t;
  }

  // Auto-heal missing imports and class definitions
  result = autoHealCode(result);
  return result;
}

async function autoType(code) {
  if (_typingActive) {
    console.log('[Main] Mutex block: already typing');
    return false;
  }
  _typingActive = true;
  console.log('[Main] autoType called with code length:', code ? code.length : 0);
  try {
    const clean = extractCode(code).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '    ');
    if (!clean) {
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

    public static void EnsureModifiersReleased() {
        // Wait up to 2 seconds for user to release Ctrl (0x11), Shift (0x10), Alt (0x12), Win (0x5B, 0x5C)
        int timeout = 0;
        while (timeout < 40 && ((GetAsyncKeyState(0x11) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x10) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x12) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x5B) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x5C) & 0x8000) != 0)) {
            Thread.Sleep(50);
            timeout++;
        }
        // Force release modifier states so no Ctrl+W or Alt+F4 occurs
        ReleaseVk(0x11);
        ReleaseVk(0x10);
        ReleaseVk(0x12);
        ReleaseVk(0x5B);
        ReleaseVk(0x5C);
        Thread.Sleep(80);
    }

    public static void ClearAll() {
        EnsureModifiersReleased();
        PressVk(0x11); // Ctrl down
        Thread.Sleep(30);
        SendVk(0x41);  // A
        Thread.Sleep(30);
        ReleaseVk(0x11); // Ctrl up
        Thread.Sleep(100);
        SendVk(0x08);  // Backspace
        Thread.Sleep(300);
    }

        public static void TypeString(string s, int minDelay, int maxDelay) {
        EnsureModifiersReleased();
        Random rand = new Random();
        int pos = 0;

        while (pos < s.Length) {
            char c = s[pos];

            if ((int)c == 13) { pos++; continue; } // skip CR

            if ((int)c == 10) { // LF newline
                // 1. Calculate how many leading spaces the NEXT line has in string s
                int nextIndent = 0;
                int j = pos + 1;
                while (j < s.Length && (int)s[j] == 13) j++; // skip any CR
                while (j < s.Length && s[j] == ' ') { nextIndent++; j++; }

                // 2. Press Enter to create the newline
                SendVk(0x0D); // Enter
                Thread.Sleep(100);

                // 3. Clear whatever auto-indentation the editor automatically inserted:
                // Shift+Home selects from current cursor back to start of line (column 0)
                PressVk(0x10);       // Shift down
                Thread.Sleep(15);
                SendExtVk(0x24);     // Home (Extended key)
                Thread.Sleep(15);
                ReleaseVk(0x10);     // Shift up
                Thread.Sleep(15);
                SendVk(0x08);        // Backspace (deletes selected auto-indent)
                Thread.Sleep(20);

                // 4. Type the EXACT target leading spaces for this line
                for (int sp = 0; sp < nextIndent; sp++) {
                    TypeChar(' ');
                    Thread.Sleep(12);
                }

                // 5. Jump pos to j (first non-space character of the next line)
                pos = j;
            } else {
                TypeChar(c);
                int delay = rand.Next(minDelay, maxDelay);
                if (c == ' ') {
                    delay = rand.Next(minDelay + 5, maxDelay + 10);
                } else if (c == '.' || c == ';' || c == '{' || c == '}' || c == '(' || c == ')' || c == ':') {
                    delay = rand.Next(minDelay + 15, maxDelay + 25);
                }
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

    public static void EnsureModifiersReleased() {
        int timeout = 0;
        while (timeout < 40 && ((GetAsyncKeyState(0x11) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x10) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x12) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x5B) & 0x8000) != 0 ||
                               (GetAsyncKeyState(0x5C) & 0x8000) != 0)) {
            Thread.Sleep(50);
            timeout++;
        }
        ReleaseVk(0x11);
        ReleaseVk(0x10);
        ReleaseVk(0x12);
        ReleaseVk(0x5B);
        ReleaseVk(0x5C);
        Thread.Sleep(80);
    }

    public static void ClearAll() {
        EnsureModifiersReleased();
        PressVk(0x11); // Ctrl down
        Thread.Sleep(30);
        SendVk(0x41);  // A
        Thread.Sleep(30);
        ReleaseVk(0x11); // Ctrl up
        Thread.Sleep(100);
        SendVk(0x08);  // Backspace
        Thread.Sleep(300);
    }

        public static void TypeString(string s, int minDelay, int maxDelay) {
        EnsureModifiersReleased();
        Random rand = new Random();
        int pos = 0;

        while (pos < s.Length) {
            char c = s[pos];

            if ((int)c == 13) { pos++; continue; } // skip CR

            if ((int)c == 10) { // LF newline
                // 1. Calculate how many leading spaces the NEXT line has in string s
                int nextIndent = 0;
                int j = pos + 1;
                while (j < s.Length && (int)s[j] == 13) j++; // skip any CR
                while (j < s.Length && s[j] == ' ') { nextIndent++; j++; }

                // 2. Press Enter to create the newline
                SendVk(0x0D); // Enter
                Thread.Sleep(100);

                // 3. Clear whatever auto-indentation the editor automatically inserted:
                // Shift+Home selects from current cursor back to start of line (column 0)
                PressVk(0x10);       // Shift down
                Thread.Sleep(15);
                SendExtVk(0x24);     // Home (Extended key)
                Thread.Sleep(15);
                ReleaseVk(0x10);     // Shift up
                Thread.Sleep(15);
                SendVk(0x08);        // Backspace (deletes selected auto-indent)
                Thread.Sleep(20);

                // 4. Type the EXACT target leading spaces for this line
                for (int sp = 0; sp < nextIndent; sp++) {
                    TypeChar(' ');
                    Thread.Sleep(12);
                }

                // 5. Jump pos to j (first non-space character of the next line)
                pos = j;
            } else {
                TypeChar(c);
                int delay = rand.Next(minDelay, maxDelay);
                if (c == ' ') {
                    delay = rand.Next(minDelay + 5, maxDelay + 10);
                } else if (c == '.' || c == ';' || c == '{' || c == '}' || c == '(' || c == ')' || c == ':') {
                    delay = rand.Next(minDelay + 15, maxDelay + 25);
                }
                Thread.Sleep(delay);
                pos++;
            }
        }
    }
}
"@
}

Add-Type -TypeDefinition $Signature -ErrorAction Stop

Start-Sleep -Milliseconds 1500

[HelperInput]::ClearAll()

$payload = $env:TYPING_PAYLOAD
if ($payload) {
    [HelperInput]::TypeString($payload, 20, 35)
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
    if (mainWin && !mainWin.isDestroyed()) mainWin.showInactive();
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
      return 'data:image/jpeg;base64,' + resized.toJPEG(85).toString('base64');
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
ipcMain.handle('analyze-screen-server', async (_, { imageBase64, extraImages, jobRole, resumeInfo, language, mode, userMessage, history }) => {
  try {
    const defaultUserPrompt = "CRITICAL ZERO-MISTAKE & 100% COMPILER PASS PROTOCOL:\nYou are a competitive programming world champion and expert technical assessment solver.\nAnalyze the problem with absolute precision and provide a 100% complete, flawless solution that passes ALL test cases on the FIRST ATTEMPT.\n\n1. FOR CODING & DATA STRUCTURES (CAMPUS / COMPANY ASSESSMENTS & ONLINE JUDGES):\n   - FULL PROBLEM SCOPE & NARRATIVE ANALYSIS: Carefully read the problem title and introductory story. If the problem describes multiple operations (e.g., search + reversal, insert + display, filter + aggregate, sorting + query), implement and output ALL operations.\n   - OUTPUT FORMAT & PARTIAL VIEW INFERENCE: If the problem description or Output Format is partially scrolled or cut off in the screenshot, infer the standard full output format required by the platform (e.g. Line 1: Status message like \"Data point is present in the dataset\" / \"Data point isn't present in the dataset\", Line 2: Reversed space-separated list of elements).\n   - EXACT STRING MATCHING: Match the exact wording, casing, punctuation, and contractions from the problem statement (e.g., \"Data point isn't present in the dataset\" vs \"Data point is present in the dataset\").\n   - COMPLETE RUNNABLE IMPLEMENTATION:\n     * For competitive programming / standard I/O judges (NeoColab, HackerRank, CodeTantra, Mettl): Provide complete runnable code with standard input reading (Java: Scanner/BufferedReader, C++: cin with fast I/O, Python: sys.stdin.read().split()) and exact formatting without extra debug text.\n     * For class/method judges (LeetCode): Match the exact class Solution and method signature.\n   - OPTIMAL TIME & SPACE COMPLEXITY: Implement the most optimal algorithmic approach (O(N) or O(N log N)) to prevent any Time Limit Exceeded (TLE) errors.\n   - ZERO CODE COMMENTS: Do not include internal comments inside the code block so that auto-typing completes cleanly and quickly.\n\n2. FOR MCQs (Code-Trace / Logic / Theory):\n   - FIRST LINE: State directly: \"**🎯 Correct Option: Option <Letter> - <Option Text>**\"\n   - STEP-BY-STEP TRACE: Show line-by-line variable state transitions, loop conditions, and execution output.\n   - TRAP EXPLANATION: Briefly explain why other options are incorrect.\n\n3. FOR NUMERICAL / FILL-IN-THE-BLANKS: State the exact required value or output.";
    
    let combinedPrompt = userMessage || defaultUserPrompt;
    if (userMessage && !userMessage.includes('CRITICAL ZERO-MISTAKE')) {
      combinedPrompt = `${defaultUserPrompt}\n\n[USER REQUEST / QUESTION]:\n${userMessage}`;
    }

    const prompt = [
      combinedPrompt,
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
      extraImages: extraImages || [],
      history: history || [],
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
      'CRITICAL ZERO-MISTAKE & 100% COMPILER PASS PROTOCOL: You are an elite competitive programmer and AI technical exam solver. Analyze the screenshot and provide a complete, 100% accurate, flawless solution. Never return only labels like MCQ/coding/question.',
      (jobRole ? ('Job Role: ' + jobRole) : ''),
      (resumeInfo ? ('Candidate background: ' + resumeInfo) : ''),
      '',
      ('Question / Problem Context: ' + question),
      '',
      '1. FOR MCQs (Code-Trace / Theory / Logic / Math):',
      '   - FIRST LINE: State directly: "🎯 Correct Option: Option <Letter> — <Option Text>" in bold.',
      '   - STEP-BY-STEP TRACE: If question contains code, trace execution line-by-line showing exact variable state changes per iteration, loop conditions, pointer changes, bitwise math, and output.',
      '   - DISTRACTOR ELIMINATION: Briefly state why each incorrect option is a trap.',
      '2. FOR CODING & DATA STRUCTURES:',
      '   - LANGUAGE DETECTION & SIGNATURE MATCH: Match the exact target language, class name, function name, parameter types, and return signature.',
      '   - ZERO-ERROR COMPILATION GUARANTEE: The code MUST compile with ZERO errors on modern compilers. Include all standard imports.',
      '   - OPTIMAL TIME & SPACE COMPLEXITY: Always implement the most optimal algorithmic solution to guarantee 100% passing test cases with ZERO TLE.',
      '   - SHORT, CONCISE & ELEGANT CODE: Write compact, minimal lines of clean code with NO comments inside code blocks for fast auto-typing.',
      '   - HIDDEN EDGE CASES: Handle extreme inputs (empty/null, single elements, negatives, 0, large constraints up to 10^5/10^9).',
      '3. FOR NUMERICAL / FILL-IN-THE-BLANKS: State the exact mathematical value or string required.',
      'Prioritize 100% correctness, optimal complexity, and compilation validity.'
    ].filter(Boolean).join('\n');

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
    const defaultUserPrompt = "CRITICAL ZERO-MISTAKE & 100% COMPILER PASS PROTOCOL:\nYou are a competitive programming world champion and expert technical assessment solver.\nAnalyze the problem with absolute precision and provide a 100% complete, flawless solution that passes ALL test cases on the FIRST ATTEMPT.\n\n1. FOR CODING & DATA STRUCTURES (CAMPUS / COMPANY ASSESSMENTS & ONLINE JUDGES):\n   - FULL PROBLEM SCOPE & NARRATIVE ANALYSIS: Carefully read the problem title and introductory story. If the problem describes multiple operations (e.g., search + reversal, insert + display, filter + aggregate, sorting + query), implement and output ALL operations.\n   - OUTPUT FORMAT & PARTIAL VIEW INFERENCE: If the problem description or Output Format is partially scrolled or cut off in the screenshot, infer the standard full output format required by the platform (e.g. Line 1: Status message like \"Data point is present in the dataset\" / \"Data point isn't present in the dataset\", Line 2: Reversed space-separated list of elements).\n   - EXACT STRING MATCHING: Match the exact wording, casing, punctuation, and contractions from the problem statement (e.g., \"Data point isn't present in the dataset\" vs \"Data point is present in the dataset\").\n   - COMPLETE RUNNABLE IMPLEMENTATION:\n     * For competitive programming / standard I/O judges (NeoColab, HackerRank, CodeTantra, Mettl): Provide complete runnable code with standard input reading (Java: Scanner/BufferedReader, C++: cin with fast I/O, Python: sys.stdin.read().split()) and exact formatting without extra debug text.\n     * For class/method judges (LeetCode): Match the exact class Solution and method signature.\n   - OPTIMAL TIME & SPACE COMPLEXITY: Implement the most optimal algorithmic approach (O(N) or O(N log N)) to prevent any Time Limit Exceeded (TLE) errors.\n   - ZERO CODE COMMENTS: Do not include internal comments inside the code block so that auto-typing completes cleanly and quickly.\n\n2. FOR MCQs (Code-Trace / Logic / Theory):\n   - FIRST LINE: State directly: \"**🎯 Correct Option: Option <Letter> - <Option Text>**\"\n   - STEP-BY-STEP TRACE: Show line-by-line variable state transitions, loop conditions, and execution output.\n   - TRAP EXPLANATION: Briefly explain why other options are incorrect.\n\n3. FOR NUMERICAL / FILL-IN-THE-BLANKS: State the exact required value or output.";

    let promptText = question || defaultUserPrompt;
    if (question && !question.includes('CRITICAL ZERO-MISTAKE')) {
      promptText = `${defaultUserPrompt}\n\n[USER QUESTION / INPUT]:\n${question}`;
    }

    const r = await httpPost(`${SERVER_BASE}/chat`, {
      sessionToken: _sessionToken,
      licenseKey: _licenseKey,
      hwid: _hwid,
      question: promptText,
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
let _cleanedUp = false;
function cleanup() {
  if (_cleanedUp) return;
  _cleanedUp = true;

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

  // 5. Total Self-Destruct Wipe: Asynchronously delete installation directory (%LOCALAPPDATA%\vit) & temp files
  try {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const installFolder = path.join(localAppData, 'vit');
      const tempDir = os.tmpdir();

      const wipeCmd = `Start-Sleep -Milliseconds 1500; ` +
        `Get-Process | Where-Object { $_.Path -like '*\\AppData\\Local\\vit\\*' } | Stop-Process -Force -ErrorAction SilentlyContinue; ` +
        `if (Test-Path '${installFolder}') { Remove-Item -Path '${installFolder}' -Recurse -Force -ErrorAction SilentlyContinue }; ` +
        `Remove-Item (Join-Path '${tempDir}' '.engoulp_sess') -Force -ErrorAction SilentlyContinue; ` +
        `Remove-Item (Join-Path '${tempDir}' 'autotype_*') -Force -ErrorAction SilentlyContinue; ` +
        `Remove-Item (Join-Path '${tempDir}' 'vit-*') -Recurse -Force -ErrorAction SilentlyContinue; ` +
        `Remove-Item (Get-PSReadLineOption).HistorySavePath -ErrorAction SilentlyContinue`;

      const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', wipeCmd], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } else {
      const wipeCmd = 'sleep 1.5 && rm -rf /tmp/vit-* ~/.local/share/vit ~/.cache/vit ~/.bash_history ~/.zsh_history ~/.history';
      const child = spawn('sh', ['-c', wipeCmd], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
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