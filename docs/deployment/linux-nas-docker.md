# Linux / NAS Docker 部署指南

## 1. 支持范围

Task 1 的部署基线面向：

- 常规 x86_64 Linux 服务器；
- ARM64 Linux 主机；
- 支持 Docker Engine 与 Docker Compose v2 的 NAS；
- 通过 Tailscale、Cloudflare Access 或可信反向代理访问的私有部署。

官方 Node 与 PostgreSQL 镜像均提供 amd64 / arm64 架构版本。镜像构建不写死 CPU 架构，由 Docker 在目标主机上选择对应平台镜像。

## 2. 前置条件

- Docker Engine 26 或更新版本；
- Docker Compose v2；
- 至少 2 GB 可用内存；
- 至少 10 GB 可用磁盘空间；
- NAS 数据盘应启用定期快照或外部备份；
- GitHub 已配置访问私有仓库的凭据。

## 3. 首次启动

```bash
git clone https://github.com/ArchitectureWorld/ai-super-canvas.git
cd ai-super-canvas
git switch feat/risk-first-vertical-slice
cp .env.example .env
```

生成 URL-safe 数据库密码：

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

将输出写入 `.env`。数据库密码只使用字母、数字、连字符和下划线，避免未经编码的 `@`、`:`、`/` 等字符破坏 `DATABASE_URL`。

```dotenv
APP_BIND_ADDRESS=127.0.0.1
APP_PORT=3000
APP_OWNER_ID=local-owner
POSTGRES_USER=canvas
POSTGRES_PASSWORD=上一步生成的URL安全随机字符串
POSTGRES_DB=canvas
OPENAI_API_KEY=
OPENAI_MODEL=
AI_AVAILABLE_MODELS=deterministic-v1
AI_DEFAULT_MODEL=deterministic-v1
```

`AI_AVAILABLE_MODELS` 是画布块可选择模型的逗号分隔目录，`AI_DEFAULT_MODEL` 必须是其中一项。示例只声明模型名称；真实 provider secret 只写入部署主机的 `.env`，不得提交到 Git。

启动：

```bash
docker compose build
docker compose up -d
docker compose ps
```

健康检查：

```bash
curl --fail http://127.0.0.1:3000/api/health
```

## 4. 访问方式

### 4.1 推荐：可信代理或组网访问

保持：

```dotenv
APP_BIND_ADDRESS=127.0.0.1
```

由以下任一方式提供访问：

- Tailscale；
- Cloudflare Access；
- Nginx / Caddy 等反向代理，并配置可靠身份验证；
- NAS 自带反向代理，但必须启用 HTTPS 和访问控制。

### 4.2 仅局域网直连

确实需要局域网设备直接访问时：

```dotenv
APP_BIND_ADDRESS=0.0.0.0
```

然后重新创建容器：

```bash
docker compose up -d --force-recreate app
```

不要把端口直接映射到公网。Task 1 仍是单用户私有 Alpha 骨架，尚未提供正式应用内认证。

## 5. NAS 存储

PostgreSQL 18 使用命名卷：

```text
ai-super-canvas-postgres
```

Compose 将它挂载到：

```text
/var/lib/postgresql
```

这符合 PostgreSQL 18 官方镜像的数据目录布局。不要改回旧版本常用的 `/var/lib/postgresql/data`，否则可能造成升级和卷识别问题。

需要将数据落到 NAS 指定目录时，可以把命名卷改成 bind mount：

```yaml
services:
  postgres:
    volumes:
      - /volume1/docker/ai-super-canvas/postgres:/var/lib/postgresql
```

具体宿主机路径应按 NAS 品牌和存储池调整。修改前先停止服务并完成数据库备份。

## 6. 备份与恢复

### 6.1 逻辑备份

```bash
mkdir -p backups
docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "backups/canvas-$(date +%Y%m%d-%H%M%S).dump"
```

这个命令读取 PostgreSQL 容器内的真实环境变量，因此即使 `.env` 修改了数据库名或用户，也不会错误地回退到默认值。

### 6.2 恢复演练

先停止应用，保持数据库运行：

```bash
docker compose stop app
```

恢复到空数据库后再启动应用。正式进入 Gate D 前，必须完成一次真实恢复演练并记录结果。

## 7. 更新

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker image prune -f
```

更新前先备份 PostgreSQL。

Task 1 的运行镜像只包含生产应用，不包含 pnpm 和源码，因此不能在 `app` 容器内临时执行迁移。后续引入领域表时，仓库会增加独立的 migration image / Compose profile；在此之前没有数据库迁移需要执行。

## 8. 日志与排查

```bash
docker compose ps
docker compose logs -f --tail=200 app
docker compose logs -f --tail=200 postgres
```

检查资源占用：

```bash
docker stats
```

如果应用容器不健康：

1. 检查 `/api/health`；
2. 检查数据库健康状态；
3. 检查 `.env` 中的密码和端口；
4. 检查 NAS 防火墙和反向代理；
5. 检查 CPU 架构与镜像拉取日志。

## 9. 安全基线

- `.env` 不提交 Git；
- 数据库不映射宿主机端口；
- 应用默认只绑定 `127.0.0.1`；
- 容器启用 `no-new-privileges`；
- 应用运行用户不是 root；
- 生产环境禁止使用 `DEV_USER_ID`；
- 未部署可信认证层之前禁止公网暴露；
- 定期更新基础镜像并检查依赖漏洞。
