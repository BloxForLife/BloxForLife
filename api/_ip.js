// Shared client-IP hashing (same salt/scheme every route uses).
import crypto from 'crypto';

const IP_HASH_SALT = process.env.IP_HASH_SALT || 'bloxforlife-default-salt';

// Vercel sets x-real-ip from the actual TCP connection, so that's the one to
// trust. x-forwarded-for can carry whatever the client put in the header at the
// front of the list, so it's only a fallback — and then only its LAST hop.
// (Trusting the first hop let anyone mint a fresh "IP" per request.)
export function getClientIp(req) {
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();

    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const hops = String(forwarded).split(',').map((s) => s.trim()).filter(Boolean);
        if (hops.length) return hops[hops.length - 1];
    }
    return 'unknown';
}

export function hashIp(ip) {
    return crypto.createHash('sha256').update(IP_HASH_SALT + ip).digest('hex').slice(0, 16);
}
