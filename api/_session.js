// Shared helpers for the Discord-login cookie session. Not an API route itself
// (Vercel skips files/paths starting with "_" when building routes).
import crypto from 'crypto';

const SESSION_SECRET = process.env.SESSION_SECRET || 'bloxforlife-dev-session-secret';
const SESSION_COOKIE = 'gb_session';
const STATE_COOKIE = 'gb_oauth_state';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// The site owner's Discord ID — same one already public in index.html for the
// Lanyard widget, so hardcoding the default here reveals nothing new.
export const OWNER_DISCORD_ID = process.env.DISCORD_OWNER_ID || '1075335630353080340';

function sign(value) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

export function parseCookies(header) {
    const out = {};
    if (!header) return out;
    header.split(';').forEach((part) => {
        const idx = part.indexOf('=');
        if (idx === -1) return;
        const key = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (key) out[key] = decodeURIComponent(val);
    });
    return out;
}

// Cookies are HMAC-signed (not encrypted) — fine here since the payload
// (Discord id/name/avatar url) is already public information, we just need
// to know the browser didn't forge it.
export function createSessionCookie(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const token = `${body}.${sign(body)}`;
    return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie() {
    return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;

    const dot = token.lastIndexOf('.');
    if (dot === -1) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!safeEqual(sign(body), sig)) return null;

    try {
        return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

// Short-lived CSRF state cookie used only during the OAuth round trip.
export function createStateCookie(state) {
    return `${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}

export function clearStateCookie() {
    return `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readState(req) {
    return parseCookies(req.headers.cookie)[STATE_COOKIE] || null;
}

export { safeEqual };
