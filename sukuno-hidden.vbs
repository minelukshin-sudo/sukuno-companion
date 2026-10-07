' Скрытый запуск Сукуно (без чёрного окна консоли).
' Двойной клик по ярлыку «Сукуно» на рабочем столе запускает этот файл.
Option Explicit

Dim fso, sh, base, exe, rc

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

If Not fso.FolderExists(base & "\node_modules") Then
  MsgBox "Первый запуск ещё не сделан." & vbCrLf & vbCrLf & _
         "Откройте папку " & base & vbCrLf & _
         "и один раз запустите start-sukuno.cmd (он установит зависимости)." & vbCrLf & vbCrLf & _
         "Либо выполните в командной строке:  npm install", _
         16, "Сукуно"
  WScript.Quit
End If

exe = base & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "Не найден Electron." & vbCrLf & vbCrLf & _
         "Запустите start-sukuno.cmd или выполните:  npm install", 16, "Сукуно"
  WScript.Quit
End If

' Пересобираем из исходников (быстро, ~2 секунды), чтобы запускалось актуальное.
rc = sh.Run("cmd /c npm run build", 0, True)
If rc <> 0 Then
  MsgBox "Не удалось собрать приложение." & vbCrLf & vbCrLf & _
         "Запустите start-sukuno.cmd и посмотрите текст ошибки.", 16, "Сукуно"
  WScript.Quit
End If

' --sukuno-settings => вместе с аватаром открывается окно настроек.
sh.Run """" & exe & """ """ & base & """ --sukuno-settings", 1, False
