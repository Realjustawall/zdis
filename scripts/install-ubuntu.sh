#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_NAME="zdis"
INSTALL_DIR="${INSTALL_DIR:-/opt/zdis}"
DOMAIN="${DOMAIN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"

log() { printf '\033[1;36m[ZDis]\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
secret() { openssl rand -base64 "${1:-36}" | tr -d '\n=+/' | head -c "${2:-48}"; }

usage() {
  cat <<'EOF'
ZDis Ubuntu installer

Usage:
  sudo bash scripts/install-ubuntu.sh [options]

Options:
  --domain chat.example.com       Enable host Nginx and Let's Encrypt
  --admin-email admin@example.com Initial administrator email
  --email ops@example.com         Let's Encrypt notification email
  --install-dir /opt/zdis         Installation directory
  --non-interactive               Accept defaults
  --help                          Show this help

DNS for --domain must already point to this server. Without a domain the
platform is installed on http://SERVER_IP:8080.
EOF
}

while (($#)); do
  case "$1" in
    --domain) DOMAIN="${2:?missing domain}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:?missing email}"; shift 2 ;;
    --email) LETSENCRYPT_EMAIL="${2:?missing email}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:?missing directory}"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || die "Run this installer with sudo/root."
[[ -f "$SOURCE_DIR/infra/docker-compose.enterprise.yml" ]] ||
  die "Run the installer from a complete ZDis source checkout."

. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || die "This installer supports Ubuntu only."
case "${VERSION_ID:-}" in
  22.04|24.04|26.04) ;;
  *) log "Ubuntu ${VERSION_ID:-unknown} is not in the tested list; continuing carefully." ;;
esac

if [[ "$NON_INTERACTIVE" != "true" && -z "$DOMAIN" ]]; then
  read -r -p "Domain (leave empty for server IP): " DOMAIN
fi
if [[ "$NON_INTERACTIVE" != "true" && "$ADMIN_EMAIL" == "admin@example.com" ]]; then
  read -r -p "Initial administrator email: " ADMIN_EMAIL
