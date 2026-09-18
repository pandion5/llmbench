' 콘솔 창 없이 앱을 띄운다. 더블클릭용. start.bat과 같은 일을 한다.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
app = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & app & "\node_modules\electron\dist\electron.exe"" """ & app & """", 0, False
