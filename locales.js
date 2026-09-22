/**
 * UI string dictionaries for the desktop shell (main process + shared bits).
 *
 * Language resolution: settings.language ('auto' | 'zh' | 'en'), falling back
 * to 'auto', which follows the Windows UI language (zh-* → zh, else en).
 * English is the fallback dictionary: every key exists in both, so the UI
 * never renders raw keys.
 */

'use strict'

const zh = {
  'language.name': '中文',
  // fatal errors
  'fatal.title': 'DeepSeek Harness Desktop 遇到错误',
  'fatal.detailPre': '详情已写入',
  'dialog.exit': '退出',
  // startup / repo errors
  'err.repoNotFound': '未找到 deepseek-harness 仓库目录(通过 settings.json 的 repoPath、环境变量 DSH_DESKTOP_REPO,或首次运行向导指定)',
  'err.repoBadBin': '在 {0} 找不到 apps/cli/src/bin.ts —— 请确认路径指向 deepseek-harness 仓库',
  'err.repoNoDeps': '{0} 缺少 node_modules/tsx —— 请在仓库里先执行 pnpm install',
  'err.noNode': '找不到 node.exe —— 请安装 Node.js,或在 settings.json 里设置 nodePath',
  'err.noOutput': '(无输出)',
  'err.startTimeout': '启动超时({0} 秒内没有等到就绪 URL)\n\n最近日志:\n{1}',
  'err.webStartFailed': 'dsh web 启动失败(code={0})\n\n最近输出:\n{1}',
  'err.cannotStartWeb': '无法启动 dsh web: {0}',
  // backend lifecycle
  'backendDied.title': 'dsh web 服务意外退出了',
  'backendDied.detail': '可以立即重新启动服务。',
  'backendDied.restart': '重新启动服务',
  'backendDied.quit': '退出应用',
  'backendDied.balloon': 'dsh web 服务意外退出了。点击托盘图标重新打开。',
  'failStart.title': '启动失败',
  'failStart.openLogs': '查看日志目录',
  'failStart.close': '关闭',
  'loading.boot': '正在启动 DeepSeek Harness…',
  'loading.restarting': '正在重新启动服务…',
  'loading.hint': '首次启动需要加载仓库插件,可能需要 10–60 秒',
  // first-run repo picker
  'picker.title': '需要 deepseek-harness 仓库目录',
  'picker.detail': '{0}\n\n请选择包含 apps/cli/src/bin.ts 的 deepseek-harness 仓库文件夹。',
  'picker.choose': '选择仓库目录…',
  'picker.quit': '退出',
  'picker.windowTitle': '选择 deepseek-harness 仓库目录',
  'picker.notRepo': '所选目录不是 deepseek-harness 仓库',
  'picker.badDetail': '在该目录找不到 apps/cli/src/bin.ts:\n{0}',
  'picker.retry': '重新选择…',
  'picker.reasonNotRepo': '所选目录不是 deepseek-harness 仓库',
  'picker.reasonNone': '未找到 deepseek-harness 仓库目录',
  'picker.reasonForced': '强制装配模式(测试)',
  'provision.windowTitle': '运行环境安装',
  // self-update
  'update.windowTitle': '版本更新',
  'update.dialog.title': '发现新版本 {0}',
  'update.dialog.detail': '当前版本 {1},最新版本 {0}。\n\n现在下载并安装吗?安装时应用会自动退出并重启。',
  'update.dialog.now': '立即更新',
  'update.dialog.later': '稍后',
  'update.dialog.skip': '跳过此版本',
  'update.balloon.available': '发现新版本 {0}(当前 {1})。右键托盘图标 →「检查更新」即可升级。',
  'update.fail.title': '更新失败',
  'update.install.portable': '便携版无法自动安装更新。\n\n更新包已下载并通过校验,请手动用新版本替换当前 exe。',
  'update.install.dev': '当前是开发模式(未打包),不会执行自动安装。\n\n安装包已下载完成,可手动运行。',
  'update.install.failed': '无法启动安装程序:{0}',
  'update.install.reveal': '打开文件位置',
  'update.install.close': '关闭',
  // tray menu
  'tray.openMain': '打开主窗口',
  'tray.openBrowser': '在系统浏览器中打开',
  'tray.restartService': '重新启动服务',
  'tray.autostart': '开机自启',
  'tray.closeToTray': '关闭窗口时驻留托盘',
  'tray.openLogs': '打开日志目录',
  'tray.quit': '退出(停止服务)',
  'tray.language': '语言',
  'tray.langAuto': '跟随系统',
  'tray.langZh': '中文',
  'tray.langEn': 'English',
  'tray.checkUpdate': '检查更新…',
  'tray.updateAvailable': '⬆ 有可用更新 {0}',
  'tray.updateAuto': '启动时自动检查更新',
  'balloon.autostartFailed': '服务启动失败,点击托盘图标重试。',
  'appMenu.app': '应用',
  'appMenu.reload': '重新加载',
  'appMenu.devtools': '开发者工具',
  'appMenu.checkUpdate': '检查更新…',
}

