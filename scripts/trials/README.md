# 真机与跨机器检查

普通测试碰不到的检查：真实供应商、两台真正分开的机器，以及在这组机器上看助手 Work 和官方 Desktop 客户端。它们都不在 `npm test` 里，每次运行都要用户授权：会调用真实模型、花额度，Docker 那项还要用户给一个临时 key。第一次用于 card #303（2026-11-05）。

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

## 助手 Work 配真实模型：`assistant-driver.mjs`

在同一组容器的 Main 上，以主人的身份和助手 Work 说话，把她和她派出去的 Work 做了什么打印出来给人读。第一次用于 card #667（2026-11-13）。普通测试里模型的回复是写好的，这里看的是真实模型会不会该派的派、该自己答的自己答、交接记录写得对不对。

```bash
# 1. 第三个参数给 Main 一份 models.json（只放要用的 provider）。想在短对话里看到交接记录，
#    再加一个同样地址和 key、但 contextWindow 很小（如 40000）的 provider，脚本里叫 openai-sub-small。
ssh root@127.0.0.1 "NODE_DIR=$HOME/.nvm/versions/node/v24.22.1 bash $PWD/scripts/trials/cross-machine-docker.sh up /tmp/alu-trial-secrets.env '' /tmp/alu-trial-models.json"

# 2. 一步一步跑，STEPS 按顺序列出要跑的；每一步后面打印她的会话里新增的内容：
ssh root@127.0.0.1 'docker exec -e STEPS=chat,remember,delegate,question,stop,remind,forget alu-trial-main node /opt/alu/scripts/trials/assistant-driver.mjs'
#    其余步骤：handoff（换小窗口模型读长文，直到写出交接记录）、leave 和 back（中间在外面重启 Host）、
#    create（替主人在 Laptop 上开 Work）、memories（十分钟没有新话之后看后台整理出了什么）、
#    child（CHILD=名字的一部分，看某个子 Work 收到了什么、做了什么）、works、transcript。
#    MODEL=provider/id 和 THINKING 指定她的模型，默认 openai-sub/gpt-6-luna、low。
```

容器里没有时区数据，`date` 打印的是 UTC；想让她的现状用本地时间，在起 Host 之前往 `/etc/profile.d/` 写一行 `export TZ=Asia/Shanghai`（Node 自带时区数据）。

## 官方 Desktop 客户端装进容器：`desktop-client-driver.mjs`

浏览器预览里的 native 一侧是样例数据，连不到真实 Host。要看真实客户端对着真实 Host 的样子，把 Linux 版客户端放进 Main 容器，用 WebKitWebDriver 操作它（Linux 上的 Tauri 是 WebKitGTK，没有 CDP）。客户端和 Host 在同一台“机器”上，走本机连接，不用配对。

```bash
# 1. 本机编译客户端（不打包）：
(cd clients/official && corepack pnpm tauri build --no-bundle --ci)

# 2. 容器里装运行库、虚拟屏幕和 WebDriver，放进客户端和操作脚本：
ssh root@127.0.0.1 'docker exec alu-trial-main sh -c "sed -i s#http://archive.ubuntu.com/ubuntu/#http://mirrors.tuna.tsinghua.edu.cn/ubuntu/# /etc/apt/sources.list.d/ubuntu.sources; apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libwebkit2gtk-4.1-0 webkit2gtk-driver xvfb fonts-noto-cjk libayatana-appindicator3-1 librsvg2-2 dbus-x11 ca-certificates xauth"'
ssh root@127.0.0.1 "docker exec alu-trial-main mkdir -p /opt/client && docker cp $PWD/clients/official/src-tauri/target/release/aludock-client-app alu-trial-main:/opt/client/ && docker cp $PWD/scripts/trials/desktop-client-driver.mjs alu-trial-main:/root/wd.mjs"

# 3. 起虚拟屏幕和 WebDriver。客户端找的是本机默认 socket，试验 Host 的 socket 在别处，所以连一个链接过去：
ssh root@127.0.0.1 'docker exec -d alu-trial-main sh -c "Xvfb :99 -screen 0 1440x900x24 -nolisten tcp"'
ssh root@127.0.0.1 'docker exec -d alu-trial-main sh -c "mkdir -p /root/.alu-dock/run && ln -sf /root/dock.sock /root/.alu-dock/run/dock.sock; export DISPLAY=:99 TAURI_WEBVIEW_AUTOMATION=true WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 LANG=C.UTF-8; exec dbus-run-session -- WebKitWebDriver --port=4444 --host=127.0.0.1"'

# 4. 打开客户端，点「连接」，之后看字、点按钮、打字、截图：
ssh root@127.0.0.1 'docker exec alu-trial-main sh -c "node /root/wd.mjs start && sleep 5 && node /root/wd.mjs click text=连接 && sleep 4 && node /root/wd.mjs shot connected"'
ssh root@127.0.0.1 'cat /tmp/alu-trial-shared/connected.png' > /tmp/connected.png
```

Host 重启后客户端左上角显示「Host」，要点开它按「刷新状态」才会读到新内容，和真机一样。容器没有时区数据，客户端里的时间是 UTC。

## 踩过的坑

- **环境变量从登录 shell 读。** Dock 给 Worker 和模型服务的环境来自那台机器的登录 shell，和真机一样，`docker run -e` 传进去的变量它们看不到。所以脚本把代理和密钥写进 `/etc/profile.d/`。真机也一样：子机器的代理和密钥要写在登录 shell 读的配置里。
- **状态目录必须是 0700**，否则 Host 拒绝启动。
- **回答项目信任时要沿用原来的 operation ID。** 用 `trust_once` 回答信任挑战时，必须用引发挑战的那个 operation ID 再发一次，换一个会得到 `invalid_project_trust_challenge`。
- **订阅登录（OAuth）不放进容器**，容器里只用临时 API key。
- 镜像经 `docker.m.daocloud.io` 拉取，需要时先 `docker pull --platform linux/amd64 docker.m.daocloud.io/library/ubuntu:24.04`。
