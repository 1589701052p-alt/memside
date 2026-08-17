; memside Windows installer (Spec B 接缝 6)
; per-user 安装（免 UAC），不自启，uninstall 保数据。
; PATH 追加用 EnVar 第三方插件（NSIS choco 包不带，CI 单独装）。
; EnVar:: 调用经 Plugins DLL 自动发现，无需 !include 头文件（插件未随附 .nsh）。
!include "MUI2.nsh"

Name "memside"
OutFile "memside-setup.exe"
Unicode True
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\memside"

!define APP_NAME "memside"
!define APP_EXE "memside.exe"
!define APP_PUBLISHER "memside"

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
  SetOutPath "$INSTDIR"
  ; 主程序（从构建产物拷入；CI build:installer 前先 build:exe）
  File "..\dist\memside.exe"
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
