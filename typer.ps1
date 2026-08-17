# typer.ps1
# Standalone, end-to-end memory-only assistant for Windows PowerShell.
# Zero Clipboard Use — uses Windows UI Automation to read the question.

$Signature = if ([IntPtr]::Size -eq 8) {
    # 64-bit definition
    @"
    using System;
    using System.Runtime.InteropServices;
    using System.Threading;
    public class HelperInput {
        [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int cb);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint u, uint m);
        [StructLayout(LayoutKind.Explicit, Size = 40)]
        public struct INPUT {
            [FieldOffset(0)] public int type;
            [FieldOffset(8)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT {
            public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }
        public static void SendKey(ushort wVk, ushort wScan, uint dwFlags) {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = 1;
            inputs[0].ki.wVk = wVk;
            inputs[0].ki.wScan = wVk != 0 ? (ushort)MapVirtualKey(wVk, 0) : wScan;
            inputs[0].ki.dwFlags = dwFlags;
            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }
        public static void TypeChar(char c) {
            SendKey(0, (ushort)c, 0x0004);
            SendKey(0, (ushort)c, 0x0004 | 0x0002);
        }
        public static void PressVk(ushort vk) { SendKey(vk, 0, 0); }
        public static void ReleaseVk(ushort vk) { SendKey(vk, 0, 0x0002); }
        public static void SendVk(ushort vk) { PressVk(vk); ReleaseVk(vk); }
        public static void TypeString(string s, int minDelay, int maxDelay) {
            Random rand = new Random();
            int pos = 0;
            while (pos < s.Length) {
                char c = s[pos];
                if ((int)c == 13) { pos++; continue; }
                if ((int)c == 10) {
                    // Just press Enter to go to the next line.
                    // Do NOT press Escape, Shift+Tab, or Tab, as they move cursor focus out of the input box
                    // and can cause tab-out warnings or hit the submit button.
                    SendVk(0x0D); // Enter
                    Thread.Sleep(250);
                    pos++;
                } else {
                    TypeChar(c);
                    int delay = rand.Next(minDelay, maxDelay);
                    if (c == ' ') {
                        delay = rand.Next(minDelay + 15, maxDelay + 30);
                    } else if (c == '.' || c == ';' || c == '{' || c == '}' || c == '(' || c == ')') {
                        delay = rand.Next(minDelay + 60, maxDelay + 110);
                    }
                    Thread.Sleep(delay);
                    pos++;
                }
            }
        }
    }
"@
} else {
    # 32-bit definition
    @"
    using System;
    using System.Runtime.InteropServices;
    using System.Threading;
    public class HelperInput {
        [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int cb);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint u, uint m);
        [StructLayout(LayoutKind.Explicit, Size = 28)]
        public struct INPUT {
            [FieldOffset(0)] public int type;
            [FieldOffset(4)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT {
            public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }
        public static void SendKey(ushort wVk, ushort wScan, uint dwFlags) {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = 1;
            inputs[0].ki.wVk = wVk;
            inputs[0].ki.wScan = wVk != 0 ? (ushort)MapVirtualKey(wVk, 0) : wScan;
            inputs[0].ki.dwFlags = dwFlags;
            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }
        public static void TypeChar(char c) {
            SendKey(0, (ushort)c, 0x0004);
            SendKey(0, (ushort)c, 0x0004 | 0x0002);
        }
        public static void PressVk(ushort vk) { SendKey(vk, 0, 0); }
        public static void ReleaseVk(ushort vk) { SendKey(vk, 0, 0x0002); }
        public static void SendVk(ushort vk) { PressVk(vk); ReleaseVk(vk); }
        public static void TypeString(string s, int minDelay, int maxDelay) {
            Random rand = new Random();
            int pos = 0;
            while (pos < s.Length) {
                char c = s[pos];
                if ((int)c == 13) { pos++; continue; }
                if ((int)c == 10) {
                    // Just press Enter to go to the next line.
                    // Do NOT press Escape, Shift+Tab, or Tab, as they move cursor focus out of the input box
                    // and can cause tab-out warnings or hit the submit button.
                    SendVk(0x0D); // Enter
                    Thread.Sleep(250);
                    pos++;
                } else {
                    TypeChar(c);
                    int delay = rand.Next(minDelay, maxDelay);
                    if (c == ' ') {
                        delay = rand.Next(minDelay + 15, maxDelay + 30);
                    } else if (c == '.' || c == ';' || c == '{' || c == '}' || c == '(' || c == ')') {
                        delay = rand.Next(minDelay + 60, maxDelay + 110);
                    }
                    Thread.Sleep(delay);
                    pos++;
                }
            }
        }
    }
"@
}

# Compile Input Helper
if (-not ([Ref].Assembly.GetType("HelperInput"))) {
    Add-Type -TypeDefinition $Signature -ErrorAction SilentlyContinue
}

# Server configuration
$SERVER_BASE = "https://study-ai-backend-omega.vercel.app"

# Find or ask for license key
if ($global:license) {
    $licenseKey = $global:license
} else {
    $licenseKey = Read-Host "Enter your License Key"
}

if (-not $licenseKey) {
    Write-Host "[Error] License key is required." -ForegroundColor Red
    return
}

# Highlight instruction
Write-Host "1. Highlight the question text on your exam page with your mouse." -ForegroundColor Green
Write-Host "2. Click inside the browser window so it has focus." -ForegroundColor Green
Write-Host "Capturing selected text in:" -ForegroundColor Yellow
for ($i = 4; $i -gt 0; $i--) {
    Write-Host "$i..." -ForegroundColor Yellow
    Start-Sleep -Seconds 1
}

# Use Windows UI Automation to read selected text without using clipboard
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$question = ""
try {
    $focusedElement = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focusedElement) {
        $textPattern = $focusedElement.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        if ($textPattern) {
            $selection = $textPattern.GetSelection()
            if ($selection.Length -gt 0) {
                $question = $selection[0].GetText(-1)
            }
        }
    }
} catch {
    Write-Host "[Warning] UI Automation query failed." -ForegroundColor DarkYellow
}

$question = $question ? $question.Trim() : ""

if (-not $question -or $question.Length -lt 5) {
    Write-Host "[Error] No text selected! Make sure the text is highlighted and the window is focused." -ForegroundColor Red
    return
}

# Generate unique HWID
$hostname = $env:COMPUTERNAME
$platform = "win32"
$hasher = [System.Security.Cryptography.MD5]::Create()
$hashBytes = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($hostname + $platform))
$hwid = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
$hwid = $hwid.Substring(0, 16)

