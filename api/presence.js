import { redisConfigured, redisPipeline } from './_redis.js';

const ONLINE_WINDOW_MS = 90 * 1000; // a viewer counts as "here" if they pinged in the last 90s

// Every open page heartbeats here every ~30s with a random per-browser id.
// Sorted set scored by last-seen time; anything older than the window is
// pruned on each call, so the count is just the set's size.
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!redisConfigured()) {
        return res.status(200).json({ online: null });
    }

    const { id } = req.body || {};
    if (!id || typeof id !== 'string' || id.length > 64) {
        return res.status(400).json({ error: 'Missing id' });
    }

    const now = Date.now();
    try {
        const [, , online] = await redisPipeline([
            ['ZADD', 'online_viewers', String(now), id],
            ['ZREMRANGEBYSCORE', 'online_viewers', '-inf', String(now - ONLINE_WINDOW_MS)],
            ['ZCARD', 'online_viewers']
        ]);
        return res.status(200).json({ online: typeof online === 'number' ? online : null });
    } catch {
        return res.status(200).json({ online: null });
    }
}
