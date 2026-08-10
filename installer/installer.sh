#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_NAME="zdis"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/zdis}"
DOMAIN="${DOMAIN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
SERVER_IP="${SERVER_IP:-}"
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"
CONFIGURE_FIREWALL="${CONFIGURE_FIREWALL:-true}"

log() { printf '\033[1;36m[ZDis]\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
secret() { openssl rand -hex "${1:-32}"; }

valid_ipv4() {
  local address="$1" octet
  local -a octets
  [[ "$address" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS=. read -r -a octets <<< "$address"
  for octet in "${octets[@]}"; do
    (( 10#$octet <= 255 )) || return 1
  done
}

valid_domain() {
  local value="$1"
  [[ ${#value} -le 253 ]] || return 1
  [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || return 1
  [[ "$value" != *..* ]]
}

usage() {
  cat <<'EOF'
ZDis non-destructive Ubuntu installer

Usage:
  sudo bash installer/installer.sh [options]

Options:
  --domain chat.example.com       Configure Nginx and Let's Encrypt
  --admin-email admin@example.com Initial administrator email
  --email ops@example.com         Let's Encrypt notification email
  --server-ip 203.0.113.10        Public IP used by LiveKit and TURN
  --install-dir /opt/zdis         Installation directory
  --skip-firewall                 Do not add or enable UFW rules
  --non-interactive               Accept defaults without prompting
  --help                          Show this help

The complete ZDis source tree must accompany this script. The installer never
deletes application files, Docker volumes, secrets, or existing configuration.
If the destination already contains a file, that file is preserved.
EOF
}

while (($#)); do
  case "$1" in
    --domain) DOMAIN="${2:?missing domain}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:?missing email}"; shift 2 ;;
    --email) LETSENCRYPT_EMAIL="${2:?missing email}"; shift 2 ;;
    --server-ip) SERVER_IP="${2:?missing server IP}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:?missing directory}"; shift 2 ;;
    --skip-firewall) CONFIGURE_FIREWALL=false; shift ;;
    --non-interactive) NON_INTERACTIVE=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || die "Run this installer with sudo/root."
[[ -f "$SOURCE_DIR/infra/docker-compose.enterprise.yml" ]] ||
  die "The complete ZDis source tree must be next to the installer directory."
[[ -f "$SOURCE_DIR/Dockerfile" ]] || die "Dockerfile is missing from the source tree."
[[ "$INSTALL_DIR" == /* ]] || die "--install-dir must be an absolute path."
[[ "$INSTALL_DIR" != *[[:space:]]* ]] || die "Installation path cannot contain spaces."
[[ -z "$DOMAIN" ]] || valid_domain "$DOMAIN" || die "Invalid domain."
[[ -z "$SERVER_IP" ]] || valid_ipv4 "$SERVER_IP" || die "--server-ip must be a valid IPv4 address."

[[ -r /etc/os-release ]] || die "Cannot identify this operating system."
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || die "This installer currently supports Ubuntu only."
case "${VERSION_ID:-}" in
  22.04|24.04|26.04) ;;
  *) warn "Ubuntu ${VERSION_ID:-unknown} is not in the tested list; continuing." ;;
esac

if [[ "$NON_INTERACTIVE" != "true" && -z "$DOMAIN" ]]; then
  read -r -p "Domain (leave empty for server IP): " DOMAIN
fi
if [[ "$NON_INTERACTIVE" != "true" && "$ADMIN_EMAIL" == "admin@example.com" ]]; then
  read -r -p "Initial administrator email: " ADMIN_EMAIL
fi
[[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] ||
  die "Invalid administrator email."
[[ -z "$DOMAIN" ]] || valid_domain "$DOMAIN" || die "Invalid domain."
if [[ -n "$DOMAIN" && -n "$LETSENCRYPT_EMAIL" ]]; then
  [[ "$LETSENCRYPT_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] ||
    die "Invalid Let's Encrypt email."
fi

log "Installing required operating-system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg openssl rsync jq ufw unattended-upgrades

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine from Docker's Ubuntu repository"
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -e /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
      gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  else
    warn "Preserving existing /etc/apt/keyrings/docker.gpg"
  fi
  if [[ ! -e /etc/apt/sources.list.d/docker.list ]]; then
    docker_arch="$(dpkg --print-architecture)"
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
      "$docker_arch" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  else
    warn "Preserving existing Docker apt source configuration"
  fi
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
if ! docker compose version >/dev/null 2>&1; then
  log "Installing the Docker Compose plugin"
  apt-get install -y docker-compose-plugin ||
    die "Docker is installed, but the Docker Compose plugin could not be installed."
fi

available_kb="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
if (( available_kb < 3000000 )) && ! swapon --show --noheadings | grep -q .; then
  if [[ ! -e /swapfile ]]; then
    log "Low-memory host detected; creating a protected 2 GiB swap file"
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -Fqx '/swapfile none swap sw 0 0' /etc/fstab ||
      printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
  else
    warn "Low memory detected, but /swapfile already exists; preserving it unchanged"
  fi
fi

if [[ ! -e /etc/sysctl.d/99-zdis.conf ]]; then
  log "Adding ZDis kernel limits"
  cat > /etc/sysctl.d/99-zdis.conf <<'EOF'
vm.max_map_count=262144
vm.swappiness=10
fs.file-max=1048576
net.core.somaxconn=65535
net.core.netdev_max_backlog=16384
net.ipv4.ip_local_port_range=10240 65535
net.ipv4.tcp_fin_timeout=15
net.ipv4.tcp_keepalive_time=600
EOF
else
  warn "Preserving existing /etc/sysctl.d/99-zdis.conf"
fi
sysctl --system >/dev/null

log "Installing missing application files in $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if [[ "$(realpath "$SOURCE_DIR")" != "$(realpath -m "$INSTALL_DIR")" ]]; then
  rsync -a --ignore-existing \
    --exclude='.git' --exclude='.env' --exclude='.env.production' \
    --exclude='node_modules' --exclude='client/dist' --exclude='.tmp' \
    --exclude='test-results' --exclude='server/data' --exclude='infra/secrets' \
    "$SOURCE_DIR/" "$INSTALL_DIR/"
else
  log "Source is already at the requested installation path"
fi
mkdir -p "$INSTALL_DIR/infra/secrets"

if [[ -z "$SERVER_IP" ]]; then
  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
[[ -n "$SERVER_IP" ]] || die "Could not detect a server IP; pass --server-ip explicitly."
valid_ipv4 "$SERVER_IP" ||
  die "Detected '$SERVER_IP' instead of an IPv4 address; pass --server-ip explicitly."

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
  S3_PUBLIC_ENDPOINT="https://${DOMAIN}"
  MINIO_PORT="127.0.0.1:9000"
  LIVEKIT_HTTP_PORT="127.0.0.1:7880"
fi

ENV_FILE="$INSTALL_DIR/.env.production"
CREATED_ENV=false
if [[ ! -e "$ENV_FILE" ]]; then
  log "Creating production configuration and secrets"
  APP_SECRET="$(secret 32)"
  AUDIT_SIGNING_KEY="$(secret 32)"
  RECOVERY_SIGNING_KEY="$(secret 32)"
  POSTGRES_PASSWORD="$(secret 24)"
  ADMIN_PASSWORD="$(secret 14)Aa1!"
  MINIO_USER="zdis$(secret 5)"
  MINIO_PASSWORD="$(secret 24)"
  LIVEKIT_API_KEY="zdis$(secret 8)"
  LIVEKIT_API_SECRET="$(secret 24)"
  TURN_SHARED_SECRET="$(secret 24)"
  GRAFANA_PASSWORD="$(secret 12)Aa1!"
  METRICS_TOKEN="$(secret 24)"

  cat > "$ENV_FILE" <<EOF
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
  chmod 600 "$ENV_FILE"
  CREATED_ENV=true
else
  warn "Preserving existing $ENV_FILE and all of its secrets"
fi

env_value() {
  local key="$1"
  awk -F= -v wanted="$key" '$1 == wanted {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE"
}

ACTIVE_PUBLIC_ORIGIN="$(env_value PUBLIC_ORIGIN)"
ACTIVE_PUBLIC_ORIGIN="${ACTIVE_PUBLIC_ORIGIN:-$PUBLIC_ORIGIN}"
ACTIVE_HTTP_PORT="$(env_value HTTP_PORT)"
ACTIVE_HTTP_PORT="${ACTIVE_HTTP_PORT:-$HTTP_PORT}"
ACTIVE_ADMIN_EMAIL="$(env_value SEED_ADMIN_EMAIL)"
ACTIVE_ADMIN_EMAIL="${ACTIVE_ADMIN_EMAIL:-$ADMIN_EMAIL}"

for required_key in \
  APP_SECRET POSTGRES_PASSWORD MINIO_ROOT_USER MINIO_ROOT_PASSWORD \
  SEED_ADMIN_PASSWORD LIVEKIT_API_KEY LIVEKIT_API_SECRET \
  TURN_SHARED_SECRET GRAFANA_ADMIN_PASSWORD; do
  [[ -n "$(env_value "$required_key")" ]] ||
    die "$ENV_FILE already exists but $required_key is empty or missing; it was preserved unchanged."
done

if [[ -n "$DOMAIN" && "$ACTIVE_PUBLIC_ORIGIN" != "https://$DOMAIN" ]]; then
  die "$ENV_FILE uses PUBLIC_ORIGIN=$ACTIVE_PUBLIC_ORIGIN, not https://$DOMAIN; refusing to alter existing configuration."
fi

METRICS_SECRET="$INSTALL_DIR/infra/secrets/metrics-token.txt"
if [[ ! -e "$METRICS_SECRET" ]]; then
  if [[ "$CREATED_ENV" == "true" ]]; then
    printf '%s\n' "$METRICS_TOKEN" > "$METRICS_SECRET"
  else
    printf '%s\n' "$(secret 24)" > "$METRICS_SECRET"
  fi
  chmod 600 "$METRICS_SECRET"
else
  warn "Preserving existing metrics token"
fi

SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
if [[ ! -e "$SERVICE_FILE" ]]; then
  log "Creating the ZDis systemd service"
  cat > "$SERVICE_FILE" <<EOF
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
ExecStart=/usr/bin/docker compose --env-file $ENV_FILE -f $INSTALL_DIR/infra/docker-compose.enterprise.yml up -d
ExecStop=/usr/bin/docker compose --env-file $ENV_FILE -f $INSTALL_DIR/infra/docker-compose.enterprise.yml stop
TimeoutStartSec=0
TimeoutStopSec=180

[Install]
WantedBy=multi-user.target
EOF
else
  warn "Preserving existing $SERVICE_FILE"
fi
systemctl daemon-reload
systemctl enable "$APP_NAME.service"

CONTROL_FILE="/usr/local/bin/zdisctl"
if [[ ! -e "$CONTROL_FILE" ]]; then
  cat > "$CONTROL_FILE" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
cd "$INSTALL_DIR"
compose=(docker compose --env-file "$ENV_FILE" -f "$INSTALL_DIR/infra/docker-compose.enterprise.yml")
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
  build) "\${compose[@]}" build --pull ;;
  update)
    "\${compose[@]}" build --pull
    systemctl restart zdis
    ;;
  *) echo "Usage: zdisctl {start|stop|restart|status|logs [service]|check|backup|build|update}"; exit 2 ;;
esac
EOF
  chmod 0755 "$CONTROL_FILE"
else
  warn "Preserving existing $CONTROL_FILE"
fi

if [[ -n "$DOMAIN" ]]; then
  log "Configuring Nginx for $DOMAIN"
  apt-get install -y --no-install-recommends nginx certbot python3-certbot-nginx
  NGINX_SITE="/etc/nginx/sites-available/zdis"
  if [[ ! -e "$NGINX_SITE" ]]; then
    cat > "$NGINX_SITE" <<EOF
map \$http_upgrade \$connection_upgrade {
  default upgrade;
  '' close;
}
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;
  client_max_body_size 12m;
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
  else
    warn "Preserving existing $NGINX_SITE"
  fi
  if [[ ! -e /etc/nginx/sites-enabled/zdis && ! -L /etc/nginx/sites-enabled/zdis ]]; then
    ln -s "$NGINX_SITE" /etc/nginx/sites-enabled/zdis
  else
    warn "Preserving existing enabled Nginx site"
  fi
  nginx -t
  systemctl enable --now nginx
fi

if [[ "$CONFIGURE_FIREWALL" == "true" ]]; then
  log "Adding required firewall allowances (existing rules are preserved)"
  ufw allow OpenSSH >/dev/null
  if [[ -n "$DOMAIN" ]]; then
    ufw allow 'Nginx Full' >/dev/null
  else
    ufw allow 8080/tcp >/dev/null
    ufw allow 9000/tcp >/dev/null
  fi
  ufw allow 3478/tcp >/dev/null
  ufw allow 3478/udp >/dev/null
  ufw allow 7881/tcp >/dev/null
  ufw allow 50000:50100/udp >/dev/null
  ufw allow 49160:49200/udp >/dev/null
  ufw --force enable >/dev/null
else
  warn "Firewall configuration skipped; open HTTP(S), TURN, and LiveKit media ports manually"
fi

log "Building the enterprise application images"
cd "$INSTALL_DIR"
docker compose --env-file "$ENV_FILE" -f infra/docker-compose.enterprise.yml build --pull

log "Starting ZDis without removing containers or volumes"
systemctl start "$APP_NAME.service"

log "Waiting for application readiness"
READY_PORT="${ACTIVE_HTTP_PORT##*:}"
READY_URL="http://127.0.0.1:${READY_PORT}/api/ready"
for attempt in $(seq 1 90); do
  if curl -fsS "$READY_URL" >/dev/null 2>&1; then
    break
  fi
  if (( attempt == 90 )); then
    docker compose --env-file "$ENV_FILE" -f infra/docker-compose.enterprise.yml ps
    die "The stack did not become ready. Run: zdisctl logs app-1"
  fi
  sleep 5
done

if [[ -n "$DOMAIN" ]]; then
  LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-$ADMIN_EMAIL}"
  if [[ ! -e "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
    log "Requesting a Let's Encrypt certificate"
    certbot --nginx --non-interactive --agree-tos --redirect \
      --email "$LETSENCRYPT_EMAIL" -d "$DOMAIN"
  else
    warn "Preserving existing TLS certificate for $DOMAIN"
  fi
fi

if [[ "$CREATED_ENV" == "true" ]]; then
  CREDENTIALS_FILE="/root/zdis-credentials.txt"
  if [[ ! -e "$CREDENTIALS_FILE" ]]; then
    cat > "$CREDENTIALS_FILE" <<EOF
ZDis URL: $ACTIVE_PUBLIC_ORIGIN
Administrator: $ADMIN_EMAIL
Administrator password: $ADMIN_PASSWORD
Grafana (local/firewall restricted): http://$SERVER_IP:3000
Grafana user: admin
Grafana password: $GRAFANA_PASSWORD
MinIO console (local/firewall restricted): http://$SERVER_IP:9001
MinIO user: $MINIO_USER
MinIO password: $MINIO_PASSWORD

Control command: zdisctl
Credentials created: $(date -u +%FT%TZ)
EOF
    chmod 600 "$CREDENTIALS_FILE"
    log "Initial credentials saved to $CREDENTIALS_FILE (mode 600)"
  else
    warn "Preserving existing $CREDENTIALS_FILE; new credentials are shown below"
  fi
  printf '\nAdministrator: %s\nPassword: %s\n' "$ADMIN_EMAIL" "$ADMIN_PASSWORD"
else
  log "Existing administrator and secret configuration was retained"
fi

ok "ZDis is ready at $ACTIVE_PUBLIC_ORIGIN"
printf 'Administrator: %s\n' "$ACTIVE_ADMIN_EMAIL"
printf 'Run "zdisctl status" or "zdisctl logs" for operations.\n'
