const GUESTBOOK_ENABLED = true;

// Manual blocklist — add an IP here to instantly reject them, no waiting on anything else.
// (Get the IP from the "IP" field in the Discord embed on any note they've left.)
const BLOCKED_IPS = [
    // "1.2.3.4",
];

const RATE_LIMIT_SECONDS = 12 * 60 * 60; // 12 hours

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

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.headers['x-real-ip'] || 'unknown';
}

// Atomic "set only if not already set" against Upstash Redis via its REST API —
// no npm package needed, just a plain fetch. Returns true if this IP is allowed
// (and marks it as used for the next RATE_LIMIT_SECONDS), false if still on cooldown.
async function checkAndSetRateLimit(ip) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
        // Not configured yet — don't hard-block the feature, just skip real enforcement
        return { allowed: true, configured: false };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(['SET', `guestbook_rl:${ip}`, '1', 'EX', String(RATE_LIMIT_SECONDS), 'NX'])
    });
    const data = await res.json();
    return { allowed: data.result === 'OK', configured: true };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!GUESTBOOK_ENABLED) {
        return res.status(503).json({ error: 'Guestbook is temporarily closed' });
    }

    const { name, message } = req.body || {};

    if (!name || !message || typeof name !== 'string' || typeof message !== 'string') {
        return res.status(400).json({ error: 'Missing name or message' });
    }
    if (name.length > 40 || message.length > 300) {
        return res.status(400).json({ error: 'Too long' });
    }

    const ip = getClientIp(req);

    if (BLOCKED_IPS.includes(ip)) {
        return res.status(403).json({ error: 'Blocked' });
    }

    const { allowed } = await checkAndSetRateLimit(ip);
    if (!allowed) {
        return res.status(429).json({ error: 'You can leave another note in a bit' });
    }

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
        return res.status(500).json({ error: 'Webhook not configured' });
    }

    // Derived server-side from the request itself — not client-supplied, so it can't be faked
    const country = req.headers['x-vercel-ip-country'] || 'Unknown';
    const cityRaw = req.headers['x-vercel-ip-city'];
    const city = cityRaw ? decodeURIComponent(cityRaw) : 'Unknown';
    const location = (country !== 'Unknown' || city !== 'Unknown') ? `${city}, ${country}` : 'Unknown';

    const { browser, os } = parseDevice(req.headers['user-agent']);

    try {
        const discordRes = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: 'New note on bloxforlife.com',
                    fields: [
                        { name: 'From', value: name },
                        { name: 'Message', value: message },
                        { name: 'Location', value: location, inline: true },
                        { name: 'Device', value: `${browser} · ${os}`, inline: true },
                        { name: 'IP', value: ip, inline: true }
                    ],
                    color: 13091926
                }]
            })
        });

        if (!discordRes.ok) {
            return res.status(502).json({ error: 'Discord rejected the message' });
        }

        return res.status(200).json({ ok: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to send' });
    }
}