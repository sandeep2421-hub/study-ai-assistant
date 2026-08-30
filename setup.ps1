$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$installDir = "$env:LOCALAPPDATA\vit"
$zipPath    = "$env:TEMP\vit-setup-temp.zip"
$sourceUrl  = "https://github.com/sandeep2421-hub/study-ai-assistant/archive/refs/heads/main.zip"

Write-Host ""
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "         VIT Windows Setup" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host ""

# Stop any running processes
Get-Process -Name "StudyAI","StudyAIPortable","study-ai-assistant","vit","VIT","electron" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Ensure Node.js is installed
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and -not (Test-Path "C:\Program Files\nodejs\node.exe")) {
    Write-Host "[VIT] Installing Node.js runtime..." -ForegroundColor Yellow
    $nodeInstaller = "$env:TEMP\node-setup.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi" -OutFile $nodeInstaller -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /quiet /norestart" -Wait
}

if (Test-Path "C:\Program Files\nodejs") {
    $env:PATH = "C:\Program Files\nodejs;" + $env:PATH
}

Write-Host "[VIT] Downloading Application Package..." -ForegroundColor Cyan
try { Invoke-WebRequest -Uri $sourceUrl -OutFile $zipPath -UseBasicParsing } catch { & curl.exe -L -s -o $zipPath $sourceUrl }

if (-not (Test-Path $zipPath)) {
    Write-Host "[ERROR] Could not download application package." -ForegroundColor Red
    exit 1
}

Write-Host "[VIT] Extracting App Archive..." -ForegroundColor Cyan
if (Test-Path $installDir) { Remove-Item -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue

$appDir = "$installDir\study-ai-assistant-main"
$electronExe = "$appDir\node_modules\electron\dist\electron.exe"

if (-not (Test-Path $electronExe)) {
    Write-Host "[VIT] Installing dependencies (first time setup)..." -ForegroundColor Cyan
    Push-Location $appDir
    & npm install --no-audit --no-fund
    Pop-Location
}

# Clear any previous session file so license window always shows
Remove-Item -Path (Join-Path $env:TEMP '.engoulp_sess') -Force -ErrorAction SilentlyContinue

Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "          Setup complete!" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "Ctrl+Shift+I   Open AI Chat Panel" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+S   Silent screen capture" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+A   Ask / generate answer" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+H   Hide / show window" -ForegroundColor Cyan
Write-Host ""
Write-Host "[VIT] Launching license verification window..." -ForegroundColor Cyan

if (Test-Path $electronExe) {
    Start-Process -FilePath $electronExe -ArgumentList "main.js" -WorkingDirectory $appDir
} else {
    Push-Location $appDir
    & npx electron main.js
    Pop-Location
}
