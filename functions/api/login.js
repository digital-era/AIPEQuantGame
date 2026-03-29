// AIPEQuantGame/functions/api/login.js

const encoder = new TextEncoder();

function buf2hex(buffer) {
    return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function hex2buf(hex) {
    const bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    return bytes;
}

// 严格判断字符串是否为我们生成的标准密文格式 (32位Hex + : + 64位Hex)
function isHashedFormat(str) {
    return /^[0-9a-f]{32}:[0-9a-f]{64}$/i.test(str);
}

// 核心：PBKDF2 加盐哈希 (1万次迭代，适配 Cloudflare 免费版)
async function hashPassword(password, saltHex = null) {
    let salt = saltHex ? hex2buf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey(
        "raw", encoder.encode(password), "PBKDF2", false,["deriveBits"]
    );
    const derivedBits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: salt, iterations: 10000, hash: "SHA-256" },
        keyMaterial, 256
    );
    return `${buf2hex(salt)}:${buf2hex(derivedBits)}`;
}

// 核心：验证密文密码
async function verifyPassword(password, storedHashString) {
    if (!isHashedFormat(storedHashString)) return false;
    const [saltHex] = storedHashString.split(':');
    const newHashString = await hashPassword(password, saltHex);
    return newHashString === storedHashString;
}

// === 原有 JWT 工具 ===
async function signJWT(payload, secret) {
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

        const storedPassword = await env.aipeusers.get(username);
        if (!storedPassword) {
            return new Response(JSON.stringify({ error: "Invalid username or password" }), { status: 401 });
        }        

        let isPasswordValid = false;
        let needsUpgrade = false;

        // 【核心向下兼容逻辑】判断 KV 里存的是密文还是旧版明文
        if (isHashedFormat(storedPassword)) {
            // 是密文：走哈希校验
            isPasswordValid = await verifyPassword(password, storedPassword);
        } else {
            // 是明文：走原版直接字符串比对
            if (storedPassword === password) {
                isPasswordValid = true;
                needsUpgrade = true; // 标记：比对成功，稍后需自动升级为密文
            }
        }

        if (isPasswordValid) {
            // 【新增条件逻辑】校验 USER_TYPE 前缀或 admin
            // 注意: 加入 !env.USER_TYPE 是为了防御性编程，防止环境变量未配置时引发 startsWith 报错
            if (username !== "admin"  && (!env.USER_TYPE || !username.startsWith(env.USER_TYPE)) && (!env.VIP_USER_TYPE || !username.startsWith(env.VIP_USER_TYPE)) && (!env.VVIP_USER_TYPE || !username.startsWith(env.VVIP_USER_TYPE))) {
                return new Response(JSON.stringify({ error: "Invalid username or password" }), { status: 401 });
            }

            // 【无缝升级】如果当前存的是明文，自动替换为密文存入 KV
            if (needsUpgrade) {
                const newHashedPassword = await hashPassword(password);
                await env.aipeusers.put(username, newHashedPassword);
            }

            // 【保留原逻辑】签发 JWT
            const token = await signJWT(
                { user: username, exp: Date.now() + 2 * 60 * 60 * 1000 }, 
                env.JWT_SECRET
            );
            
            // 只有身份校验和前缀校验全通过，才返回成功
            return new Response(JSON.stringify({ success: true, token }), { status: 200 });
        } else {
            return new Response(JSON.stringify({ error: "Invalid username or password" }), { status: 401 });
        }
    } catch (e) {
        console.error(e);
        return new Response(JSON.stringify({ error: "Server error" }), { status: 500 });
    }
}
