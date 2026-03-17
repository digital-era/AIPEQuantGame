// functions/api/user-sts-credentials.js

// 定义通用的 CORS 响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // 允许所有域名访问，或者你可以指定 'https://digital-era.github.io'
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400', // 预检请求缓存时间
};

// 1. 新增：处理 OPTIONS 预检请求
export async function onRequestOptions() {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}

// 2. 修改：POST 请求处理
export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    // =============================
    // 1️⃣ 解析 JWT（识别用户身份）
    // =============================
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      return new Response(JSON.stringify({ error: '未授权：缺少Token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    function parseJWT(token) {
      try {
        const base64Payload = token.split('.')[1];
        return JSON.parse(atob(base64Payload));
      } catch {
        return null;
      }
    }

    const decoded = parseJWT(token);

    if (!decoded) {
      return new Response(JSON.stringify({ error: '无效Token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const username = decoded.user;
    const isAdmin = username === 'admin';

    // =============================
    // 2️⃣ 解析请求体
    // =============================
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // =============================
    // 3️⃣ 凭证来源分流（核心）
    // =============================
    let OSS_ACCESS_KEY_ID;
    let OSS_ACCESS_KEY_SECRET;
    let OSS_STS_ROLE_ARN;
    let OSS_REGION;

    if (isAdmin) {
      // ✅ 管理员：使用前端传入
      ({
        OSS_ACCESS_KEY_ID,
        OSS_ACCESS_KEY_SECRET,
        OSS_STS_ROLE_ARN,
        OSS_REGION
      } = body);
    } else {
      // ✅ 普通用户：使用 Cloudflare env（关键修复）
      OSS_ACCESS_KEY_ID     = env["OSS_CONFIG.ACCESS_KEY_ID"];
      OSS_ACCESS_KEY_SECRET = env["OSS_CONFIG.ACCESS_KEY_SECRET"];
      OSS_STS_ROLE_ARN      = env["OSS_CONFIG.STS_ROLE_ARN"];
      OSS_REGION            = env["OSS_CONFIG.OSS_REGION"];
    }

    // =============================
    // 4️⃣ 参数校验
    // =============================
    if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET || !OSS_STS_ROLE_ARN || !OSS_REGION) {
      return new Response(JSON.stringify({
        error: isAdmin
          ? '管理员参数不完整'
          : '服务器端OSS配置缺失(env.OSS_CONFIG)'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // =============================
    // 5️⃣ 构造 STS 请求参数
    // =============================
    const params = {
      AccessKeyId: OSS_ACCESS_KEY_ID,
      Action: 'AssumeRole',
      DurationSeconds: 3600,
      Format: 'JSON',
      RegionId: OSS_REGION,
      RoleArn: OSS_STS_ROLE_ARN,
      RoleSessionName: `${username}-cf-${Date.now()}`, // ✅ 带用户名
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: Date.now() + Math.random().toString(36).substring(2, 8),
      SignatureVersion: '1.0',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z/, 'Z'),
      Version: '2015-04-01'
    };

    const canonicalizedQueryString = Object.keys(params)
      .sort()
      .map(key => `${aliyunPercentEncode(key)}=${aliyunPercentEncode(params[key])}`)
      .join('&');

    const stringToSign = `GET&${aliyunPercentEncode('/')}&${aliyunPercentEncode(canonicalizedQueryString)}`;

    const signature = await hmacSha1(stringToSign, `${OSS_ACCESS_KEY_SECRET}&`);
    params.Signature = signature;

    const queryStringWithSignature = Object.keys(params)
      .sort()
      .map(key => `${aliyunPercentEncode(key)}=${aliyunPercentEncode(params[key])}`)
      .join('&');

    const endpoint = `https://sts.${OSS_REGION}.aliyuncs.com`;
    const url = `${endpoint}/?${queryStringWithSignature}`;

    // =============================
    // 6️⃣ 请求阿里云 STS
    // =============================
    const response = await fetch(url, { method: 'GET' });
    const responseText = await response.text();

    console.log(`STS响应: ${response.status} - ${responseText.substring(0, 100)}`);

    if (!response.ok) {
      throw new Error(`阿里云STS错误: ${response.status} ${response.statusText}`);
    }

    const result = JSON.parse(responseText);

    // =============================
    // 7️⃣ 返回 STS 凭证
    // =============================
    if (result.Credentials) {
      return new Response(JSON.stringify({
        AccessKeyId: result.Credentials.AccessKeyId,
        AccessKeySecret: result.Credentials.AccessKeySecret,
        SecurityToken: result.Credentials.SecurityToken,
        Expiration: result.Credentials.Expiration
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, max-age=0',
          ...corsHeaders
        }
      });
    } else if (result.Code) {
      throw new Error(`${result.Code}: ${result.Message}`);
    } else {
      throw new Error('无效的STS响应');
    }

  } catch (error) {
    console.error('STS请求失败:', error);

    return new Response(JSON.stringify({
      error: `获取STS凭证失败: ${error.message}`
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}

// 辅助函数保持不变
function aliyunPercentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
    .replace(/%20/g, '+');
}

async function hmacSha1(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(message)
  );
  
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
