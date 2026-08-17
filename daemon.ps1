# daemon.ps1 — Fully headless stealth daemon for Windows
# Zero UI. Zero clipboard. Zero files on disk. Runs entirely in RAM.
#
# HOTKEYS (work even when only the exam browser is visible):
#   Alt+Shift+G  = Grab highlighted question + solve it
#   Alt+Shift+J  = Jet-type the answer into the active editor
#   Alt+Shift+Q  = Quit daemon + wipe terminal history
#
# SILENT CAPS LOCK LED FEEDBACK:
#   2 blinks     = daemon ready / answer typed
#   solid ON     = question captured, solving...
#   3 blinks     = answer ready, press Alt+Shift+J to type
#   5 blinks     = error
#   1 long flash = shutting down
#
# Usage:
#   $global:license = "your_key"; irm https://raw.githubusercontent.com/sandeep2421-hub/study-ai-assistant/main/daemon.ps1 | iex

# ── Step 1: Compile WinHide helper ──
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinHide {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    public static void Hide() { ShowWindow(GetConsoleWindow(), 0); }
}
"@ -ErrorAction SilentlyContinue

# ── Step 2: Get license key ──
$lk = if ($global:license) { $global:license } else { "sandy" }

# ── Step 3: Generate HWID ──
$md5 = [System.Security.Cryptography.MD5]::Create()
$hb = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($env:COMPUTERNAME + "win32"))
$hwid = (-join ($hb | ForEach-Object { $_.ToString("x2") })).Substring(0, 16)

