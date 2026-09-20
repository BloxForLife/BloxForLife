import crypto from 'crypto';

const WALL_LIMIT = 20; // how many recent notes to show on the page

function redisConfigured() {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    return !!(url && token);
}

async function redisCommand(command) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(command)
    });
    const data = await res.json();
    return data.result;
}

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

        const raw = await redisCommand(['HMGET', 'guestbook_entries', ...ids]);

        const entries = ids
            .map((id, i) => {
                const item = raw[i];
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
                        avatar: parsed.discordAvatar || null
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
