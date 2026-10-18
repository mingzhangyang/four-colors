# 四色图志 Fourfold Atlas

用四种颜色修复一部失色地图册：相邻区域不同色，在边界之间寻找协调的秩序。独立开发、独立部署的单页解谜游戏（vanilla JavaScript + Vite + SVG）。

当前阶段：**首发候选已实现**——32 个主线关、8 个修复短篇、60 张编号每日地图、收藏配色与导出均可玩，模型/内容/浏览器测试通过；Cloudflare 自动部署的仓库侧配置已就绪，但站点尚未上线，也尚未做真人试玩与真机验收（见 [实现状态](docs/implementation-status.md)）。

- [完整实现方案（持续维护的详细规格）](docs/implementation-plan.md)
- [实现状态与验收证据](docs/implementation-status.md)
- [体验与内容增强方案（后续设计）](docs/experience-enhancement-plan.md)
- [部署与回滚](docs/deploy.md)
- [四色地图示意图](docs/diagrams/fourfold-atlas-four-colors.svg)
- [Mini Games Collection](https://github.com/mingzhangyang/games)

计划正式地址：`https://four-colors.orangely.xyz`（尚未上线）。仓库侧已按 Cloudflare Workers Builds 配置好（关联后推送 `main` 即自动部署），但还需在 Cloudflare 控制台把本仓库关联到 Workers Builds；完成这一步之前不会部署，步骤见 [部署与回滚](docs/deploy.md)。

## 快速开始

```bash
npm ci                 # Node ≥ 22.12
npm run dev            # 本地开发服务器
npm run build          # 生产构建 → dist/
npm run verify         # lint + 内容检查 + 模型/关卡/每日测试 + 构建 + 浏览器 smoke
```

| 命令 | 作用 |
| --- | --- |
| `npm run content:build` | 由 `tools/levels/*.mjs` 规格重新生成关卡主数据与运行时模块 |
| `npm run content:check` | 在内存中重新生成并与提交的文件逐字比对；拓扑变化未升 revision、已发布的每日编号被改写或起始日被移动时失败 |
| `npm run build:cloudflare` | Cloudflare Workers Builds 使用的构建命令：内容检查 + 测试 + 构建 |
| `npm test` | `tests/verify-four-colors-{rules,levels,daily}.mjs` |
| `npm run smoke` | `tests/smoke-four-colors.mjs`，用 Playwright Chromium 驱动 `dist/` |
| `node tools/checks/budget.mjs` | 首屏 JS gzip 预算（≤150 KB） |
| `node tools/generators/og-image.mjs` | 从矢量来源生成 `public/og.png` 与 PNG 图标 |

## 目录

```text
index.html                    单页入口（首屏主题/语言引导脚本）
src/
  index.js                    组装存储、设置、音频、提示服务与游戏
  game.js                     路由、命令入口（模型 → 完成判定 → 渲染 → 存档）、记录与生命周期
  model/{rules,commands,solver,kempe}.js   纯规则层，可在 Node 中运行
  content/{levels,chapters,checksum}.js    懒加载与校验；generated/ 为编译产物
  render/{atlas,map,feedback,landmarks,dom}.js
  input/{pointer,keyboard}.js
  services/{settings,daily,hints,hint-engine,hint-worker,export}.js
  storage.js / i18n.js / audio.js
  styles/main.css
tools/
  generators/four-colors-build.mjs   关卡管线（Voronoi/手工几何 → 共享网格 → 编译检查 → 谜题与证书）
  lib/                                几何、Voronoi、网格构建、编译器、手绘抖动、谜题构造
  levels/{main,daily,shapes}.mjs      关卡规格；revisions.lock.json 锁定拓扑与 revision
content/master/*.json          关卡主数据（共享顶点、边、区域环、线索、见证、证书）
content/daily-lock.json        已发布的每日编号与起始日（只追加，不改写）
public/daily/*.json            编号每日题库（No.1…），按 revision 命名，首次需要时才下载
tests/                         模型、内容、每日与浏览器回归
```

## 独立性与匿名访问统计

本仓库自带构建、依赖、设置、版本化存档、UTC+8 每日编号规则与 CI；核心游戏不依赖合集的 CSS 或运行时。仅在正式域名可选异步加载 `games` 的 Analytics V2 客户端；预览和 localhost 不加载。客户端匿名统计页面打开、前台活跃时长，以及用户首次有效着色/擦除/交换后的实际游玩时长与关卡完成次数。查看地图册、进入收藏、选择颜料、提示、重开和恢复已通关存档均不计对局；退出关卡或完成后结束游玩计时。不使用 Cookie、账号或独立数据库，网络故障不会影响游戏。统计 Worker 的新外站 ID 与 CORS 来源必须先部署，详情见 games PR #152。

返回合集使用固定链接 `https://games.orangely.xyz/`。语言与主题可由 `?lang=en|zh`、`?theme=light|dark|system` 初始化，已保存的偏好优先，声音默认静音且不经 URL 传递。
