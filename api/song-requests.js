import crypto from 'crypto';
import { readSession, OWNER_DISCORD_ID } from './_session.js';
import { redisConfigured, redisCommand } from './_redis.js';
import { getClientIp, hashIp } from './_ip.js';

const LIST_KEY = 'song_requests';
const MAX_KEPT = 30;   // how many the list holds
const SHOW = 10;       // how many the page shows
const RATE_LIMIT_SECONDS = 60 * 60; // one request per hour per IP (owner exempt)

function publicView(item) {
    return { id: item.id, song: item.song, by: item.by, avatar: item.avatar || null, ts: item.ts };
}

async function readAll() {
    const raw = await redisCommand(['LRANGE', LIST_KEY, '0', '-1']);
    if (!Array.isArray(raw)) return [];
    return raw.map((s) => {
        try { return { raw: s, item: JSON.parse(s) }; } catch { return null; }
    }).filter(Boolean);
}

export default async function handler(req, res) {
    if (!redisConfigured()) {
        if (req.method === 'GET') return res.status(200).json({ requests: [] });
        return res.status(503).json({ error: 'Storage not configured' });
    }

    if (req.method === 'GET') {
        const all = await readAll();
        return res.status(200).json({ requests: all.slice(0, SHOW).map(({ item }) => publicView(item)) });
    }

    const session = readSession(req);
    const isOwner = !!(session && session.id === OWNER_DISCORD_ID);

    if (req.method === 'DELETE') {
        if (!isOwner) return res.status(403).json({ error: 'Owner only' });
        const id = req.query?.id;
        if (!id) return res.status(400).json({ error: 'Missing id' });
        const match = (await readAll()).find(({ item }) => item.id === id);
        if (!match) return res.status(404).json({ error: 'Not found' });
        await redisCommand(['LREM', LIST_KEY, '0', match.raw]);
        await redisCommand(['INCR', 'song_requests_version']);
        return res.status(200).json({ ok: true });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const song = typeof req.body?.song === 'string' ? req.body.song.trim() : '';
    if (!song) return res.status(400).json({ error: 'Missing song' });
    if (song.length > 100) return res.status(400).json({ error: 'Too long' });

    const ipHash = hashIp(getClientIp(req));
    if (!isOwner) {
        const ok = await redisCommand(['SET', `songreq_rl:${ipHash}`, '1', 'EX', String(RATE_LIMIT_SECONDS), 'NX']);
        if (ok !== 'OK') return res.status(429).json({ error: 'One request an hour — try again later' });
    }

    const item = {
        id: crypto.randomUUID(),
        song,
        by: session ? session.name : 'a visitor',
        avatar: session ? session.avatar : null,
        discordId: session ? session.id : null,
        ts: Date.now()
    };

    await redisCommand(['LPUSH', LIST_KEY, JSON.stringify(item)]);
    await redisCommand(['LTRIM', LIST_KEY, '0', String(MAX_KEPT - 1)]);
    await redisCommand(['INCR', 'song_requests_version']);

    const webhookUrl = process.env.SONG_REQUEST_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    embeds: [{
                        title: 'Song request on bloxforlife.com',
                        fields: [
                            { name: 'Song', value: song },
                            { name: 'From', value: session ? `${session.name} (${session.id})` : 'Not logged in', inline: true },
                            { name: 'IP hash', value: ipHash, inline: true }
                        ],
                        color: 16711680
                    }]
                })
            });
        } catch {
            // the request is already saved; a webhook hiccup shouldn't fail it
        }
    }

    return res.status(200).json({ ok: true, request: publicView(item) });
}
