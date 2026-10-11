// POST  /api/visits {path}  -> log a visit (deduped per IP per hour), bump the total
// GET   /api/visits         -> the running unique-visitor total
// PATCH /api/visits {count} -> owner only: set the total (e.g. after a spam run)
import { readSession, OWNER_DISCORD_ID } from './_session.js';
import { redisConfigured, redisCommand, redisPipeline } from './_redis.js';
import crypto from 'crypto';
import { getClientIp, hashIp } from './_ip.js';

const DEDUPE_SECONDS = 60 * 60;     // only count/log the same IP once per hour
const BURST_MAX_PER_MINUTE = 10;    // more new "unique" visitors than this in a minute is a bot run
// Discord visit pings per hour, no matter what gets through. Override with the
// VISIT_LOG_MAX_PER_HOUR env var on Vercel (0 = no visit pings at all).
const envMax = parseInt(process.env.VISIT_LOG_MAX_PER_HOUR, 10);
const WEBHOOK_MAX_PER_HOUR = Number.isNaN(envMax) ? 10 : Math.max(0, envMax);

// Same-device detection: this many new "visitors" sharing one exact browser
// fingerprint (full user-agent + city + country) inside the window is treated
// as one person cycling IPs. All but the first are un-counted, their Discord
// pings deleted, and that fingerprint is ignored for SUSPECT_MUTE_SECONDS.
const SUSPECT_THRESHOLD = 5;
const SUSPECT_WINDOW_SECONDS = 10 * 60;
const SUSPECT_MUTE_SECONDS = 60 * 60;
const IP_HASH_SALT = process.env.IP_HASH_SALT || 'bloxforlife-default-salt';

// Obvious non-browser clients. Trivial to spoof, but it stops the lazy ones
// and keeps search crawlers out of the count.
const BOT_UA = /^$|curl|wget|python|httpx|aiohttp|node-fetch|undici|axios|go-http|java\/|libwww|okhttp|scrapy|bot|spider|crawl|headless/i;

