@echo off
rem 다른 PC에서 npm 없이 실행. electron 바이너리로 앱 폴더를 직접 연다.
rem %~dp0은 끝에 \가 붙어 따옴표를 깨뜨리므로 떼고 쓴다.
set "APP=%~dp0"
set "APP=%APP:~0,-1%"
start "" "%APP%\node_modules\electron\dist\electron.exe" "%APP%"
