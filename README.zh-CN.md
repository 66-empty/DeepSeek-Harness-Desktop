# DeepSeek Harness 桌面版(dsh-desktop-app)

[English](../README.md) | **中文**

把 DeepSeek Harness 的 Web GUI 变成真正的 Windows 桌面应用:双击图标即在一个独立
Electron 窗口中打开 GUI,并自动在后台启动仓库自带的 `dsh web` 服务。本目录是
**仓库外**的配套外壳,不修改 deepseek-harness 仓库中的任何文件(唯一的可选改动见
「仓库配套改动」一节,按需打补丁)。

当前版本:**0.4.0**(Windows x64;NSIS 安装版 + 便携版,见 `release/`)。界面语言:中文 / English(默认跟随系统,托盘菜单可切换)。安装版可自动从 GitHub Releases 升级(见「应用自动升级」)。

## 功能特性

- **自动装配运行环境(两种通道)**:普通用户无需预先安装 Node.js 或
  deepseek-harness——首次启动向导自动完成;装配可走“在线源码构建”(便携 Node +
  固定版本源码 + pnpm + 构建)或“预构建运行包”(发布机打好包,用户端下载即用,
  详见「打包发布」);支持国内镜像、进度日志、取消与断点续跑;
- **普通权限可装**:不需要管理员或开发者模式(0.2.3+ 内置解压回退、junction 重建、
  构建元数据自动适配无 `.git` 源码包),系统里装有旧版 Node 也不会影响装配
  (0.2.5+ 全程把便携 Node 置于 PATH);
- **应用自动升级**:安装版启动后自动检查 GitHub Releases(托盘菜单也可手动检查),
  下载新版安装包(支持断点续传)并做完整性校验(资产 digest / 发布的 `.sha256` +
  文件大小 + PE 头),随后静默原地升级并自动重启;便携版无法替换自身 exe,改为
  下载校验后提示手动替换;
- **独立窗口**:无浏览器标签/工具栏,窗口即应用;
- **托盘驻留**:关闭窗口默认隐藏到托盘,服务继续运行;托盘菜单可随时重新打开、
  在系统浏览器中打开、重启服务或退出(停止服务);
- **开机自启**:登录后以 `--hidden` 模式后台启动、驻留托盘;托盘菜单与 GUI 内
  「设置 → 通用设置 → 开机自启」开关共用同一份配置,任一处修改立即写入;
- **单实例**:重复启动不会开第二个实例,而是聚焦已存在的主窗口;
- **自动端口**:默认 `port: 0`,每次由系统分配空闲端口,不与已运行的
  其他 `dsh web` 实例冲突;
- **边界安全**:窗口启用 `contextIsolation` + `sandbox`,无 `nodeIntegration`;
  外部 http(s) 链接一律交给系统默认浏览器,页面导航被限制在 GUI 同源内;
- **故障可见**:主进程异常写入 `desktop.log` + `crashes.log` 并弹错误框,不再
  静默失败(0.2.1+);窗口图标读取失败时自动回退 exe 内嵌图标,避免任务栏空白
  (0.2.6+);
- **自动化自检**:`smoke` / `e2e` / `probe` / `provision:selftest` / `update:selftest` /
  `update:probe`(见「自动化检查」)。

## 工作原理

DeepSeek Harness 的 GUI 不是静态网页——只有 `dsh web` 进程能提供页面、注入
`window.__DSH_BOOT__` 并承载 /api 与 RPC。因此外壳(main.js)按以下流程工作:

1. **定位资源**:按「配置」一节解析仓库路径与 node.exe,并校验仓库有效
   (存在 `apps/cli/src/bin.ts` 且已 `pnpm install`):
   - 找到可用仓库 → 直接进入启动流程;
   - 找不到任何仓库线索(settings/环境变量/同级目录均无)→ 打开**装配向导**
     (`autoProvision=true`,默认),自动安装运行环境;
   - `autoProvision=false` 时退回目录选择对话框,直到选到合法仓库为止;
2. **拉起后端**:在仓库目录中启动(隐藏窗口,`cwd` = 仓库),子进程 PATH 会
   **置顶到所用 Node 的目录**,避免被系统里的旧 Node 劫持:

   ```text
   node --import tsx/esm apps/cli/src/bin.ts web --no-open --port <port> [extraArgs…]
   ```

   与 `pnpm dsh web` 是同一启动路径;`--no-open` 阻止 CLI 自己打开浏览器;
   `--port 0` 让操作系统分配空闲端口;
3. **等待就绪**:从进程 stdout 解析就绪行
   `dsh web: http://127.0.0.1:<port>/?token=...`(90 秒超时,失败时展示最近日志);
4. **加载 GUI**:主窗口直接加载该 URL(带 token,自动完成鉴权);preload 向页面注入
   `window.__dshDesktopShell` 桥接(`getAutoStart` / `setAutoStart`),GUI 设置页只在该
   桥接存在时才注册「开机自启」行,普通浏览器行为不变;装配向导窗口则使用另一组
   `window.__dshProvision` 桥接(状态/进度/镜像/取消,仅向导页存在);