Write-Host "Question captured successfully! Connecting to server..." -ForegroundColor Cyan

try {
    # 1. Login to get session token
    $loginBody = @{ licenseKey = $licenseKey; hwid = $hwid } | ConvertTo-Json
    $loginRes = Invoke-RestMethod -Method Post -Uri "$SERVER_BASE/login" -Body $loginBody -ContentType "application/json"
    
    if (-not $loginRes.success) {
        Write-Host "[Error] Invalid license key." -ForegroundColor Red
        return
    }
    $sessionToken = $loginRes.sessionToken

    # 2. Get answer from AI
    Write-Host "Solving question (please wait 5-10s)..." -ForegroundColor Yellow
    $fullQuestion = @"
You are an expert Software Engineer assistant helping in a live interview.

Interview Question: $question

Provide a thorough, well-structured answer. For code questions, provide complete, working code with no comments inside the code blocks.
Be concise but complete. For MCQ, give the answer letter and a brief explanation.
"@
    
    $answerBody = @{
        sessionToken = $sessionToken
        licenseKey = $licenseKey
        hwid = $hwid
        question = $fullQuestion
    } | ConvertTo-Json

    $answerRes = Invoke-RestMethod -Method Post -Uri "$SERVER_BASE/answer" -Body $answerBody -ContentType "application/json"
    
    if ($answerRes.error) {
        Write-Host "[Error] Server error: $($answerRes.error)" -ForegroundColor Red
        return
    }
    
    $rawAnswer = $answerRes.answer
    
    # 3. Extract code block
    $code = $rawAnswer
    if ($rawAnswer -match '(?s)```[\w]*\r?\n?(.*?)```') {
        $code = $Matches[1].Trim()
    }
    
    # Replace public class name if Java class is public
    $code = $code -replace '\bpublic(\s+class\s+Solution\b)', '$1'
    
    Write-Host "Solution ready!" -ForegroundColor Green
    Write-Host "Focus your editor! Starting auto-typing in:" -ForegroundColor Yellow
    for ($i = 5; $i -gt 0; $i--) {
        Write-Host "$i..." -ForegroundColor Yellow
        Start-Sleep -Seconds 1
    }
    
    Write-Host "Typing..." -ForegroundColor Green
    [HelperInput]::TypeString($code, 25, 45)
    Write-Host "Typing finished!" -ForegroundColor Green

} catch {
    Write-Host "[Error] Connection failed: $_" -ForegroundColor Red
}
