const DEDUPE_SECONDS = 60 * 60; // only log the same IP once per hour

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

// Returns true if this is the first time we've seen this IP in the current window
async function isNewVisit(ip) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) return true; // no dedupe store configured — just log every time

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(['SET', `visit_seen:${ip}`, '1', 'EX', String(DEDUPE_SECONDS), 'NX'])
    });
    const data = await res.json();
    return data.result === 'OK';
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const webhookUrl = process.env.VISIT_LOG_WEBHOOK_URL;
    if (!webhookUrl) {
        return res.status(200).json({ ok: true }); // fail silently, never break the site over this
    }

    const ip = getClientIp(req);
    const fresh = await isNewVisit(ip);
    if (!fresh) {
        return res.status(200).json({ ok: true, logged: false });
    }

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
                        { name: 'IP', value: ip, inline: true }
                    ],
                    color: 5793266
                }]
            })
        });
    } catch (err) {
        // Never let logging failures affect the visitor's experience
    }

    return res.status(200).json({ ok: true, logged: true });
}