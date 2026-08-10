import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = string;
const STORAGE_KEY = 'zdis.locale';
const languageModules = import.meta.glob<Record<string, string>>('../language/*.json', {
  eager: true,
  import: 'default',
});
const languagePacks: Record<Locale, Record<string, string>> = Object.fromEntries(
  Object.entries(languageModules).map(([file, messages]) => [
    file.split('/').pop()?.replace(/\.json$/i, '') ?? '',
    messages,
  ]).filter(([locale]) => Boolean(locale)),
);
export const availableLanguages = Object.freeze(Object.keys(languagePacks).sort((a, b) => a.localeCompare(b)));

export function languageName(locale: Locale): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

export function languageShortName(locale: Locale): string {
  if (locale.toLowerCase() === 'fa') return 'فا';
  return locale.split('-')[0].toUpperCase();
}

export function isRtlLanguage(locale: Locale): boolean {
  return /^(?:ar|arc|ckb|dv|fa|he|ku|nqo|ps|sd|syr|ug|ur|yi)(?:-|$)/i.test(locale);
}

const DOM_FA: Record<string, string> = {
  'Server Settings': 'تنظیمات گروه',
  'Server settings': 'تنظیمات گروه',
  'Group settings': 'تنظیمات گروه',
  'Overview': 'نمای کلی',
  'Roles': 'نقش‌ها',
  'Server Roles': 'نقش‌های گروه',
  'Onboarding': 'آغاز به کار',
  'Members': 'اعضا',
  'Channels': 'کانال‌ها',
  'Expressions': 'شکلک‌ها و صداها',
  'Apps & Commands': 'برنامه‌ها و فرمان‌ها',
  'Community': 'اجتماع',
  'Safety & Moderation': 'ایمنی و مدیریت',
  'Server Insights': 'آمار گروه',
  'Danger zone': 'منطقه خطر',
  'Delete Server': 'حذف گروه',
  'Create Channel': 'ساخت کانال',
  'Create Category': 'ساخت دسته',
  'Create Role': 'ساخت نقش',
  'New role': 'نقش جدید',
  'New category': 'دسته جدید',
  'Add category': 'افزودن دسته',
  'Category name': 'نام دسته',
  'Channel name': 'نام کانال',
  'Server name': 'نام گروه',
  'Server icon': 'تصویر گروه',
  'Server accent color': 'رنگ اصلی گروه',
  'Description': 'توضیحات',
  'Role name': 'نام نقش',
  'Role color': 'رنگ نقش',
  'Search permissions': 'جست‌وجوی مجوزها',
  'Search members': 'جست‌وجوی اعضا',
  'Search accounts…': 'جست‌وجوی حساب‌ها…',
  'Manage': 'مدیریت',
  'Permissions': 'مجوزها',
  'Permission': 'مجوز',
  'Rename': 'تغییر نام',
  'Delete': 'حذف',
  'Delete category': 'حذف دسته',
  'Sync': 'همگام‌سازی',
  'Category': 'دسته',
  'Channel': 'کانال',
  'Member': 'عضو',
  'Role': 'نقش',
  'Owner': 'مالک',
  'Administrator': 'مدیر کل',
  'Moderator': 'ناظر',
  'Allow': 'مجاز',
  'Deny': 'ممنوع',
  'Neutral': 'خنثی',
  'Inherited': 'ارث‌بری‌شده',
  'Save': 'ذخیره',
  'Save changes': 'ذخیره تغییرات',
  'Saving…': 'در حال ذخیره…',
  'Cancel': 'انصراف',
  'Close': 'بستن',
  'Remove': 'حذف',
  'Remove Override': 'حذف بازنویسی',
  'Create': 'ساخت',
  'Creating…': 'در حال ساخت…',
  'Edit': 'ویرایش',
  'Done': 'انجام شد',
  'Add': 'افزودن',
  'Invite': 'دعوت',
  'Invite people': 'دعوت افراد',
  'Create invite': 'ساخت دعوت‌نامه',
  'Copy': 'کپی',
  'Copied': 'کپی شد',
  'General': 'عمومی',
  'Membership': 'عضویت',
  'Text': 'متنی',
  'Voice': 'صوتی',
  'Events': 'رویدادها',
  'Apps': 'برنامه‌ها',
  'Appearance': 'ظاهر',
  'Display': 'نمایش',
  'Links': 'پیوندها',
  'Rules': 'قوانین',
  'Audit Log': 'گزارش فعالیت',
  'Bans': 'مسدودی‌ها',
  'Webhooks': 'وب‌هوک‌ها',
  'Commands': 'فرمان‌ها',
  'Soundboard': 'صفحه صدا',
  'Stickers': 'استیکرها',
  'Sounds': 'صداها',
  'Actions are hierarchy checked and recorded in the audit log.': 'عملیات بر اساس سلسله‌مراتب بررسی و در گزارش فعالیت ثبت می‌شوند.',
  'Add people to this group': 'افزودن افراد به این گروه',
  'Administrator is enabled': 'دسترسی مدیر کل فعال است',
  'Allow anyone to @mention this role': 'اجازه اشاره به این نقش برای همه',
  'Announcement': 'اطلاعیه',
  'Announcement follows': 'دنبال‌کردن اطلاعیه‌ها',
  'Application command permissions': 'مجوزهای فرمان برنامه‌ها',
  'Assigned to every member': 'اختصاص‌یافته به همه اعضا',
  'AutoMod actions & server audit': 'عملیات مدیریت خودکار و گزارش گروه',
  'Ban Member': 'مسدودکردن عضو',
  'Can be mentioned': 'قابل اشاره',
  'Category permissions': 'مجوزهای دسته',
  'Channel type': 'نوع کانال',
  'Choose the onboarding roles that describe you.': 'نقش‌هایی را انتخاب کنید که شما را بهتر توصیف می‌کنند.',
  'Command': 'فرمان',
  'Complete Discord permission model': 'سامانه کامل مجوزهای دیسکورد',
  'Create event': 'ساخت رویداد',
  'Create subscription tier': 'ساخت سطح اشتراک',
  'Creator monetization': 'درآمدزایی سازنده',
  'Default access for all members before the overrides below.': 'دسترسی پیش‌فرض همه اعضا پیش از بازنویسی‌های زیر.',
  'Delete Role': 'حذف نقش',
  'Display role members separately': 'نمایش جداگانه اعضای نقش',
  'Displayed separately': 'نمایش جداگانه',
  'Emoji': 'شکلک',
  'Emoji, e.g. 🛡️': 'شکلک، برای نمونه 🛡️',
  'Expires after (hours)': 'انقضا پس از (ساعت)',
  'Follow announcement channel': 'دنبال‌کردن کانال اطلاعیه',
  'Forum': 'انجمن',
  'Gradient color': 'رنگ گرادیان',
  'Hoisted': 'نمایش جداگانه',
  'Holographic accent': 'رنگ هولوگرافیک',
  'Kick Member': 'اخراج عضو',
  'Managed': 'مدیریت‌شده',
  'Managed by an integration': 'مدیریت‌شده توسط یک اتصال',
  'Maximum uses': 'حداکثر استفاده',
  'Members can add or remove this role for themselves.': 'اعضا می‌توانند این نقش را برای خود اضافه یا حذف کنند.',
  'Members can notify everyone assigned to this role.': 'اعضا می‌توانند به همه دارندگان این نقش اعلان بفرستند.',
  'Moderation': 'مدیریت',
  'Moderation & AutoMod': 'مدیریت و مدیریت خودکار',
  'Name': 'نام',
  'Never': 'هرگز',
  'New channel': 'کانال جدید',
  'No application commands are installed in this server.': 'هیچ فرمان برنامه‌ای در این گروه نصب نشده است.',
  'No category': 'بدون دسته',
  'Off': 'خاموش',
  'Only people you invite to it can see this channel.': 'فقط افرادی که دعوت می‌کنید می‌توانند این کانال را ببینند.',
  'Platform extension': 'قابلیت افزوده سامانه',
  'Private channel': 'کانال خصوصی',
  'Reason (optional)': 'دلیل (اختیاری)',
  'Remove Timeout': 'برداشتن محدودیت زمانی',
  'Remove override': 'حذف بازنویسی',
  'Role icon': 'نماد نقش',
  'Role image icon': 'تصویر نقش',
  'Role or member': 'نقش یا عضو',
  'Server insights': 'آمار گروه',
  'Server nickname': 'نام مستعار گروه',
  'Server-owned file': 'فایل متعلق به گروه',
  'Show in onboarding role picker': 'نمایش در انتخاب‌گر نقش آغاز به کار',
  'Show members with this role in a separate member-list group.': 'اعضای این نقش را در بخش جداگانه فهرست اعضا نمایش می‌دهد.',
  'Shown in onboarding': 'نمایش در آغاز به کار',
  'Slowmode': 'حالت آهسته',
  'Stage': 'صحنه',
  'Sticker': 'استیکر',
  'This role bypasses every permission and channel override. Assign it with extreme care.': 'این نقش همه مجوزها و بازنویسی‌های کانال را نادیده می‌گیرد؛ آن را با احتیاط کامل واگذار کنید.',
  'This server has no custom assets yet.': 'این گروه هنوز فایل سفارشی ندارد.',
  'Timeout': 'محدودیت زمانی',
  'Topic / description': 'موضوع یا توضیحات',
  'Type': 'نوع',
  'Unban': 'رفع مسدودی',
  'Unfollow': 'لغو دنبال‌کردن',
  'Unlimited': 'نامحدود',
  'What is this channel for?': 'این کانال برای چه کاری است؟',
  'Who can access this channel?': 'چه کسانی به این کانال دسترسی دارند؟',
  'Activities': 'فعالیت‌ها',
  'Activity status': 'وضعیت فعالیت',
  'Add public creator profiles. An administrator may verify them.': 'پروفایل عمومی سازندگان را اضافه کنید؛ مدیر سامانه می‌تواند آن‌ها را تأیید کند.',
  'Allow direct messages': 'اجازه پیام خصوصی',
  'Allow file uploads': 'اجازه بارگذاری فایل',
  'Allow group direct messages': 'اجازه پیام خصوصی گروهی',
  'An accepted request creates a shared group automatically.': 'پذیرش درخواست به‌صورت خودکار یک گروه مشترک می‌سازد.',
  'Approve': 'تأیید',
  'Audio': 'صدا',
  'Blocked terms': 'عبارت‌های مسدود',
  'Camera on': 'دوربین روشن',
  'Choose account…': 'انتخاب حساب…',
  'Collaborations': 'همکاری‌ها',
  'Connect with another account without opening a group.': 'بدون ساخت گروه به یک حساب دیگر متصل شوید.',
  'Control public signup and every prominent text on the authentication page.': 'ثبت‌نام عمومی و متن‌های اصلی صفحه ورود را کنترل کنید.',
  'Copy main platform invite link': 'کپی پیوند اصلی دعوت سامانه',
  'Create forum post': 'ساخت پست انجمن',
  'Database:': 'پایگاه داده:',
  'Deafened': 'ناشنوا',
  'Delete message': 'حذف پیام',
  'Developer runtime': 'محیط اجرای توسعه‌دهنده',
  'Discover servers': 'یافتن گروه‌ها',
  'Discovery': 'فهرست عمومی',
  'Display name': 'نام نمایشی',
  'Documents (PDF, ZIP, text)': 'سندها (PDF، ZIP و متن)',
  'Duplicate-message limit per 30 seconds': 'محدودیت پیام تکراری در هر ۳۰ ثانیه',
  'Edit window (minutes)': 'مهلت ویرایش (دقیقه)',
  'Email': 'ایمیل',
  'Enable public registration': 'فعال‌کردن ثبت‌نام عمومی',
  'File uploads': 'بارگذاری فایل',
  'First name': 'نام',
  'Friends': 'دوستان',
  'Friends, collaborations, roster and public profiles': 'دوستان، همکاری‌ها، فهرست افراد و پروفایل‌های عمومی',
  'Full screen': 'تمام‌صفحه',
  'Handle': 'شناسه',
  'Hold Space to speak': 'برای صحبت کلید فاصله را نگه دارید',
  'IP': 'نشانی IP',
  'Identity': 'هویت',
  'Images': 'تصاویر',
  'Jobهای شکست‌خورده پس از پایان Retry': 'کارهای ناموفق پس از پایان تلاش مجدد',
  'Join': 'پیوستن',
  'Last name': 'نام خانوادگی',
  'Linked profiles': 'پروفایل‌های متصل',
  'Login and registration': 'ورود و ثبت‌نام',
  'Maximum file size (MB)': 'حداکثر حجم فایل (مگابایت)',
  'Member accounts can create groups': 'حساب اعضا می‌توانند گروه بسازند',
  'Members decide which additional streamer may invite or label them.': 'اعضا تعیین می‌کنند کدام سازنده دیگر می‌تواند آن‌ها را دعوت یا برچسب‌گذاری کند.',
  'Message of the day': 'پیام روز',
  'Message thread': 'رشته پیام',
  'Messaging': 'پیام‌رسانی',
  'Muted': 'بی‌صدا',
  'Network': 'شبکه',
  'Nickname': 'نام مستعار',
  'No appeals are waiting.': 'هیچ درخواست تجدیدنظری در انتظار نیست.',
  'No discoverable servers found.': 'گروه عمومی پیدا نشد.',
  'No posts yet': 'هنوز پستی وجود ندارد',
  'Nothing is pinned here yet.': 'هنوز پیامی اینجا سنجاق نشده است.',
  'Nothing is scheduled here.': 'هیچ پیامی زمان‌بندی نشده است.',
  'One term per line or comma-separated. Leave empty to disable.': 'در هر خط یک عبارت یا عبارت‌ها را با ویرگول جدا کنید؛ برای غیرفعال‌سازی خالی بگذارید.',
  'Only invited server members and moderators can see or reply.': 'فقط اعضای دعوت‌شده و مدیران می‌توانند مشاهده یا پاسخ دهند.',
  'Open appeals': 'درخواست‌های تجدیدنظر باز',
  'Pending': 'در انتظار',
  'Phone': 'تلفن',
  'Pinned messages': 'پیام‌های سنجاق‌شده',
  'Platform Control Plane': 'مرکز کنترل سامانه',
  'Platform logo URL': 'نشانی لوگوی سامانه',
  'Priority Speaker': 'گوینده اولویت‌دار',
  'Private': 'خصوصی',
  'Provision roster account': 'ساخت حساب فهرست افراد',
  'Push to Talk · Space': 'فشار برای صحبت · فاصله',
  'Reject': 'رد',
  'Reply in thread…': 'پاسخ در رشته…',
  'Reply to this post…': 'پاسخ به این پست…',
  'Require password change on first sign-in': 'الزام تغییر رمز در نخستین ورود',
  'Retry': 'تلاش دوباره',
  'Roster access': 'دسترسی فهرست افراد',
  'Saved messages': 'پیام‌های ذخیره‌شده',
  'Scheduled messages': 'پیام‌های زمان‌بندی‌شده',
  'Search by name or description': 'جست‌وجو با نام یا توضیحات',
  'Security': 'امنیت',
  'Sharing screen': 'اشتراک صفحه',
  'Shown as a banner to everyone. Leave blank to hide it.': 'به‌صورت بنر به همه نمایش داده می‌شود؛ برای پنهان‌کردن خالی بگذارید.',
  'Stage controls': 'کنترل‌های صحنه',
  'Tags (comma separated)': 'برچسب‌ها (جداشده با ویرگول)',
  'Temporary password': 'رمز عبور موقت',
  'The name people see in the interface.': 'نامی که افراد در رابط کاربری می‌بینند.',
  'Title': 'عنوان',
  'Toggle size': 'تغییر اندازه',
  'Uptime:': 'زمان فعالیت:',
  'Username': 'نام کاربری',
  'Verified': 'تأییدشده',
  'Video': 'ویدیو',
  'Waiting room': 'اتاق انتظار',
  'Who may talk to whom, and who may start a group.': 'مشخص کنید چه کسانی می‌توانند با هم گفتگو کنند یا گروه بسازند.',
  'You have no saved messages.': 'پیام ذخیره‌شده‌ای ندارید.',
  'YouTuber accounts can create groups': 'حساب سازندگان می‌توانند گروه بسازند',
  'Your roster': 'فهرست افراد شما',
  'Group deleted.': 'گروه حذف شد.',
  'Channel created.': 'کانال ساخته شد.',
  'Channel settings updated.': 'تنظیمات کانال به‌روزرسانی شد.',
  'Channel permissions synced with its category.': 'مجوزهای کانال با دسته همگام شد.',
  'Channel deleted.': 'کانال حذف شد.',
  'Invite created.': 'دعوت‌نامه ساخته شد.',
  'Invite link copied.': 'پیوند دعوت کپی شد.',
  'Category created.': 'دسته ساخته شد.',
  'Category renamed.': 'نام دسته تغییر کرد.',
  'Role updated.': 'نقش به‌روزرسانی شد.',
  'Role created.': 'نقش ساخته شد.',
  'Role deleted.': 'نقش حذف شد.',
  'Channel permissions updated.': 'مجوزهای کانال به‌روزرسانی شد.',
  'Channel override removed.': 'بازنویسی کانال حذف شد.',
  'Member updated.': 'عضو به‌روزرسانی شد.',
  'Member timed out.': 'عضو به‌طور موقت محدود شد.',
  'Timeout removed.': 'محدودیت زمانی برداشته شد.',
  'Member banned.': 'عضو مسدود شد.',
  'Member kicked.': 'عضو اخراج شد.',
  'Application command access updated.': 'دسترسی فرمان برنامه به‌روزرسانی شد.',
  'Channel renamed.': 'نام کانال تغییر کرد.',
  'Could not save.': 'ذخیره انجام نشد.',
  'Could not create the channel.': 'ساخت کانال انجام نشد.',
  'Could not create the category.': 'ساخت دسته انجام نشد.',
  'Could not create the invite.': 'ساخت دعوت‌نامه انجام نشد.',
  'Could not save the role.': 'ذخیره نقش انجام نشد.',
  'Could not delete the role.': 'حذف نقش انجام نشد.',
  'Could not load channel permissions.': 'بارگذاری مجوزهای کانال انجام نشد.',
  'Could not save channel permissions.': 'ذخیره مجوزهای کانال انجام نشد.',
  'Could not remove the override.': 'حذف بازنویسی انجام نشد.',
  'Could not update the member.': 'به‌روزرسانی عضو انجام نشد.',
  'Could not sync permissions.': 'همگام‌سازی مجوزها انجام نشد.',
  'Could not rename the channel.': 'تغییر نام کانال انجام نشد.',
  'Could not delete the channel.': 'حذف کانال انجام نشد.',
  'That file type is not supported.': 'این نوع فایل پشتیبانی نمی‌شود.',
  'File scanning is temporarily unavailable. Try again later.': 'بررسی امنیتی فایل موقتاً در دسترس نیست؛ کمی بعد دوباره تلاش کنید.',
  'File uploads are disabled by the administrator.': 'بارگذاری فایل توسط مدیر غیرفعال شده است.',
  'No file received.': 'فایلی دریافت نشد.',
  'File is empty.': 'فایل خالی است.',
  'Something went wrong.': 'خطایی رخ داد.',
  'Uploaded server icon not found.': 'تصویر بارگذاری‌شده گروه پیدا نشد.',
  'Server icons must be image files.': 'تصویر گروه باید یک فایل تصویری باشد.',
  'Server icons must be 8 MB or smaller.': 'حجم تصویر گروه باید حداکثر ۸ مگابایت باشد.',
  'Create Poll': 'ساخت نظرسنجی',
  'Record voice message': 'ضبط پیام صوتی',
  'Stop voice recording': 'توقف ضبط صدا',
  'Send code': 'ارسال کد',
  'Plain text': 'متن ساده',
  'Copy code': 'کپی کد',
  'Message': 'پیام',
  'Reply': 'پاسخ',
  'Search': 'جست‌وجو',
  'No results': 'نتیجه‌ای پیدا نشد',
  'No custom roles yet. Members currently use the default @everyone access.':
    'هنوز نقش سفارشی ساخته نشده است. اعضا از دسترسی پیش‌فرض همگانی استفاده می‌کنند.',
  'Create roles, set the hierarchy, and configure all server-wide Discord permissions.':
    'نقش‌ها را بسازید، ترتیب آن‌ها را مشخص کنید و همه مجوزهای گروه را تنظیم کنید.',
  'Channels placed here can synchronize the category’s permission overwrites.':
    'کانال‌های این دسته می‌توانند بازنویسی مجوزهای دسته را همگام‌سازی کنند.',
  'Your effective permissions': 'مجوزهای مؤثر شما',
  'App permissions are restricted': 'مجوزهای برنامه محدود است',
  'Server Insights is restricted': 'دسترسی به آمار گروه محدود است',
  'Safety settings are restricted': 'تنظیمات ایمنی محدود است',
  'You need Manage Roles to configure application command access.':
    'برای تنظیم دسترسی فرمان برنامه‌ها به مجوز مدیریت نقش‌ها نیاز دارید.',
  'You need the View Server Insights permission to access analytics.':
    'برای مشاهده آمار به مجوز مشاهده آمار گروه نیاز دارید.',
  'A moderation permission is required to view this area.':
    'برای مشاهده این بخش به یکی از مجوزهای مدیریتی نیاز دارید.',
};