fi
[[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] ||
  die "Invalid administrator email."
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "Invalid domain."
[[ "$INSTALL_DIR" != *[[:space:]]* ]] || die "Installation path cannot contain spaces."

log "Installing operating-system prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg openssl rsync jq ufw unattended-upgrades

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine from the official repository"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  arch="$(dpkg --print-architecture)"
  . /etc/os-release
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$arch" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
docker compose version >/dev/null

available_kb="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
if (( available_kb < 3000000 )) && ! swapon --show --noheadings | grep -q .; then
  log "Low-memory host detected; creating a 2 GiB protected swap file"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi

log "Applying kernel limits for OpenSearch, WebSocket and TURN workloads"
cat >/etc/sysctl.d/99-zdis.conf <<'EOF'
vm.max_map_count=262144
vm.swappiness=10
fs.file-max=1048576
net.core.somaxconn=65535
net.core.netdev_max_backlog=16384
net.ipv4.ip_local_port_range=10240 65535
net.ipv4.tcp_fin_timeout=15
net.ipv4.tcp_keepalive_time=600
EOF
sysctl --system >/dev/null

log "Copying application files to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if [[ "$(realpath "$SOURCE_DIR")" != "$(realpath -m "$INSTALL_DIR")" ]]; then
  rsync -a --delete \
    --exclude='.git' --exclude='.env' --exclude='node_modules' --exclude='client/dist' \
    --exclude='.tmp' --exclude='test-results' --exclude='server/data' \
    "$SOURCE_DIR/" "$INSTALL_DIR/"
fi
mkdir -p "$INSTALL_DIR/infra/secrets"

SERVER_IP="$(hostname -I | awk '{print $1}')"
PUBLIC_ORIGIN="http://${SERVER_IP}:8080"
HTTP_PORT="8080"
SECURE_COOKIES="false"
PUBLIC_LIVEKIT_URL="ws://${SERVER_IP}:7880"
S3_PUBLIC_ENDPOINT="http://${SERVER_IP}:9000"
MINIO_PORT="9000"
MINIO_CONSOLE_PORT="127.0.0.1:9001"
LIVEKIT_HTTP_PORT="7880"
if [[ -n "$DOMAIN" ]]; then
  PUBLIC_ORIGIN="https://${DOMAIN}"
  HTTP_PORT="127.0.0.1:8080"
  SECURE_COOKIES="true"
  PUBLIC_LIVEKIT_URL="wss://${DOMAIN}"
  # Serve signed objects through the already-required application hostname so
  # an installation does not depend on a second DNS record and certificate.
  S3_PUBLIC_ENDPOINT="https://${DOMAIN}"
  MINIO_PORT="127.0.0.1:9000"
  LIVEKIT_HTTP_PORT="127.0.0.1:7880"
fi

APP_SECRET="$(secret 48 64)"
AUDIT_SIGNING_KEY="$(secret 48 64)"
RECOVERY_SIGNING_KEY="$(secret 48 64)"
POSTGRES_PASSWORD="$(secret 36 48)"
ADMIN_PASSWORD="$(secret 24 28)Aa1!"
MINIO_USER="zdis$(secret 8 10)"
MINIO_PASSWORD="$(secret 36 48)"
LIVEKIT_API_KEY="zdis$(secret 12 16)"
LIVEKIT_API_SECRET="$(secret 36 48)"
TURN_SHARED_SECRET="$(secret 36 48)"
GRAFANA_PASSWORD="$(secret 20 24)Aa1!"
METRICS_TOKEN="$(secret 36 48)"

cat >"$INSTALL_DIR/.env.production" <<EOF
PUBLIC_ORIGIN=$PUBLIC_ORIGIN
PUBLIC_URL=$PUBLIC_ORIGIN
HTTP_PORT=$HTTP_PORT
SECURE_COOKIES=$SECURE_COOKIES
APP_SECRET=$APP_SECRET
AUDIT_SIGNING_KEY=$AUDIT_SIGNING_KEY
RECOVERY_CODE_SIGNING_KEY=$RECOVERY_SIGNING_KEY
SEED_ADMIN_EMAIL=$ADMIN_EMAIL
SEED_ADMIN_USERNAME=admin
SEED_ADMIN_PASSWORD=$ADMIN_PASSWORD
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_POOL_MAX=8
MINIO_ROOT_USER=$MINIO_USER
MINIO_ROOT_PASSWORD=$MINIO_PASSWORD
MINIO_PORT=$MINIO_PORT
MINIO_CONSOLE_PORT=$MINIO_CONSOLE_PORT
S3_PUBLIC_ENDPOINT=$S3_PUBLIC_ENDPOINT
MEDIA_ORIGINS=$S3_PUBLIC_ENDPOINT
LIVEKIT_API_KEY=$LIVEKIT_API_KEY
LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET
LIVEKIT_NODE_IP=$SERVER_IP
PUBLIC_LIVEKIT_URL=$PUBLIC_LIVEKIT_URL
LIVEKIT_HTTP_PORT=$LIVEKIT_HTTP_PORT
TURN_REALM=${DOMAIN:-$SERVER_IP}
TURN_EXTERNAL_IP=$SERVER_IP
PUBLIC_TURN_URL=turn:$SERVER_IP:3478
TURN_SHARED_SECRET=$TURN_SHARED_SECRET
GRAFANA_ADMIN_PASSWORD=$GRAFANA_PASSWORD
GRAFANA_PORT=127.0.0.1:3000
JOB_CONCURRENCY=4
MEDIA_CONCURRENCY=2
NODE_OPTIONS=--max-old-space-size=384
OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m
DLP_MODE=block
BACKUP_RETENTION_DAYS=30
EOF
printf '%s\n' "$METRICS_TOKEN" >"$INSTALL_DIR/infra/secrets/metrics-token.txt"
chmod 600 "$INSTALL_DIR/.env.production" "$INSTALL_DIR/infra/secrets/metrics-token.txt"

cat >/etc/systemd/system/zdis.service <<EOF
[Unit]
Description=ZDis Enterprise Chat Platform
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStartPre=$INSTALL_DIR/scripts/configure-media-routing.sh
ExecStart=/usr/bin/docker compose --env-file $INSTALL_DIR/.env.production -f $INSTALL_DIR/infra/docker-compose.enterprise.yml up -d --remove-orphans
ExecStop=/usr/bin/docker compose --env-file $INSTALL_DIR/.env.production -f $INSTALL_DIR/infra/docker-compose.enterprise.yml down
TimeoutStartSec=0
TimeoutStopSec=180

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable zdis.service

cat >/usr/local/bin/zdisctl <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
cd "$INSTALL_DIR"
compose=(docker compose --env-file "$INSTALL_DIR/.env.production" -f "$INSTALL_DIR/infra/docker-compose.enterprise.yml")
case "\${1:-status}" in
  start) systemctl start zdis ;;
  stop) systemctl stop zdis ;;
  restart) systemctl restart zdis ;;
  status) "\${compose[@]}" ps ;;
  logs)
    if [[ -n "\${2:-}" ]]; then
      "\${compose[@]}" logs -f --tail=200 "\$2"
    else
      "\${compose[@]}" logs -f --tail=200
    fi
    ;;
  check) "\${compose[@]}" exec -T app-1 npm run enterprise:check ;;
  backup) "\${compose[@]}" exec -T app-1 npm run backup --workspace server ;;
  update)
    "\${compose[@]}" build --pull
    "\${compose[@]}" up -d --remove-orphans
    ;;
  *) echo "Usage: zdisctl {start|stop|restart|status|logs [service]|check|backup|update}"; exit 2 ;;
