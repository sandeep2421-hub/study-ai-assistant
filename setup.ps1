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

# 1. Stop any old running instance
Get-Process -Name "StudyAI","StudyAIPortable","study-ai-assistant","vit","VIT","electron" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. Ensure Node.js is installed
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and -not (Test-Path "C:\Program Files\nodejs\node.exe")) {
    Write-Host "[VIT] Installing Node.js runtime..." -ForegroundColor Yellow
    $nodeInstaller = "$env:TEMP\node-setup.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi" -OutFile $nodeInstaller -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /quiet /norestart" -Wait
}

if (Test-Path "C:\Program Files\nodejs") {
    $env:PATH = "C:\Program Files\nodejs;" + $env:PATH
}

# 3. Download App Code
Write-Host "[VIT] Downloading Application Package..." -ForegroundColor Cyan
try { Invoke-WebRequest -Uri $sourceUrl -OutFile $zipPath -UseBasicParsing } catch { & curl.exe -L -s -o $zipPath $sourceUrl }

if (-not (Test-Path $zipPath)) {
    Write-Host "[ERROR] Could not download application package." -ForegroundColor Red
    exit 1
}

# 4. Extract (Preserving node_modules if already installed)
Write-Host "[VIT] Extracting App Archive..." -ForegroundColor Cyan
$tempExtract = "$env:TEMP\vit-extract"
if (Test-Path $tempExtract) { Remove-Item -Path $tempExtract -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $tempExtract -Force | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $tempExtract -Force
Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item -Path "$tempExtract\study-ai-assistant-main\*" -Destination $appDir -Recurse -Force
Remove-Item -Path $tempExtract -Recurse -Force -ErrorAction SilentlyContinue

# 5. Install dependencies if missing
$electronCmd = "$appDir\node_modules\.bin\electron.cmd"
if (-not (Test-Path $electronCmd)) {
    Write-Host "[VIT] Installing dependencies (first time setup, please wait 30s)..." -ForegroundColor Cyan
    Push-Location $appDir
    & npm install --no-audit --no-fund
    Pop-Location
}

# 6. Clear old saved session so license box pops up fresh
Remove-Item -Path (Join-Path $env:TEMP '.engoulp_sess') -Force -ErrorAction SilentlyContinue

Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "          Setup complete!" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "Ctrl+Shift+I   Open AI Chat Panel" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+S   Silent screen capture" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+A   Ask / generate answer" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+H   Hide / show window" -ForegroundColor Cyan
Write-Host ""
Write-Host "[VIT] Starting app..." -ForegroundColor Cyan

# 7. Launch Electron directly
Set-Location $appDir
if (Test-Path $electronCmd) {
    & $electronCmd main.js
} else {
    & npx electron main.js
}
