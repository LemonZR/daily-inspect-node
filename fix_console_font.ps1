# ============================================================================
#  fix_console_font.ps1  -  Optional helper (called by start.bat).
#  Switches THIS console window to a TrueType font so Chinese log lines from
#  Node render properly instead of showing as empty boxes. Win7's default
#  "raster font" cannot draw Chinese; that is the root cause of the error
#  "The system cannot write to the specified device" when chcp 65001 is used.
#  Safe to fail: start.bat ignores any error from this script.
# ============================================================================

$ErrorActionPreference = 'SilentlyContinue'

# Try to change the font of the current console via Win32 API.
$code = @'
using System;
using System.Runtime.InteropServices;
public class ConsoleFont {
    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X; public short Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CONSOLE_FONT_INFOEX {
        public uint cbSize;
        public uint nFont;
        public COORD dwFontSize;
        public uint FontFamily;
        public uint FontWeight;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string FaceName;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetCurrentConsoleFontEx(IntPtr h, bool bMax, ref CONSOLE_FONT_INFOEX info);
}
'@
try {
    Add-Type -TypeDefinition $code -ErrorAction Stop
    $fonts = @('Consolas', 'Lucida Console', 'Microsoft YaHei', 'SimHei')
    foreach ($name in $fonts) {
        $info = New-Object ConsoleFont+CONSOLE_FONT_INFOEX
        $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
        $info.FaceName = $name
        $info.FontFamily = 0x36
        $info.FontWeight = 400
        $info.dwFontSize = New-Object ConsoleFont+COORD
        $info.dwFontSize.X = 0
        $info.dwFontSize.Y = 16
        $h = [ConsoleFont]::GetStdHandle(-11)
        if ([ConsoleFont]::SetCurrentConsoleFontEx($h, $false, [ref]$info)) { break }
    }
} catch {
    # ignore - font is cosmetic only
}

# Also set the default for future console windows (Win7 reads these keys).
$regPaths = @(
    'HKCU:\Console',
    'HKCU:\Console\%SystemRoot%_system32_cmd.exe'
)
foreach ($rp in $regPaths) {
    try {
        if (-not (Test-Path $rp)) { New-Item -Path $rp -Force | Out-Null }
        Set-ItemProperty -Path $rp -Name 'FaceName' -Value 'Consolas' -ErrorAction Stop
        Set-ItemProperty -Path $rp -Name 'FontFamily' -Value 0x36 -ErrorAction SilentlyContinue
    } catch { }
}
