!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\\runtime\\python311.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\runtime\\python311.dll" "$INSTDIR\\python311.dll"
  IfFileExists "$INSTDIR\\runtime\\python3.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\runtime\\python3.dll" "$INSTDIR\\python3.dll"
  IfFileExists "$INSTDIR\\runtime\\zlib.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\runtime\\zlib.dll" "$INSTDIR\\zlib.dll"
  IfFileExists "$INSTDIR\\runtime\\libssl-3-x64.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\runtime\\libssl-3-x64.dll" "$INSTDIR\\libssl-3-x64.dll"
  IfFileExists "$INSTDIR\\runtime\\libcrypto-3-x64.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\runtime\\libcrypto-3-x64.dll" "$INSTDIR\\libcrypto-3-x64.dll"
  IfFileExists "$INSTDIR\\runtime\\sqlite3.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\runtime\\sqlite3.dll" "$INSTDIR\\sqlite3.dll"
  IfFileExists "$INSTDIR\\runtime\\bz2.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\runtime\\bz2.dll" "$INSTDIR\\bz2.dll"
  IfFileExists "$INSTDIR\\runtime\\lzma.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\runtime\\lzma.dll" "$INSTDIR\\lzma.dll"
  IfFileExists "$INSTDIR\\runtime\\libffi-8.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\runtime\\libffi-8.dll" "$INSTDIR\\libffi-8.dll"

  IfFileExists "$INSTDIR\\python311.dll" +3 0
  IfFileExists "$INSTDIR\\resources\\runtime\\python311.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\resources\\runtime\\python311.dll" "$INSTDIR\\python311.dll"
  IfFileExists "$INSTDIR\\resources\\runtime\\python3.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\resources\\runtime\\python3.dll" "$INSTDIR\\python3.dll"
  IfFileExists "$INSTDIR\\resources\\runtime\\zlib.dll" 0 +2
    CopyFiles /SILENT "$INSTDIR\\resources\\runtime\\zlib.dll" "$INSTDIR\\zlib.dll"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\\python311.dll"
  Delete "$INSTDIR\\python3.dll"
  Delete "$INSTDIR\\zlib.dll"
  Delete "$INSTDIR\\libssl-3-x64.dll"
  Delete "$INSTDIR\\libcrypto-3-x64.dll"
  Delete "$INSTDIR\\sqlite3.dll"
  Delete "$INSTDIR\\bz2.dll"
  Delete "$INSTDIR\\lzma.dll"
  Delete "$INSTDIR\\libffi-8.dll"
!macroend
