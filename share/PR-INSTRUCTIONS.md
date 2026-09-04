# 仓库改动提交与 PR 操作说明

本文件记录如何把「设置 → 通用设置 开机自启行」的仓库改动提交并提 PR 回
`deepseek-ai/deepseek-harness`。桌面壳部分(dsh-desktop-app)不在此列。

## 当前状态

- 分支已创建:`feat/desktop-start-at-login-row`(基于 master)
- 全部改动已 `git add`(暂存)、**尚未提交**(仓库没有配置提交身份)
- 改动范围:`packages/client/ui-settings-general`(源码/测试/README 中英)
  + `.agents/notes/implemented/feature/2026-09-03-desktop-shell-start-at-login-row.{md,zh.md}`
- 不涉及构建产物(lib/dist 已被 gitignore)

## 1) 配置身份并提交

```powershell
git config user.name "你的名字"
git config user.email "你的邮箱"
git commit -m "feat(client): add start-at-login row to General settings behind desktop-shell bridge

Settings -> General renders a Start at login switch only while the page runs
inside the desktop-shell wrapper (the optional window.__dshDesktopShell
preload bridge); plain browsers keep the settings.general.item ledger
unchanged because the row never registers. The repository ships only the
bridge contract, the row, and its locale copy - OS login-item logic stays in
the out-of-repo Electron shell that already owns the tray toggle, sharing one
settings.json behind IPC handlers restricted to the main window.

Coverage: controller, row-component, and apply-registration specs (including
the no-bridge negative); test:gui is green."
```

提交后补齐 Agent Note 双语一致性记录(会生成 `.i18n.yaml` sidecar):

```powershell
pnpm exec tsx scripts/verify-translation-pairing.ts --write .agents/notes/implemented/feature/2026-09-03-desktop-shell-start-at-login-row.md
git add .agents/notes/implemented/feature/
git commit --amend --no-edit
```

## 2) 已在本地完成的验证

- `pnpm exec vitest run packages/client/ui-settings-general/tests` 全绿(61 项)
- `pnpm run test:gui`:3936 通过、1 失败,失败项
  (`ui-theme/tests/corner-shape-styles.client.spec.ts`)由本次新增 CSS 漏写
  `corner-shape: round` 导致,**已修复并复跑通过**(61/61)
- `pnpm run build:lib:client`、`pnpm run build:web` 成功
- 端到端(桌面壳):真实窗口内 设置→通用设置 渲染「开机自启」行,开关
  两次切换均真实读写 Windows 登录自启(读回 false/true 与注册表一致)

## 3) 提 PR

本机没有安装 `gh`,且没有直接推送 `deepseek-ai/deepseek-harness` 的权限:

1. 在 GitHub 网页 fork `deepseek-ai/deepseek-harness` 到您的账号;
2. 添加 remote 并推送分支:

```powershell
git remote add fork https://github.com/<你的账号>/deepseek-harness.git
git push fork feat/desktop-start-at-login-row
```

3. 用网页或安装 `gh` 后向 `deepseek-ai/deepseek-harness:master` 发起 PR。

PR 标题建议:

> feat(client): start-at-login row in General settings behind desktop-shell bridge

PR 正文要点(可直接粘贴):

- **动机**: 桌面外壳(仓库外 Electron 配套)提供托盘开机自启;用户希望在
  设置 → 通用设置看到同一开关。
- **做法**: `window.__dshDesktopShell` 可选桥接契约(getAutoStart/setAutoStart)
  + 快照 store 控制器 + `settings.general.item` 行;**仅桥接存在时注册**,
  普通浏览器与快照账本零变化;仓库不含任何 OS 登录项逻辑。
- **测试**: 控制器/组件/apply 注册规范(含无桥接负例);`test:gui` 绿。
- **标签**: `kind/feature`、`area/web-client`(以及 `area/settings` 若有)。
- 已附 Agent Note(feature 类,中英 + sidecar)。
- 说明快照无变化的理由:行注册以桥接存在为前提,keyless 快照环境无桥接。

若本地需再跑检查,按仓库规则用 `.agents/skills/dsh-pre-push-checks` 挑选最小门禁
(该改动是客户端包,至少应跑 `test:gui`;若上游要求再看
`DSH_SNAPSHOT=replay pnpm run test:web`)。
