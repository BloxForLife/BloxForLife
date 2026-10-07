// Banning: who's blocked from posting, and the owner's "ban this author" action.
// Bans live in Redis sets so they take effect instantly with no redeploy.
import { readSession } from './_session.js';
import { getClientIp, hashIp } from './_ip.js';
import { redisConfigured, redisCommand, redisPipeline } from './_redis.js';

// Manual fallback blocklist — add a HASHED IP here (from the "IP hash" field in
// a Discord embed) for someone whose notes are already gone from the wall, so
// there's nothing left to press Ban on.
const BLOCKED_IP_HASHES = [
    // "a1b2c3d4e5f6a7b8",
];

export async function isBanned(req) {
    const ipHash = hashIp(getClientIp(req));
    if (BLOCKED_IP_HASHES.includes(ipHash)) return true;
    if (!redisConfigured()) return false;

    const session = readSession(req);
    const checks = [['SISMEMBER', 'banned_ip_hashes', ipHash]];
    if (session) checks.push(['SISMEMBER', 'banned_discord_ids', session.id]);

    const results = await redisPipeline(checks);
    return results.some((r) => r === 1);
}

function matches(item, ipHash, discordId) {
    return (ipHash && item.ipHash === ipHash) || (discordId && item.discordId === discordId);
}

// Bans the identity and removes everything they've posted. Returns what was removed.
export async function banAuthor({ ipHash, discordId }) {
    if (ipHash) await redisCommand(['SADD', 'banned_ip_hashes', ipHash]);
    if (discordId) await redisCommand(['SADD', 'banned_discord_ids', discordId]);

    // Their guestbook notes (+ reactions on them)
    const flat = await redisCommand(['HGETALL', 'guestbook_entries']);
    const noteIds = [];
    if (Array.isArray(flat)) {
        for (let i = 0; i < flat.length; i += 2) {
            try {
                if (matches(JSON.parse(flat[i + 1]), ipHash, discordId)) noteIds.push(flat[i]);
            } catch {}
        }
    }
    if (noteIds.length) {
        await redisPipeline([
            ['HDEL', 'guestbook_entries', ...noteIds],
            ['ZREM', 'guestbook_wall_index', ...noteIds],
            ...noteIds.map((id) => ['DEL', `guestbook_reactors:${id}`]),
            ['INCR', 'guestbook_version']
        ]);
    }

    // Their song requests
    const songs = await redisCommand(['LRANGE', 'song_requests', '0', '-1']);
    const songRaws = [];
    if (Array.isArray(songs)) {
        for (const raw of songs) {
            try {
                if (matches(JSON.parse(raw), ipHash, discordId)) songRaws.push(raw);
            } catch {}
        }
    }
    if (songRaws.length) {
        await redisPipeline([
            ...songRaws.map((raw) => ['LREM', 'song_requests', '0', raw]),
            ['INCR', 'song_requests_version']
        ]);
    }

    return { removedNotes: noteIds.length, removedSongs: songRaws.length };
}
