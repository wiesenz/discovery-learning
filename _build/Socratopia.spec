# -*- mode: python ; coding: utf-8 -*-
# Socratopia v0 PyInstaller 规格（--onefile，windowed）。
# 入口与静态资源都在本文件同目录（_build/）：launcher.py + webapp。
# 关键：入口脚本与 datas 都用「相对本 spec 文件的绝对路径」，不再依赖 pyinstaller 的
# 启动 CWD。这样 build.bat 从项目根跑 `pyinstaller _build\Socratopia.spec` 也能正确
# 解析，避免“从根跑找不到 webapp / launcher.py”的耦合坑。
#
# 入口为何是 launcher.py（2026-09-13 恢复）：
#   2026-09-10 的批量提交（2e0a743）误把加固版 launcher.py 换成了朴素的
#   socratopia_server.py，丢掉四条硬约束：① 8199 被占用时静默顺延 8200/8201
#   （localStorage 按 origin 隔离 → 用户"记录消失"）② 单实例互斥锁 ③ ThreadingMixIn
#   ④ 失败时原生报错框 + /__version__ 更新检测接口。详见 _build/launcher.py 顶部注释。
import os

# PyInstaller 以 exec() 执行本 spec，__file__ 未定义。入口/静态资源位置由 build.bat
# 通过环境变量 SPEC_DIR 传入（即 _build/）；未设时退回 CWD（兼容 `cd _build && pyinstaller`）。
SPEC_DIR = os.environ.get("SPEC_DIR", os.getcwd())  # 即 _build/
ENTRY = os.path.join(SPEC_DIR, "launcher.py")
WEBAPP = os.path.join(SPEC_DIR, "webapp")  # _build/webapp -> 打包内 webapp/
block_cipher = None

a = Analysis(
    [ENTRY],
    pathex=[],
    binaries=[],
    datas=[(WEBAPP, 'webapp')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='Socratopia',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
