# Stop any running process of VIT, Node, or Electron in the vit directory
Get-Process | Where-Object { $_.Path -like "*\AppData\Local\vit\*" -or $_.Path -like "*\Local\vit\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "StudyAI", "StudyAIPortable", "study-ai-assistant", "engoulp", "ENGOULP", "sandeep", "SANDEEP", "vit", "VIT" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "[VIT] Stopping processes..." -ForegroundColor Cyan

# Delete the installation directory completely
$installDir = Join-Path $env:LOCALAPPDATA "vit"
if (Test-Path $installDir) {
    Remove-Item -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "[✓] Removed installation folder." -ForegroundColor Green
}

# Delete the cached session file (.engoulp_sess) from the TEMP directory
$sessionFile = Join-Path $env:TEMP ".engoulp_sess"
if (Test-Path $sessionFile) {
    Remove-Item -Path $sessionFile -Force -ErrorAction SilentlyContinue
    Write-Host "[✓] Cleared session files and credentials." -ForegroundColor Green
}

# Remove the 'vit' function from the PowerShell profile
try {
    if (Test-Path -Path $PROFILE) {
        $profileContent = Get-Content $PROFILE -ErrorAction SilentlyContinue
        if ($profileContent) {
            $newContent = $profileContent | Where-Object { $_ -notlike "*function vit*" -and $_ -notlike "*Start-Process*Local\vit\VIT.exe*" }
            Set-Content -Path $PROFILE -Value $newContent -Force
            Write-Host "[✓] Removed alias from PowerShell profile." -ForegroundColor Green
        }
    }
} catch {
    Write-Host "[WARNING] Could not automatically remove 'vit' alias from profile." -ForegroundColor Yellow
}

# Clean up any temporary autotype scripts generated in Temp
Get-ChildItem -Path $env:TEMP -Filter "autotype_*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "[VIT] Cleanup complete! No digital footprints left." -ForegroundColor Green
