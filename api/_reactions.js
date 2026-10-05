// Shared guestbook-reaction logic. Not a route (underscore prefix).
import { readSession } from './_session.js';
import { getClientIp, hashIp } from './_ip.js';

export const REACTION_EMOJIS = ['❤️', '🔥', '💀'];

export function reactionsKey(noteId) {
    return `guestbook_reactors:${noteId}`;
}

// Who is reacting: Discord id when logged in, otherwise the hashed IP. Good
// enough to stop casual double-tapping without needing accounts.
export function reactorKey(req) {
    const session = readSession(req);
    return session ? `d:${session.id}` : `ip:${hashIp(getClientIp(req))}`;
}

// Reactions live in one hash per note: field = reactor key, value = JSON array
// of emojis they've used. Counts are derived from that, so nothing can drift.
// `flat` is HGETALL's [field, value, field, value, ...] shape.
export function summarizeReactions(flat, viewerKey) {
    const counts = Object.fromEntries(REACTION_EMOJIS.map((e) => [e, 0]));
    let mine = [];
    if (Array.isArray(flat)) {
        for (let i = 0; i < flat.length; i += 2) {
            let emojis = [];
            try { emojis = JSON.parse(flat[i + 1]); } catch {}
            if (!Array.isArray(emojis)) continue;
            for (const e of emojis) if (e in counts) counts[e] += 1;
            if (flat[i] === viewerKey) mine = emojis.filter((e) => e in counts);
        }
    }
    return { counts, mine };
}
