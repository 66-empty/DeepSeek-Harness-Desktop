; DeepSeek Harness Desktop — assisted-installer options page.
; Inserts an "Installation options" page (desktop shortcut + start-at-login)
; after the choose-directory page and before installation starts, and applies
; the choices after the files land. Silent installs keep both options on.
; Strings are bilingual (English + Simplified Chinese); electron-builder must
; enable both via nsis.installerLanguages (en_US, zh_CN).

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; Language ids: 1033 = English (en-US), 2052 = Simplified Chinese (zh-CN).
; Numeric ids are used because the MUI LANG_* constants may not be defined at
; the point where electron-builder includes this file.
LangString DSH_OPTIONS_TITLE  1033 "Installation options"
LangString DSH_OPTIONS_TITLE  2052 "安装选项:"
LangString DSH_DESKTOP_LABEL  1033 "Create a desktop shortcut"
LangString DSH_DESKTOP_LABEL  2052 "创建桌面快捷方式"
LangString DSH_AUTOSTART_LABEL 1033 "Start at login (run in the background and keep in the system tray)"
LangString DSH_AUTOSTART_LABEL 2052 "开机自启(登录后自动在后台运行,驻留系统托盘)"
LangString DSH_RUNTIME_HINT  1033 "Note: the first launch automatically downloads and installs the runtime (portable Node.js + deepseek-harness; ~1.4 GB over the network, typically 10–40 minutes). No other software is required afterwards."
LangString DSH_RUNTIME_HINT  2052 "提示:首次运行会自动下载并安装运行环境(便携 Node.js + deepseek-harness,需联网,约 1.4 GB,通常 10–40 分钟),安装完成后无需再准备任何软件。"

!ifndef BUILD_UNINSTALLER
  Var dshDesktopCheckbox
  Var dshAutostartCheckbox
!endif
Var dshDesktopChecked
Var dshAutostartChecked

!macro preInit
  ; Defaults for silent and update installs, where the options page never runs.
  StrCpy $dshDesktopChecked "1"
  StrCpy $dshAutostartChecked "1"
!macroend

!ifndef BUILD_UNINSTALLER

!macro customPageAfterChangeDir
  Page custom dshOptionsCreate dshOptionsLeave
!macroend

Function dshOptionsCreate
  ${If} ${Silent}
    Return
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 6u 100% 18u "$(DSH_OPTIONS_TITLE)"
  Pop $0
  ${NSD_CreateCheckBox} 0 30u 100% 16u "$(DSH_DESKTOP_LABEL)"
  Pop $dshDesktopCheckbox
  ${NSD_Check} $dshDesktopCheckbox
  ${NSD_CreateCheckBox} 0 52u 100% 16u "$(DSH_AUTOSTART_LABEL)"
  Pop $dshAutostartCheckbox
  ${NSD_Check} $dshAutostartCheckbox
  ${NSD_CreateLabel} 0 76u 100% 26u "$(DSH_RUNTIME_HINT)"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function dshOptionsLeave
  ${NSD_GetState} $dshDesktopCheckbox $dshDesktopChecked
  ${NSD_GetState} $dshAutostartCheckbox $dshAutostartChecked
FunctionEnd

!macro customInstall
  ${If} $dshDesktopChecked == "1"
    CreateShortCut "$DESKTOP\DeepSeek Harness.lnk" "$appExe" "" "$appExe" 0 SW_SHOWNORMAL "" "DeepSeek Harness Desktop"
  ${EndIf}
  ${If} $dshAutostartChecked == "1"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ai.deepseek.dsh.desktop" '"$appExe" "$INSTDIR" --hidden'
  ${EndIf}
!macroend

!else

!macro customUnInstall
  Delete "$DESKTOP\DeepSeek Harness.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ai.deepseek.dsh.desktop"
!macroend

!endif
