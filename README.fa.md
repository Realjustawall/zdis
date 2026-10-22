<div align="center">

![ZDIS](docs/assets/banner-fa.svg)

**پلتفرم ارتباطی خودمیزبان برای سازندگان محتوا و تیم‌ها؛ با کانال، پیام خصوصی، تماس صوتی و تصویری، اشتراک فایل و حساب‌های تحت مدیریت مدیر.**

<img alt="Version" src="https://img.shields.io/badge/version-v1.0.1-7765ff?style=flat-square" />
<img alt="Platform" src="https://img.shields.io/badge/platform-Self-hosted%20web-354158?style=flat-square" />
<a href="https://github.com/Realjustawall/zdis/actions/workflows/quality.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/Realjustawall/zdis/quality.yml?branch=main&amp;label=CI&amp;style=flat-square" /></a>

<a href="https://github.com/Realjustawall/zdis/releases/latest"><img src="https://img.shields.io/badge/%D8%AF%D8%B1%DB%8C%D8%A7%D9%81%D8%AA-7765ff?style=flat-square&labelColor=161b22" alt="دریافت" /></a>
<a href="docs/gallery.fa.md"><img src="https://img.shields.io/badge/%DA%AF%D8%A7%D9%84%D8%B1%DB%8C%20%D8%AF%D9%85%D9%88-5968c3?style=flat-square&labelColor=161b22" alt="گالری دمو" /></a>
<a href="#quick-start"><img src="https://img.shields.io/badge/%D8%B1%D8%A7%D9%87%E2%80%8C%D8%A7%D9%86%D8%AF%D8%A7%D8%B2%DB%8C-354158?style=flat-square&labelColor=161b22" alt="راه‌اندازی" /></a>
<a href="https://github.com/Realjustawall/zdis/issues"><img src="https://img.shields.io/badge/%DA%AF%D8%B2%D8%A7%D8%B1%D8%B4%20%D9%85%D8%B4%DA%A9%D9%84-354158?style=flat-square&labelColor=161b22" alt="گزارش مشکل" /></a>

[English](README.md) · [فارسی](README.fa.md)

</div>

---

[قابلیت‌های شاخص](#features) · [پیش‌نمایش](#preview) · [راه‌اندازی](#quick-start) · [توسعه](#development) · [مستندات](#documentation) · [امنیت و حریم خصوصی](#security) · [مجوز و بازخورد](#license)

<a id="features"></a>

## قابلیت‌های شاخص

| قابلیت | کاربرد |
|---|---|
| گفت‌وگوی منظم | گروه، کانال متنی، پیام خصوصی، رشتهٔ گفت‌وگو و اشتراک فایل. |
| تماس و فعالیت | تماس صوتی و تصویری، پیش‌نمایش دستگاه و فعالیت‌های کانال؛ اعمال محدودیت‌های SFU به پیکربندی LiveKit نیاز دارد. |
| مدیریت | ساخت حساب توسط مدیر، ربات‌های سرور، نظارت، سهمیه‌ها و نشان‌های اختصاصی. |
| میزبانی انعطاف‌پذیر | SQLite و ذخیره‌سازی محلی به‌صورت پیش‌فرض؛ PostgreSQL، Redis و امکانات سازمانی به‌صورت اختیاری. |
| رابط خوانا | رابط فارسی و انگلیسی، پوستهٔ روشن و تیره و تنظیمات ظاهر. |

<a id="preview"></a>

## پیش‌نمایش

ثبت‌شده از سرور محلی ZDIS و گروه آزمایشی.

![ZDIS — گفت‌وگوی گروهی](docs/assets/screenshots/fa/01-community.webp)

<details>
<summary>تصاویر بیشتر</summary>

![ZDIS — ظاهر و پوسته‌ها](docs/assets/screenshots/fa/02-appearance.webp)

</details>

[مشاهدهٔ گالری کامل](docs/gallery.fa.md)

<a id="quick-start"></a>

## راه‌اندازی

**پیش‌نیاز محلی:** Node.js نسخهٔ ۲۴ یا جدیدتر و npm. برای SQLite به نصب سرور پایگاه‌داده نیاز نیست.

```bash
git clone https://github.com/Realjustawall/zdis.git
cd zdis
npm ci
npm run build
npm start
```

نشانی `http://localhost:4000` را باز کنید. ساخت حساب فقط توسط مدیر انجام می‌شود و ثبت‌نام عمومی وجود ندارد. `SEED_ADMIN_EMAIL` و `SEED_ADMIN_PASSWORD` را در `.env` تنظیم کنید، یا رمز تولیدشده در اولین راه‌اندازی را از خروجی سرور نگه دارید.

نصب بومی اوبونتو با `bash ubuntu/setup.sh` و سپس `bash ubuntu/start.sh` انجام می‌شود. برای استقرار کامل، [راهنمای اوبونتو](docs/UBUNTU_INSTALL.md) را بخوانید.

<a id="development"></a>

## توسعه

Node.js نسخهٔ ۲۴ یا جدیدتر؛ پروژه از workspaceهای npm استفاده می‌کند.

```bash
npm ci
npm run dev
# API: http://localhost:4000
# Client: http://localhost:5173
```

دستورهای بررسی:

```bash
npm test
npm run build
```

<a id="documentation"></a>

## مستندات

- [راهنمای اوبونتو](ubuntu/README.md)
- [استقرار عملیاتی](docs/UBUNTU_INSTALL.md)
- [نگهداری سازمانی](docs/ENTERPRISE.md)
- [تماس و فعالیت‌ها](docs/VOICE_ACTIVITIES.md)
- [ربات‌های سرور](docs/BOTS.md)
- [مجوز و سهمیه](docs/PERMISSIONS.md)
- [نسخهٔ حفظ‌شدهٔ مستندات پیشین](REFERENCE.md)

<a id="security"></a>

## امنیت و حریم خصوصی

در محیط عملیاتی از HTTPS و کوکی امن استفاده کنید. نشانی عمومی، اعتماد به پراکسی و سیاست پیوست را متناسب با استقرار تنظیم کنید. ClamAV امکان بررسی بدافزار شناخته‌شده را اضافه می‌کند؛ محدودیت‌های مربوط به انتشار صدا به تنظیم LiveKit/SFU نیاز دارند. اجرای درست کنترل‌های امنیتی به پیکربندی وابسته است.

<a id="license"></a>

## مجوز و بازخورد

سورس تحت [مجوز غیرتجاری ZDis](LICENSE) در دسترس است؛ استفادهٔ تجاری به مجوز جداگانه نیاز دارد.

[گزارش اشکال و پیشنهاد بهبود](https://github.com/Realjustawall/zdis/issues). نسخه، سیستم‌عامل و روش بازتولید را بنویسید و اطلاعات خصوصی یا رمزها را در گزارش قرار ندهید.

---

نگهداری توسط **[Realjustawall](https://github.com/Realjustawall)**.
