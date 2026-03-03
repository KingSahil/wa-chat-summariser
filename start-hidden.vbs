Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & "c:\projects\suprememath\wa-chat-summariser\tray.ps1" & Chr(34), 0, False
