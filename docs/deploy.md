# 部署与回滚

四色图志以 Cloudflare Workers 静态资源方式部署（`wrangler.jsonc`，无服务端代码），正式地址 **https://four-colors.orangely.xyz**。部署由 **Cloudflare Workers Builds** 关联本 GitHub 仓库自动完成：推送到 `main` 即构建并发布正式站点，其他分支只上传预览版本。单款更新只走本仓库，不触发 games 或其他游戏的发布。

## 一次性关联（在 Cloudflare 控制台完成）

前提：`orangely.xyz` 这个 zone 在同一个 Cloudflare 账户下（games 已使用该账户）。若 DNS 里已有名为 `four-colors` 的记录，先删除，自定义域名会自动创建 DNS 记录与证书。

1. Workers & Pages → **Create** → **Import a repository** → 授权 GitHub 并选择 `mingzhangyang/four-colors`。
2. 项目名填 **`four-colors`**（必须与 `wrangler.jsonc` 的 `name` 一致）。
3. Build settings：

   | 字段 | 值 |
   | --- | --- |
   | Production branch | `main` |
   | Build command | `npm run build:cloudflare` |
   | Deploy command | `npx wrangler deploy` |
   | Non-production branch deploy command | `npx wrangler versions upload` |
   | Root directory | `/` |

   Node 版本由仓库根目录的 `.node-version`（22）决定；依赖由 Workers Builds 按 `package-lock.json` 安装。`build:cloudflare` 会先跑内容一致性检查与模型/关卡/每日测试再构建，任何一项失败都不会部署。
4. 保存并触发首次构建。`wrangler deploy` 读取 `routes` 中的 `four-colors.orangely.xyz`（`custom_domain: true`）并绑定自定义域名；`workers.dev` 子域已关闭，PR/分支构建会得到预览 URL。

浏览器 smoke 测试需要 Chromium，放在 GitHub Actions CI（`.github/workflows/ci.yml`）里跑；建议在 GitHub 分支保护中把 CI 设为合并 `main` 的必需检查，这样进入 `main` 的提交都已通过完整回归。

## 发布前验收

- 正式域名首页、`#/p/FC08` 这类深链、`/og.png`、`/sitemap.xml`、`/robots.txt` 可访问；canonical 指向正式域名。
- 按 [实现状态](implementation-status.md) 第 3 节完成真机、试玩与读屏验收。
- 通过后再到 games 仓库单独提交外链接入 PR（`site.home.externalGames`），预览 URL 不写入合集卡片。

## 回滚

- Cloudflare 控制台 → Workers & Pages → `four-colors` → **Deployments** → 选择上一个版本 → Rollback；或
- 本地 `npx wrangler rollback`（需要账户权限）；或
- 在 `main` 上 revert 有问题的提交，Workers Builds 会自动重新部署。

每日题库文件按 `D###.r<revision>.json` 命名且不可变，回滚代码不会改变已发布的每日地图；`content/daily-lock.json` 只允许追加，且锁定起始日（epoch）。

## 缓存

`public/_headers`：`/assets/*` 与 `/daily/*` 为一年 immutable（文件名带内容哈希或 revision），`index.html` 为 `no-cache`，新版本立即生效，旧资源可长期缓存。