function translateDomText(value: string, locale: Locale): string {
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  const core = value.trim();
  if (!core) return value;
  const catalog = languagePacks[locale] as Record<string, string>;
  const catalogValue = catalog[`text.${core}`];
  let translated = catalogValue && catalogValue !== core ? catalogValue : undefined;
  if (!translated && locale === 'fa') translated = DOM_FA[core];
  if (!translated && locale === 'fa') {
    const patterns: Array<[RegExp, (...parts: string[]) => string]> = [
      [/^Members · (\d+)$/, (count) => `اعضا · ${count}`],
      [/^Channels · (\d+)$/, (count) => `کانال‌ها · ${count}`],
      [/^Members — (\d+)$/, (count) => `اعضا — ${count}`],
      [/^Channels — (\d+)$/, (count) => `کانال‌ها — ${count}`],
      [/^(\d+) shown$/, (count) => `${count} مورد نمایش داده شده`],
      [/^(\d+) members?$/, (count) => `${count} عضو`],
      [/^(\d+) permissions?$/, (count) => `${count} مجوز`],
      [/^File exceeds the (\d+) MB limit\.$/, (size) => `حجم فایل بیشتر از سقف ${size} مگابایت است.`],
      [/^(image|video|audio|document) uploads are disabled by the administrator\.$/, (kind) => `بارگذاری ${({ image: 'تصویر', video: 'ویدیو', audio: 'صدا', document: 'سند' } as Record<string, string>)[kind] ?? kind} توسط مدیر غیرفعال شده است.`],
      [/^Could not upload (.+)\.$/, (name) => `بارگذاری ${name} انجام نشد.`],
      [/^(.+) was added\.$/, (name) => `${name} اضافه شد.`],
      [/^(.+) added to this server\.$/, (kind) => `${DOM_FA[kind] ?? kind} به گروه اضافه شد.`],
      [/^(.+) channel permissions$/, (category) => `مجوزهای کانال ${DOM_FA[category] ?? category}`],
      [/^New (.+) name$/, (kind) => `نام جدید ${DOM_FA[kind.toLowerCase()] ?? kind}`],
    ];
    for (const [pattern, replacement] of patterns) {
      const match = pattern.exec(core);
      if (match) {
        translated = replacement(...match.slice(1));
        break;
      }
    }
  }
  return translated ? `${leading}${translated}${trailing}` : value;
}

