const WALL_LIMIT = 20; // how many recent notes to show on the page

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
        return res.status(200).json({ entries: [] });
    }

    try {
        const redisRes = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(['LRANGE', 'guestbook_wall', '0', String(WALL_LIMIT - 1)])
        });
        const data = await redisRes.json();
        const raw = Array.isArray(data.result) ? data.result : [];

        const entries = raw
            .map((item) => {
                try {
                    const parsed = JSON.parse(item);
                    if (typeof parsed.name !== 'string' || typeof parsed.message !== 'string') return null;
                    return { name: parsed.name, message: parsed.message, ts: parsed.ts || null };
                } catch {
                    return null;
                }
            })
            .filter(Boolean);

        return res.status(200).json({ entries });
    } catch (err) {
        return res.status(200).json({ entries: [] });
    }
}
