// The two cheap endpoints the page polls:
//   GET  /api/live        -> version counters (guestbook, song requests), so the
//                            client only re-fetches a list when it actually changed
//   POST /api/live {id}   -> presence heartbeat; returns how many viewers are here now
import { redisConfigured, redisCommand, redisPipeline } from './_redis.js';

const ONLINE_WINDOW_MS = 90 * 1000; // a viewer counts as "here" if they pinged in the last 90s

async function versions(req, res) {
    if (!redisConfigured()) {
        return res.status(200).json({ version: 0, songs: 0 });
    }
    try {
        const [guestbook, songs] = await redisCommand(['MGET', 'guestbook_version', 'song_requests_version']);
        return res.status(200).json({
            version: guestbook ? parseInt(guestbook, 10) : 0,
            songs: songs ? parseInt(songs, 10) : 0
        });
    } catch {
        return res.status(200).json({ version: 0, songs: 0 });
    }
}

// Every open page heartbeats here every ~30s with a random per-browser id.
// Sorted set scored by last-seen time; anything older than the window is
// pruned on each call, so the count is just the set's size.
async function heartbeat(req, res) {
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

export default async function handler(req, res) {
    if (req.method === 'GET') return versions(req, res);
    if (req.method === 'POST') return heartbeat(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
}
