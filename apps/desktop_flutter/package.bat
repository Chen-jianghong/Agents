@echo off
rem ZaoHua Code one-click package script
setlocal
if not exist "C:\src\flutter\bin\flutter.bat" goto :noflutter
set PATH=C:\src\flutter\bin;%PATH%
cd /d %~dp0\..\..

echo [1/4] esbuild bundle backend...
node node_modules\esbuild\bin\esbuild examples\dev-server.mjs --bundle --platform=node --format=esm --banner:js="import { createRequire as __zcCreateRequire } from 'module'; const require = __zcCreateRequire(import.meta.url);" --outfile=apps\desktop_flutter\backend\backend.mjs
if errorlevel 1 goto :err

echo [2/4] flutter build windows (via subst X: for CJK path)...
subst X: /d >nul 2>&1
subst X: "%CD%"
if errorlevel 1 goto :err
cd /d X:\apps\desktop_flutter
call flutter clean >nul 2>&1
call flutter build windows
set FLUTTER_OK=%ERRORLEVEL%
cd /d %~dp0\..\..
subst X: /d >nul 2>&1
if not "%FLUTTER_OK%"=="0" goto :err

echo [3/4] assemble package dir...
if exist apps\desktop_flutter\package rmdir /s /q apps\desktop_flutter\package
mkdir apps\desktop_flutter\package\resources
xcopy /e /i /y apps\desktop_flutter\build\windows\x64\runner\Release\* apps\desktop_flutter\package\ >nul
move /y "apps\desktop_flutter\package\desktop_flutter.exe" "apps\desktop_flutter\package\ZaoHua Code.exe" >nul
copy /y "%ProgramFiles%\nodejs\node.exe" apps\desktop_flutter\package\resources\node.exe >nul
copy /y apps\desktop_flutter\backend\backend.mjs apps\desktop_flutter\package\resources\backend.mjs >nul

echo [4/4] Inno Setup compile...
"%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" apps\desktop_flutter\installer.iss
if errorlevel 1 goto :err

echo.
echo DONE: apps\release\ZaoHua-Code-Setup-*.exe
exit /b 0

:err
echo PACKAGE FAILED. Check errors above.
exit /b 1

:noflutter
echo Flutter SDK not found at C:\src\flutter. Install it or edit this script.
exit /b 1