5. **生命周期**:窗口关闭 = 隐藏到托盘(服务保持运行);真正退出(托盘「退出」、
   Ctrl+Q)时,用 `taskkill /T /F` 结束整个服务进程树(Windows 下无法向隐藏进程发
   Ctrl+C),避免工具子进程残留。会话数据按事件实时落盘,退出不影响已保存内容;
   服务意外退出时弹出「重新启动服务 / 退出应用」对话框(窗口隐藏时改为托盘气泡
   提示)。

## 目录结构

```text
dsh-desktop-app/
├─ main.js                 Electron 主进程:启停服务、窗口、托盘、开机自启、装配流程
├─ preload.js              桥接注入:__dshDesktopShell(开机自启)+ __dshProvision(装配向导)
├─ provision.js            装配引擎(纯 Node):下载/校验/解压/pnpm/构建,断点续跑;
│                          tar 失败自动回退内置解压器(zip64/符号链接占位/别名重建)
├─ provision.html          装配向导页面(进度/日志/镜像选择)
├─ runtime.manifest.json   默认装配清单(仓库 ref、Node 版本、下载源;可覆盖)
├─ package.json            依赖与 electron-builder 打包配置(版本号在此)
├─ setup.ps1               一键安装脚本(给已有 Node+仓库的开发机用)
├─ settings.json           运行时配置(首次启动后生成,见「配置」)
├─ assets/
│  ├─ icon-source.svg      图标源(与 Web GUI favicon 同款鲸鱼图形)
│  └─ icon.ico             由 make-icon.ps1 生成的 ICO(16–256 多尺寸)
├─ build/
│  ├─ license.txt          安装协议文本(分发前可替换)
│  └─ installer.nsh        安装选项页与注册/卸载逻辑(NSIS 定制)
├─ scripts/
│  ├─ make-runtime-pack.js 发布机:打“预构建运行包”(便携 Node+已构建仓库+别名清单)
│  ├─ make-icon.ps1        用本地 Electron 把 SVG 栅格化为多尺寸 ICO
│  ├─ render-icon.cjs      make-icon.ps1 调用的离屏渲染器
│  ├─ create-shortcuts.ps1 创建桌面与开始菜单快捷方式
│  └─ uninstall.ps1        移除快捷方式并清理开机自启注册项
├─ share/
│  ├─ dsh-settings-autostart-row.patch   「通用设置 开机自启行」仓库改动补丁
│  └─ PR-INSTRUCTIONS.md                把该改动提交/提 PR 回上游的操作说明
└─ release/
   ├─ *.exe                安装版/便携版(npm run dist)
   ├─ win-unpacked/        解包目录
   └─ runtime/             预构建运行包输出(npm run pack:runtime)
```

## 首次运行自动装配(普通用户零安装)

从 0.2.0 起,普通用户**不需要再手动安装 Node.js 或 deepseek-harness**:安装版/
便携版首次运行时,若找不到可用仓库(settings 的 `repoPath`、环境变量
`DSH_DESKTOP_REPO`、同级目录均无效),外壳自动打开**运行环境安装向导**并开始
装配:

| 步骤 | 内容 | 体积 |
|---|---|---|
| Node.js | 下载便携版 Node(官方或 npmmirror 镜像)并解压到运行目录 | ≈35 MB |
| deepseek-harness | 下载固定版本标签的源码 zip(GitHub 或加速代理) | ≈20–150 MB |
| pnpm + 依赖 | 用便携 Node 装 pnpm,再 `pnpm install`(走可选镜像 registry) | 下载 ≈1.4 GB |
| 构建 | `pnpm run build`(前端 dist 与各包产物,通常 3–10 分钟) | — |

装完后自动写入 `settings.json`(`repoPath` / `nodePath` 指向装配产物)并正常启动
GUI。**两种装配通道**,由装配清单决定:

- **在线源码构建(默认)**:下载便携 Node + 固定标签源码 → `pnpm install` →
  `pnpm run build`,上表即此流程;任何源都能跑;
- **预构建运行包(推荐给正式分发)**:发布机用 `npm run pack:runtime` 把“便携
  Node + 已装好依赖并构建完成的仓库”打成一个 zip,在清单里加一条
  `pack.url`/`pack.sha256` 后,用户端**只下载→校验→解压**,跳过 pnpm 与构建
  (适合内网/离线,速度快、结果与发布机完全一致)。详见「打包发布」一节的
  “预构建运行包”子章节。

向导页面提供:

- **下载源三档**:自动(探测网络)/ 国内镜像(优先)/ 直连官方源,随时可切;
- **实时进度与日志**,可折叠查看;关闭窗口会隐藏到托盘并在**后台继续**;
- **取消与断点续跑**:取消/断电后重试,已完成的步骤自动跳过,下载支持续传
  (临时文件与 npm/pnpm 缓存都保留在运行目录下);
- **选择已有仓库…**:开发/内网用户可改用手动指定(与旧版目录选择框等效);
- **退出**:取消装配并退出。

