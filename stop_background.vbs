' ============================================================================
'  stop_background.vbs  -  Stop the inspection center started by
'  start_background.vbs. Kills only node processes running THIS folder's
'  server.js, so other Node apps on the machine are left alone.
'  Pure ASCII on purpose (Win7 console/font issues with UTF-8 text).
' ============================================================================
Option Explicit

Dim ws, fso, here, target, wmi, procs, p, killed, cmd

Set ws  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
target = LCase(here & "\server.js")

killed = 0
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("Select ProcessId, CommandLine from Win32_Process Where Name = 'node.exe'")

For Each p In procs
    cmd = ""
    If Not IsNull(p.CommandLine) Then cmd = LCase(p.CommandLine)
    If InStr(cmd, LCase("server.js")) > 0 And InStr(cmd, LCase(here)) > 0 Then
        On Error Resume Next
        p.Terminate()
        If Err.Number = 0 Then killed = killed + 1
        Err.Clear
        On Error GoTo 0
    End If
Next

MsgBox "Stopped " & killed & " inspection center process(es).", vbInformation, "Stopped"
