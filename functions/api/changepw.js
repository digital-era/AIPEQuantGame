// AIPEQuantGame/functions/api/changepw.js

// JWT 验证工具
async function verifyJWT(token, secret) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const encoder = new TextEncoder();
    const data = `${parts[0]}.${parts[1]}`;
    const signature = parts[2].replace(/-/g, '+').replace(/_/g, '/');
    const rawSignature = Uint8Array.from(atob(signature), c => c.charCodeAt(0));

    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    
    const isValid = await crypto.subtle.verify('HMAC', key, rawSignature, encoder.encode(data));
    if (!isValid) return null;

    const payload = JSON.parse(atob(parts[1]));
    if (Date.now() > payload.exp) return null; // 验证过期时间
    
    return payload;
}

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
        }

        const token = authHeader.split(' ')[1];
        const decoded = await verifyJWT(token, env.JWT_SECRET);
        
        if (!decoded) {
            return new Response(JSON.stringify({ error: "Invalid or expired token" }), { status: 401 });
        }

        const { oldPassword, newPassword } = await request.json();
        const storedPassword = await env.aipeusers.get(decoded.user);

        if (storedPassword !== oldPassword) {
            return new Response(JSON.stringify({ error: "Old password incorrect" }), { status: 403 });
        }

        // 更新 KV 中的密码
        await env.aipeusers.put(decoded.user, newPassword);
        
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (e) {
        return new Response(JSON.stringify({ error: "Server error" }), { status: 500 });
    }
}