装配产物与缓存都放在用户数据目录下(独立于安装位置,重装/升级外壳不清除):

```text
%APPDATA%\DeepSeek Harness Desktop\
├─ settings.json                    运行时配置
├─ runtime.manifest.json            (可选)装配清单覆盖文件
└─ runtime\
   ├─ node\…                       便携 Node
   ├─ harness\dsh-v0.1.2-alpha.5\  仓库(含依赖与构建产物)
   ├─ provisioned.json             装配结果记录
   ├─ .downloads\                  下载的 zip(复用,可手动删除)
   └─ .cache\                      npm / pnpm 缓存
```

总磁盘占用约 **3 GB**,全程视网速约 **10–40 分钟**。注意:

- 需要网络;完全离线时向导会明确报错——离线机请用「选择已有仓库」指向一个已
  `pnpm install && pnpm run build` 好的仓库副本;
- 装配的是官方仓库指定版本标签(默认 `dsh-v0.1.2-alpha.5`),**不含**本目录
  `share\` 里的「开机自启行」补丁——不影响使用,托盘菜单开关始终可用;需要那行
  的用户可自行在仓库里打补丁;
- 想随版本换源或改装配内容,见「配置」中 `runtime.manifest.json` 覆盖说明;
- 仓库更新后的新版本装配会自动使用独立目录(按 ref 隔离),旧版本目录保留,
  可手动删除以回收磁盘。

## 快速开始(开发 / zip 布局)

### 前置条件

- Windows 10/11;
- 机器上已安装 **Node.js ≥ 22.19**(桌面版用系统 node.exe 跑后端服务);
- `deepseek-harness` 仓库已 `pnpm install && pnpm run build`(和平时跑 GUI 的要求
  一致),且与桌面版处于同级目录(`dsh-desktop-app` 的上一级),例如:
  `<你的目录>\deepseek-harness` ← → `<你的目录>\dsh-desktop-app`。

### 安装

```powershell
cd "<你的 dsh-desktop-app 目录>"   # 进入本目录后执行
npm install            # 安装 Electron(需联网,约 200MB)
npm run smoke          # (可选)无窗口冒烟:拉起真实服务→解析 URL→HTTP 探测→退出
npm run e2e            # (可选)真实窗口回归:GUI 页面加载成功后自动退出
npm run probe          # (可选)界面探测:打开 设置→通用设置,验证「开机自启」行
powershell -ExecutionPolicy Bypass -File scripts\make-icon.ps1         # 生成图标
powershell -ExecutionPolicy Bypass -File scripts\create-shortcuts.ps1  # 桌面+开始菜单
```

之后双击桌面的 **DeepSeek Harness** 即可。若仓库不在默认同级位置,先写
`settings.json`(见下)或设置环境变量 `DSH_DESKTOP_REPO`。

### 启动后的日常使用

| 操作 | 效果 |
|---|---|
| 双击桌面/开始菜单图标 | 启动(或聚焦已有实例),后台拉起 `dsh web` 并打开 GUI |
| 点窗口关闭按钮 | 默认隐藏到托盘,服务继续运行(可关闭此行为,见配置) |
| 单击托盘图标 | 打开主窗口 |
| 托盘 → 在系统浏览器中打开 | 用默认浏览器打开当前 GUI URL |
| 托盘 → 重新启动服务 | 停掉后端并重新拉起(重读 settings.json,仓库更新后用它) |
| 托盘 → 检查更新… | 打开升级窗口(版本检查、更新说明、下载进度、选项) |
| 托盘 → 退出(停止服务) | 结束服务进程树并退出应用 |
| Ctrl+R / F12 / Ctrl+Q | 重新加载页面 / 开发者工具 / 退出(菜单栏已隐藏,快捷键仍可用) |

日志:主程序与 `dsh web` 输出统一写入
`%USERPROFILE%\.dsh-desktop-logs\desktop.log`(单文件上限 2 MB,超限只保留最新
一行);托盘菜单可一键「打开日志目录」。

## 配置

### settings.json 的位置

运行时设置保存在 `settings.json`,位置规则:

- **打包版(安装版、便携版、win-unpacked)**:程序运行在只读的 app.asar 内,
  设置一律存 `%APPDATA%\DeepSeek Harness Desktop\settings.json`(可随系统迁移、
  卸载后保留);
- **zip 布局/源码运行(非打包)**:应用目录**可写**时 `settings.json` 与应用
  同目录,便于打包携带;目录不可写(如放进 Program Files)时同样回退到
  `%APPDATA%\DeepSeek Harness Desktop\settings.json`。

### 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `repoPath` | `""`(自动) | deepseek-harness 仓库路径;为空时依次尝试环境变量 `DSH_DESKTOP_REPO`、同级目录 `..\deepseek-harness`、首次运行目录选择框 |
| `nodePath` | `null`(自动) | node.exe 绝对路径;自动探测顺序:`DSH_DESKTOP_NODE` → `C:\Program Files\nodejs` → `C:\Program Files (x86)\nodejs` → Electron 同目录 node.exe → PATH 中的 `node` |
| `port` | `0` | `0` = 每次由系统分配空闲端口;想固定用 3080 可改成 `3080`(需确保空闲) |
| `closeToTray` | `true` | 关闭窗口时驻留托盘(托盘菜单同名开关即时修改) |
| `autoStart` | `true` | 开机自启(托盘菜单与 GUI 通用设置开关共用此字段) |
| `extraArgs` | `[]` | 追加传给 `dsh web` 的参数(如 `["--patch","xxx.yml"]`) |
| `autoProvision` | `true` | 找不到可用仓库时,首启自动打开装配向导并开始安装(0.2.0+);`false` 退回“选择仓库目录”对话框 |
| `mirrorMode` | `"auto"` | 装配下载源:`auto`(探测网络)/ `cn`(国内镜像优先)/ `direct`(直连官方);向导页面可切换 |
| `language` | `"auto"` | 界面语言:`auto`(跟随系统)/ `zh` / `en`(0.3.0+;托盘菜单「语言」可即时切换) |
| `dshRef` | `null` | 覆盖装配的 deepseek-harness 版本(默认取装配清单 `dsh.ref`) |
| `nodeMirrorBase` / `registryMirror` / `githubProxies` | `null` | 高级:自定义 Node 镜像站、npm registry 镜像、GitHub 加速代理列表(默认内置 npmmirror 与常用代理) |
| `checkUpdates` | `true` | 启动后静默检查新版本(托盘菜单同名开关即时修改) |
| `skipVersion` | `""` | 用户选择“跳过此版本”的版本号(如 `0.4.1`) |
| `updateIncludePrerelease` | `false` | 是否把预发布版本也算作可升级 |
| `updateMirror` | `""` | 可选:GitHub 下载地址的加速前缀(如 `https://ghfast.top`);留空=先直连,失败再试内置加速 |
| `updateRepo` | `""`(内置) | 发布仓库 `owner/name`,供 fork 使用 |

