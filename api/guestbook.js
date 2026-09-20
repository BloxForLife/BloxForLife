import crypto from 'crypto';
import { readSession, OWNER_DISCORD_ID } from './_session.js';

const GUESTBOOK_ENABLED = true;

// Manual blocklist — add a HASHED IP here to instantly reject them.
// (Get the hash from the "IP hash" field in the Discord embed on any note they've left.)
const BLOCKED_IP_HASHES = [
    // "a1b2c3d4e5f6a7b8",
];

const RATE_LIMIT_SECONDS = 12 * 60 * 60; // 12 hours
const IP_HASH_SALT = process.env.IP_HASH_SALT || 'bloxforlife-default-salt';
const WALL_MAX_ENTRIES = 50; // how many recent notes the public wall keeps

function hashIp(ip) {
    return crypto.createHash('sha256').update(IP_HASH_SALT + ip).digest('hex').slice(0, 16);
}

function hashToken(token) {
    return crypto.createHash('sha256').update(IP_HASH_SALT + token).digest('hex');
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.headers['x-real-ip'] || 'unknown';
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

// Atomic "set only if not already set" against Upstash Redis via its REST API.
async function checkAndSetRateLimit(ipHash) {
    if (!redisConfigured()) {
        return { allowed: true, configured: false };
    }
    const result = await redisCommand(['SET', `guestbook_rl:${ipHash}`, '1', 'EX', String(RATE_LIMIT_SECONDS), 'NX']);
    return { allowed: result === 'OK', configured: true };
}

// Drops the oldest entries once the wall grows past WALL_MAX_ENTRIES.
async function trimWall() {
    const count = await redisCommand(['ZCARD', 'guestbook_wall_index']);
    if (!count || count <= WALL_MAX_ENTRIES) return;

    const excess = count - WALL_MAX_ENTRIES;
    const popped = await redisCommand(['ZPOPMIN', 'guestbook_wall_index', String(excess)]);
    if (!Array.isArray(popped) || !popped.length) return;

    const ids = [];
    for (let i = 0; i < popped.length; i += 2) ids.push(popped[i]);
    if (ids.length) await redisCommand(['HDEL', 'guestbook_entries', ...ids]);
}

// Stores the note keyed by a fresh id (guestbook_entries hash) plus its position
// on the wall (guestbook_wall_index sorted set, scored by time). Returns an
// edit token whose hash is stored alongside the note — a fallback way for an
// anonymous submitter to prove ownership later. A logged-in submitter's
// Discord id is stored too, which works as ownership proof across browsers.
async function createEntry(name, message, discordUser) {
    if (!redisConfigured()) return null;

    const id = crypto.randomUUID();
    const editToken = crypto.randomBytes(24).toString('hex');
    const ts = Date.now();

    const entry = JSON.stringify({
        name,
        message,
        ts,
        editTokenHash: hashToken(editToken),
        discordId: discordUser?.id || null,
        discordName: discordUser?.name || null,
        discordAvatar: discordUser?.avatar || null
    });
    await redisCommand(['HSET', 'guestbook_entries', id, entry]);
    await redisCommand(['ZADD', 'guestbook_wall_index', String(ts), id]);
    await trimWall();
    await redisCommand(['INCR', 'guestbook_version']);

    return { id, editToken };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!GUESTBOOK_ENABLED) {
        return res.status(503).json({ error: 'Guestbook is temporarily closed' });
    }

    const { name, message } = req.body || {};

    if (!name || !message || typeof name !== 'string' || typeof message !== 'string') {
        return res.status(400).json({ error: 'Missing name or message' });
    }
    if (name.length > 40 || message.length > 300) {
        return res.status(400).json({ error: 'Too long' });
    }

    const ipHash = hashIp(getClientIp(req));

    if (BLOCKED_IP_HASHES.includes(ipHash)) {
        return res.status(403).json({ error: 'Blocked' });
    }

    const discordUser = readSession(req);
    const isOwner = discordUser?.id === OWNER_DISCORD_ID;

    if (!isOwner) {
        const { allowed } = await checkAndSetRateLimit(ipHash);
        if (!allowed) {
            return res.status(429).json({ error: 'You can sign the guestbook again in a bit' });
        }
    }

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
        return res.status(500).json({ error: 'Webhook not configured' });
    }

    try {
        const discordRes = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: 'New guestbook entry on bloxforlife.com',
                    fields: [
                        { name: 'From', value: name },
                        { name: 'Message', value: message },
                        { name: 'IP hash', value: ipHash, inline: true },
                        { name: 'Discord', value: discordUser ? `${discordUser.name} (${discordUser.id})` : 'Not logged in', inline: true }
                    ],
                    color: 13091926
                }]
            })
        });

        if (!discordRes.ok) {
            return res.status(502).json({ error: 'Discord rejected the message' });
        }

        const created = await createEntry(name, message, discordUser);

        return res.status(200).json({ ok: true, id: created?.id ?? null, editToken: created?.editToken ?? null });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to send' });
    }
}
