export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { name, message } = req.body || {};

    if (!name || !message || typeof name !== 'string' || typeof message !== 'string') {
        return res.status(400).json({ error: 'Missing name or message' });
    }
    if (name.length > 40 || message.length > 300) {
        return res.status(400).json({ error: 'Too long' });
    }

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
        return res.status(500).json({ error: 'Webhook not configured' });
    }

    try {
        const discordRes = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: 'New note on bloxforlife.com',
                    fields: [
                        { name: 'From', value: name },
                        { name: 'Message', value: message }
                    ],
                    color: 13091926
                }]
            })
        });

        if (!discordRes.ok) {
            return res.status(502).json({ error: 'Discord rejected the message' });
        }

        return res.status(200).json({ ok: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to send' });
    }
}