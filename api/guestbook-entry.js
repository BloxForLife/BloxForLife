import crypto from 'crypto';
import { readSession, OWNER_DISCORD_ID } from './_session.js';

const IP_HASH_SALT = process.env.IP_HASH_SALT || 'bloxforlife-default-salt';

function hashToken(token) {
    return crypto.createHash('sha256').update(IP_HASH_SALT + token).digest('hex');
}

// Constant-time-ish compare so a wrong key/token can't be brute-forced via response timing.
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

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

function ownsViaToken(entry, providedEditToken) {
    return !!(entry.editTokenHash && providedEditToken && safeEqual(hashToken(providedEditToken), entry.editTokenHash));
}

export default async function handler(req, res) {
    if (req.method !== 'DELETE' && req.method !== 'PATCH') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!redisConfigured()) {
        return res.status(503).json({ error: 'Guestbook storage not configured' });
    }

    const id = (req.query && req.query.id) || (req.body && req.body.id);
    if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Missing note id' });
    }

    const { editToken, message } = req.body || {};

    const raw = await redisCommand(['HGET', 'guestbook_entries', id]);
    if (!raw) {
        return res.status(404).json({ error: 'Note not found' });
    }

    let entry;
    try {
        entry = JSON.parse(raw);
    } catch {
        return res.status(404).json({ error: 'Note not found' });
    }

    const session = readSession(req);
    const admin = !!(session && session.id === OWNER_DISCORD_ID);
    const viaDiscord = !!(session && entry.discordId && session.id === entry.discordId);

    if (!admin && !viaDiscord && !ownsViaToken(entry, editToken)) {
        return res.status(403).json({ error: 'Not allowed to modify this note' });
    }

    if (req.method === 'DELETE') {
        await redisCommand(['HDEL', 'guestbook_entries', id]);
        await redisCommand(['ZREM', 'guestbook_wall_index', id]);
        return res.status(200).json({ ok: true });
    }

    // PATCH: edit the message
    if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Missing message' });
    }
    if (message.length > 300) {
        return res.status(400).json({ error: 'Too long' });
    }

    const updated = { ...entry, message: message.trim(), editedTs: Date.now() };
    await redisCommand(['HSET', 'guestbook_entries', id, JSON.stringify(updated)]);

    return res.status(200).json({
        ok: true,
        entry: { id, name: updated.name, message: updated.message, ts: updated.ts, editedTs: updated.editedTs }
    });
}
