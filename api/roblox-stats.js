const ROBLOX_USER_ID = '4548670369';

const PRESENCE_LABELS = { 0: 'Offline', 1: 'Online', 2: 'In a game', 3: 'In Roblox Studio' };

async function safeJson(url, options) {
    try {
        const res = await fetch(url, options);
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
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

    if (!user) {
        return res.status(502).json({ error: 'Could not reach Roblox' });
    }

    const presenceType = presence?.userPresences?.[0]?.userPresenceType ?? 0;

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');

    return res.status(200).json({
        name: user.name,
        displayName: user.displayName || user.name,
        joinedYear: user.created ? new Date(user.created).getFullYear() : null,
        avatar: avatar?.data?.[0]?.imageUrl || null,
        friends: typeof friendCount?.count === 'number' ? friendCount.count : null,
        followers: typeof followerCount?.count === 'number' ? followerCount.count : null,
        presence: PRESENCE_LABELS[presenceType] || 'Offline',
        online: presenceType !== 0,
        badges: Array.isArray(badges)
            ? badges.map((b) => ({ name: b.name, description: b.description, imageUrl: b.imageUrl }))
            : []
    });
}