const en = {
  'language.name': 'English',
  'fatal.title': 'DeepSeek Harness Desktop encountered an error',
  'fatal.detailPre': 'Details were written to',
  'dialog.exit': 'Exit',
  'err.repoNotFound': 'No deepseek-harness checkout found (configure via settings.json "repoPath", the DSH_DESKTOP_REPO environment variable, or the first-run wizard)',
  'err.repoBadBin': 'apps/cli/src/bin.ts not found in {0} — point repoPath at a deepseek-harness checkout',
  'err.repoNoDeps': '{0} is missing node_modules/tsx — run pnpm install in the checkout first',
  'err.noNode': 'No node.exe found — install Node.js or set "nodePath" in settings.json',
  'err.noOutput': '(no output)',
  'err.startTimeout': 'Startup timed out (no ready URL within {0} seconds)\n\nRecent log:\n{1}',
  'err.webStartFailed': 'dsh web failed to start (code={0})\n\nRecent output:\n{1}',
  'err.cannotStartWeb': 'Could not start dsh web: {0}',
  'backendDied.title': 'The dsh web service exited unexpectedly',
  'backendDied.detail': 'You can restart the service now.',
  'backendDied.restart': 'Restart service',
  'backendDied.quit': 'Quit app',
  'backendDied.balloon': 'The dsh web service exited unexpectedly. Click the tray icon to reopen.',
  'failStart.title': 'Startup failed',
  'failStart.openLogs': 'Open log folder',
  'failStart.close': 'Close',
  'loading.boot': 'Starting DeepSeek Harness…',
  'loading.restarting': 'Restarting the service…',
  'loading.hint': 'The first launch loads repository plugins and may take 10–60 seconds',
  'picker.title': 'A deepseek-harness checkout is required',
  'picker.detail': '{0}\n\nChoose the folder that contains apps/cli/src/bin.ts.',
  'picker.choose': 'Choose checkout folder…',
  'picker.quit': 'Quit',
  'picker.windowTitle': 'Choose deepseek-harness checkout',
  'picker.notRepo': 'That folder is not a deepseek-harness checkout',
  'picker.badDetail': 'No apps/cli/src/bin.ts in that folder:\n{0}',
  'picker.retry': 'Choose again…',
  'picker.reasonNotRepo': 'The chosen folder is not a deepseek-harness checkout',
  'picker.reasonNone': 'No deepseek-harness checkout found',
  'picker.reasonForced': 'forced setup mode (testing)',
  'provision.windowTitle': 'Runtime setup',
  // self-update
  'update.windowTitle': 'App update',
  'update.dialog.title': 'Version {0} is available',
  'update.dialog.detail': 'You have {1}; the latest release is {0}.\n\nDownload and install it now? The app will exit and restart during the upgrade.',
  'update.dialog.now': 'Update now',
  'update.dialog.later': 'Later',
  'update.dialog.skip': 'Skip this version',
  'update.balloon.available': 'Version {0} is available (you have {1}). Right-click the tray icon → "Check for updates".',
  'update.fail.title': 'Update failed',
  'update.install.portable': 'The portable build cannot install updates automatically.\n\nThe update was downloaded and verified — replace the current exe with it manually.',
  'update.install.dev': 'This is an unpackaged dev run, so automatic installation is skipped.\n\nThe installer was downloaded; you can run it manually.',
  'update.install.failed': 'Could not start the installer: {0}',
  'update.install.reveal': 'Show file',
  'update.install.close': 'Close',
  // tray menu
  'tray.openMain': 'Open main window',
  'tray.openBrowser': 'Open in system browser',
  'tray.restartService': 'Restart service',
  'tray.autostart': 'Start at login',
  'tray.closeToTray': 'Keep in tray on close',
  'tray.openLogs': 'Open log folder',
  'tray.quit': 'Quit (stop service)',
  'tray.language': 'Language',
  'tray.langAuto': 'System default',
  'tray.langZh': '中文',
  'tray.langEn': 'English',
  'tray.checkUpdate': 'Check for updates…',
  'tray.updateAvailable': '⬆ Update {0} available',
  'tray.updateAuto': 'Check for updates on startup',
  'balloon.autostartFailed': 'The service failed to start. Click the tray icon to retry.',
  'appMenu.app': 'App',
  'appMenu.reload': 'Reload',
  'appMenu.devtools': 'Developer tools',
  'appMenu.checkUpdate': 'Check for updates…',
}

/** Resolve a UI language: settings value, then the OS UI language. */
function resolveLanguage(settingsLanguage, osLocale) {
  const requested = settingsLanguage || 'auto'
  if (requested === 'zh' || requested === 'en') return requested
  return String(osLocale || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function makeDictionary(settingsLanguage, osLocale) {
  const lang = resolveLanguage(settingsLanguage, osLocale)
  const dict = lang === 'zh' ? zh : en
  const fallback = lang === 'zh' ? en : zh
  return {
    lang,
    isZh: lang === 'zh',
    t(key, ...args) {
      let text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined
      if (text === undefined) text = Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key] : undefined
      if (text === undefined) return key
      return String(text).replace(/\{(\d+)\}/gu, (match, index) => {
        const value = args[Number(index)]
        return value === undefined ? match : String(value)
      })
    },
  }
}

module.exports = { zh, en, resolveLanguage, makeDictionary }
