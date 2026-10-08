// One function for the whole Discord login flow:
//   /api/discord/login     -> redirect to Discord's consent screen
//   /api/discord/callback  -> exchange the code, set the session cookie
//   /api/discord/logout    -> clear the session cookie
//   /api/discord/me        -> who the current cookie says you are
// (/api/discord-callback still works via a rewrite in vercel.json, since
// that's the redirect URI registered with Discord.)
import crypto from 'crypto';
import {
    createStateCookie, clearStateCookie, readState,
    createSessionCookie, clearSessionCookie, readSession,
    safeEqual, OWNER_DISCORD_ID
} from '../_session.js';

function redirect(res, location) {
    res.writeHead(302, { Location: location });
    res.end();
}

function login(req, res) {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const redirectUri = process.env.DISCORD_REDIRECT_URI;
    if (!clientId || !redirectUri) {
        return res.status(500).send('Discord login is not configured yet.');
    }

    const state = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', createStateCookie(state));

    const authorizeUrl = new URL('https://discord.com/api/oauth2/authorize');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'identify');
    authorizeUrl.searchParams.set('state', state);
    redirect(res, authorizeUrl.toString());
}

function defaultAvatar(userId) {
    const index = Number((BigInt(userId) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

async function callback(req, res) {
    const { code, state, error } = req.query || {};
    const expectedState = readState(req);

    if (error || !code || !state || !expectedState || !safeEqual(state, expectedState)) {
        res.setHeader('Set-Cookie', clearStateCookie());
        return redirect(res, '/?discord_error=1');
    }

    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.DISCORD_REDIRECT_URI
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

        res.setHeader('Set-Cookie', [
            clearStateCookie(),
            createSessionCookie({ id: user.id, name: user.global_name || user.username, avatar })
        ]);
        redirect(res, '/');
    } catch {
        res.setHeader('Set-Cookie', clearStateCookie());
        redirect(res, '/?discord_error=1');
    }
}

function logout(req, res) {
    res.setHeader('Set-Cookie', clearSessionCookie());
    redirect(res, '/');
}

function me(req, res) {
    const session = readSession(req);
    if (!session) return res.status(200).json({ loggedIn: false });
    return res.status(200).json({
        loggedIn: true,
        id: session.id,
        name: session.name,
        avatar: session.avatar,
        isOwner: session.id === OWNER_DISCORD_ID
    });
}

// Public profile (badges, bio, pronouns) via dcdn.dstn.to — a public mirror of
// Discord's /users/:id/profile that needs no token. Proxied here so the page
// isn't at the mercy of that service's CORS, and edge-cached for 5 minutes.
async function profile(req, res) {
    let upstream;
    try {
        upstream = await fetch(`https://dcdn.dstn.to/profile/${OWNER_DISCORD_ID}`, {
            headers: { Accept: 'application/json', 'User-Agent': 'bloxfor.life (+https://bloxfor.life)' }
        });
    } catch (err) {
        return res.status(200).json({ badges: [], error: `upstream unreachable: ${err.message}` });
    }
    if (!upstream.ok) {
        return res.status(200).json({ badges: [], error: `upstream ${upstream.status}` });
    }

    const data = await upstream.json().catch(() => null);
    const badges = Array.isArray(data?.badges)
        ? data.badges
            // legacy_username's hover text is the old username — not for the site
            .filter((b) => b && b.icon && b.id !== 'legacy_username')
            .map((b) => ({
                id: b.id,
                description: b.description || b.id,
                icon: `https://cdn.discordapp.com/badge-icons/${b.icon}.png`
            }))
        : [];

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
        badges,
        bio: data?.user_profile?.bio || data?.user?.bio || null,
        pronouns: data?.user_profile?.pronouns || null
    });
}

const actions = { login, callback, logout, me, profile };

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    const action = actions[req.query?.action];
    if (!action) {
        return res.status(404).json({ error: 'Unknown action' });
    }
    return action(req, res);
}
