; Hooks NSIS de SavIDE (bundle.windows.nsis.installerHooks).
; Avant de copier les fichiers : ferme tout processus lancé depuis le dossier de
; l'appli (python.exe de python-runtime, démon), sinon « Erreur lors de l'ouverture
; du fichier en écriture : ...\python-runtime\DLLs\_bz2.pyd ».
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR\'; Get-Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
  Sleep 800
!macroend