esac
EOF
chmod 0755 /usr/local/bin/zdisctl

if [[ -n "$DOMAIN" ]]; then
  log "Configuring Nginx reverse proxy for $DOMAIN"
  apt-get install -y --no-install-recommends nginx certbot python3-certbot-nginx
  cat >"/etc/nginx/sites-available/zdis" <<EOF
map \$http_upgrade \$connection_upgrade {
  default upgrade;
  '' close;
}
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;
  client_max_body_size 12m;
  # Preserve both the public host and the complete bucket path. They are part
  # of the S3 signature MinIO validates.
  location ^~ /youtbelimo/ {
    proxy_pass http://127.0.0.1:9000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
  location ~ ^/(rtc|validate|settings) {
    proxy_pass http://127.0.0.1:7880;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_set_header Host \$host;
  }
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
EOF
  ln -sfn /etc/nginx/sites-available/zdis /etc/nginx/sites-enabled/zdis
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable --now nginx
fi

log "Configuring the firewall"
ufw allow OpenSSH >/dev/null
if [[ -n "$DOMAIN" ]]; then
  ufw allow 'Nginx Full' >/dev/null
else
  ufw allow 8080/tcp >/dev/null
  ufw allow 9000/tcp >/dev/null
  ufw allow 9001/tcp >/dev/null
fi
ufw allow 3478/tcp >/dev/null
ufw allow 3478/udp >/dev/null
ufw allow 7881/tcp >/dev/null
ufw allow 50000:50100/udp >/dev/null
ufw allow 49160:49200/udp >/dev/null
ufw --force enable >/dev/null

log "Building and starting the complete enterprise stack"
cd "$INSTALL_DIR"
docker compose --env-file .env.production -f infra/docker-compose.enterprise.yml build --pull
systemctl start zdis

log "Waiting for application readiness"
ready_url="http://127.0.0.1:${HTTP_PORT##*:}/api/ready"
for attempt in $(seq 1 90); do
  if curl -fsS "$ready_url" >/dev/null 2>&1; then break; fi
  if (( attempt == 90 )); then
    docker compose --env-file .env.production -f infra/docker-compose.enterprise.yml ps
    die "The stack did not become ready. Run: zdisctl logs app-1"
  fi
  sleep 5
done

if [[ -n "$DOMAIN" ]]; then
  [[ -n "$LETSENCRYPT_EMAIL" ]] || LETSENCRYPT_EMAIL="$ADMIN_EMAIL"
  log "Requesting the TLS certificate"
  certbot --nginx --non-interactive --agree-tos --redirect \
    --email "$LETSENCRYPT_EMAIL" -d "$DOMAIN"
fi

cat >"/root/zdis-credentials.txt" <<EOF
ZDis URL: $PUBLIC_ORIGIN
Administrator: $ADMIN_EMAIL
Administrator password: $ADMIN_PASSWORD
Grafana: http://$SERVER_IP:3000
Grafana user: admin
Grafana password: $GRAFANA_PASSWORD
MinIO console (local/firewall restricted): http://$SERVER_IP:9001
MinIO user: $MINIO_USER
MinIO password: $MINIO_PASSWORD

Control command: zdisctl
Credentials created: $(date -u +%FT%TZ)
EOF
chmod 600 /root/zdis-credentials.txt

ok "ZDis is ready at $PUBLIC_ORIGIN"
printf '\nAdministrator: %s\nPassword: %s\n' "$ADMIN_EMAIL" "$ADMIN_PASSWORD"
printf 'Credentials were also saved to /root/zdis-credentials.txt (mode 600).\n'
printf 'Run "zdisctl status" and "zdisctl logs" for operations.\n'
