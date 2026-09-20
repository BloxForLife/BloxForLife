import { clearSessionCookie } from './_session.js';

export default async function handler(req, res) {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.writeHead(302, { Location: '/' });
    res.end();
}
