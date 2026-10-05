// Shared client-IP hashing (same salt/scheme guestbook.js and track-visit.js use).
import crypto from 'crypto';

const IP_HASH_SALT = process.env.IP_HASH_SALT || 'bloxforlife-default-salt';

export function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.headers['x-real-ip'] || 'unknown';
}

export function hashIp(ip) {
    return crypto.createHash('sha256').update(IP_HASH_SALT + ip).digest('hex').slice(0, 16);
}
