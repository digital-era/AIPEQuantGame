// querylocal.js
// Cloudflare Worker - 纯本地 QMT 代理（无 Eastmoney）

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type");

  if (!code || !type) {
    return jsonResponse({ detail: "Missing code or type" }, 400);
  }

  // ==============================
  // 配置：本地 QMT 服务公网地址（通过 Cloudflare Tunnel 暴露）
  // 示例：https://qmt-api.your-domain.com
  // ==============================
  const QMT_BASE_URL = "https://qmt-api.your-domain.com"; // ← 替换为你的 Tunnel 域名

  try {
    // ==============================
    // ✅ price
    // ==============================
    if (type === "price") {
      const qmt = await fetchFromQMT(QMT_BASE_URL, code, type);
      if (qmt) {
        return jsonResponse(qmt);
      }
      return jsonResponse(
        { detail: `Price data not found for ${code}` },
        404
      );
    }

    // ==============================
    // ✅ intraday
    // ==============================
    else if (type === "intraday") {
      const qmt = await fetchFromQMT(QMT_BASE_URL, code, type);
      if (qmt) {
        return jsonResponse(qmt);
      }
      return jsonResponse(
        { detail: `Intraday data not found for ${code}` },
        404
      );
    }

    // ==============================
    // ❌ 不支持（保持接口结构）
    // ==============================
    else if (type === "info" || type === "movingaveragedata") {
      return jsonResponse(
        { detail: `${type} not supported in Cloudflare Workers` },
        501
      );
    }

    return jsonResponse(
      {
        detail:
          "Invalid 'type' parameter. Use 'price', 'info', 'movingaveragedata', or 'intraday'.",
      },
      400
    );
  } catch (err) {
    return jsonResponse({ detail: err.message }, 500);
  }
}


// ==============================
// ✅ 访问本地 QMT 服务
// ==============================
async function fetchFromQMT(baseUrl, code, type) {
  try {
    const url = `${baseUrl}/query?code=${encodeURIComponent(code)}&type=${encodeURIComponent(type)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) return null;

    const data = await res.json();
    // QMT 服务端已保证字段格式与原始接口完全一致，直接透传
    return data;
  } catch (e) {
    console.log("QMT local service error:", e);
    return null;
  }
}


// ==============================
// ✅ 统一 JSON 返回
// ==============================
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "max-age=5, stale-while-revalidate=10",
    },
  });
}
