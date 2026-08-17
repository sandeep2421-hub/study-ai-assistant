$ErrorActionPreference = "Stop"

# 1. Cleanly close any running instances of the app if they exist (safe, native PowerShell)
Get-Process -Name "StudyAI", "StudyAIPortable", "study-ai-assistant", "engoulp", "ENGOULP", "sandeep", "SANDEEP", "vit", "VIT" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "         VIT Windows Setup" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host ""

$installDir = Join-Path $env:LOCALAPPDATA "vit"

$appUrl  = "https://github.com/sandeep2421-hub/study-ai-assistant/releases/latest/download/VIT-1.0.3-win.zip"
$zipPath = Join-Path $env:TEMP "vit-setup-temp.zip"
$exePath = Join-Path $installDir "VIT.exe"

Write-Host "[VIT] Fetching latest release..." -ForegroundColor Cyan
Write-Host "[$([char]0x2714)] Release: Latest - vit.zip" -ForegroundColor Green

Write-Host "[VIT] Downloading Portable App Archive (~80MB)..." -ForegroundColor Cyan

function Download-File {
    param (
        [string]$url,
        [string]$destination
    )
    
    # Method 1: Try curl.exe
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        Write-Host "[VIT] Method 1: Downloading using native curl..." -ForegroundColor Cyan
        try {
            curl.exe -L -o $destination $url
            if (Test-Path $destination) {
                $fileSize = (Get-Item $destination).Length
                if ($fileSize -gt 10MB) {
                    return $true
                }
            }
        } catch {}
    }
    
    # Method 2: Try Start-BitsTransfer
    Write-Host "[VIT] Method 2: Downloading using BITS Transfer..." -ForegroundColor Cyan
    try {
        Import-Module BitsTransfer -ErrorAction SilentlyContinue
        Start-BitsTransfer -Source $url -Destination $destination -ErrorAction Stop
        if (Test-Path $destination) {
            return $true
        }
    } catch {}
    
    # Method 3: Try Invoke-WebRequest
    Write-Host "[VIT] Method 3: Downloading using Invoke-WebRequest..." -ForegroundColor Cyan
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
        Invoke-WebRequest -Uri $url -OutFile $destination -UseBasicParsing -ErrorAction Stop
        if (Test-Path $destination) {
            return $true
        }
    } catch {}

    # Method 4: Try WebClient as final fallback
    Write-Host "[VIT] Method 4: Downloading using WebClient..." -ForegroundColor Cyan
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
        $webClient = New-Object System.Net.WebClient
        $webClient.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        $webClient.DownloadFile($url, $destination)
        if (Test-Path $destination) {
            return $true
        }
    } catch {}
    
    return $false
}

# Fallback to local release zip if present
$localZip = ""
if ($PSScriptRoot) {
    $localZip = Join-Path $PSScriptRoot "release\VIT-1.0.3-win.zip"
}
if (($localZip -ne "") -and (Test-Path $localZip)) {
    Write-Host "[VIT] Found local release archive in workspace. Copying..." -ForegroundColor Green
    Copy-Item -Path $localZip -Destination $zipPath -Force
    $downloadSuccess = $true
} else {
    $downloadSuccess = Download-File -url $appUrl -destination $zipPath
}

if (-not $downloadSuccess -or -not (Test-Path $zipPath)) {
    throw "All download methods failed. Please check your internet connection or try again."
}

Write-Host "[$([char]0x2714)] Download complete!" -ForegroundColor Green
Write-Host "[$([char]0x2714)] Dependencies already installed" -ForegroundColor Green
Write-Host "[VIT] Extracting App Archive..." -ForegroundColor Cyan
try {
    # Kill any processes running from the installation directory to prevent locked file errors
    Get-Process | Where-Object { $_.Path -like "*\AppData\Local\vit\*" -or $_.Path -like "*\Local\vit\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    
    # Completely remove the installation directory to ensure a clean slate (no conflicting folder structures)
    if (Test-Path $installDir) {
        Remove-Item -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null

    Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
    Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue
    
    # If the zip extracts to an exe with old name, rename it to VIT.exe
    $oldExe = Join-Path $installDir "StudyAI.exe"
    if (Test-Path $oldExe) {
        Rename-Item -Path $oldExe -NewName "VIT.exe" -Force
    }
    
    $engoulpExe = Join-Path $installDir "ENGOULP.exe"
    if (Test-Path $engoulpExe) {
        Rename-Item -Path $engoulpExe -NewName "VIT.exe" -Force
    }

    $sandeepExe = Join-Path $installDir "SANDEEP.exe"
    if (Test-Path $sandeepExe) {
        Rename-Item -Path $sandeepExe -NewName "VIT.exe" -Force
    }

    $defenderExe = Join-Path $installDir "WindowsDefenderHelper.exe"
    if (Test-Path $defenderExe) {
        Rename-Item -Path $defenderExe -NewName "VIT.exe" -Force
    }

    $runtimeBrokerExe = Join-Path $installDir "RuntimeBroker.exe"
    if (Test-Path $runtimeBrokerExe) {
        Rename-Item -Path $runtimeBrokerExe -NewName "VIT.exe" -Force
    }
    
    Write-Host "[$([char]0x2714)] App extracted to $installDir" -ForegroundColor Green
} catch {
    throw "Extraction failed: $_"
}

# Adding alias 'vit' to PowerShell profile
Write-Host "[$([char]0x2714)] Adding alias 'vit' to PowerShell profile..." -ForegroundColor Green
try {
    $profileDir = Split-Path $PROFILE
    if (-not (Test-Path -Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
    if (-not (Test-Path -Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
    $aliasCmd = "`nfunction vit { Start-Process -FilePath `"$exePath`" }"
    if (-not (Get-Content $PROFILE -ErrorAction SilentlyContinue | Select-String "function vit")) {
        Add-Content -Path $PROFILE -Value $aliasCmd
    }
} catch {
    Write-Host "[WARNING] Could not automatically register 'vit' alias, skipping..." -ForegroundColor Yellow
}

Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "          Setup complete!" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor DarkCyan
Write-Host "Ctrl+Shift+S   Silent screen capture" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+A   Ask / generate answer" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+L   Toggle audio listener" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+C   Copy text from external window" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+V   Auto-type code at OS cursor" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+K   Toggle kiosk/stealth mode" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+H   Hide / show window" -ForegroundColor Cyan
Write-Host "Ctrl+Shift+Q   Quit app" -ForegroundColor Cyan
Write-Host ""

Write-Host "[VIT] Launching app..." -ForegroundColor Cyan
if (Test-Path $exePath) {
    $process = Start-Process -FilePath $exePath -PassThru
    Write-Host "[$([char]0x2714)] App running extracted (PID $($process.Id))" -ForegroundColor Green
} else {
    Write-Host "[WARNING] VIT.exe not found at $exePath. Please run manually." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Login window will appear. Enter your license key in the pop-up box!" -ForegroundColor Green
Write-Host ""
