#!/usr/bin/env bash
# One-shot setup for the Control Tower demo on a fresh EC2 instance.
# Works on Amazon Linux 2023 and Ubuntu 22.04 / 24.04.
#
# Usage (from the unzipped project folder on the instance):
#   sudo bash deploy/ec2-setup.sh
# Optional password protection:
#   sudo DEMO_USER=demo DEMO_PASS='choose-a-password' bash deploy/ec2-setup.sh
set -euo pipefail

APP_DIR=/opt/control-tower
APP_USER=controltower
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then echo "Please run with sudo." >&2; exit 1; fi

. /etc/os-release
echo "==> Detected OS: ${PRETTY_NAME}"

install_node_and_nginx() {
  if command -v node >/dev/null 2>&1 && [[ "$(node -v | cut -c2- | cut -d. -f1)" -ge 18 ]]; then
    echo "==> Node $(node -v) already installed"
  else
    echo "==> Installing Node.js 20"
    if [[ "${ID}" == "amzn" ]]; then
      dnf install -y nodejs20 nodejs20-npm || { curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && dnf install -y nodejs; }
      # Amazon Linux names the binaries node-20 / npm-20; expose them as node / npm
      [[ -x /usr/bin/node-20 && ! -e /usr/bin/node ]] && ln -s /usr/bin/node-20 /usr/bin/node
      [[ -x /usr/bin/npm-20 && ! -e /usr/bin/npm ]] && ln -s /usr/bin/npm-20 /usr/bin/npm
    else
      apt-get update -y
      apt-get install -y ca-certificates curl gnupg
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y nodejs
    fi
  fi
  echo "==> Installing nginx"
  if [[ "${ID}" == "amzn" ]]; then dnf install -y nginx; else apt-get install -y nginx; fi
}

install_node_and_nginx

echo "==> Creating service user and copying app to ${APP_DIR}"
id -u "${APP_USER}" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "${APP_USER}" 2>/dev/null || useradd --system --no-create-home --shell /sbin/nologin "${APP_USER}"
mkdir -p "${APP_DIR}"
cp -r "${SRC_DIR}/server.js" "${SRC_DIR}/package.json" "${SRC_DIR}/package-lock.json" "${SRC_DIR}/src" "${SRC_DIR}/public" "${SRC_DIR}/scripts" "${APP_DIR}/"
cd "${APP_DIR}"
npm ci --omit=dev --no-audit --no-fund
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

echo "==> Writing environment file"
cat > /etc/control-tower.env <<EOF
PORT=3000
HOST=127.0.0.1
NODE_ENV=production
TICK_MS=5000
SIM_MINUTES_PER_TICK=2
DEMO_USER=${DEMO_USER:-}
DEMO_PASS=${DEMO_PASS:-}
EOF
chmod 600 /etc/control-tower.env

echo "==> Installing systemd service"
cp "${SRC_DIR}/deploy/control-tower.service" /etc/systemd/system/control-tower.service
sed -i "s|__NODE__|$(command -v node)|" /etc/systemd/system/control-tower.service
systemctl daemon-reload
systemctl enable --now control-tower
systemctl restart control-tower

echo "==> Configuring nginx reverse proxy on port 80"
if [[ -d /etc/nginx/sites-available ]]; then
  cp "${SRC_DIR}/deploy/nginx-control-tower.conf" /etc/nginx/sites-available/control-tower
  ln -sf /etc/nginx/sites-available/control-tower /etc/nginx/sites-enabled/control-tower
  rm -f /etc/nginx/sites-enabled/default
else
  cp "${SRC_DIR}/deploy/nginx-control-tower.conf" /etc/nginx/conf.d/control-tower.conf
  # Amazon Linux's default server block also listens on 80; make ours the default
  sed -i 's/listen 80;/listen 80 default_server;/; s/listen \[::\]:80;/listen [::]:80 default_server;/' /etc/nginx/conf.d/control-tower.conf
  sed -i 's/listen       80 default_server;/listen       8081;/; s/listen       \[::\]:80 default_server;/listen       [::]:8081;/' /etc/nginx/nginx.conf || true
fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> Waiting for the app to come up"
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1/api/health && echo

TOKEN=$(curl -s -m 2 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)
PUBLIC_IP=$(curl -s -m 2 -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
echo
echo "Done. Open: http://${PUBLIC_IP:-<your-ec2-public-ip>}/"
echo "Logs:   sudo journalctl -u control-tower -f"
echo "Restart: sudo systemctl restart control-tower"