function parseDevice(userAgent) {
    if (!userAgent) return { browser: 'Unknown', os: 'Unknown' };

    let browser = 'Unknown';
    if (/Edg\//.test(userAgent)) browser = 'Edge';
    else if (/OPR\//.test(userAgent)) browser = 'Opera';
    else if (/Chrome\//.test(userAgent)) browser = 'Chrome';
    else if (/Firefox\//.test(userAgent)) browser = 'Firefox';
    else if (/Safari\//.test(userAgent)) browser = 'Safari';

    let os = 'Unknown';
    if (/Windows/.test(userAgent)) os = 'Windows';
    else if (/Mac OS X/.test(userAgent)) os = 'macOS';
    else if (/Android/.test(userAgent)) os = 'Android';
    else if (/iPhone|iPad|iOS/.test(userAgent)) os = 'iOS';
    else if (/Linux/.test(userAgent)) os = 'Linux';

    return { browser, os };
}

async function count(req, res) {
    if (!redisConfigured()) {
        return res.status(200).json({ count: null });
    }
    try {
        const total = await redisCommand(['GET', 'total_unique_visits']);
        return res.status(200).json({ count: total ? parseInt(total, 10) : 0 });
    } catch {
        return res.status(200).json({ count: null });
    }
}

// Browsers always send Origin on a fetch() POST, and it can't be set from page
// script. Scripts hammering the endpoint directly usually don't bother — so a
// missing or foreign Origin means "not a real page load".
function fromOwnPage(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
        return new URL(origin).host === req.headers.host;
    } catch {
        return false;
    }
}

// Webhook URL with a path/query tweak, preserving anything already on it.
function webhookUrlFor(base, { messageId, wait } = {}) {
    const u = new URL(base);
    if (messageId) u.pathname = `${u.pathname.replace(/\/$/, '')}/messages/${messageId}`;
    if (wait) u.searchParams.set('wait', 'true');
    return u.toString();
}

// Posts an embed. With wait=true Discord returns the created message, so we
// get its id back (needed to delete it later). Returns the id or null.
async function sendVisitWebhook(webhookUrl, embed) {
    try {
        const res = await fetch(webhookUrlFor(webhookUrl, { wait: true }), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        });
        if (!res.ok) return null;
        const msg = await res.json().catch(() => null);
        return msg?.id || null;
    } catch {
        // Never let logging failures affect the visitor's experience
        return null;
    }
}

async function deleteVisitWebhookMessage(webhookUrl, messageId) {
    try {
        await fetch(webhookUrlFor(webhookUrl, { messageId }), { method: 'DELETE' });
    } catch {}
}

function visitorDetails(req, userAgent) {
    const country = req.headers['x-vercel-ip-country'] || 'Unknown';
    const cityRaw = req.headers['x-vercel-ip-city'];
    const city = cityRaw ? decodeURIComponent(cityRaw) : 'Unknown';
    const location = (country !== 'Unknown' || city !== 'Unknown') ? `${city}, ${country}` : 'Unknown';
    const { browser, os } = parseDevice(userAgent);
    const fingerprint = crypto.createHash('sha256')
        .update(`${IP_HASH_SALT}|${userAgent}|${city}|${country}`)
        .digest('hex').slice(0, 16);
    return { location, browser, os, fingerprint };
}

// Hourly ceiling on Discord pings. Returns true if this ping may go out. The
// first one over the limit sends a single heads-up instead.
async function claimWebhookSlot(webhookUrl) {
    if (!redisConfigured()) return true;
    const hourKey = `visit_webhook:${Math.floor(Date.now() / 3600000)}`;
    const [sent] = await redisPipeline([['INCR', hourKey], ['EXPIRE', hourKey, '7200']]);
    if (typeof sent !== 'number' || sent <= WEBHOOK_MAX_PER_HOUR) return true;
    if (sent === WEBHOOK_MAX_PER_HOUR + 1) {
        await sendVisitWebhook(webhookUrl, {
            title: 'Visit flood — muting visit logs for the rest of this hour',
            description: `More than ${WEBHOOK_MAX_PER_HOUR} new visitors this hour. Visits are still being deduped and capped; logs resume next hour.`,
            color: 15548997
        });
    }
    return false;
}

// Record this visit under its fingerprint; if that fingerprint has now hit the
// threshold, collapse the group down to its first visit.
async function checkSameDevice(fingerprint, messageId, details, webhookUrl) {
    const key = `visit_fp:${fingerprint}`;
    const [count] = await redisPipeline([
        ['RPUSH', key, messageId || ''],
        ['EXPIRE', key, String(SUSPECT_WINDOW_SECONDS)]
    ]);
    if (typeof count !== 'number' || count < SUSPECT_THRESHOLD) return;

    // Only one request gets to do the cleanup, even if several race in.
    const won = await redisCommand(['SET', `visit_fp_flagged:${fingerprint}`, '1', 'EX', String(SUSPECT_MUTE_SECONDS), 'NX']);
    if (won !== 'OK') return;

    const [group] = await redisPipeline([['LRANGE', key, '0', '-1'], ['DEL', key]]);
    const extras = Array.isArray(group) ? group.slice(1) : [];
    if (extras.length) {
        await redisCommand(['DECRBY', 'total_unique_visits', String(extras.length)]);
    }
    if (webhookUrl) {
        await Promise.all(extras.filter(Boolean).map((id) => deleteVisitWebhookMessage(webhookUrl, id)));
        await sendVisitWebhook(webhookUrl, {
            title: 'Suspicious visits — same device, different IPs',
            description: `${extras.length + 1} new visitors in ${SUSPECT_WINDOW_SECONDS / 60} min with an identical browser fingerprint. Kept 1, removed ${extras.length} from the count and deleted their logs. This device is ignored for the next ${SUSPECT_MUTE_SECONDS / 60} min.`,
            fields: [
                { name: 'Device', value: `${details.browser} · ${details.os}`, inline: true },
                { name: 'Location', value: details.location, inline: true }
            ],
            color: 15105570
        });
    }
}

async function track(req, res) {
    const userAgent = req.headers['user-agent'] || '';
    if (BOT_UA.test(userAgent) || !fromOwnPage(req)) {
        return res.status(200).json({ ok: true, logged: false });
    }

    const ipHash = hashIp(getClientIp(req));
    const details = visitorDetails(req, userAgent);

    if (redisConfigured()) {
        // A device already caught cycling IPs is ignored until its mute expires.
        const flagged = await redisCommand(['EXISTS', `visit_fp_flagged:${details.fingerprint}`]);
        if (flagged === 1) {
            return res.status(200).json({ ok: true, logged: false });
        }

        // SET NX returns OK only if this IP hasn't been seen within the window.
        const fresh = await redisCommand(['SET', `visit_seen:${ipHash}`, '1', 'EX', String(DEDUPE_SECONDS), 'NX']);
        if (fresh !== 'OK') {
            return res.status(200).json({ ok: true, logged: false });
        }

        // Burst guard: past N new visitors in a minute, stop counting and stop
        // pinging Discord until the minute rolls over.
        const bucket = `visit_burst:${Math.floor(Date.now() / 60000)}`;
        const [burst] = await redisPipeline([['INCR', bucket], ['EXPIRE', bucket, '120']]);
        if (typeof burst === 'number' && burst > BURST_MAX_PER_MINUTE) {
            return res.status(200).json({ ok: true, logged: false, throttled: true });
        }

        // Bump the real running total — persists forever, independent of Discord logging
        await redisCommand(['INCR', 'total_unique_visits']);
    }

    const webhookUrl = WEBHOOK_MAX_PER_HOUR > 0 ? process.env.VISIT_LOG_WEBHOOK_URL : null;

    let messageId = null;
    if (webhookUrl && await claimWebhookSlot(webhookUrl)) {
        const path = String((req.body && req.body.path) || 'Unknown').slice(0, 100);
        messageId = await sendVisitWebhook(webhookUrl, {
            title: 'New visit',
            fields: [
                { name: 'Page', value: path, inline: true },
                { name: 'Location', value: details.location, inline: true },
                { name: 'Device', value: `${details.browser} · ${details.os}`, inline: true },
                { name: 'IP hash', value: ipHash, inline: true }
            ],
            color: 5793266
        });
    }

    if (redisConfigured()) {
        await checkSameDevice(details.fingerprint, messageId, details, webhookUrl);
    }

    return res.status(200).json({ ok: true, logged: true });
}

async function reset(req, res) {
    const session = readSession(req);
    if (!session || session.id !== OWNER_DISCORD_ID) {
        return res.status(403).json({ error: 'Owner only' });
    }
    if (!redisConfigured()) {
        return res.status(503).json({ error: 'Storage not configured' });
    }
    const value = Number(req.body?.count);
    if (!Number.isInteger(value) || value < 0 || value > 1e9) {
        return res.status(400).json({ error: 'Bad count' });
    }
    await redisCommand(['SET', 'total_unique_visits', String(value)]);
    return res.status(200).json({ ok: true, count: value });
}

export default async function handler(req, res) {
    if (req.method === 'GET') return count(req, res);
    if (req.method === 'POST') return track(req, res);
    if (req.method === 'PATCH') return reset(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
}
