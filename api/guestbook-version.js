import { redisConfigured, redisCommand } from './_redis.js';

// Cheap single-command endpoint the client polls frequently to know whether
// to bother re-fetching the heavier lists. `version` is bumped by guestbook
// create/edit/delete/react; `songs` by song-request create/delete.
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!redisConfigured()) {
        return res.status(200).json({ version: 0, songs: 0 });
    }

    try {
        const [guestbook, songs] = await redisCommand(['MGET', 'guestbook_version', 'song_requests_version']);
        return res.status(200).json({
            version: guestbook ? parseInt(guestbook, 10) : 0,
            songs: songs ? parseInt(songs, 10) : 0
        });
    } catch (err) {
        return res.status(200).json({ version: 0, songs: 0 });
    }
}
