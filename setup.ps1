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

Get-Process -Name "StudyAI","StudyAIPortable","study-ai-assistant","vit","VIT" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[VIT] Installing Node.js runtime..." -ForegroundColor Yellow
    $nodeInstaller = "$env:TEMP\node-setup.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi" -OutFile $nodeInstaller -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i $nodeInstaller /quiet /norestart" -Wait
    $env:PATH += ";C:\Program Files\nodejs"
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
$electronCmd = "$appDir\node_modules\.bin\electron.cmd"

if (-not (Test-Path $electronCmd)) {
    Write-Host "[VIT] Installing dependencies (first time setup)..." -ForegroundColor Cyan
    Push-Location $appDir
    npm install --quiet 2>&1 | Out-Null
    Pop-Location
}

Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "          Setup complete!" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "Ctrl+Shift+I   Open AI Chat Panel" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+S   Silent screen capture" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+A   Ask / generate answer" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+H   Hide / show window" -ForegroundColor Cyan
Write-Host ""
Write-Host "[VIT] Launching app..." -ForegroundColor Cyan
Start-Process -FilePath $electronCmd -ArgumentList "main.js" -WorkingDirectory $appDir -WindowStyle Hidden
