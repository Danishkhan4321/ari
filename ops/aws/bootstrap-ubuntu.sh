#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this once with sudo on a new Ubuntu Lightsail instance." >&2
  exit 1
fi

deploy_user="${SUDO_USER:-ubuntu}"
apt-get update
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker "$deploy_user"

if [[ ! -d /opt/ari/.git ]]; then
  git clone https://github.com/Danishkhan4321/ari.git /opt/ari
fi
chown -R "$deploy_user:$deploy_user" /opt/ari

echo "Bootstrap complete. Create /opt/ari/.env.production, then run ops/aws/deploy.sh as $deploy_user."
