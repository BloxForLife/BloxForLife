import crypto from 'crypto';

const GUESTBOOK_ENABLED = true;

// Manual blocklist — add a HASHED IP here to instantly reject them.
// (Get the hash from the "IP hash" field in the Discord embed on any note they've left.)
const BLOCKED_IP_HASHES = [
    // "a1b2c3d4e5f6a7b8",
];

const RATE_LIMIT_SECONDS = 12 * 60 * 60; // 12 hours
const IP_HASH_SALT = process.env.IP_HASH_SALT || 'bloxforlife-default-salt';

function hashIp(ip) {
    return crypto.createHash('sha256').update(IP_HASH_SALT + ip).digest('hex').slice(0, 16);
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.headers['x-real-ip'] || 'unknown';
}

// Atomic "set only if not already set" against Upstash Redis via its REST API.
async function checkAndSetRateLimit(ipHash) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
        return { allowed: true, configured: false };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(['SET', `guestbook_rl:${ipHash}`, '1', 'EX', String(RATE_LIMIT_SECONDS), 'NX'])
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

    const ipHash = hashIp(getClientIp(req));

    if (BLOCKED_IP_HASHES.includes(ipHash)) {
        return res.status(403).json({ error: 'Blocked' });
    }

    const { allowed } = await checkAndSetRateLimit(ipHash);
    if (!allowed) {
        return res.status(429).json({ error: 'You can leave another note in a bit' });
    }

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
        return res.status(500).json({ error: 'Webhook not configured' });
    }

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
                        { name: 'IP hash', value: ipHash, inline: true }
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