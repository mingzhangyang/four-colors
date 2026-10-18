# 部署与回滚

四色图志以 Cloudflare Workers 静态资源方式部署（`wrangler.jsonc`，无服务端代码），正式地址 **https://four-colors.orangely.xyz**。

2026-10-17 的 Cloudflare 部署记录显示：**已有 `four-colors` Worker、生产部署和自定义域名**，最近生产版本由 Wrangler 发布。但未找到该 Worker 的 GitHub Workers Builds 构建记录和触发器。已部署不代表 Git 自动部署已建立，也不代表已经完成公网、手机和读屏验收。**不要再创建同名 Worker，也不要删除其现有 DNS 记录。**

## 在现有 Worker 上关联 GitHub（一次性）

1. Cloudflare → **Workers & Pages** → 选择已存在的 **`four-colors`**。
2. 打开 **Settings → Builds → Connect**，授权 GitHub 后选 `mingzhangyang/four-colors`；不要走创建新 Worker 的入口。
3. 核对现有 Worker 的名称与 `wrangler.jsonc` 的 `name` 都为 `four-colors`。配置：

   | 字段 | 值 |
   | --- | --- |
   | Production branch | `main` |
   | Build command | `npm run build:cloudflare` |
   | Deploy command | `npx wrangler deploy` |
   | Non-production branch deploy command | `npx wrangler versions upload` |
   | Root directory | `/` |

4. Node 22 来自 `.node-version`；`build:cloudflare` 做内容锁校验、规则测试和构建。Chromium smoke 由 GitHub Actions 检查（Wrangler dry-run 不是部署证据）。
5. 经 CI 验证的 PR 合并到 `main` 后，在 Workers Builds 页面核对源 Git SHA、成功部署版本和生产流量，随后验证自定义域名。不要从旧本地 `dist` 重复手工部署。

Cloudflare 官方文档：https://developers.cloudflare.com/workers/ci-cd/builds/

## 发布前验收

- 正式域名首页、`#/p/FC08` 这类深链、`/og.png`、`/sitemap.xml`、`/robots.txt` 可访问；canonical 指向正式域名。
- 按 [实现状态](implementation-status.md) 第 3 节完成真机、试玩与读屏验收。
- 通过后再到 games 仓库单独提交外链接入 PR（`site.home.externalGames`），预览 URL 不写入合集卡片。

## 回滚

- Cloudflare 控制台 → Workers & Pages → `four-colors` → **Deployments** → 选择上一个版本 → Rollback；或
- 本地 `npx wrangler rollback`（需要账户权限）；或
- 在 `main` 上 revert 有问题的提交，Workers Builds 会自动重新部署。

编号题库文件按 `D###.r<revision>.json` 命名且不可变；本次改版允许 60 个编号全部自由访问，历史 `content/daily-lock.json` 的 epoch 仅用于审计，不再决定开放资格。回滚到旧应用版本会恢复旧代码的日期开放限制（不会删除已保存的完成记录），请评估这一行为变化。

## 缓存

`public/_headers`：`/assets/*` 与 `/daily/*` 为一年 immutable（文件名带内容哈希或 revision），`index.html` 为 `no-cache`，新版本立即生效，旧资源可长期缓存。
