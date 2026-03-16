// AIPEQuantGame/functions/api/login.js

// 简单的 JWT 签名工具 (基于 Cloudflare 原生 Web Crypto API)
async function signJWT(payload, secret) {
    const encoder = new TextEncoder();
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
    const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, '');
    const data = `${header}.${encodedPayload}`;
    
    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
    const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        
    return `${data}.${encodedSignature}`;
}

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const { username, password } = await request.json();
        if (!username || !password) {
            return new Response(JSON.stringify({ error: "Missing credentials" }), { status: 400 });
        }

        // 从 Cloudflare KV 中读取密码
        const storedPassword = await env.USERS_KV.get(username);

        if (storedPassword && storedPassword === password) {
            // 签发真实 JWT，有效期 2 小时
            const token = await signJWT(
                { user: username, exp: Date.now() + 2 * 60 * 60 * 1000 }, 
                env.JWT_SECRET
            );
            return new Response(JSON.stringify({ success: true, token }), { status: 200 });
        } else {
            return new Response(JSON.stringify({ error: "Invalid username or password" }), { status: 401 });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: "Server error" }), { status: 500 });
    }
}
