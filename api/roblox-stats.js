const ROBLOX_USER_ID = '4548670369';

const PRESENCE_LABELS = { 0: 'Offline', 1: 'Online', 2: 'In a game', 3: 'In Roblox Studio' };

// Roblox's APIs are behind bot protection that can reject requests with no
// browser-like User-Agent (common from plain server-to-server fetches), so we
// always send one. Returns status/error alongside the body so failures are
// visible in the response instead of silently becoming "null".
async function safeJson(url, options) {
    try {
        const res = await fetch(url, {
            ...options,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                Accept: 'application/json',
                ...(options?.headers || {})
            }
        });
        const body = await res.json().catch(() => null);
        return { ok: res.ok, status: res.status, body };
    } catch (err) {
        return { ok: false, status: 0, body: null, error: String(err) };
    }
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const [user, avatar, friendCount, followerCount, presence, badges] = await Promise.all([
        safeJson(`https://users.roblox.com/v1/users/${ROBLOX_USER_ID}`),
        safeJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ROBLOX_USER_ID}&size=150x150&format=Png&isCircular=true`),
        safeJson(`https://friends.roblox.com/v1/users/${ROBLOX_USER_ID}/friends/count`),
        safeJson(`https://friends.roblox.com/v1/users/${ROBLOX_USER_ID}/followers/count`),
        safeJson('https://presence.roblox.com/v1/presence/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userIds: [Number(ROBLOX_USER_ID)] })
        }),
        safeJson(`https://accountinformation.roblox.com/v1/users/${ROBLOX_USER_ID}/roblox-badges`)
    ]);

    if (!user.ok) {
        return res.status(502).json({ error: 'Could not reach Roblox', debug: { user } });
    }

    const presenceType = presence.body?.userPresences?.[0]?.userPresenceType ?? 0;

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');

    return res.status(200).json({
        name: user.body.name,
        displayName: user.body.displayName || user.body.name,
        joinedYear: user.body.created ? new Date(user.body.created).getFullYear() : null,
        avatar: avatar.body?.data?.[0]?.imageUrl || null,
        friends: typeof friendCount.body?.count === 'number' ? friendCount.body.count : null,
        followers: typeof followerCount.body?.count === 'number' ? followerCount.body.count : null,
        presence: PRESENCE_LABELS[presenceType] || 'Offline',
        online: presenceType !== 0,
        badges: Array.isArray(badges.body)
            ? badges.body.map((b) => ({ name: b.name, description: b.description, imageUrl: b.imageUrl }))
            : [],
        // Remove once avatar/badges are confirmed working — shows what each
        // Roblox endpoint actually returned so failures aren't silent.
        _debug: {
            avatar: { ok: avatar.ok, status: avatar.status, error: avatar.error },
            badges: { ok: badges.ok, status: badges.status, error: badges.error }
        }
    });
}