修改 `port` / `extraArgs` / `repoPath` 后,用托盘 →「重新启动服务」生效。

### 装配清单(runtime.manifest.json)

默认清单随应用分发(打包在安装目录内);在 **settings.json 同目录**放一个同名
`runtime.manifest.json` 可整体覆盖(顶层与 `dsh`/`node`/`pnpm` 节点做浅合并),
用于渠道锁定仓库版本或指向私有下载源。常用可改字段:`dsh.ref`(版本标签)、
`dsh.url`(源码 zip 地址)、`dsh.sha256`(校验和,留空不校验)、`node.version`/
`node.url`/`node.sha256`、`pnpm.version`、`registry`/`registryMirror`;
可选 `pack.url` / `pack.sha256` 开启“预构建运行包”通道(见打包发布一节)。

> 开发自测:设环境变量 `DSH_DESKTOP_FORCE_PROVISION=1` 启动,可在仓库本来就有效
> 的开发机上强制打开装配向导(仅手动测试用,不影响正式流程)。

### 如何切换装配用的 Node 版本

约束:deepseek-harness 引擎只接受 **Node `^22.19.0 || >=24.0.0`**(20/23 会被拒);
装配的便携 Node 与系统 Node/nvm-windows **互相独立**。

- **换便携 Node 版本(打包版)**:在 `%APPDATA%\DeepSeek Harness Desktop\`
  放覆盖文件 `runtime.manifest.json`:

  ```json
  {
    "node": {
      "version": "24.8.0",
      "url": "https://nodejs.org/dist/v24.8.0/node-v24.8.0-win-x64.zip",
      "sha256": ""
    }
  }
  ```

  sha256 可取自 `https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt`
  (npmmirror 也有同名文件),留空=不校验;
- **必须删旧目录才生效**:引擎对“已存在且 ≥22.19”的 Node 一律复用,不会因清单
  变化自动重装。改完清单后删除
  `%APPDATA%\DeepSeek Harness Desktop\runtime\node` 再重开向导,会重新下载;
- **装配到一半想换**:先取消(会安全终止子进程),按上面改完再续跑——源码包、
  pnpm、依赖与缓存都会跳过/复用,只重做“新 Node → 构建”;
- **预构建运行包通道**:Node 已打进包里,需发布机
  `npm run pack:runtime -- --node-version 24.8.0` 重打并换 `pack.url`;
- **开发/zip 布局想用自己的 Node**:用 `settings.json` 的 `nodePath` 或环境变量
  `DSH_DESKTOP_NODE` 指向任意 node.exe,托盘 →「重新启动服务」生效;注意一旦走
  装配向导,跑的是引擎自己的便携 Node(想用自己的,请用「选择已有仓库…」)。

## 应用自动升级

外壳**自身**的升级走本仓库的 GitHub Releases;deepseek-harness **运行环境**是另一条
版本线,仍由装配向导负责(新版本外壳若固定了更新的 dsh 版本,升级窗口页脚会提示
「检测到新的运行环境」并给出一键入口)。

实现见 `updater.js`(纯 Node,自带 `--selftest`),四步:

1. **检查**:请求 `GET /repos/<repo>/releases/latest`(开启预发布时为 `/releases`),
   用完整 semver 规则(含预发布标识)与 `app.getVersion()` 比较;
2. **下载**:取 `DeepSeek-Harness-Desktop-Setup-<版本>.exe` 存到
   `%APPDATA%\DeepSeek Harness Desktop\updates`,支持断点续传(`Range`),多源回退:
   `updateMirror` 前缀 → 直连 GitHub → 内置加速代理(`mirrorMode: cn` 时加速优先);
3. **校验**:优先用 GitHub 资产 digest,其次用随包发布的 `.sha256`;再校验文件大小与
   PE 头,任一步不通过即删除文件;
4. **安装**:执行 `Setup-<版本>.exe --updated /S --force-run`——electron-builder 的
   NSIS 安装脚本遇到 `--updated` 会跳过所有页面、按注册表记录的目录原地覆盖安装,
   `/S` 静默,`--force-run` 让安装完成后自动重新启动应用。

入口与行为:

| 入口 | 行为 |
|---|---|
| 启动后 8 秒 | 静默检查;发现新版本弹对话框:「立即更新」/「稍后」/「跳过此版本」 |
| 开机自启(`--hidden`) | 只发托盘气泡,不打断用户 |
| 托盘 →「检查更新…」 | 打开升级窗口(版本、更新说明、进度、选项) |
| 托盘 →「⬆ 有可用更新 x.y.z」 | 有未处理的新版本时出现 |
| 应用菜单 →「检查更新…」 | 同上 |

说明与边界:

- 需要当前安装的版本 **≥ 0.4.0**(更早的版本没有升级模块),第一次升级需手动安装一次,
  之后一键完成;
- 升级窗口是独立窗口:**关闭窗口不会中断下载**(重开继续显示进度);托盘退出或点
  「取消下载」才会停止,已下载的部分文件保留以便续传;
- **便携版**无法替换自身 exe:会下载并校验安装包,然后提示「打开文件位置」手动替换;
  未打包的开发运行同理(测试真实交接链路可设 `DSH_DESKTOP_FORCE_UPDATE_INSTALL=1`);
- 代理/网络屏蔽 GitHub 时,可在升级窗口填「下载镜像」前缀(如 `https://ghfast.top`),
   或把 `mirrorMode` 切到 `cn`;
