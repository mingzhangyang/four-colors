# 部署与回滚

四色图志以 Cloudflare Workers 静态资源方式部署（`wrangler.jsonc`，无服务端代码）。单款游戏的更新只走本仓库的 CI 与部署流程，不触发 games 或其他游戏的发布。

## 发布顺序

1. CI（`.github/workflows/ci.yml`）在 PR 与 main 上运行：lint → `content:check` → 模型/关卡/每日测试 → 构建 → 首屏预算 → Playwright smoke。
2. 预览验收：`npm run build && npx wrangler dev`，或部署到预览 Worker 后按 [实现状态](implementation-status.md) 中“待人工完成”的清单做真机与试玩。
3. 配置正式域名：在 `wrangler.jsonc` 加入
   `"routes": [{ "pattern": "four-colors.orangely.xyz", "custom_domain": true }]`，确认 canonical、`sitemap.xml`、`og.png` 与 `#/p/FC08` 这类深链在正式域名可用。
4. 手动运行 **Deploy** 工作流（`.github/workflows/deploy.yml`，需要仓库 secrets `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）。它会先完整跑一遍校验再部署。
5. 正式站点验收通过后，再到 games 仓库单独提交外链接入 PR（`site.home.externalGames`），预览域名不写入合集卡片。

## 回滚

- 重新运行 Deploy 工作流，`ref` 填上一个已知良好的提交或 tag；或
- `npx wrangler rollback`（回到上一个 Worker 版本）。

每日题库文件按 `D###.r<revision>.json` 命名且不可变，回滚代码不会让已排期的每日内容改变；`content/daily-lock.json` 只允许追加。

## 缓存

`public/_headers`：`/assets/*` 与 `/daily/*` 为一年 immutable（文件名带内容哈希或 revision），`index.html` 为 `no-cache`，保证新版本立即生效且旧资源可长期缓存。
