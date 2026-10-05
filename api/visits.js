// POST /api/visits {path} -> log a visit (deduped per IP per hour), bump the total
// GET  /api/visits        -> the running unique-visitor total
import { redisConfigured, redisCommand } from './_redis.js';
import { getClientIp, hashIp } from './_ip.js';

const DEDUPE_SECONDS = 60 * 60; // only count/log the same IP once per hour

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

async function track(req, res) {
    const ipHash = hashIp(getClientIp(req));

    // SET NX returns OK only if this IP hasn't been seen within the window.
    if (redisConfigured()) {
        const fresh = await redisCommand(['SET', `visit_seen:${ipHash}`, '1', 'EX', String(DEDUPE_SECONDS), 'NX']);
        if (fresh !== 'OK') {
            return res.status(200).json({ ok: true, logged: false });
        }
        // Bump the real running total — persists forever, independent of Discord logging
        await redisCommand(['INCR', 'total_unique_visits']);
    }

    const webhookUrl = process.env.VISIT_LOG_WEBHOOK_URL;
    if (webhookUrl) {
        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        const cityRaw = req.headers['x-vercel-ip-city'];
        const city = cityRaw ? decodeURIComponent(cityRaw) : 'Unknown';
        const location = (country !== 'Unknown' || city !== 'Unknown') ? `${city}, ${country}` : 'Unknown';
        const { browser, os } = parseDevice(req.headers['user-agent']);
        const path = (req.body && req.body.path) || 'Unknown';

        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    embeds: [{
                        title: 'New visit',
                        fields: [
                            { name: 'Page', value: path, inline: true },
                            { name: 'Location', value: location, inline: true },
                            { name: 'Device', value: `${browser} · ${os}`, inline: true },
                            { name: 'IP hash', value: ipHash, inline: true }
                        ],
                        color: 5793266
                    }]
                })
            });
        } catch {
            // Never let logging failures affect the visitor's experience
        }
    }

    return res.status(200).json({ ok: true, logged: true });
}

export default async function handler(req, res) {
    if (req.method === 'GET') return count(req, res);
    if (req.method === 'POST') return track(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
}
