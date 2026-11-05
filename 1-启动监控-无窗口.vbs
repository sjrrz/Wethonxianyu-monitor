' 1-启动监控-无窗口.vbs
' Double-click this file to start the Goofish scan monitor with NO console window.
' It reads runtime.txt, prefers a portable runtime\ folder next to this script,
' then launches 1-启动监控.cmd hidden (window style 0).
Option Explicit

Dim fso, sh, here, rtFile, rt, cmdFile, nodeLocal
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)

' ---- 1) read runtime.txt (UTF-8) via ADODB so Unicode paths survive ----
rt = ""
rtFile = here & "\runtime.txt"
If fso.FileExists(rtFile) Then
    Dim stream
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.LoadFromFile rtFile
    rt = Trim(stream.ReadText(-1))
    stream.Close
End If

' ---- 1b) 便携包优先：同目录带 runtime\ 就无条件用它，搬走整个文件夹也能跑 ----
nodeLocal = here & "\runtime\playwright-driver\node.exe"
If fso.FileExists(nodeLocal) Then
    rt = here & "\runtime"
End If

If rt = "" Then
    MsgBox "找不到 runtime.txt 里的运行目录。" & vbCrLf & vbCrLf & _
           "请先把 runtime.txt 改成你机器上 runtime 文件夹的完整路径。", _
           16, "闲鱼扫货监控"
    WScript.Quit 1
End If

If Not fso.FileExists(rt & "\playwright-driver\node.exe") Then
    MsgBox "运行目录里找不到 playwright-driver\node.exe：" & vbCrLf & rt & vbCrLf & vbCrLf & _
           "便携包的话，确认 runtime\ 文件夹和本脚本在同一个目录。", _
           16, "闲鱼扫货监控"
    WScript.Quit 1
End If

' ---- 2) hand the resolved runtime to the cmd launcher through env vars ----
' NOTE: children inherit the current working directory, so cd is unnecessary.
sh.Environment("PROCESS")("XIANYU_RUNTIME") = rt
sh.Environment("PROCESS")("PLAYWRIGHT_BROWSERS_PATH") = rt & "\playwright-browsers"
sh.Environment("PROCESS")("SCAN_KEEP_ALIVE") = "1"

cmdFile = here & "\1-启动监控.cmd"
If Not fso.FileExists(cmdFile) Then
    MsgBox "找不到启动脚本：" & vbCrLf & cmdFile, 16, "闲鱼扫货监控"
    WScript.Quit 1
End If

' window style 0 = hidden, waitOnReturn False = return immediately
sh.Run "cmd /c """ & cmdFile & """", 0, False

' ---- 【启动即扫 2026-11-04】双击本文件 = 我要开始扫，不该停在待命 ----
' 1-启动监控.cmd 里已经挂了同样的助手；这里再挂一次只是保险（两处都挂不会重复解除，
' 因为 start-resume.ps1 只在「确实是待命」时才 POST resume，而且会自己退出）。
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\start-resume.ps1""", 0, False