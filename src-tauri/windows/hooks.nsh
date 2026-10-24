; Hooks NSIS de SavIDE (bundle.windows.nsis.installerHooks).
; Avant de copier les fichiers : ferme tout processus lancé depuis le dossier de
; l'appli (python.exe de python-runtime, démon), sinon « Erreur lors de l'ouverture
; du fichier en écriture : ...\python-runtime\DLLs\_bz2.pyd ».
; Boucle (jusqu'à ~15 s) : d'abord les démons SavIDE.exe (qui relanceraient leurs
; noyaux), puis python.exe, puis on revérifie ; on ne sort que quand plus rien du
; dossier ne tourne (bug du 24/10 : un python.exe relancé entre deux arrêts gardait
; _bz2.pyd ouvert).
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR\'; for ($$i=0; $$i -lt 30; $$i++) { $$p = @(Get-Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) }); if ($$p.Count -eq 0) { break }; $$p | Sort-Object { $$_.ProcessName -like 'python*' } | ForEach-Object { taskkill /F /T /PID $$_.Id | Out-Null }; Start-Sleep -Milliseconds 500 }"`
  Pop $0
!macroend
