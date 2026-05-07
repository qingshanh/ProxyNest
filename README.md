# ProxyNest

ProxyNest 是一个本地优先的代理订阅管理面板，用于批量导入订阅、解析节点、去重、测活、测速、解锁检测、维护优质节点池，并生成可直接给 Clash/Mihomo、v2rayN/v2rayNG 使用的订阅链接。

后端使用 Fastify + TypeScript，前端使用 React + Vite。生产模式下后端会同端口托管前端页面。

## 功能

- 批量添加订阅，支持 Clash/Mihomo YAML、v2rayN/v2rayNG base64 文本、URI 列表。
- GitHub raw 链接自动加前置代理，可自动发现 GitHub 免费订阅。
- 入库前节点去重，默认策略为协议 + IP/域名 + 端口。
- 订阅源去重，支持 URL、内容签名、同仓库节点数量和协议分布弱重复判断。
- 测活、测速、OpenAI/YouTube/Netflix/Disney+ 解锁检测。
- 任务中心支持排队、暂停、继续、取消、历史清理和实时进度。
- 优质节点池，支持最低速度、高延迟阈值、连续综合不达标移除。
- 国家备用订阅，按国家排序并保留每国优质节点。
- 生成活跃节点、测速合格、优质池、国家备用、平台解锁订阅。
- Telegram HTML 通知，订阅链接以超链接形式发送。
- GeoIP 本地 MMDB 数据库，可手动或定时更新。

## 快速开始

安装 Node.js 20 或更高版本。

```powershell
cd Bestsub
npm install
Copy-Item .env.example .env
```

编辑 `.env`，至少修改：

```text
ADMIN_PASSWORD=你的面板密码
COOKIE_SECRET=随机长字符串
PUBLIC_BASE_URL=http://127.0.0.1:8080
```

构建并启动：

```powershell
npm run build:all
npm start
```

访问：

```text
http://127.0.0.1:8080
```

首次登录密码来自 `.env` 的 `ADMIN_PASSWORD`。数据库初始化后，如果要改密码，请在面板设置页修改。

## 开发模式

后端：

```powershell
npm run dev
```

前端：

```powershell
npm run dev:web
```

开发访问：

```text
http://127.0.0.1:5173
```

前端会自动回退到 `http://127.0.0.1:8080` 请求后端，尽量避免关闭系统代理后 API 失败。

## Mihomo

真实测活、测速、解锁需要配置 Mihomo。不配置 `MIHOMO_BIN` 时服务仍可启动，但测速和解锁会提示需要 Mihomo，测活只能使用 TCP 兜底。

Windows 把 `mihomo.exe` 放在项目根目录时可配置：

```text
MIHOMO_BIN=./mihomo.exe
MIHOMO_API_SECRET=proxynest
MIHOMO_BASE_PORT=17890
MIHOMO_BASE_CONTROLLER_PORT=17990
```

Linux/VPS 把 `mihomo` 放在项目根目录时可配置：

```bash
chmod +x ./mihomo
```

```text
MIHOMO_BIN=./mihomo
MIHOMO_API_SECRET=proxynest
MIHOMO_BASE_PORT=17890
MIHOMO_BASE_CONTROLLER_PORT=17990
```

也可以填写绝对路径：

```text
MIHOMO_BIN=D:\tools\mihomo.exe
```

设置页会显示 Mihomo 路径是否存在。改 `.env` 后需要重启后端。

Docker 部署时，项目根目录的 `mihomo` 不会自动进入运行容器，需要挂载到 `/app/mihomo`：

```yaml
volumes:
  - ./data:/app/data
  - ./mihomo:/app/mihomo:ro
```

然后设置：

```text
MIHOMO_BIN=/app/mihomo
```

如果面板仍显示 `/app/mihomo.exe`，说明容器仍在使用旧环境变量或旧镜像，请确认 VPS 上的 `.env`、`docker compose config` 输出和容器重建结果。

## Telegram

在 `.env` 或设置页配置：

```text
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=123456:bot-token
TELEGRAM_CHAT_ID=123456789
TELEGRAM_API_BASE_URL=https://api.telegram.org
```

如果网络无法直连 Telegram，可把 `TELEGRAM_API_BASE_URL` 改成你的反代地址。任务启动时勾选 Telegram 通知后，任务成功结束会发送汇总消息，包含节点统计和订阅超链接。

如果通知没有收到：

- 先在设置页点击“发送测试通知”。
- 确认 Telegram 已启用，Bot Token 和 Chat ID 正确。
- 查看任务详情里的 `telegram` stats，发送失败原因会记录在那里。

## GeoIP

默认本地库路径：

```text
data/geoip/GeoLite2-Country.mmdb
```

设置页可配置本地库下载地址并立即更新。推荐来源：

- ip66: `https://downloads.ip66.dev/db/ip66.mmdb`，免 key，MMDB，日更。
- DB-IP Lite: 免费 Lite，MMDB，月更。
- IPinfo Lite: 免费 Lite，MMDB/CSV/JSON，日更但下载通常需要 token。

在线 API 可作为兜底，例如：

```text
http://ip-api.com/json/{ip}?fields=status,country,countryCode
https://ipapi.co/{ip}/json/
https://ipwho.is/{ip}
https://api.country.is/{ip}
```

GitHub 规则集文件不是 GeoIP 查询 API，不能直接填在 GeoIP API URL。

## 订阅输出

订阅页会展示可复制链接。常见路径：

```text
/sub/{token}/alive.yaml
/sub/{token}/alive.txt
/sub/{token}/speed.yaml
/sub/{token}/speed.txt
/sub/{token}/reusable.yaml
/sub/{token}/reusable.txt
/sub/{token}/country-backup.yaml
/sub/{token}/country-backup.txt
/sub/{token}/platform/openai.yaml
/sub/{token}/platform/openai.txt
```

订阅 token 可在设置页重置，重置后旧链接立即失效。

## 优质节点池

入池规则在设置页配置：

- 入池硬性最低速度：默认 1 MB/s，测速低于此值不会入池。
- 入池最低速度：默认 3 MB/s，用于判断高速节点。
- 高延迟阈值：超过阈值会降低质量。
- 连续综合不达标移除：节点连续多轮不满足质量条件才移出优质池。

优质池会参与后续复测和订阅生成，适合长期沉淀可用节点。

## 本机访问排错

推荐访问：

```text
http://127.0.0.1:8080
```

不要用 `http://0.0.0.0:8080` 作为浏览器地址。`0.0.0.0` 是监听地址，不是访问地址。

如果关闭系统代理后页面能打开但 API 请求失败：

- 确认后端正在运行并监听 `8080`。
- 优先访问 `http://127.0.0.1:8080`。
- 系统代理绕过列表加入：`127.0.0.1;localhost`。
- 开发模式下访问 `http://127.0.0.1:5173`，Vite 会代理到 `127.0.0.1:8080`。

## Docker

```bash
cp .env.example .env
docker compose up -d --build
```

反向代理示例：

```nginx
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 常用命令

```bash
npm run typecheck:all
npm run build:all
npm start
docker compose down
docker logs -f proxynest-api
```

## 目录

```text
apps/api/src       后端源码
apps/web/src       前端源码
data               本地数据库、GeoIP、本地订阅产物
docker             Docker 相关文件
```
