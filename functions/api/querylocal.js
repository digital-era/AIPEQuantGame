// querylocal.js
// Cloudflare Worker - 本地 QMT 代理（支持批量查询）

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  const QMT_BASE_URL = "https://desktop-6hirfc0.tail8fcfdf.ts.net"; // ← 你的 Tunnel 域名

  try {
    // ==============================
    // POST = 批量查询
    // ==============================
    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || !body.codes || !body.type) {
        return jsonResponse({ detail: "Missing codes or type in JSON body" }, 400);
      }

      const { codes, type } = body;

      if (codes.length > 50) {
        return jsonResponse({ detail: "Too many codes, max 50" }, 400);
      }

      if (type !== "price" && type !== "intraday") {
        return jsonResponse({ detail: "Batch only supports 'price' or 'intraday'" }, 400);
      }

      const qmt = await fetchBatchFromQMT(QMT_BASE_URL, codes, type);
      if (qmt) {
        return jsonResponse(qmt);
      }
      return jsonResponse({ detail: "Batch request failed" }, 502);
    }

    // ==============================
    // GET = 单只查询（向后兼容）
    // ==============================
    else {
      const code = url.searchParams.get("code");
      const type = url.searchParams.get("type");

      if (!code || !type) {
        return jsonResponse({ detail: "Missing code or type" }, 400);
      }

      if (type === "price" || type === "intraday") {
        const qmt = await fetchSingleFromQMT(QMT_BASE_URL, code, type);
        if (qmt) {
          return jsonResponse(qmt);
        }
        return jsonResponse({ detail: `${type} data not found for ${code}` }, 404);
      }

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
    }
  } catch (err) {
    return jsonResponse({ detail: err.message }, 500);
  }
}

// ==============================
// 批量查询 QMT
// ==============================
async function fetchBatchFromQMT(baseUrl, codes, type) {
  try {
    const res = await fetch(`${baseUrl}/api/querylocal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify({ codes, type }),
    });

    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.log("QMT batch error:", e);
    return null;
  }
}

// ==============================
// 单只查询 QMT（向后兼容）
// ==============================
async function fetchSingleFromQMT(baseUrl, code, type) {
  try {
    const url = `${baseUrl}/api/querylocal?code=${encodeURIComponent(code)}&type=${encodeURIComponent(type)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.log("QMT single error:", e);
    return null;
  }
}

// ==============================
// 统一 JSON 返回
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
