import { createSessionCookie, clearStateCookie, readState, safeEqual } from './_session.js';

function defaultAvatar(userId) {
    const index = Number((BigInt(userId) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { code, state, error } = req.query || {};
    const expectedState = readState(req);

    if (error || !code || !state || !expectedState || !safeEqual(state, expectedState)) {
        res.setHeader('Set-Cookie', clearStateCookie());
        res.writeHead(302, { Location: '/?discord_error=1' });
        return res.end();
    }

    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const redirectUri = process.env.DISCORD_REDIRECT_URI;

    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri
            })
        });
        if (!tokenRes.ok) throw new Error('token exchange failed');
        const tokenData = await tokenRes.json();

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        if (!userRes.ok) throw new Error('user fetch failed');
        const user = await userRes.json();

        const avatar = user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=64`
            : defaultAvatar(user.id);

        const session = { id: user.id, name: user.global_name || user.username, avatar };

        res.setHeader('Set-Cookie', [clearStateCookie(), createSessionCookie(session)]);
        res.writeHead(302, { Location: '/' });
        res.end();
    } catch (err) {
        res.setHeader('Set-Cookie', clearStateCookie());
        res.writeHead(302, { Location: '/?discord_error=1' });
        res.end();
    }
}
