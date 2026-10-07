@echo off
rem ============================================================================
rem  Установка RVC-окружения Сукуно (нужно выполнить один раз).
rem  Всё ставится ВНУТРЬ проекта, в rvc\venv. Система не меняется.
rem
rem  Почему Python 3.10, а не 3.11/3.13:
rem    fairseq 0.12.2 (зависимость rvc-python) падает на 3.11 из-за проверки
rem    dataclasses, а на 3.12+ вообще не собирается.
rem ============================================================================
setlocal
cd /d "%~dp0"

set PYVER=3.10.11
set PYDIR=%~dp0venv
set PYDIR=%PYDIR:~0,-1%
set PY=%PYDIR%\python.exe

if exist "%PY%" (
  echo Окружение уже есть: %PY%
  goto :deps
)

echo [1/6] Скачиваю Python %PYVER% (embeddable)...
powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/%PYVER%/python-%PYVER%-embed-amd64.zip' -OutFile '%PYDIR%\..\py-embed.zip' -UseBasicParsing" || goto :err
echo [2/6] Распаковываю в venv...
powershell -NoProfile -Command "Expand-Archive -Path '%PYDIR%\..\py-embed.zip' -DestinationPath '%PYDIR%' -Force; Remove-Item '%PYDIR%\..\py-embed.zip' -Force" || goto :err
powershell -NoProfile -Command "Set-Content -Path '%PYDIR%\python310._pth' -Encoding ASCII -Value @('python310.zip','.','Lib','Lib\site-packages','import site')" || goto :err

:deps
echo [3/6] Ставлю pip...
powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile '%~dp0get-pip.py' -UseBasicParsing" || goto :err
"%PY%" "%~dp0get-pip.py" --no-warn-script-location >nul || goto :err
del /q "%~dp0get-pip.py"
rem pip < 24.1 обязателен: pip>=24.1 не умеет читать метаданные omegaconf 2.0.6
"%PY%" -m pip install --quiet "pip==24.0" || goto :err

echo [4/6] Ставлю PyTorch 2.1.1 + CUDA 11.8 (около 2.4 ГБ, это долго)...
"%PY%" -m pip install torch==2.1.1+cu118 torchaudio==2.1.1+cu118 --index-url https://download.pytorch.org/whl/cu118 || goto :err

echo [5/6] Ставлю остальные зависимости...
"%PY%" -m pip install -r "%~dp0requirements.txt" || goto :err
"%PY%" -m pip install omegaconf==2.0.6 || goto :err
rem setuptools>=81 больше не содержит pkg_resources, который нужен librosa
"%PY%" -m pip install "setuptools==75.6.0" || goto :err

echo [6/6] Ставлю rvc-python и fairseq без C-расширений...
"%PY%" -m pip install --no-deps rvc-python || goto :err
if not exist "%~dp0_src\fairseq-0.12.2" (
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://files.pythonhosted.org/packages/30/36/db42846570f479ac859be3b48d8b47f2ae9b0b9c77487a512f2f2ecbcb6b/fairseq-0.12.2.tar.gz' -OutFile '%~dp0fairseq.tar.gz' -UseBasicParsing" || goto :err
  powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '%~dp0_src' | Out-Null; tar -xzf '%~dp0fairseq.tar.gz' -C '%~dp0_src'; Remove-Item '%~dp0fairseq.tar.gz' -Force" || goto :err
)
rem READTHEDOCS=1 — штатная ветка в setup.py fairseq: собрать без C-расширений
set READTHEDOCS=1
"%PY%" -m pip install --no-deps --no-build-isolation "%~dp0_src\fairseq-0.12.2" || goto :err

echo.
echo Готово. Проверка:
"%PY%" -c "import torch, fairseq; print('torch', torch.__version__, 'cuda', torch.cuda.is_available()); print('fairseq ok')"
echo.
echo Дальше: положите .pth и .index в rvc\models и включите RVC в настройках приложения.
pause
exit /b 0

:err
echo.
echo ОШИБКА на шаге выше. Смотрите текст сообщения.
pause
exit /b 1
