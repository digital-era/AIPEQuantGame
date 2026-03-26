// AIPEQuantGame/functions/api/changepw.js

const encoder = new TextEncoder();

function buf2hex(buffer) {
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hex2buf(hex) {
    const bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    return bytes;
}

function isHashedFormat(str) {
    return /^[0-9a-f]{32}:[0-9a-f]{64}$/i.test(str);
}

// 1万次迭代
async function hashPassword(password, saltHex = null) {
    let salt = saltHex ? hex2buf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey(
        "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const derivedBits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: salt, iterations: 10000, hash: "SHA-256" },
        keyMaterial, 256
    );
    return `${buf2hex(salt)}:${buf2hex(derivedBits)}`;
}

async function verifyPassword(password, storedHashString) {
    if (!isHashedFormat(storedHashString)) return false;
    const [saltHex] = storedHashString.split(':');
    const newHashString = await hashPassword(password, saltHex);
    return newHashString === storedHashString;
}

// === 原有 JWT 工具 ===
async function verifyJWT(token, secret) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const data = `${parts[0]}.${parts[1]}`;
    const signature = parts[2].replace(/-/g, '+').replace(/_/g, '/');
    const rawSignature = Uint8Array.from(atob(signature), c => c.charCodeAt(0));

    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    
    const isValid = await crypto.subtle.verify('HMAC', key, rawSignature, encoder.encode(data));
    if (!isValid) return null;

    const payload = JSON.parse(atob(parts[1]));
    if (Date.now() > payload.exp) return null; 
    
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
        
        // 获取当前密码
        const storedPassword = await env.aipeusers.get(decoded.user);
        
        // 【防御性编程】万一用户在 KV 里被删了，但拿着没过期的 Token 请求，拦截它
        if (!storedPassword) {
            return new Response(JSON.stringify({ error: "User not found" }), { status: 403 });
        }

        // 兼容验证旧密码是否正确
        let isOldPasswordValid = false;
        if (isHashedFormat(storedPassword)) {
            isOldPasswordValid = await verifyPassword(oldPassword, storedPassword);
        } else {
            // 如果KV里还是明文
            if (storedPassword === oldPassword) isOldPasswordValid = true;
        }

        if (!isOldPasswordValid) {
            return new Response(JSON.stringify({ error: "Old password incorrect" }), { status: 403 });
        }

        // 验证通过，对【新密码】进行加密哈希
        const newHashedPassword = await hashPassword(newPassword);

        // 【核心修改】将新的密文存入 KV (即使旧密码是明文，改密码后也会彻底变成密文)
        await env.aipeusers.put(decoded.user, newHashedPassword);
        
        // 【保留原逻辑】原样返回成功状态
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (e) {
        console.error(e);
        return new Response(JSON.stringify({ error: "Server error" }), { status: 500 });
    }
}
