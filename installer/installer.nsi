; memside Windows installer (Spec B 接缝 6)
; per-user 安装（免 UAC），不自启，uninstall 保数据。
; PATH 追加用 EnVar 第三方插件（NSIS choco 包不带，CI 单独装）。
; EnVar:: 调用经 Plugins DLL 自动发现，无需 !include 头文件（插件未随附 .nsh）。
!include "MUI2.nsh"

!define APP_NAME "memside"
!define APP_EXE "memside.exe"
!define APP_PUBLISHER "memside"

Name "memside"
; 产物名带版本号（发版约定 2026-08-20）：setup 输出与打包的 exe 均按
; `-DAPP_VERSION=<version>`（package.json build:installer 注入）命名，如
; memside-setup-0.4.0.exe / 打包 dist\memside-0.4.0.exe。装到用户机器后
; 仍是 $INSTDIR\memside.exe（安装后文件名不带版本，PATH/快捷方式不受影响）。
; 直接手跑 makensis（无 -D）时 fallback unversioned，产物名为 memside-setup-unversioned.exe。
!ifndef APP_VERSION
  !define APP_VERSION "unversioned"
!endif
OutFile "memside-setup-${APP_VERSION}.exe"
Unicode True
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\memside"
; 升级识别已安装目录（2026-08-20 用户反馈）：读上次安装写在卸载注册表里的
; InstallLocation 作初始目录——首次安装（无键）落回上面的默认目录；升级时
; 目录页直接预填上次的真实安装目录，不再「失忆」回 LOCALAPPDATA 默认值。
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "InstallLocation"

; ------ finish 页引导（2026-08-18-exe-autostart-browser）：装完勾选立即启动 exe → 开浏览器 ------
!define MUI_FINISHPAGE_RUN "$INSTDIR\memside.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 memside"
!define MUI_FINISHPAGE_RUN_CHECKED

; ------ MUI ------
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "memside" SecMain
  SectionIn RO
  ; 升级时旧 daemon 可能正跑着锁住 memside.exe（Windows 锁运行中的 exe），
  ; 直接 File 覆盖会弹「文件正在使用」重试对话框。先结束旧进程——daemon 无
  ; 内存态（数据全在 sqlite），杀掉无损；未在跑时 taskkill 报错，忽略即可。
  nsExec::Exec 'taskkill /IM ${APP_EXE} /F'
  Pop $0
  SetOutPath "$INSTDIR"
  ; 主程序（从构建产物拷入；CI build:installer 前先 build:exe；产物名带版本号，
  ; /oname= 保持装到用户机器后仍叫 memside.exe——快捷方式/PATH/MUI_FINISHPAGE_RUN 都指它）
  File /oname=memside.exe "..\dist\memside-${APP_VERSION}.exe"
  ; 开始菜单 + 桌面快捷方式
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\memside.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$DESKTOP\memside.lnk" "$INSTDIR\${APP_EXE}"
  ; PATH 追加（user scope，幂等）
  EnVar::SetHKCU
  EnVar::AddValue "PATH" "$INSTDIR"
  ; uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"
  ; 注册 Add/Remove（per-user：HKCU）
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "Publisher" "${APP_PUBLISHER}"
  ; 已装版本号（Add/Remove「安装的应用」列表可见）——升级时用户可对照安装器版本
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayVersion" "${APP_VERSION}"
SectionEnd

Section "Uninstall"
  ; 删程序文件 + 快捷方式 + PATH
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP_NAME}\memside.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\memside.lnk"
  EnVar::SetHKCU
  EnVar::DeleteValue "PATH" "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
  ; 不删：~/.memside（记忆库）/ ~/.claude/settings.json（hooks）/ ~/.config/opencode（插件）
  ; —— 用户数据保留；如需彻底清理请手动删上述目录与 settings.json 中 memside-managed 条目。
SectionEnd
