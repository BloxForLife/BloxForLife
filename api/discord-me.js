import { readSession, OWNER_DISCORD_ID } from './_session.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const session = readSession(req);
    if (!session) {
        return res.status(200).json({ loggedIn: false });
    }

    return res.status(200).json({
        loggedIn: true,
        id: session.id,
        name: session.name,
        avatar: session.avatar,
        isOwner: session.id === OWNER_DISCORD_ID
    });
}
