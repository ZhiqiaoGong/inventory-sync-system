#!/usr/bin/env bash
#
# Provisions a bare Amazon Linux 2023 (arm64) host into a running v2 stack.
#
# Paste it into the EC2 "User data" box at launch and the instance builds and
# starts itself on first boot; or run it by hand on a box that is already up:
#
#   sudo bash deploy/bootstrap.sh
#
# Nothing here is instance-specific, so the box stays disposable: terminate it,
# launch a new one with this same user data, and the stack comes back.
set -euo pipefail

# Pinned deliberately. `latest` broke the build once already: compose v5 refuses
# to build against the buildx 0.12 that ships with AL2023, so these two versions
# have to move together.
COMPOSE_VERSION=v5.3.1
BUILDX_VERSION=v0.35.0

REPO_URL=https://github.com/zhiqiaogong/inventory-sync-system.git
APP_DIR=/home/ec2-user/inventory-sync-system
PLUGIN_DIR=/usr/libexec/docker/cli-plugins

log() { echo "[bootstrap] $*"; }

if [ "$(uname -m)" != "aarch64" ]; then
  echo "expected an arm64 host (t4g family); found $(uname -m)" >&2
  exit 1
fi

log "installing docker and git"
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user

# AL2023 has no docker-compose-plugin package, so both CLI plugins come from
# Docker's own releases.
log "installing compose ${COMPOSE_VERSION} and buildx ${BUILDX_VERSION}"
mkdir -p "$PLUGIN_DIR"
curl -fsSL \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-aarch64" \
  -o "$PLUGIN_DIR/docker-compose"
curl -fsSL \
  "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-arm64" \
  -o "$PLUGIN_DIR/docker-buildx"
chmod +x "$PLUGIN_DIR/docker-compose" "$PLUGIN_DIR/docker-buildx"

log "cloning $REPO_URL"
rm -rf "$APP_DIR"
git clone --depth 1 "$REPO_URL" "$APP_DIR"
chown -R ec2-user:ec2-user "$APP_DIR"

log "building images (a few minutes on 2 vCPUs)"
cd "$APP_DIR"
docker compose up --build -d

# The box has no Elastic IP — a public IP is assigned fresh on every launch, so
# read it back from the instance metadata rather than assuming the last one.
# IMDSv2 is required on this instance, hence the token handshake.
token=$(curl -fsSL -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
public_ip=$(curl -fsSL -H "X-aws-ec2-metadata-token: $token" \
  "http://169.254.169.254/latest/meta-data/public-ipv4")

log "waiting for the app to report healthy"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://localhost:3000/health" >/dev/null 2>&1; then
    log "stack is up: http://${public_ip}:3000"
    exit 0
  fi
  sleep 2
done

echo "[bootstrap] app did not pass /health in time; check 'docker compose logs'" >&2
exit 1
