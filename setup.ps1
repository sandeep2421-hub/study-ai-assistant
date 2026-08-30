$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$installDir = "$env:LOCALAPPDATA\vit"
$runtimeDir = "$installDir\runtime"
$appDir     = "$installDir\study-ai-assistant-main"
$zipPath    = "$env:TEMP\vit-setup-temp.zip"
$nodeZipPath = "$env:TEMP\vit-node-portable.zip"
$sourceUrl  = "https://github.com/sandeep2421-hub/study-ai-assistant/archive/refs/heads/main.zip"
$nodeZipUrl = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip"

Write-Host ""
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "     VIT AI System Checkup & Setup" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host ""

# 1. Kill any existing instances
Get-Process -Name "electron","StudyAI","vit" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. System Diagnostic & Node.js Runtime Checkup
Write-Host "[1/4] Checking System Requirements..." -ForegroundColor Cyan

$nodeExe = ""
$npmCmd  = ""

# Check standard system paths
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeExe = (Get-Command node).Source
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        $npmCmd = (Get-Command npm).Source
    }
} elseif (Test-Path "C:\Program Files\nodejs\node.exe") {
    $nodeExe = "C:\Program Files\nodejs\node.exe"
    $npmCmd  = "C:\Program Files\nodejs\npm.cmd"
} elseif (Test-Path "$runtimeDir\node.exe") {
    $nodeExe = "$runtimeDir\node.exe"
    $npmCmd  = "$runtimeDir\npm.cmd"
}

# If Node.js is missing, download & extract Portable Standalone Runtime (No Admin Rights Needed)
if (-not $nodeExe -or -not (Test-Path $nodeExe)) {
    Write-Host "      -> Node.js not detected. Downloading portable runtime..." -ForegroundColor Yellow
    try {
        Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeZipPath -UseBasicParsing
    } catch {
        & curl.exe -L -s -o $nodeZipPath $nodeZipUrl
    }

    if (Test-Path $nodeZipPath) {
        Write-Host "      -> Extracting portable runtime..." -ForegroundColor Yellow
        $tempNodeExtract = "$env:TEMP\vit-node-extract"
        if (Test-Path $tempNodeExtract) { Remove-Item -Path $tempNodeExtract -Recurse -Force }
        Expand-Archive -Path $nodeZipPath -DestinationPath $tempNodeExtract -Force
        Remove-Item -Path $nodeZipPath -Force -ErrorAction SilentlyContinue

        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
        Copy-Item -Path "$tempNodeExtract\node-v20.18.0-win-x64\*" -Destination $runtimeDir -Recurse -Force
        Remove-Item -Path $tempNodeExtract -Recurse -Force -ErrorAction SilentlyContinue

        $nodeExe = "$runtimeDir\node.exe"
        $npmCmd  = "$runtimeDir\npm.cmd"
        Write-Host "      [OK] Portable runtime ready." -ForegroundColor Green
    } else {
        Write-Host "      [ERROR] Could not download runtime." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "      [OK] Node runtime verified ($nodeExe)" -ForegroundColor Green
}

# Update Session PATH
$nodeDir = Split-Path -Parent $nodeExe
$env:PATH = "$nodeDir;" + $env:PATH
if (-not $npmCmd) { $npmCmd = "$nodeDir\npm.cmd" }

# 3. Download Latest Application Package
Write-Host "[2/4] Downloading Application Package..." -ForegroundColor Cyan
try { Invoke-WebRequest -Uri $sourceUrl -OutFile $zipPath -UseBasicParsing } catch { & curl.exe -L -s -o $zipPath $sourceUrl }

if (-not (Test-Path $zipPath)) {
    Write-Host "[ERROR] Download failed. Check your internet connection." -ForegroundColor Red
    exit 1
}

# 4. Extract Application Package (Preserving existing modules)
Write-Host "[3/4] Extracting Package..." -ForegroundColor Cyan
$tempExtract = "$env:TEMP\vit-extract"
if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $tempExtract -Force
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item -Path "$tempExtract\study-ai-assistant-main\*" -Destination $appDir -Recurse -Force
Remove-Item -Path $tempExtract -Recurse -Force -ErrorAction SilentlyContinue

# 5. Dependency Check & Resolution
Write-Host "[4/4] Verifying Engine & Dependencies..." -ForegroundColor Cyan
$electronExe = "$appDir\node_modules\electron\dist\electron.exe"

if (-not (Test-Path $electronExe)) {
    Write-Host "      -> Installing core modules (one-time setup, ~30s)..." -ForegroundColor Yellow
    Push-Location $appDir
    $ErrorActionPreference = 'Continue'
    & $npmCmd install --no-audit --no-fund 2>&1 | Write-Host
    $ErrorActionPreference = 'SilentlyContinue'
    Pop-Location
}

# Retry if binary missing
$electronExe = "$appDir\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
    Write-Host "      -> Finalizing Electron binary..." -ForegroundColor Yellow
    Push-Location $appDir
    $ErrorActionPreference = 'Continue'
    & $npmCmd install electron@28.2.0 --save-dev --no-audit --no-fund 2>&1 | Write-Host
    $ErrorActionPreference = 'SilentlyContinue'
    Pop-Location
}

# 6. Reset old session cache so License Verification box ALWAYS appears
Remove-Item (Join-Path $env:TEMP '.engoulp_sess') -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "         All Systems Ready!" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "Ctrl+Shift+H   Hide / show window" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+I   Open AI Chat Panel" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+S   Silent screen capture" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+A   Ask / generate answer" -ForegroundColor Cyan
Write-Host ""
Write-Host "[VIT] Launching License Verification..." -ForegroundColor Green

# 7. Launch App as independent detached process (safe to close terminal)
$electronExe = "$appDir\node_modules\electron\dist\electron.exe"
if (Test-Path $electronExe) {
    Start-Process -FilePath $electronExe -ArgumentList "main.js" -WorkingDirectory $appDir
    Write-Host "[VIT] App running! You can safely close this PowerShell window." -ForegroundColor Green
} else {
    Write-Host "[ERROR] Launch failed. Please re-run the command." -ForegroundColor Red
}
