import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { logger } from '../lib/logger.js';

let transporter;

export function resetDeliveryTransport() {
  transporter?.close?.();
  transporter = undefined;
}

export async function verifySmtpConfiguration() {
  if (!config.smtp.host) return { ok: false, configured: false };
  try {
    await mailer().verify();
    return { ok: true, configured: true };
  } catch (error) {
    return { ok: false, configured: true, error: error.message };
  }
}

function mailer() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      pool: true,
      maxConnections: 5,
    });
  }
  return transporter;
}

export async function deliverNotification(job) {
  const { user_id: userId, title, body, data, preferences, digestItemIds = [] } = job;
  const user = await getDb().get('SELECT email, is_active FROM users WHERE id = ?', [userId]);
  if (!user?.is_active) return;

  if (preferences.email && config.smtp.from && mailer()) {
    await mailer().sendMail({
      from: config.smtp.from,
      to: user.email,
      subject: title,
      text: `${body}\n\n${config.appName}`,
    });
  }

  if (
    preferences.push &&
    config.vapid.publicKey &&
    config.vapid.privateKey
  ) {
    webpush.setVapidDetails(
      config.vapid.subject,
      config.vapid.publicKey,
      config.vapid.privateKey,
    );
    const subscriptions = await getDb().all(
      'SELECT * FROM push_subscriptions WHERE user_id = ?',
      [userId],
    );
    for (const subscription of subscriptions) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify({ title, body, data: data ? JSON.parse(data) : null }),
          { TTL: 3600, urgency: 'normal' },
        );
        await getDb().run('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?', [
          Date.now(),
          subscription.id,
        ]);
      } catch (error) {
        if ([404, 410].includes(error.statusCode)) {
          await getDb().run('DELETE FROM push_subscriptions WHERE id = ?', [subscription.id]);
        } else {
          logger.warn('push delivery failed', { error: error.message, userId });
          throw error;
        }
      }
    }
  }
  if (digestItemIds.length) {
    await getDb().run(
      `UPDATE notification_digest_items SET status = 'delivered', delivered_at = ?
       WHERE id IN (${digestItemIds.map(() => '?').join(', ')})`,
      [Date.now(), ...digestItemIds],
    );
  }
}
