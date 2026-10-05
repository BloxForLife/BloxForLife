import crypto from 'crypto';
import { redisConfigured, redisCommand, redisPipeline } from './_redis.js';
import { reactionsKey, reactorKey, summarizeReactions } from './_reactions.js';

const WALL_LIMIT = 20; // how many recent notes to show on the page

// One-time upgrade for notes posted before per-note ids/edit-tokens existed
// (the old schema was a plain list at "guestbook_wall"). Gives each a fresh
// id with no edit token, so only admin can manage them, then clears the old key.
async function migrateLegacyEntries() {
    const legacy = await redisCommand(['LRANGE', 'guestbook_wall', '0', '-1']);
    if (!Array.isArray(legacy) || !legacy.length) return;

    for (const item of legacy) {
        try {
            const parsed = JSON.parse(item);
            if (typeof parsed.name !== 'string' || typeof parsed.message !== 'string') continue;
            const id = crypto.randomUUID();
            const ts = parsed.ts || Date.now();
            const entry = JSON.stringify({ name: parsed.name, message: parsed.message, ts, editTokenHash: null });
            await redisCommand(['HSET', 'guestbook_entries', id, entry]);
            await redisCommand(['ZADD', 'guestbook_wall_index', String(ts), id]);
        } catch {
            // skip malformed legacy entries
        }
    }

    await redisCommand(['DEL', 'guestbook_wall']);
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!redisConfigured()) {
        return res.status(200).json({ entries: [] });
    }

    try {
        const indexCount = await redisCommand(['ZCARD', 'guestbook_wall_index']);
        if (!indexCount) {
            await migrateLegacyEntries();
        }

        const ids = await redisCommand(['ZREVRANGE', 'guestbook_wall_index', '0', String(WALL_LIMIT - 1)]);
        if (!Array.isArray(ids) || !ids.length) {
            return res.status(200).json({ entries: [] });
        }

        const [raw, ...reactionHashes] = await redisPipeline([
            ['HMGET', 'guestbook_entries', ...ids],
            ...ids.map((id) => ['HGETALL', reactionsKey(id)])
        ]);
        const viewer = reactorKey(req);

        const entries = ids
            .map((id, i) => {
                const item = raw?.[i];
                if (!item) return null;
                try {
                    const parsed = JSON.parse(item);
                    if (typeof parsed.name !== 'string' || typeof parsed.message !== 'string') return null;
                    return {
                        id,
                        name: parsed.name,
                        message: parsed.message,
                        ts: parsed.ts || null,
                        editedTs: parsed.editedTs || null,
                        discordId: parsed.discordId || null,
                        avatar: parsed.discordAvatar || null,
                        reactions: summarizeReactions(reactionHashes[i], viewer)
                    };
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
