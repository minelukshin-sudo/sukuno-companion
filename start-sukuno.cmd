@echo off
rem Запуск Сукуно с видимой консолью — удобно, если что-то не работает.
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo Не найден npm. Установите Node.js 20 или новее: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости, это займёт пару минут...
  call npm install
  if errorlevel 1 (
    echo.
    echo Не удалось выполнить npm install. Проверьте интернет и VPN.
    pause
    exit /b 1
  )
)

if not exist models (
  echo Внимание: нет папки models — положите туда файл модели .vrm
)

echo Собираю приложение...
call npm run build
if errorlevel 1 (
  echo.
  echo Ошибка сборки, смотрите текст выше.
  pause
  exit /b 1
)

echo Запускаю Сукуно...
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --sukuno-settings
exit /b 0
