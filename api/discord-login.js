import crypto from 'crypto';
import { createStateCookie } from './_session.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

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

    res.writeHead(302, { Location: authorizeUrl.toString() });
    res.end();
}
