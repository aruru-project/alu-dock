#!/usr/bin/env bash
# Main and a SubHost in two Docker containers, for checks that need two real machines.
# Run as root on the Docker host (here: ssh root@127.0.0.1). See scripts/trials/README.md.
#
#   cross-machine-docker.sh up SECRETS_ENV [PROXY] [MAIN_MODELS_JSON]
#                                                    start both Hosts; only Main gets the secrets
#                                                    and the optional models.json
#   cross-machine-docker.sh run                      drive the check from Main
#   cross-machine-docker.sh connections              which addresses each container talked to
#   cross-machine-docker.sh down                     remove containers, network and the join file
#
# NODE_DIR must name a Node 24 install whose glibc matches the image (Ubuntu 24.04), e.g.
# NODE_DIR=/home/me/.nvm/versions/node/v24.22.1. The repository is mounted read-only; build it first.
set -euo pipefail
REPO=${ALU_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}
IMAGE=${ALU_TRIAL_IMAGE:-docker.m.daocloud.io/library/ubuntu:24.04}
SHARED=/tmp/alu-trial-shared
MAIN=alu-trial-main SUB=alu-trial-sub NET=alu-trial-net

up() {
  local secrets=${1:?usage: up SECRETS_ENV [PROXY] [MAIN_MODELS_JSON]} proxy=${2:-} models=${3:-}
  : "${NODE_DIR:?set NODE_DIR to a Node 24 directory}"
  [ -d "$REPO/dist/src" ] || { echo "Build the repository first (npm run build)"; exit 1; }
  down >/dev/null 2>&1 || true
  mkdir -p "$SHARED" && chmod 700 "$SHARED"
  docker network create "$NET" >/dev/null
  local common=(--network "$NET" --platform linux/amd64 -v "$NODE_DIR:/opt/node:ro" -v "$REPO:/opt/alu:ro" -v "$SHARED:/shared")
  if [ -n "$proxy" ]; then
    local noproxy=localhost,127.0.0.1,$MAIN,$SUB
    common+=(-e "HTTPS_PROXY=$proxy" -e "HTTP_PROXY=$proxy" -e "https_proxy=$proxy" -e "http_proxy=$proxy" -e "NO_PROXY=$noproxy" -e "no_proxy=$noproxy")
  fi
  docker run -d --name "$MAIN" --hostname "$MAIN" "${common[@]}" --env-file "$secrets" "$IMAGE" sleep infinity >/dev/null
  docker run -d --name "$SUB" --hostname "$SUB" "${common[@]}" "$IMAGE" sleep infinity >/dev/null
  for c in "$MAIN" "$SUB"; do
    # The state directory must be private, as Dock creates it on a real machine.
    docker exec "$c" sh -c 'ln -sf /opt/node/bin/node /usr/local/bin/node && mkdir -p /root/.pi/agent /root/project && mkdir -m 700 -p /root/state'
    # Dock reads a machine's environment from its login shell, as on a real computer, not from
    # docker -e; so the proxy goes where a login shell reads it.
    docker exec "$c" sh -c 'env | grep -E "^(HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy)=" | sed "s/^/export /" > /etc/profile.d/alu-trial-proxy.sh'
  done
  # Only Main gets the secrets, also through its login shell.
  local names; names=$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$secrets" | tr -d '=' | paste -sd '|')
  docker exec "$MAIN" sh -c "umask 077; env | grep -E '^($names)=' | sed 's/^/export /' > /etc/profile.d/alu-trial-secrets.sh; chmod 644 /etc/profile.d/alu-trial-secrets.sh"
  if [ -n "$models" ]; then docker cp "$models" "$MAIN:/root/.pi/agent/models.json"; fi
  docker exec "$MAIN" sh -c 'cd /root && node /opt/alu/dist/src/cli.js machine join-file --out /shared/join.json --state /root/state/catalog.json --machine-name Main'
  docker exec -d "$MAIN" sh -c 'cd /root && ALU_DOCK_SOCKET=/root/dock.sock exec node /opt/alu/dist/src/cli.js serve --dev --state /root/state/catalog.json --machine-port 7443 > /root/main.log 2>&1'
  sleep 4
  local main_ip; main_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$MAIN")
  docker exec "$SUB" node /opt/alu/scripts/trials/subhost-settings.mjs "$main_ip"
  docker exec -d "$SUB" sh -c 'cd /root && exec node /opt/alu/dist/src/cli.js serve --dev --state /root/state/catalog.json --join-file /shared/join.json > /root/sub.log 2>&1'
  sleep 5
  echo "Main:    $(docker exec "$MAIN" tail -1 /root/main.log)"
  echo "SubHost: $(docker exec "$SUB" tail -1 /root/sub.log)"
  echo "SubHost Pi directory entries: $(docker exec "$SUB" sh -c 'ls -A /root/.pi/agent | wc -l')"
}

run() {
  docker exec ${MODEL:+-e MODEL="$MODEL"} "$MAIN" node /opt/alu/scripts/trials/cross-machine-driver.mjs
  echo "ok.txt on the SubHost: $(docker exec "$SUB" sh -c 'cat /root/project/ok.txt 2>&1')"
  echo "SubHost Pi directory: $(docker exec "$SUB" sh -c 'ls -A /root/.pi/agent | tr "\n" " "')"
}

# Closed connections stay in the table for about a minute, so this shows whom a container talked to.
connections() {
  for c in "$SUB" "$MAIN"; do
    echo "$c:"
    docker exec "$c" sh -c 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null' | python3 -c '
import socket, struct, sys
seen = set()
for line in sys.stdin:
    parts = line.split()
    if len(parts) < 4 or parts[0] == "sl": continue
    ip, port = parts[2].split(":"); port = int(port, 16)
    if port == 0: continue
    if len(ip) == 8: addr = socket.inet_ntoa(struct.pack("<I", int(ip, 16)))
    else:
        raw = bytes.fromhex(ip); addr = socket.inet_ntop(socket.AF_INET6, b"".join(raw[i:i + 4][::-1] for i in range(0, 16, 4)))
    seen.add(f"{addr}:{port}")
for item in sorted(seen): print("  ", item)'
  done
}

down() {
  docker rm -f "$MAIN" "$SUB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$SHARED"
}

command=${1:-}; shift || true
case "$command" in
  up) up "$@" ;;
  run) run ;;
  connections) connections ;;
  down) down ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
