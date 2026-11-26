@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1/3] 同步源码到 _build/webapp ...
REM robocopy 退出码 0-7 均为成功（0=无变化 1=已复制），8 以上才是错误。
REM 整目录镜像，确保 js/roles/vendor 不会缺文件（旧版逐个 copy 曾导致 webapp 漂移、exe 缺 js/core.js）。
robocopy . _build\webapp app.js config.js index.html styles.css /NJH /NJS /NDL /NFL
robocopy js _build\webapp\js /E /NJH /NJS /NDL /NFL
robocopy roles _build\webapp\roles /E /NJH /NJS /NDL /NFL
robocopy vendor _build\webapp\vendor /E /NJH /NJS /NDL /NFL
if not exist _build\webapp\js\core.js (
  echo.
  echo [错误] webapp 同步不完整（缺少 js/core.js），请检查上面 robocopy 的输出。
  pause
  exit /b 1
)

echo [2/3] PyInstaller 打包 ...
set CODEBUDDY_SAFE_DELETE_SANDBOX=0
REM 告诉 spec 入口/webapp 所在目录（即 _build/）。PyInstaller 的 spec 用 exec() 执行，
REM __file__/sys.argv 均不可用，故用环境变量传入，使打包与启动 CWD 解耦（修复“从根跑
REM 找不到 launcher.py / webapp”的耦合坑，输出仍落在项目根 dist\）。
REM 注：入口是 launcher.py（加固版）。2026-09-10 的批量提交曾把它误换成朴素的
REM socratopia_server.py，20260913 已恢复 —— 该误换版已从仓库删除，别再指回去。
set SPEC_DIR=%~dp0_build
REM 不再写死本机路径，改用系统 Python 的 PyInstaller 模块（换机器也能跑）。
REM 首次使用若报 "No module named PyInstaller"，先执行：python -m pip install pyinstaller
python -m PyInstaller --noconfirm --clean _build\Socratopia.spec
if errorlevel 1 (
  echo.
  echo [错误] 打包失败，请检查上面的输出。
  pause
  exit /b 1
)

echo [3/3] 生成唯一 exe 到项目根目录（清理中间副本，保证项目里只有一个 Socratopia.exe）...
REM 注意：spec 未指定 distpath，PyInstaller 默认输出到项目根 dist\ 而非 _build\dist\（后者是旧残留）。
copy /Y dist\Socratopia.exe Socratopia.exe >nul
REM 清理 PyInstaller 的中间副本 dist\Socratopia.exe 与 dist 文件夹，避免项目里出现多个 exe 让人困惑；
REM 也不要再手动拷贝到 _build\dist\（那是旧残留，会造成“exe 一直不更新”的假象）。
del /Q dist\Socratopia.exe >nul 2>&1
rmdir dist >nul 2>&1
REM 20260913 补：PyInstaller 的【-clean 只清它的缓存，不清工作目录】—— 每次打包都会在
REM 项目根留下 build\ 中间目录（约 13MB）。它已被 .gitignore 覆盖、不会入库，但会一直堆着。
REM 这里顺手删掉：下次打包本来就是全新生成，删了无任何副作用。
rmdir /S /Q build >nul 2>&1
echo.
echo 完成！双击根目录 Socratopia.exe 即可运行（端口 8199）。项目内只保留这一个 exe。
pause