- 安装包**未做代码签名**,首次安装可能出现 SmartScreen 提示;之后原地升级是静默的。

## 自动化检查

| 命令 | 模式 | 验证内容 |
|---|---|---|
| `npm run smoke` | `--smoke` | 无窗口无托盘:拉起真实服务 → 等到就绪 URL → 用 node 对该 URL 发 HTTP 请求(状态码 < 500)→ 停服务退出;0 = 通过 |
| `npm run e2e` | `--e2e` | 真实窗口:加载 GUI 页面成功(`did-finish-load`)即 PASS 并自动退出;120 秒兜底超时判 FAIL |
| `npm run probe` | `--probe` | 真实窗口内 DOM 驱动:打开 设置 → 通用设置,断言「开机自启」行渲染且桥接存在;`DSH_PROBE_TOGGLE=1` 时额外把开关来回各点一次并读回验证 |
| `npm run provision:selftest` | — | 装配引擎离线自测(纯 Node,无需网络/Electron):版本门、镜像 URL 变换、file:// 下载与校验、zip 解压重定位、引擎 API 形态 |
| `npm run update:selftest` | — | 升级引擎离线演练(纯 Node,内置本地 fixture 服务器):semver 比较、发布信息解析、安装包挑选、下载/断点续传/校验和/大小/PE 头 |
| `npm run update:probe` | `--update-probe` | 真实窗口(隐藏):加载 update.html、验证 preload 桥接、走一次真实版本检查;渲染层出现 console error 即 FAIL |

> `probe` 的 PASS 条件包含设置页那行开关,而该行只在仓库打了配套补丁并重建
> 产物后才存在——未打补丁的仓库上 `probe` 会以退出码 1 失败,属预期行为。

