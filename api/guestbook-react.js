import { redisConfigured, redisCommand } from './_redis.js';
import { REACTION_EMOJIS, reactionsKey, reactorKey, summarizeReactions } from './_reactions.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!redisConfigured()) {
        return res.status(503).json({ error: 'Guestbook storage not configured' });
    }

    const { id, emoji } = req.body || {};
    if (!id || typeof id !== 'string' || !REACTION_EMOJIS.includes(emoji)) {
        return res.status(400).json({ error: 'Bad request' });
    }

    const exists = await redisCommand(['HEXISTS', 'guestbook_entries', id]);
    if (!exists) {
        return res.status(404).json({ error: 'Note not found' });
    }

    const key = reactionsKey(id);
    const me = reactorKey(req);

    let mine = [];
    try { mine = JSON.parse(await redisCommand(['HGET', key, me]) || '[]'); } catch {}
    if (!Array.isArray(mine)) mine = [];

    // Toggle: tapping an emoji you've already used removes it.
    mine = mine.includes(emoji) ? mine.filter((e) => e !== emoji) : [...mine, emoji];

    if (mine.length) {
        await redisCommand(['HSET', key, me, JSON.stringify(mine)]);
    } else {
        await redisCommand(['HDEL', key, me]);
    }
    await redisCommand(['INCR', 'guestbook_version']);

    const all = await redisCommand(['HGETALL', key]);
    return res.status(200).json({ ok: true, reactions: summarizeReactions(all, me) });
}
