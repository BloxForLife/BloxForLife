// Everything that acts on one note, /api/guestbook/<id>:
//   PATCH  { message, editToken? }  -> edit (own note only)
//   DELETE { editToken? }           -> delete (own note, or owner moderating)
//   DELETE { ban: true }            -> owner only: delete, ban the author, and
//                                      remove everything else they've posted
//   POST   { emoji }                -> toggle a reaction
import crypto from 'crypto';
import { readSession, safeEqual, OWNER_DISCORD_ID } from '../_session.js';
import { redisConfigured, redisCommand } from '../_redis.js';
import { REACTION_EMOJIS, reactionsKey, reactorKey, summarizeReactions } from '../_reactions.js';
import { isBanned, banAuthor } from '../_bans.js';
import { containsSlur } from '../_filter.js';

const IP_HASH_SALT = process.env.IP_HASH_SALT || 'bloxforlife-default-salt';

function hashToken(token) {
    return crypto.createHash('sha256').update(IP_HASH_SALT + token).digest('hex');
}

function ownsViaToken(entry, providedEditToken) {
    return !!(entry.editTokenHash && providedEditToken && safeEqual(hashToken(providedEditToken), entry.editTokenHash));
}

async function react(req, res, id) {
    const { emoji } = req.body || {};
    if (!REACTION_EMOJIS.includes(emoji)) {
        return res.status(400).json({ error: 'Bad request' });
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

export default async function handler(req, res) {
    if (!['DELETE', 'PATCH', 'POST'].includes(req.method)) {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!redisConfigured()) {
        return res.status(503).json({ error: 'Guestbook storage not configured' });
    }

    const id = req.query?.id;
    if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Missing note id' });
    }

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

    const { editToken, message, ban } = req.body || {};
    const session = readSession(req);
    const admin = !!(session && session.id === OWNER_DISCORD_ID);

    if (!admin && await isBanned(req)) {
        return res.status(403).json({ error: 'Blocked' });
    }

    if (req.method === 'POST') return react(req, res, id);

    const isOwnNote = !!(session && entry.discordId && session.id === entry.discordId) || ownsViaToken(entry, editToken);

    if (req.method === 'DELETE') {
        // Admin can delete anyone's note; a note's own author can delete theirs.
        if (!admin && !isOwnNote) {
            return res.status(403).json({ error: 'Not allowed to delete this note' });
        }
        await redisCommand(['HDEL', 'guestbook_entries', id]);
        await redisCommand(['ZREM', 'guestbook_wall_index', id]);
        await redisCommand(['DEL', reactionsKey(id)]);
        await redisCommand(['INCR', 'guestbook_version']);

        if (ban) {
            if (!admin) {
                return res.status(403).json({ error: 'Owner only' });
            }
            if (!entry.ipHash && !entry.discordId) {
                // Pre-ban-feature note with nothing stored to ban by.
                return res.status(200).json({ ok: true, banned: false });
            }
            const removed = await banAuthor({ ipHash: entry.ipHash || null, discordId: entry.discordId || null });
            return res.status(200).json({ ok: true, banned: true, ...removed });
        }
        return res.status(200).json({ ok: true });
    }

    // PATCH: edit the message — own-note only, admin does not get to edit others' wording.
    if (!isOwnNote) {
        return res.status(403).json({ error: 'Not allowed to edit this note' });
    }
    if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Missing message' });
    }
    if (message.length > 300) {
        return res.status(400).json({ error: 'Too long' });
    }
    if (containsSlur(message)) {
        return res.status(400).json({ error: "That's not allowed here." });
    }

    const updated = { ...entry, message: message.trim(), editedTs: Date.now() };
    await redisCommand(['HSET', 'guestbook_entries', id, JSON.stringify(updated)]);
    await redisCommand(['INCR', 'guestbook_version']);

    return res.status(200).json({
        ok: true,
        entry: { id, name: updated.name, message: updated.message, ts: updated.ts, editedTs: updated.editedTs }
    });
}