### 调试/开发用环境变量

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_REPO` | 指定仓库路径(优先级高于同级目录) |
| `DSH_DESKTOP_NODE` | 指定后端 node.exe |
| `DSH_DESKTOP_FORCE_PROVISION=1` | 仓库有效也强制打开装配向导(手动测试) |
| `DSH_PROVISION_FILELOG=1` | 装配日志同时写入 `desktop.log` |
| `DSH_FORCE_NODE_UNZIP=1` | 装配解压跳过 tar,强制走内置解压器(测试) |
| `DSH_PACK_DEBUG=1` | 装配解压等待/别名修复输出详细日志 |
| `DSH_DESKTOP_SKIP_UPDATE_CHECK=1` | 完全不访问升级服务器(离线/测试) |
| `DSH_DESKTOP_FORCE_UPDATE_INSTALL=1` | 让未打包的开发运行也真正把安装包交给 Windows(测试升级链路) |
| `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` | electron-builder 下载镜像(`dist:cn` 已内置) |

## 仓库配套改动(可选)—「通用设置 开机自启」行

为了让 GUI 内 设置 → 通用设置 也出现「开机自启」开关,仓库侧需要一处小特性
(仅 `packages/client/ui-settings-general` 一个包:行组件 + 控制器 + 桥接契约 +
locale 文案 + 测试 + README)。行为约定:**仅当页面运行在桌面壳内(preload 桥接
`window.__dshDesktopShell` 存在)时才注册该行**,普通浏览器与快照账本零变化;
仓库不含任何 OS 登录项逻辑,登录项由本外壳管理。

- 本机仓库当前处于分支 `feat/desktop-start-at-login-row`,改动已 `git add`
  暂存、尚未提交;若要自行交付,更可靠的载体是补丁文件:
- **应用补丁**(在 deepseek-harness 仓库根目录):

  ```powershell
  git apply "<你的 dsh-desktop-app 目录>\share\dsh-settings-autostart-row.patch"
  pnpm run build:lib:client   # 重新类型检查并打包全部 client 包
  pnpm run build:web          # 重新构建前端 dist(桌面版启动的服务使用最新产物)
  ```

- **没有该补丁,桌面版照常可用**:只是通用设置里没有这一行开关
  (仍可用托盘菜单切换开机自启,两者等效、共用同一配置)。不想改仓库的人无需补丁;
- 想把改动合入上游的,按 `share/PR-INSTRUCTIONS.md` 操作(提交身份、PR 标题与
  正文模板、验证记录一应俱全)。

## 打包发布(Windows)

### 产物

```powershell
npm run dist        # NSIS 安装版 + 便携版(win x64)
npm run dist:cn     # 同上,但 Electron 与打包工具链改走 npmmirror(国内网络推荐)
npm run dist:dir    # 仅产出 release/win-unpacked(免安装目录版,调试用)
```

`release/` 下产出(首次运行需联网下载 Electron 发行包与 electron-builder 打包工具;
国内网络不通时用 `dist:cn`,或自行设置环境变量
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`):

- `DeepSeek-Harness-Desktop-Setup-<版本>.exe` —— **向导式安装程序**;
- `DeepSeek-Harness-Desktop-Portable-<版本>.exe` —— **便携单文件版**;
- `win-unpacked/` —— 解包目录(相当于免安装版;打包结构,设置同样落在
  `%APPDATA%\DeepSeek Harness Desktop\settings.json`)。

版本号取自 `package.json` 的 `version`,发新版前先递增;产物命名规则在
`package.json` 的 `build` 段。打包脚本统一带 `--publish never`:否则 electron-builder
在打 tag 构建时会尝试隐式发布并要求 `GH_TOKEN`,导致构建失败;发布由
[build 工作流](.github/workflows/build.yml)负责——它跑两个引擎自测、每次 push 打包、
tag 构建时额外生成每个 exe 的 `.sha256` 校验文件,并为 `v*` 标签创建 GitHub Release
(应用内升级读取的正是这个 Release)。

**发布一次升级**:改 `package.json` 版本号 → 提交 → `git tag vX.Y.Z && git push origin vX.Y.Z`
→ 等工作流完成 → 确认 Release 里包含 `DeepSeek-Harness-Desktop-Setup-X.Y.Z.exe`
(以及 `.sha256`、`.blockmap`、便携版)。已安装的应用下次启动检查时即可看到新版本。

### 安装版行为

双击 Setup 后依次为:欢迎页 → 用户协议(需接受,文本见 `build/license.txt`)→
安装方式(当前用户/所有用户)→ 选择安装目录 → **安装选项**(“创建桌面快捷方式”
与 “开机自启(登录后后台驻留托盘)”,默认均勾选)→ 安装完成(可选立即运行)。
默认安装目录 `%LOCALAPPDATA%\Programs\DeepSeek Harness Desktop`;
静默安装 `Setup.exe /S` 采用两个选项均勾选的默认行为。卸载会删除程序、
快捷方式与开机自启注册项;用户数据(设置、装配的运行环境与缓存,位于
`%APPDATA%`)默认保留,需彻底清除时手动删除 `%APPDATA%\DeepSeek Harness Desktop`。

### 便携版行为

