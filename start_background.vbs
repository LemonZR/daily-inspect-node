' ============================================================================
'  start_background.vbs  -  Launch the inspection center with NO black window.
'  Double-click this file. Works on Win7, no dependencies beyond WScript.
'  Uses PowerShell Start-Process -WindowStyle Hidden (detached from console),
'  so the server keeps running independently. Output -> logs\server.log.
'  To stop it, double-click stop_background.vbs.
'  NOTE: keep this file pure ASCII (Win7 console/font breaks on UTF-8 text).
' ============================================================================
Option Explicit

Dim ws, fso, here, logDir, logFile, psScript, cmdLine, found, chkFile, tf, outs

Set ws  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)

logDir  = here & "\logs"
logFile = logDir & "\server.log"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

' --- check node is reachable, hidden (ws.Exec flashes a console on Win7) ---
found = False
chkFile = logDir & "\_nodechk.tmp"
On Error Resume Next
ws.Run "cmd /c where node > """ & chkFile & """ 2>&1", 0, True
If fso.FileExists(chkFile) Then
    Set tf = fso.OpenTextFile(chkFile, 1)
    outs = tf.ReadAll()
    tf.Close()
    fso.DeleteFile chkFile
    If InStr(LCase(outs), "node.exe") > 0 Then found = True
End If
Err.Clear
On Error GoTo 0
If Not found Then
    MsgBox "Cannot find 'node' in PATH." & vbCrLf & _
           "Install Node 18.16.0 and add it to PATH (or set NODEEXE)," & vbCrLf & _
           "then run this again.", vbExclamation, "Node not found"
    WScript.Quit 1
End If

' --- detached hidden launch via PowerShell, same core as the .bat version ---
psScript = here & "\launch_hidden.ps1"
cmdLine = "powershell -NoProfile -ExecutionPolicy Bypass -File """ & psScript & _
          """ -Server """ & here & "\server.js"" -LogFile """ & logFile & """"
ws.Run cmdLine, 0, False

' Give the server a moment to bind its port, then open the dashboard.
WScript.Sleep 1500
ws.Run "http://localhost:8082", 1, False