function translateDomTree(root: Node, locale: Locale) {
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest(
          '.message .content, .attachment-file, .custom-status, .user-bio, pre, code, [data-no-auto-translate]',
        )
      ) return;
      const value = node.nodeValue ?? '';
      const translated = translateDomText(value, locale);
      if (translated !== value) node.nodeValue = translated;
      return;
    }
    if (!(node instanceof Element)) return;
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      const translated = translateDomText(value, locale);
      if (translated !== value) node.setAttribute(attribute, translated);
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
}

const messages = {
  fa: {
    'language.fa': 'فارسی', 'language.en': 'English', 'language.change': 'تغییر زبان',
    'login.tagline': 'فضایی خصوصی برای سازندگان محتوا و تیم‌هایشان.',
    'login.identifier': 'ایمیل یا نام کاربری', 'login.password': 'رمز عبور',
    'login.submit': 'ورود', 'login.submitting': 'در حال ورود…',
    'login.unreachable': 'ارتباط با سرور برقرار نشد.',
    'login.directoryFailed': 'ورود از طریق سرویس سازمانی ناموفق بود.',
    'login.mfaHelp': 'کد ۶ رقمی برنامه احراز هویت یا یکی از کدهای بازیابی را وارد کنید.',
    'login.mfaCode': 'کد احراز هویت', 'login.verify': 'تأیید و ورود',
    'login.verifying': 'در حال تأیید…', 'login.back': 'بازگشت',
    'login.continueWith': 'ادامه با {provider}', 'login.signInWith': 'ورود با {provider}',
    'login.private': 'حساب‌ها فقط توسط مدیر ساخته می‌شوند و ثبت‌نام عمومی غیرفعال است.',
    'login.needAccess': 'برای دریافت دسترسی با مدیر این سرور تماس بگیرید.',
    'nav.directMessages': 'پیام‌های خصوصی', 'nav.createGroup': 'ساخت گروه',
    'nav.joinGroup': 'عضویت با دعوت‌نامه', 'nav.notifications': 'اعلان‌ها',
    'nav.admin': 'مدیریت', 'nav.account': 'تنظیمات حساب', 'nav.logout': 'خروج',
    'status.reconnecting': 'در حال اتصال مجدد…', 'status.online': 'آنلاین',
    'status.offline': 'آفلاین', 'common.cancel': 'انصراف', 'common.save': 'ذخیره',
    'common.close': 'بستن', 'common.loading': 'در حال بارگذاری…', 'common.back': 'بازگشت',
    'common.copy': 'کپی', 'common.remove': 'حذف', 'common.working': 'در حال انجام…',
    'account.title': 'حساب کاربری شما', 'account.profile': 'پروفایل',
    'account.security': 'امنیت', 'account.notifications': 'اعلان‌ها',
    'account.sessions': 'نشست‌ها', 'account.status': 'وضعیت',
    'account.displayName': 'نام نمایشی', 'account.accent': 'رنگ پروفایل',
    'account.customStatus': 'وضعیت سفارشی', 'account.about': 'درباره شما',
    'account.save': 'ذخیره پروفایل', 'account.saving': 'در حال ذخیره…',
    'account.saved': 'پروفایل با موفقیت به‌روزرسانی شد.',
    'account.saveFailed': 'ذخیره پروفایل انجام نشد.',
    'account.avatar.change': 'تغییر تصویر', 'account.avatar.remove': 'حذف تصویر',
    'account.avatar.help': 'تصویر PNG، JPEG، GIF، WebP یا BMP انتخاب کنید.',
    'account.avatar.uploading': 'در حال بارگذاری…',
    'account.avatar.saved': 'تصویر پروفایل به‌روزرسانی شد.',
    'account.avatar.failed': 'بارگذاری تصویر پروفایل انجام نشد.',
    'account.statusPlaceholder': 'مثلاً در حال ویرایش ویدیوی جدید',
    'presence.online': 'آنلاین', 'presence.idle': 'بیکار',
    'presence.dnd': 'مزاحم نشوید', 'presence.offline': 'نمایش به‌صورت آفلاین',
    'ui.close': 'بستن', 'ui.confirm': 'تأیید', 'ui.cancel': 'انصراف',
    'ui.fixFollowing': 'لطفاً موارد زیر را اصلاح کنید:',
    'theme.light': 'روشن', 'theme.dark': 'تیره', 'theme.system': 'سیستم',
    'theme.label': 'پوسته', 'theme.change': 'تغییر پوسته؛ حالت فعلی {theme}',
    'theme.customize': 'شخصی‌سازی ظاهر',
    'welcome.title': 'خوش آمدی، {name}',
    'welcome.body': 'یک گفتگو را انتخاب کنید، وارد گروه شوید یا از فهرست اعضا گفتگویی تازه آغاز کنید.',
    'pwa.install': 'نصب برنامه', 'pwa.update': 'نسخه جدید آماده است',
    'pwa.reload': 'به‌روزرسانی', 'pwa.updating': 'در حال به‌روزرسانی…', 'pwa.offline': 'اتصال اینترنت قطع است؛ پس از برقراری اتصال دوباره همگام می‌شویم.',
  },
  en: {
    'language.fa': 'فارسی', 'language.en': 'English', 'language.change': 'Change language',
    'login.tagline': 'A private space for creators and their teams.',
    'login.identifier': 'Email or username', 'login.password': 'Password',
    'login.submit': 'Sign in', 'login.submitting': 'Signing in…',
    'login.unreachable': 'Could not reach the server.', 'login.directoryFailed': 'Directory sign-in failed.',
    'login.mfaHelp': 'Enter the 6-digit code from your authenticator app or a recovery code.',
    'login.mfaCode': 'Authentication code', 'login.verify': 'Verify and sign in',
    'login.verifying': 'Verifying…', 'login.back': 'Back',
    'login.continueWith': 'Continue with {provider}', 'login.signInWith': 'Sign in with {provider}',
    'login.private': 'Accounts are created by an administrator; public sign-up is disabled.',
    'login.needAccess': 'Need access? Ask the person who runs this server.',
    'nav.directMessages': 'Direct messages', 'nav.createGroup': 'Create a group',
    'nav.joinGroup': 'Join with an invite', 'nav.notifications': 'Notifications',
    'nav.admin': 'Administration', 'nav.account': 'Account settings', 'nav.logout': 'Sign out',
    'status.reconnecting': 'Reconnecting…', 'status.online': 'Online', 'status.offline': 'Offline',
    'common.cancel': 'Cancel', 'common.save': 'Save', 'common.close': 'Close',
    'common.loading': 'Loading…', 'common.back': 'Back',
    'common.copy': 'Copy', 'common.remove': 'Remove', 'common.working': 'Working…',
    'account.title': 'Your account', 'account.profile': 'Profile',
    'account.security': 'Security', 'account.notifications': 'Notifications',
    'account.sessions': 'Sessions', 'account.status': 'Status',
    'account.displayName': 'Display name', 'account.accent': 'Accent colour',
    'account.customStatus': 'Custom status', 'account.about': 'About you',
    'account.save': 'Save profile', 'account.saving': 'Saving…',
    'account.saved': 'Profile updated.',
    'account.saveFailed': 'Could not save the profile.',
    'account.avatar.change': 'Change picture', 'account.avatar.remove': 'Remove picture',
    'account.avatar.help': 'Choose a PNG, JPEG, GIF, WebP or BMP image.',
    'account.avatar.uploading': 'Uploading…',
    'account.avatar.saved': 'Profile picture updated.',
    'account.avatar.failed': 'Could not upload the profile picture.',
    'account.statusPlaceholder': 'Editing the next upload',
    'presence.online': 'Online', 'presence.idle': 'Idle',
    'presence.dnd': 'Do not disturb', 'presence.offline': 'Appear offline',
    'ui.close': 'Close', 'ui.confirm': 'Confirm', 'ui.cancel': 'Cancel',
    'ui.fixFollowing': 'Please fix the following:',
    'theme.light': 'Light', 'theme.dark': 'Dark', 'theme.system': 'System',
    'theme.label': 'Theme', 'theme.change': 'Change theme; current mode {theme}',
    'theme.customize': 'Customize appearance',
    'welcome.title': 'Welcome back, {name}',
    'welcome.body': 'Pick a conversation, open a group, or browse the member directory to begin.',
    'pwa.install': 'Install app', 'pwa.update': 'A new version is ready',
    'pwa.reload': 'Update now', 'pwa.updating': 'Updating…', 'pwa.offline': 'You are offline; changes will sync when the connection returns.',
  },
} as const;

