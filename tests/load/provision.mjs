const baseUrl = process.env.LOAD_BASE_URL || 'http://127.0.0.1:8080';
const adminEmail = process.env.SCALE_ADMIN_EMAIL || 'scale-admin@example.com';
const adminPassword = process.env.SCALE_ADMIN_PASSWORD;
const loadEmail = process.env.LOAD_EMAIL || 'scale-load@example.com';
const loadPassword = process.env.LOAD_PASSWORD;

if (!adminPassword || !loadPassword) throw new Error('Scale admin and load passwords are required.');
const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: adminEmail, password: adminPassword }),
});
if (!login.ok) throw new Error(`Scale admin login failed: ${login.status} ${await login.text()}`);
const session = await login.json();
const cookie = login.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
const created = await fetch(`${baseUrl}/api/admin/users`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    cookie,
    'x-csrf-token': session.csrfToken,
  },
  body: JSON.stringify({
    email: loadEmail,
    username: 'scaleload',
    displayName: 'Scale Load User',
    password: loadPassword,
    role: 'member',
    mustChangePassword: false,
  }),
});
if (!created.ok && created.status !== 409) {
  throw new Error(`Load user provisioning failed: ${created.status} ${await created.text()}`);
}
console.log(`load user ready: ${loadEmail}`);
