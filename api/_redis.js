// Shared Upstash Redis REST helpers. Not a route (underscore prefix).
function creds() {
    return {
        url: (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, ''),
        token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
    };
}

export function redisConfigured() {
    const { url, token } = creds();
    return !!(url && token);
}

export async function redisCommand(command) {
    const { url, token } = creds();
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command)
    });
    const data = await res.json();
    return data.result;
}

// Several commands in one round trip. Returns an array of results in order.
export async function redisPipeline(commands) {
    if (!commands.length) return [];
    const { url, token } = creds();
    const res = await fetch(`${url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands)
    });
    const data = await res.json();
    return Array.isArray(data) ? data.map((d) => d.result) : [];
}