单文件 exe 免安装;运行时在临时目录解压,因此设置与装配产物一律落到
`%APPDATA%\DeepSeek Harness Desktop\`。

### 安装版/便携版与 zip 版的行为差异

- **首次运行自动装配**(settings 未设 `repoPath` 且未设 `DSH_DESKTOP_REPO` 时):
  自动打开运行环境向导,下载并安装便携 Node + 固定版本的 deepseek-harness
  (zip 版通常靠“同级仓库”自动命中,不走装配;把 `autoProvision` 设为 `false`
  可退回旧版目录选择框);
- 装配完成后**不再要求**目标机器预装任何东西;zip 布局仍沿用原流程,需要机器上
  有 Node.js ≥ 22.19 与已 `pnpm install && pnpm run build` 的仓库——桌面版自带
  Electron 壳,zip 模式下不带 Node 与仓库。

### 可定制件

| 文件 | 用途 |
|---|---|
| `build/license.txt` | 安装协议内容,分发前可替换后重新打包 |
| `build/installer.nsh` | 安装选项页文案与勾选、注册表/快捷方式逻辑 |
| `assets/icon-source.svg` / `assets/icon.ico` | 图标源与生成产物 |
| `runtime.manifest.json` | 装配清单(默认源/版本/校验和;也可在 settings.json 旁放覆盖文件) |
| `package.json` → `build` | electron-builder 配置(产品名、artifact 命名等) |

### 预构建运行包(可选,方案 B)

在**发布机**(已有 `pnpm install && pnpm run build` 好的仓库)上执行:

```powershell
npm run pack:runtime   # 可加 --repo <路径> --ref <标签> --out <目录>
```

产出(默认在 `release\runtime\`):

- `dsh-runtime-<ref>-win-x64.zip` —— 内含便携 Node、完整仓库(依赖已装、
  前端已构建,不含 .git);
- 同名 `.sha256` —— 校验和文件。

把 zip 与校验和上传到你的分发渠道(GitHub Release / 内网共享等),然后在
`runtime.manifest.json`(或 %APPDATA% 覆盖文件)里开启该通道:

```json
{ "pack": { "url": "<zip 的下载地址>", "sha256": "<.sha256 文件里的值>" } }
```

之后所有用户的装配都走“下载→校验→解压即用”,不再在用户机器上跑 pnpm/构建。
去掉该 `pack` 条目即回退到在线源码构建。注意:

- 包体较大:本仓库 ≈1.5 GB,deflate 压缩后约 500 MB(安装 7-Zip 后打包更快,
  或改产 7z 格式进一步缩小);
- 每个 ref 一份包,随上游发版重打即可;装的是官方源码,不含本目录
  `share\` 的补丁(用户侧可自行打);
- 包内 node_modules 符号链接以“别名清单”形式记录在 `pack.json`,解压后由引擎
  重建为 junction/副本——目标机无需管理员或开发者模式。

## 分享给他人

**普通用户(推荐)**:直接分发 `npm run dist` 的安装版或便携版即可——对方双击
安装,首次运行自动装配运行环境(需联网,10–40 分钟),之后零前置使用。
网络不佳时可在向导里切「国内镜像」。

**开发者/内网(已有 Node.js ≥ 22.19 与构建好的仓库)**:沿用 zip 布局交付,两部分:

1. **桌面壳**(本目录):压缩包(建议名 `DeepSeek-Harness-Desktop-<版本>.zip`),
   内容为本目录全部源码/脚本/图标/补丁, **不含** `node_modules/`、`release/`、
   `settings.json`(安装时会自动生成)。对方解压后执行:

   ```powershell
   powershell -ExecutionPolicy Bypass -File setup.ps1 -RepoPath "对方的deepseek-harness路径"
   ```

   `setup.ps1` 自动完成:定位/校验仓库(参数 → `DSH_DESKTOP_REPO` → 同级目录)→
   `npm install`(约 200MB,需联网;已装则跳过)→ 写 `settings.json`(只写
   `repoPath`,其余用默认)→ 生成图标与桌面/开始菜单快捷方式。

2. **仓库配套改动(可选)**:`share\dsh-settings-autostart-row.patch`(范围仅
   `ui-settings-general` 一个包)。想要「通用设置 开机自启」开关的对方,在仓库执行:

   ```powershell
   git apply share\dsh-settings-autostart-row.patch
   pnpm run build:lib:client && pnpm run build:web
   ```

   **没有该补丁,桌面版照常可用**,只是设置页少了那一行开关(托盘菜单等效)。

> 网络受限时,可先设镜像再 `npm install`:
> `npm config set registry https://registry.npmmirror.com`,并以环境变量
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 重跑。

## 注意事项与排障

- **避免两个实例并存**:桌面版每次启动自己的服务实例;不要让它与浏览器里的旧
  GUI(`dsh web`)同时运行并共享同一份 `~/.dsh` 会话数据。先用托盘退出(或 Ctrl+C)
  停掉旧的,再打开桌面版;
- **仓库更新后(zip 布局)**:先 `pnpm install && pnpm run build`,再用 托盘 →
  「重新启动服务」重启后端;装配出的运行环境由外壳管理,无需手动更新;
- **启动失败/超时**:后端需在 90 秒内输出就绪行,否则弹错并展示最近日志;
  到 `%USERPROFILE%\.dsh-desktop-logs\desktop.log` 看完整输出;
- **退出即停服务**:托盘「退出」会强制结束服务进程树;会话数据按事件实时落盘,
  已保存的内容不受影响;
- **卸载(zip 布局)**:运行 `scripts\uninstall.ps1`(移除快捷方式、清除指向本目录的
  开机自启注册项),然后删除本文件夹即可;
