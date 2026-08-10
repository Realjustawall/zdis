# نصب خودکار روی Ubuntu

نصب‌کننده روی Ubuntu 22.04 و 24.04 آزمایش‌پذیر طراحی شده و تمام اجزای
PostgreSQL، PgBouncer، Redis، MinIO، ClamAV، OpenSearch، LiveKit، TURN،
Worker، Nginx، Prometheus، Grafana، Tempo و Alertmanager را راه‌اندازی می‌کند.

```bash
git clone <repository-url> zdis
cd zdis
sudo bash installer/installer.sh \
  --domain chat.example.com \
  --admin-email admin@example.com \
  --email operations@example.com
```

قبل از اجرای حالت Domain، رکورد DNS دامنه اصلی را به IP سرور متصل کنید. برای
سرورهایی که چند IP دارند، IP عمومی را با گزینه `--server-ip` مشخص کنید.
نصب بدون Domain:

```bash
sudo bash installer/installer.sh \
  --admin-email admin@example.com \
  --non-interactive
```

در این حالت برنامه روی `http://SERVER_IP:8080` اجرا می‌شود. اطلاعات ورود اولیه
در `/root/zdis-credentials.txt` با مجوز `600` ذخیره می‌شود.

اجرای دوباره نصب‌کننده فایل‌ها، تنظیمات، Secretها یا Volumeهای Docker موجود را
حذف یا جایگزین نمی‌کند؛ فقط مواردی که وجود ندارند ساخته می‌شوند.

فرمان‌های مدیریت:

```bash
zdisctl status
zdisctl logs app-1
zdisctl restart
zdisctl check
zdisctl backup
zdisctl update
```

نصب‌کننده برای میزبان کم‌حافظه Swap محافظت‌شده می‌سازد، Heap مربوط به Node و
OpenSearch را محدود می‌کند، Cache پردازش تصویر و concurrency را کنترل می‌کند،
محدودیت‌های Kernel را برای WebSocket تنظیم و UFW را فعال می‌کند.

برای Production واقعی، SMTP، VAPID، SSO و مقصد Alertmanager را پس از نصب در
`.env.production` و فایل‌های `infra/observability` تنظیم کرده و سپس
`zdisctl restart` و `zdisctl check` را اجرا کنید.
