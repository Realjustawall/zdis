import { config } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { audit } from './audit.js';
import { logger } from '../lib/logger.js';

const PATTERNS = [
  { id: 'private_key', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i },
  { id: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: 'github_token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,255}\b/ },
  { id: 'slack_token', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { id: 'stripe_secret', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { id: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/**
 * Detects high-confidence secrets and valid payment-card numbers. Findings
 * contain rule names only; sensitive values never reach logs or audit rows.
 */
export async function inspectDlp(value, { source, actorId = null, ip = null } = {}) {
  if (config.dlpMode === 'off') return { allowed: true, findings: [] };
  const text = Buffer.isBuffer(value)
    ? new TextDecoder('utf-8', { fatal: false }).decode(value.subarray(0, 1024 * 1024))
    : String(value ?? '').slice(0, 1024 * 1024);
  const findings = PATTERNS.filter(({ regex }) => regex.test(text)).map(({ id }) => id);
  if (containsPaymentCard(text)) findings.push('payment_card');
  if (!findings.length) return { allowed: true, findings: [] };

  const unique = [...new Set(findings)];
  await audit({
    actorId,
    action: config.dlpMode === 'block' ? 'security.dlp_blocked' : 'security.dlp_detected',
    targetType: source || 'content',
    meta: { rules: unique },
    ip,
  });
  logger.warn('DLP finding', { source, actorId, rules: unique, mode: config.dlpMode });
  if (config.dlpMode === 'block') {
    throw badRequest('This content appears to contain a secret or sensitive payment data.');
  }
  return { allowed: true, findings: unique };
}

function containsPaymentCard(text) {
  const candidates = text.match(/(?:\d[ -]?){13,19}/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
    let sum = 0;
    let double = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    return sum % 10 === 0;
  });
}
