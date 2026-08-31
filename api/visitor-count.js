export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
        return res.status(200).json({ count: null });
    }

    try {
        const redisRes = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(['GET', 'total_unique_visits'])
        });
        const data = await redisRes.json();
        const count = data.result ? parseInt(data.result, 10) : 0;
        return res.status(200).json({ count });
    } catch (err) {
        return res.status(200).json({ count: null });
    }
}