# ── Step 4: Compile the daemon engine based on Architecture ──
$Engine = if ([IntPtr]::Size -eq 8) {
    # 64-bit definition
    @"
    using System;
    using System.IO;
    using System.Net;
    using System.Runtime.InteropServices;
    using System.Text;
    using System.Text.RegularExpressions;
    using System.Threading;
    using System.Windows.Automation;

    public class StealthDaemon {

        // ── Win32 API imports ──
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] p, int cb);
        [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);
        [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
        [DllImport("user32.dll")] static extern short GetKeyState(int nVirtKey);

        [StructLayout(LayoutKind.Explicit, Size = 40)]
        public struct INPUT {
            [FieldOffset(0)] public int type;
            [FieldOffset(8)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT {
            public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }

        static string serverBase, licenseKey, hwid, sessionToken, storedCode;
        static bool running;

        static void SendKeyEvt(ushort wVk, ushort wScan, uint flags) {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = 1; // INPUT_KEYBOARD
            inputs[0].ki.wVk = wVk;
            inputs[0].ki.wScan = wVk != 0 ? (ushort)MapVirtualKey(wVk, 0) : wScan;
            inputs[0].ki.dwFlags = flags;
            inputs[0].ki.time = 0;
            inputs[0].ki.dwExtraInfo = IntPtr.Zero;
            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        static void TypeChar(char c) {
            SendKeyEvt(0, (ushort)c, 0x0004);
            SendKeyEvt(0, (ushort)c, 0x0004 | 0x0002);
        }
        static void PressVk(ushort v)   { SendKeyEvt(v, 0, 0); }
        static void ReleaseVk(ushort v) { SendKeyEvt(v, 0, 0x0002); }
        static void SendVk(ushort v)    { PressVk(v); ReleaseVk(v); }

        static void TypeString(string s) {
            Random r = new Random();
            int pos = 0;
            while (pos < s.Length) {
                char c = s[pos];
                if ((int)c == 13) { pos++; continue; }
                if ((int)c == 10) {
                    SendVk(0x0D); // Enter
                    Thread.Sleep(250);
                    pos++;
                } else {
                    TypeChar(c);
                    int d = r.Next(25, 45);
                    if (c == ' ') d = r.Next(40, 75);
                    else if (".;{}()[]".IndexOf(c) >= 0) d = r.Next(85, 155);
                    Thread.Sleep(d);
                    pos++;
                }
            }
        }

        static string CaptureSelected() {
            try {
                var el = AutomationElement.FocusedElement;
                if (el == null) return "";
                while (el != null) {
                    object pat;
                    if (el.TryGetCurrentPattern(TextPattern.Pattern, out pat)) {
                        var tp = (TextPattern)pat;
                        var sel = tp.GetSelection();
                        if (sel.Length > 0) {
                            string txt = sel[0].GetText(-1);
                            if (!string.IsNullOrEmpty(txt) && txt.Trim().Length > 3)
                                return txt.Trim();
                        }
                    }
                    try { el = TreeWalker.RawViewWalker.GetParent(el); } catch { break; }
                }
            } catch {}
            return "";
        }

        static string HttpPost(string url, string body) {
            try {
                var wc = new WebClient();
                wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                wc.Encoding = Encoding.UTF8;
                return wc.UploadString(url, body);
            } catch (Exception ex) {
                return "{\"error\":\"" + ex.Message.Replace("\"","'") + "\"}";
            }
        }
        static string JEsc(string s) {
            if (s == null) return "";
            var sb = new StringBuilder();
            foreach (char c in s) {
                if      (c == '"')  sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < 0x20)  sb.AppendFormat("\\u{0:x4}", (int)c);
                else sb.Append(c);
            }
            return sb.ToString();
        }
        static string JVal(string json, string key) {
            var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!m.Success) return "";
            return m.Groups[1].Value
                .Replace("\\n","\n").Replace("\\r","\r").Replace("\\t","\t")
                .Replace("\\\"","\"").Replace("\\\\","\\").Replace("\\/","/");
        }
        static bool JBool(string json, string key) {
            var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(true|false)");
            return m.Success && m.Groups[1].Value == "true";
        }
        static string ExtractCode(string raw) {
            var m = Regex.Match(raw, @"```[\w]*\r?\n?([\s\S]*?)```");
            string code = m.Success ? m.Groups[1].Value.Trim() : raw.Trim();
            code = Regex.Replace(code, @"\bpublic(\s+class\s+Solution\b)", "$1");
            return code;
        }

        static void SetCapsLock(bool state) {
            try {
                bool current = (GetKeyState(0x14) & 1) != 0;
                if (current != state) {
                    keybd_event(0x14, 0, 0, 0);
                    keybd_event(0x14, 0, 0x0002, 0);
                }
            } catch {}
        }
        static void SignalReady() {
            SetCapsLock(true); Thread.Sleep(150);
            SetCapsLock(false); Thread.Sleep(150);
            SetCapsLock(true); Thread.Sleep(150);
            SetCapsLock(false);
        }
        static void SignalCapture() {
            SetCapsLock(true);
        }
        static void SignalSolved() {
            SetCapsLock(false); Thread.Sleep(150);
            for (int i = 0; i < 3; i++) {
                SetCapsLock(true); Thread.Sleep(150);
                SetCapsLock(false); Thread.Sleep(150);
            }
        }
        static void SignalError() {
            SetCapsLock(false); Thread.Sleep(150);
            for (int i = 0; i < 5; i++) {
                SetCapsLock(true); Thread.Sleep(80);
                SetCapsLock(false); Thread.Sleep(80);
            }
        }
        static void SignalQuit() {
            SetCapsLock(true); Thread.Sleep(1000);
            SetCapsLock(false);
        }

        public static void Run(string server, string license, string hw) {
            serverBase = server;
            licenseKey = license;
            hwid = hw;
            storedCode = "";
            running = true;

            string loginBody = "{\"licenseKey\":\"" + JEsc(licenseKey) + "\",\"hwid\":\"" + JEsc(hwid) + "\"}";
            string loginRes = HttpPost(serverBase + "/login", loginBody);
            if (!JBool(loginRes, "success")) { SignalError(); return; }
            sessionToken = JVal(loginRes, "sessionToken");

            SignalReady();

            bool gP = false, jP = false, qP = false;
            while (running) {
                bool alt   = (GetAsyncKeyState(0x12) & 0x8000) != 0;
                bool shift = (GetAsyncKeyState(0x10) & 0x8000) != 0;
                if (alt && shift) {
                    bool gN = (GetAsyncKeyState(0x47) & 0x8000) != 0; // G
                    bool jN = (GetAsyncKeyState(0x4A) & 0x8000) != 0; // J
                    bool qN = (GetAsyncKeyState(0x51) & 0x8000) != 0; // Q

                    // ── Alt+Shift+G: GRAB question + SOLVE ──
                    if (gN && !gP) {
                        SignalCapture();
                        string question = CaptureSelected();
                        if (string.IsNullOrEmpty(question)) {
                            SignalError();
                        } else {
                            string fullQ = "You are an expert Software Engineer assistant."
                                + "\\n\\nQuestion: " + JEsc(question)
                                + "\\n\\nProvide complete, working code with no comments inside code blocks."
                                + " Be concise but complete. For MCQ, give the answer letter and brief explanation.";
                            string body = "{\"sessionToken\":\"" + JEsc(sessionToken)
                                + "\",\"licenseKey\":\"" + JEsc(licenseKey)
                                + "\",\"hwid\":\"" + JEsc(hwid)
                                + "\",\"question\":\"" + fullQ + "\"}";
                            string res = HttpPost(serverBase + "/answer", body);
                            string answer = JVal(res, "answer");
                            string error  = JVal(res, "error");
                            if (!string.IsNullOrEmpty(error) || string.IsNullOrEmpty(answer)) {
                                SignalError();
                            } else {
                                storedCode = ExtractCode(answer);
                                SignalSolved();
                            }
                        }
                    }

                    // ── Alt+Shift+J: JET-TYPE ──
                    if (jN && !jP) {
                        if (string.IsNullOrEmpty(storedCode)) {
                            SignalError();
                        } else {
                            // Virtually release Alt, Shift, and Ctrl keys to prevent modifier bleed
                            ReleaseVk(0x12); // Alt
                            ReleaseVk(0x10); // Shift
                            ReleaseVk(0x11); // Ctrl
                            Thread.Sleep(300);
                            TypeString(storedCode);
                            SignalSolved();
                        }
                    }

                    // ── Alt+Shift+Q: QUIT ──
                    if (qN && !qP) { running = false; }

                    gP = gN; jP = jN; qP = qN;
                } else {
                    gP = false; jP = false; qP = false;
                }
                Thread.Sleep(50);
            }

            SignalQuit();
            try {
                string hist = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt");
                if (File.Exists(hist)) File.Delete(hist);
            } catch {}
        }
    }
"@
} else {
    # 32-bit definition
    @"
    using System;
    using System.IO;
    using System.Net;
    using System.Runtime.InteropServices;
    using System.Text;
    using System.Text.RegularExpressions;
    using System.Threading;
    using System.Windows.Automation;

    public class StealthDaemon {

        // ── Win32 API imports ──
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] p, int cb);
        [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);
        [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
        [DllImport("user32.dll")] static extern short GetKeyState(int nVirtKey);

        [StructLayout(LayoutKind.Explicit, Size = 28)]
        public struct INPUT {
            [FieldOffset(0)] public int type;
            [FieldOffset(4)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT {
            public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }

        static string serverBase, licenseKey, hwid, sessionToken, storedCode;
        static bool running;

        static void SendKeyEvt(ushort wVk, ushort wScan, uint flags) {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = 1; // INPUT_KEYBOARD
            inputs[0].ki.wVk = wVk;
            inputs[0].ki.wScan = wVk != 0 ? (ushort)MapVirtualKey(wVk, 0) : wScan;
            inputs[0].ki.dwFlags = flags;
            inputs[0].ki.time = 0;
            inputs[0].ki.dwExtraInfo = IntPtr.Zero;
            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        static void TypeChar(char c) {
            SendKeyEvt(0, (ushort)c, 0x0004);
            SendKeyEvt(0, (ushort)c, 0x0004 | 0x0002);
        }
        static void PressVk(ushort v)   { SendKeyEvt(v, 0, 0); }
        static void ReleaseVk(ushort v) { SendKeyEvt(v, 0, 0x0002); }
        static void SendVk(ushort v)    { PressVk(v); ReleaseVk(v); }

        static void TypeString(string s) {
            Random r = new Random();
            int pos = 0;
            while (pos < s.Length) {
                char c = s[pos];
                if ((int)c == 13) { pos++; continue; }
                if ((int)c == 10) {
                    SendVk(0x0D); // Enter
                    Thread.Sleep(250);
                    pos++;
                } else {
                    TypeChar(c);
                    int d = r.Next(25, 45);
                    if (c == ' ') d = r.Next(40, 75);
                    else if (".;{}()[]".IndexOf(c) >= 0) d = r.Next(85, 155);
                    Thread.Sleep(d);
                    pos++;
                }
            }
        }

        static string CaptureSelected() {
            try {
                var el = AutomationElement.FocusedElement;
                if (el == null) return "";
                while (el != null) {
                    object pat;
                    if (el.TryGetCurrentPattern(TextPattern.Pattern, out pat)) {
                        var tp = (TextPattern)pat;
                        var sel = tp.GetSelection();
                        if (sel.Length > 0) {
                            string txt = sel[0].GetText(-1);
                            if (!string.IsNullOrEmpty(txt) && txt.Trim().Length > 3)
                                return txt.Trim();
                        }
                    }
                    try { el = TreeWalker.RawViewWalker.GetParent(el); } catch { break; }
                }
            } catch {}
            return "";
        }

        static string HttpPost(string url, string body) {
            try {
                var wc = new WebClient();
                wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                wc.Encoding = Encoding.UTF8;
                return wc.UploadString(url, body);
            } catch (Exception ex) {
                return "{\"error\":\"" + ex.Message.Replace("\"","'") + "\"}";
            }
        }
        static string JEsc(string s) {
            if (s == null) return "";
            var sb = new StringBuilder();
            foreach (char c in s) {
                if      (c == '"')  sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < 0x20)  sb.AppendFormat("\\u{0:x4}", (int)c);
                else sb.Append(c);
            }
            return sb.ToString();
        }
        static string JVal(string json, string key) {
            var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!m.Success) return "";
            return m.Groups[1].Value
                .Replace("\\n","\n").Replace("\\r","\r").Replace("\\t","\t")
                .Replace("\\\"","\"").Replace("\\\\","\\").Replace("\\/","/");
        }
        static bool JBool(string json, string key) {
            var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(true|false)");
            return m.Success && m.Groups[1].Value == "true";
        }
        static string ExtractCode(string raw) {
            var m = Regex.Match(raw, @"```[\w]*\r?\n?([\s\S]*?)```");
            string code = m.Success ? m.Groups[1].Value.Trim() : raw.Trim();
            code = Regex.Replace(code, @"\bpublic(\s+class\s+Solution\b)", "$1");
            return code;
        }

        static void SetCapsLock(bool state) {
            try {
                bool current = (GetKeyState(0x14) & 1) != 0;
                if (current != state) {
                    keybd_event(0x14, 0, 0, 0);
                    keybd_event(0x14, 0, 0x0002, 0);
                }
            } catch {}
        }
        static void SignalReady() {
            SetCapsLock(true); Thread.Sleep(150);
            SetCapsLock(false); Thread.Sleep(150);
            SetCapsLock(true); Thread.Sleep(150);
            SetCapsLock(false);
        }
        static void SignalCapture() {
            SetCapsLock(true);
        }
        static void SignalSolved() {
            SetCapsLock(false); Thread.Sleep(150);
            for (int i = 0; i < 3; i++) {
                SetCapsLock(true); Thread.Sleep(150);
                SetCapsLock(false); Thread.Sleep(150);
            }
        }
        static void SignalError() {
            SetCapsLock(false); Thread.Sleep(150);
            for (int i = 0; i < 5; i++) {
                SetCapsLock(true); Thread.Sleep(80);
                SetCapsLock(false); Thread.Sleep(80);
            }
        }
        static void SignalQuit() {
            SetCapsLock(true); Thread.Sleep(1000);
            SetCapsLock(false);
        }

        public static void Run(string server, string license, string hw) {
            serverBase = server;
            licenseKey = license;
            hwid = hw;
            storedCode = "";
            running = true;

            string loginBody = "{\"licenseKey\":\"" + JEsc(licenseKey) + "\",\"hwid\":\"" + JEsc(hwid) + "\"}";
            string loginRes = HttpPost(serverBase + "/login", loginBody);
            if (!JBool(loginRes, "success")) { SignalError(); return; }
            sessionToken = JVal(loginRes, "sessionToken");

            SignalReady();

            bool gP = false, jP = false, qP = false;
            while (running) {
                bool alt   = (GetAsyncKeyState(0x12) & 0x8000) != 0;
                bool shift = (GetAsyncKeyState(0x10) & 0x8000) != 0;
                if (alt && shift) {
                    bool gN = (GetAsyncKeyState(0x47) & 0x8000) != 0; // G
                    bool jN = (GetAsyncKeyState(0x4A) & 0x8000) != 0; // J
                    bool qN = (GetAsyncKeyState(0x51) & 0x8000) != 0; // Q

                    // ── Alt+Shift+G: GRAB question + SOLVE ──
                    if (gN && !gP) {
                        SignalCapture();
                        string question = CaptureSelected();
                        if (string.IsNullOrEmpty(question)) {
                            SignalError();
                        } else {
                            string fullQ = "You are an expert Software Engineer assistant."
                                + "\\n\\nQuestion: " + JEsc(question)
                                + "\\n\\nProvide complete, working code with no comments inside code blocks."
                                + " Be concise but complete. For MCQ, give the answer letter and brief explanation.";
                            string body = "{\"sessionToken\":\"" + JEsc(sessionToken)
                                + "\",\"licenseKey\":\"" + JEsc(licenseKey)
                                + "\",\"hwid\":\"" + JEsc(hwid)
                                + "\",\"question\":\"" + fullQ + "\"}";
                            string res = HttpPost(serverBase + "/answer", body);
                            string answer = JVal(res, "answer");
                            string error  = JVal(res, "error");
                            if (!string.IsNullOrEmpty(error) || string.IsNullOrEmpty(answer)) {
                                SignalError();
                            } else {
                                storedCode = ExtractCode(answer);
                                SignalSolved();
                            }
                        }
                    }

                    // ── Alt+Shift+J: JET-TYPE ──
                    if (jN && !jP) {
                        if (string.IsNullOrEmpty(storedCode)) {
                            SignalError();
                        } else {
                            // Virtually release Alt, Shift, and Ctrl keys to prevent modifier bleed
                            ReleaseVk(0x12); // Alt
                            ReleaseVk(0x10); // Shift
                            ReleaseVk(0x11); // Ctrl
                            Thread.Sleep(300);
                            TypeString(storedCode);
                            SignalSolved();
                        }
                    }

                    // ── Alt+Shift+Q: QUIT ──
                    if (qN && !qP) { running = false; }

                    gP = gN; jP = jN; qP = qN;
                } else {
                    gP = false; jP = false; qP = false;
                }
                Thread.Sleep(50);
            }

            SignalQuit();
            try {
                string hist = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt");
                if (File.Exists(hist)) File.Delete(hist);
            } catch {}
        }
    }
"@
}

Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue

Add-Type -TypeDefinition $Engine -ReferencedAssemblies @(
    "UIAutomationClient",
    "UIAutomationTypes"
) -ErrorAction Stop

# ── Step 5: Hide console and run the daemon (blocks until Alt+Shift+Q) ──
[WinHide]::Hide()
[StealthDaemon]::Run(
    "https://study-ai-backend-omega.vercel.app",
    $lk,
    $hwid
)

# ── Step 6: Exit PowerShell session ──
exit
