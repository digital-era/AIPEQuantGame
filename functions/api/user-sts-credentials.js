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
      const { request } = context;

      // --- 修改开始：从请求体中解析参数，而不是从 env 获取 ---
      let body = {};
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          },
        });
      }

      // 从解析后的 body 中解构所需的变量
      const { 
        OSS_ACCESS_KEY_ID, 
        OSS_ACCESS_KEY_SECRET, 
        OSS_STS_ROLE_ARN, 
        OSS_REGION 
      } = body;
      // --- 修改结束 ---
      
      if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET || !OSS_STS_ROLE_ARN || !OSS_REGION) {
        return new Response(JSON.stringify({ error: '请求参数不完整，请提供: OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_STS_ROLE_ARN, OSS_REGION' }), {
          status: 400, // 参数错误通常返回 400
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders // 添加 CORS 头
          },
        });
      }
      
      // ... 签名逻辑保持不变 ...
      const params = {
        AccessKeyId: OSS_ACCESS_KEY_ID,
        Action: 'AssumeRole',
        DurationSeconds: 3600,
        Format: 'JSON',
        RegionId: OSS_REGION,
        RoleArn: OSS_STS_ROLE_ARN,
        RoleSessionName: 'cf-worker-' + Date.now(),
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
  
      const method = 'GET';
      const stringToSign = `${method}&${aliyunPercentEncode('/')}&${aliyunPercentEncode(canonicalizedQueryString)}`;
      
      const signature = await hmacSha1(stringToSign, `${OSS_ACCESS_KEY_SECRET}&`);
      
      params.Signature = signature;
  
      const queryStringWithSignature = Object.keys(params)
        .sort()
        .map(key => `${aliyunPercentEncode(key)}=${aliyunPercentEncode(params[key])}`)
        .join('&');
        
      const endpoint = `https://sts.${OSS_REGION}.aliyuncs.com`;
      const url = `${endpoint}/?${queryStringWithSignature}`;
  
      const response = await fetch(url, { method: 'GET' });
      const responseText = await response.text();
      
      console.log(`STS响应: ${response.status} - ${responseText.substring(0, 100)}`);
      
      if (!response.ok) {
        throw new Error(`阿里云STS错误: ${response.status} ${response.statusText}`);
      }
      
      const result = JSON.parse(responseText);
      
      if (result.Credentials) {
        // 成功响应：务必添加 CORS 头
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
            ...corsHeaders // 关键：在这里解构并添加 CORS 头
          }
        });
      } else if (result.Code) {
        throw new Error(`${result.Code}: ${result.Message}`);
      } else {
        throw new Error('无效的STS响应');
      }
    } catch (error) {
      console.error('STS请求失败:', error);
      // 错误响应：也需要添加 CORS 头，否则前端拿不到具体的报错信息
      return new Response(JSON.stringify({
        error: `获取STS凭证失败: ${error.message}`
      }), {
        status: 500,
        headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders // 关键：错误时也要允许跨域
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
