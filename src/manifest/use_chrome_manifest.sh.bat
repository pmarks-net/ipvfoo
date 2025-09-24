:; # This part is a Linux shell script
:; cd "$(dirname "$0")"
:; pwd
:; cp -v "chrome-manifest.json" "../manifest.json"
:; exit

@REM This part is a Windows batch file
CD /D "%~dp0"
COPY "chrome-manifest.json" "..\manifest.json"
@PAUSE