- **单实例锁定**:第二个启动请求只会聚焦已有主窗口;如需完全重启,先托盘退出;
- **固定端口冲突**:把 `port` 设为固定值后,若端口被占用会启动失败,请保持 `0`
  或先释放端口;
- **装配失败先看两点**:下载源(向导切「国内镜像」/「直连」)与网络;重试会自动
  续跑已完成的步骤。装配日志在向导内实时显示,如需同时写入 `desktop.log`,
  启动前设环境变量 `DSH_PROVISION_FILELOG=1`;
- **装配期间关窗**:关闭向导窗口 = 隐藏到托盘后台继续;托盘「退出」才会真正取消
  并停止下载/构建;
- **杀软/防火墙**:装配会大量联网并执行 node/pnpm 构建,如被拦截请放行
  `%APPDATA%\DeepSeek Harness Desktop\runtime`;
- **无需管理员/开发者模式**:无符号链接权限的机器上,tar 解压失败时会自动改用
  内置解压器(符号链接条目降级为占位,运行包会按清单重建 junction);源码包没有
  `.git` 时构建所需的提交元数据由 ref 派生,装配照常完成;
- **卸载残留**:安装版卸载默认保留 `%APPDATA%\DeepSeek Harness Desktop`
  (设置 + 装配产物,约 3 GB)。先卸载程序,再手动删除该目录即可彻底清除;
- **双击没反应/没有窗口**:九成是“旧实例还占着单实例锁”(旧版装过并勾了开机自启,
  登录后以 `--hidden` 驻留托盘,新进程静默让位)。任务管理器结束所有
  `DeepSeek Harness Desktop` 进程、卸载旧版再装新版;
- **系统装有旧 Node 不影响装配**:0.2.5+ 全程把便携 Node 目录置顶到 PATH。
  若日志里出现 `Node.js v20.x … globSync` 一类报错,说明用的是 ≤0.2.4 的旧包,
  请升级;
- **任务栏图标空白**:0.2.6+ 在图标读取失败时自动回退 exe 内嵌图标;仍空白多为
  Windows 图标缓存——重启“Windows 资源管理器”或取消/重新固定任务栏图标;
- **装配进度卡在“解压”且报 Can't create / tar error**(旧版现象):无符号链接权限
  的机器上 tar 会失败,0.2.3+ 已自动改用内置解压器,升级即可;
- **检查更新失败**:升级窗口会给出具体原因(HTTP 404 / 网络不可达 / 校验不符等)。
  国内网络或公司代理常需填「下载镜像」前缀或切 `mirrorMode: cn`;若提示
  “该仓库还没有发布任何版本”,说明对应 tag 的 Release 还没生成(见「打包发布」);
- **升级下载中断**:关窗口不中断下载;重新打开窗口会显示进度。中途断网的部分文件
  保留在 `%APPDATA%\DeepSeek Harness Desktop\updates`,点「下载更新」会从断点续传;
- **升级后应用没重启**:`--force-run` 只在静默安装时生效;若安装程序被 SmartScreen
  拦下,手动运行一次 Setup 即可,数据与设置不受影响(均在 `%APPDATA%`);
- **升级后仍显示旧版本**:确认安装目录未被手工移动过(NSIS 按注册表记录的目录原地
  升级);必要时用新版 Setup 手动覆盖安装一次。

版本号统一维护在 `package.json`(`version` 与 `build` 段的产物命名联动);
发新版前先递增版本,再 `npm run dist` 产出对应版本号的安装包。

## 版本历史

| 版本 | 要点 |
|---|---|
| 0.1.x | 桌面壳基础:独立窗口、托盘、开机自启、首次运行仓库选择、smoke/e2e/probe |
| 0.2.0 | 首次运行自动装配运行环境(向导、镜像、断点续跑) |
| 0.2.1 | 修复打包版 settings.json 落到 asar 内导致写失败的问题;主进程崩溃落盘 + 错误弹窗 |
| 0.2.2 | 预构建运行包通道(pack 源)+ node_modules 符号链接别名清单与 junction 重建 |
| 0.2.3 | tar 解压失败自动回退内置解压器(zip64、符号链接占位);无 `.git` 源码包构建适配 |
| 0.2.4 | pnpm 全局安装固定 `--prefix`,不再装到 `%APPDATA%\npm` |
| 0.2.5 | 装配与后端子进程 PATH 置顶便携 Node,系统旧 Node 不再劫持构建 |
| 0.2.6 | 窗口图标读取失败自动回退 exe 内嵌图标,修复任务栏空白 |
| 0.3.0 | 国际化:界面双语(托盘/对话框/向导/安装器,跟随系统+手动切)、README 中英分版、GitHub CI 与 Release、MIT 许可 |
| 0.4.0 | 应用自动升级:启动静默检查 + 可跳过版本、升级窗口(版本/更新说明/进度/选项)、断点续传 + 多源 + 完整性校验的下载、静默原地 NSIS 升级;修复 CI 隐式发布导致的构建失败并发布 `.sha256` 校验文件 |
