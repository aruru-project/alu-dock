# 真机与跨机器检查

普通测试碰不到的两类检查：真实供应商，以及两台真正分开的机器。这两类都不在 `npm test` 里，每次运行都要用户授权：会调用真实模型、花额度，Docker 那项还要用户给一个临时 key。第一次用于 card #303（2026-11-05）。

开始前先 `npm run build`。要验证 Pi 分叉里还没发布的改动，先装好本地候选包。

## 真实供应商：`real-providers.mjs`

在本机另起一个 Host，有自己的 socket、catalog 和会话目录，和用户共用 Pi 目录（`~/.pi/agent`）。依次检查：

- Codex 走 HTTP，带一次工具调用；
- Codex 走 WebSocket；
- 扩展（pi-alu-sol-tuner 的 `/codex-usage`）通过 Pi 拿 Codex 令牌查额度；
- GitHub Copilot 回一句话。

```bash
node scripts/trials/real-providers.mjs
# 换模型：CODEX_MODEL=openai-codex/gpt-6-luna COPILOT_MODEL=github-copilot/claude-haiku-5.5
```

为什么共用 Pi 目录而不复制一份：订阅的刷新令牌用一次就作废，在副本里刷新会让用户真实的登录掉线。软链接也不行，Pi 给 `auth.json` 加锁时不跟随软链接。

为了不留痕迹，脚本这样处理用户的数据：

- 会话写在临时目录里，跑完删掉；项目信任只给这一次，不记下来。
- Work 里切换 model 和 thinking 时，Pi 会把它们存成用户的默认值。跑完后，如果值还是测试写的那个，就改回原值；如果期间被别人改过，就不动并提示。
- `auth.json` 从不还原：里面唯一可能的变化是 Pi 刷新过的登录，还原反而会让用户掉线。
- 最后打印 Pi 目录的前后对比。只看哈希和过期时间，不打印任何凭据。

输出里的 "Questions the Works asked Main" 是每个 Work 向 Main 要了什么，以及拿回的是哪种答复（有没有 key、地址指向哪台主机），不含凭据本身。

HTTP 那项是通过项目设置指定 `transport: "sse"` 的。请求成功时 Pi 不记录实际用的传输方式，所以只能确认设置下发了，不能证明真的走了 HTTP。WebSocket 那项能证明：如果改走了 HTTP，Pi 会在回复里留下 `provider_transport_failure`。

## 两台机器：`cross-machine-docker.sh`

起两个 Ubuntu 24.04 容器 `alu-trial-main` 和 `alu-trial-sub`：

- 仓库只读挂进去，本机的 Node 也挂进去。镜像的 glibc 要和本机一致，本机 Node 才能直接用。
- SubHost 用 Hub 设置页同样的方式保存"作为 SubHost"，再用 Main 生成的一次性 join file 加入。
- 只有 Main 拿到密钥；SubHost 什么模型配置都没有。

以 root 在 Docker 所在的机器上运行，这里是 `ssh root@127.0.0.1`。

```bash
# 1. 用户给的临时 key 写进仓库外的文件，只有自己能读：
umask 077; printf 'OPENAI_API_KEY=...\n' > /tmp/alu-trial-secrets.env

# 2. 起机器，第二个参数是可选的出口代理，第三个是可选的 Main models.json：
NODE_DIR=$HOME/.nvm/versions/node/v24.22.1 \
  ssh root@127.0.0.1 bash "$PWD/scripts/trials/cross-machine-docker.sh" up /tmp/alu-trial-secrets.env http://<代理主机>:<端口>

# 3. 在 Main 上驱动：SubHost 上的 Work 回一句话、调一次工具（MODEL=provider/id 可指定模型）：
ssh root@127.0.0.1 bash "$PWD/scripts/trials/cross-machine-docker.sh" run

# 4. 每个容器连过哪些地址（关掉的连接约一分钟内还在表里）：
ssh root@127.0.0.1 bash "$PWD/scripts/trials/cross-machine-docker.sh" connections

# 5. 收尾，然后删掉密钥文件，告诉用户可以吊销 key：
ssh root@127.0.0.1 bash "$PWD/scripts/trials/cross-machine-docker.sh" down
rm /tmp/alu-trial-secrets.env
```

第 4 步是证据：SubHost 应该只连了 Main 的机器端口（7443）和出口代理；Main 只有 SubHost 连进来的那一条，自己不向外发请求。

## 踩过的坑

- **环境变量从登录 shell 读。** Dock 给 Worker 和模型服务的环境来自那台机器的登录 shell，和真机一样，`docker run -e` 传进去的变量它们看不到。所以脚本把代理和密钥写进 `/etc/profile.d/`。真机也一样：子机器的代理和密钥要写在登录 shell 读的配置里。
- **状态目录必须是 0700**，否则 Host 拒绝启动。
- **回答项目信任时要沿用原来的 operation ID。** 用 `trust_once` 回答信任挑战时，必须用引发挑战的那个 operation ID 再发一次，换一个会得到 `invalid_project_trust_challenge`。
- **订阅登录（OAuth）不放进容器**，容器里只用临时 API key。
- 镜像经 `docker.m.daocloud.io` 拉取，需要时先 `docker pull --platform linux/amd64 docker.m.daocloud.io/library/ubuntu:24.04`。