export type MessageKey = string;
type Translator = (key: MessageKey, values?: Record<string, string | number>) => string;
const I18nContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void; t: Translator }>({
  locale: 'en', setLocale: () => undefined, t: (key) => languagePacks.en?.[key] ?? messages.en[key as keyof (typeof messages)['en']] ?? key,
});

function initialLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && availableLanguages.includes(saved)) return saved;
  const normalized = new Map(availableLanguages.map((locale) => [locale.toLowerCase(), locale]));
  for (const requested of navigator.languages ?? [navigator.language]) {
    const exact = normalized.get(requested.toLowerCase());
    if (exact) return exact;
    const base = normalized.get(requested.split('-')[0].toLowerCase());
    if (base) return base;
  }
  return availableLanguages.includes('en') ? 'en' : (availableLanguages[0] ?? 'en');
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback((next: Locale) => {
    if (!availableLanguages.includes(next) || next === locale) return;
    localStorage.setItem(STORAGE_KEY, next);
    setLocaleState(next);
    window.location.reload();
  }, [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = isRtlLanguage(locale) ? 'rtl' : 'ltr';
  }, [locale]);
  useEffect(() => {
    if (!document.body) return;
    translateDomTree(document.body, locale);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          translateDomTree(mutation.target, locale);
        }
        for (const node of mutation.addedNodes) translateDomTree(node, locale);
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label'],
    });
    return () => observer.disconnect();
  }, [locale]);
  const t = useCallback<Translator>((key, values) => {
    const builtIn = messages[locale as keyof typeof messages];
    let value: string = languagePacks[locale]?.[key] ?? builtIn?.[key as keyof typeof messages.en] ?? languagePacks.en?.[key] ?? messages.en[key as keyof (typeof messages)['en']] ?? key;
    for (const [name, replacement] of Object.entries(values ?? {})) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
    return value;
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
