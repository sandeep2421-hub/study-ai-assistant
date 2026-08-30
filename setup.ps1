$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$installDir = "$env:LOCALAPPDATA\vit"
$appDir     = "$installDir\study-ai-assistant-main"
$zipPath    = "$env:TEMP\vit-setup-temp.zip"
$sourceUrl  = "https://github.com/sandeep2421-hub/study-ai-assistant/archive/refs/heads/main.zip"

Write-Host ""
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "         VIT Windows Setup" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host ""

# 1. Kill old instances
Get-Process -Name "electron","StudyAI","vit" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. Ensure Node.js exists
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and -not (Test-Path "C:\Program Files\nodejs\node.exe")) {
    Write-Host "[VIT] Installing Node.js..." -ForegroundColor Yellow
    $nodeInstaller = "$env:TEMP\node-setup.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi" -OutFile $nodeInstaller -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /quiet /norestart" -Wait
}
if (Test-Path "C:\Program Files\nodejs") { $env:PATH = "C:\Program Files\nodejs;" + $env:PATH }
$npmCmd = "C:\Program Files\nodejs\npm.cmd"

# 3. Download app
Write-Host "[VIT] Downloading app..." -ForegroundColor Cyan
try { Invoke-WebRequest -Uri $sourceUrl -OutFile $zipPath -UseBasicParsing } catch { & curl.exe -L -s -o $zipPath $sourceUrl }
if (-not (Test-Path $zipPath)) { Write-Host "[ERROR] Download failed." -ForegroundColor Red; exit 1 }

# 4. Extract
Write-Host "[VIT] Extracting..." -ForegroundColor Cyan
$tempExtract = "$env:TEMP\vit-extract"
if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $tempExtract -Force
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item -Path "$tempExtract\study-ai-assistant-main\*" -Destination $appDir -Recurse -Force
Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue

# 5. Install dependencies (DO NOT silence — must see errors)
$electronExe = "$appDir\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
    Write-Host "[VIT] Installing dependencies (one-time, ~60 seconds)..." -ForegroundColor Cyan
    Push-Location $appDir
    $ErrorActionPreference = 'Continue'
    & $npmCmd install --no-audit --no-fund 2>&1 | Write-Host
    $ErrorActionPreference = 'SilentlyContinue'
    Pop-Location
}

# 6. Verify electron installed
$electronExe = "$appDir\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
    Write-Host "[VIT] Retrying Electron install..." -ForegroundColor Yellow
    Push-Location $appDir
    $ErrorActionPreference = 'Continue'
    & $npmCmd install electron@28.2.0 --save-dev --no-audit --no-fund 2>&1 | Write-Host
    $ErrorActionPreference = 'SilentlyContinue'
    Pop-Location
}

# 7. Clear old session so license box always shows
Remove-Item (Join-Path $env:TEMP '.engoulp_sess') -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "          Setup complete!" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "Ctrl+Shift+H   Hide / show window" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+I   Open AI Chat Panel" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+S   Silent screen capture" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+A   Ask / generate answer" -ForegroundColor Cyan
Write-Host ""

# 8. Launch app directly in foreground
$electronExe = "$appDir\node_modules\electron\dist\electron.exe"
if (Test-Path $electronExe) {
    Write-Host "[VIT] Opening License Verification..." -ForegroundColor Green
    Set-Location $appDir
    & $electronExe main.js
} else {
    Write-Host "[ERROR] Electron not found. Run: npm install" -ForegroundColor Red
    Write-Host "Path checked: $electronExe" -ForegroundColor Yellow
}
