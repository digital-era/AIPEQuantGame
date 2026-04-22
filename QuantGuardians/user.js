// 定义全局变量
let gmarketdate = null;
let globalMarketMap =  {};

// ==========================================
// UI 逻辑：Settings Tab 切换
// ==========================================
function switchSettingsTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById('tab-' + tabName).classList.add('active');
    
    if(tabName === 'user') checkAuthStatus();
    document.getElementById('auth-status-msg').innerText = ''; // 切换时清空消息
}

function openSettingsAndCheckAuth() {
    if(typeof openSettings === 'function') openSettings(); // 调用你外部JS的函数展示窗口
    else document.getElementById('settingsModal').style.display = 'flex'; // 降级方案
    checkAuthStatus(); // 更新面板状态
}

// ==========================================
// 操作权限拦截检查机制 (新增)
// ==========================================
function checkActionAuth(actionName) {
    const token = localStorage.getItem('qgr_jwt_token');
    let isLoggedIn = false;
    let username = '';

    if (token) {
        const decoded = parseJWTClientSide(token);
        if (decoded) {
            isLoggedIn = true;
            username = decoded.user || 'UNKNOWN';
        }
    }

    const logBox = document.getElementById('systemLog');
    if (!isLoggedIn) {
        // 如果未登录，在日志框输出红色报错信息并直接返回 false
        if (logBox) {
            const line = document.createElement('div');
            line.className = 'log-line';
            line.style.color = '#EF4444'; 
            line.innerText = `> [DENIED] 操作被拒绝: 执行 ${actionName} 前请先在 Settings 中完成登录验证。`;
            logBox.appendChild(line);
            logBox.scrollTop = logBox.scrollHeight;
        }
        return false;
    }

    // 权限验证通过，附带输出一行合法操作的提示(可选增强体验)
    if (logBox) {
        const line = document.createElement('div');
        line.className = 'log-line';
        line.style.color = '#10B981'; 
        line.innerText = `> [GRANTED] 认证用户[${username.toUpperCase()}] 正在启动 ${actionName}...`;
        logBox.appendChild(line);
        logBox.scrollTop = logBox.scrollHeight;
    }
    return true;
}

// ==========================================
// 核心逻辑：基于 Cloudflare API 的真实认证机制
// ==========================================

const b64DecodeUnicode = str => decodeURIComponent(atob(str).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));

function parseJWTClientSide(token) {
    try {
        const parts = token.split('.');
        if(parts.length !== 3) return null;
        const payload = JSON.parse(b64DecodeUnicode(parts[1]));
        if(Date.now() > payload.exp) return null; // 客户端判断是否过期
        return payload;
    } catch(e) { return null; }
}

function showAuthMsg(msg, color) {
    const box = document.getElementById('auth-status-msg');
    box.innerText = msg;
    box.style.color = color;
}

function checkAuthStatus() {
    const token = localStorage.getItem('qgr_jwt_token');
    if (token) {
        const decoded = parseJWTClientSide(token);
        if (decoded) {
            document.getElementById('loginSection').classList.add('auth-hidden');
            document.getElementById('cpwSection').classList.remove('auth-hidden');
            document.getElementById('loggedInUser').innerText = decoded.user.toUpperCase();
            return true;
        } else {
            // [修改] Token 存在但是解析失败或已过期 (被动登出)
            localStorage.removeItem('qgr_jwt_token'); 
            if (typeof ossClient !== 'undefined') ossClient = null;
            window.CURRENT_OSS_PREFIX = '';
            
            // 提示用户登录已过期，并刷新页面清空残留数据
            alert("登录已过期，请重新登录。");
            window.location.reload();
            return false;
        }
    }
    document.getElementById('loginSection').classList.remove('auth-hidden');
    document.getElementById('cpwSection').classList.add('auth-hidden');
    return false;
}

async function handleLogin() {
    const u = document.getElementById('auth_username').value.trim();
    const p = document.getElementById('auth_password').value;
    if(!u || !p) return showAuthMsg("MISSING CREDENTIALS", "#EF4444");

    showAuthMsg("AUTHENTICATING...", "#FFD700");

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            // 1. 手动重置 OSS 状态 (非常严谨)
            if (typeof ossClient !== 'undefined') ossClient = null;
            window.CURRENT_OSS_PREFIX = '';
            
            // 2. 写入新的 Token
            localStorage.setItem('qgr_jwt_token', data.token);
            
            // 3. 提示并清空密码框
            showAuthMsg("ACCESS GRANTED. RELOADING...", "#10B981");
            document.getElementById('auth_password').value = '';
            
            // 4. [推荐] 延迟 800ms 刷新页面，彻底把上个用户的日志、DOM 残留全部干掉
            setTimeout(() => {
                window.location.reload(); 
            }, 800);
            
        } else {
            showAuthMsg(data.error || "ACCESS DENIED", "#EF4444");
        }
    } catch (error) {
        showAuthMsg("NETWORK ERROR", "#EF4444");
        console.error('Login error:', error);
    }
}

function handleLogout() {
    // 1. 清除 JWT Token
    localStorage.removeItem('qgr_jwt_token');
    
    // 2. [新增] 强制清除 OSS 客户端实例，防止 STS Token 泄露或被下个登录者复用
    if (typeof ossClient !== 'undefined') {
        ossClient = null; 
    }
    
    // 3. [新增] 清除用户目录隔离前缀
    window.CURRENT_OSS_PREFIX = '';

    // 4. 更新 UI 状态
    checkAuthStatus();
    showAuthMsg("LOGGED OUT SUCCESSFULLY", "#10B981");
    log(`> [SYSTEM] 用户已登出，OSS 会话已销毁。`, '#9CA3AF');
    setTimeout(() => {
        window.location.reload(); 
    }, 500); // 半秒后刷新回到干净的初始状态
}

async function handleChangePassword() {
    const token = localStorage.getItem('qgr_jwt_token');
    const decoded = parseJWTClientSide(token);
    if(!decoded) return handleLogout();

    const oldP = document.getElementById('cpw_old').value;
    const newP = document.getElementById('cpw_new').value;
    if(!oldP || !newP) return showAuthMsg("FIELDS CANNOT BE EMPTY", "#EF4444");

    showAuthMsg("UPDATING PASSWORD...", "#FFD700");

    try {
        const response = await fetch('/api/changepw', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ oldPassword: oldP, newPassword: newP })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showAuthMsg("PASSWORD UPDATED. PLEASE RELOGIN...", "#10B981");
            
            // [新增] 密码修改成功后，强制登出并重载页面
            localStorage.removeItem('qgr_jwt_token');
            if (typeof ossClient !== 'undefined') ossClient = null;
            window.CURRENT_OSS_PREFIX = '';
            
            setTimeout(() => {
                window.location.reload();
            }, 1000); // 留1秒钟给用户看“修改成功”的提示
            
        } else {
            showAuthMsg(data.error || "UPDATE FAILED", "#EF4444");
        }
    } catch (error) {
        showAuthMsg("NETWORK ERROR", "#EF4444");
        console.error('Change password error:', error);
    }
}

// ================= initOSS LOGIC =================
async function initOSS() {
    if (ossClient) return true;

    // =============================
    // 1️⃣ 获取 Token
    // =============================
    const token = localStorage.getItem('qgr_jwt_token');
    if (!token) {
        console.error("初始化 OSS 失败：用户未登录");
        return false;
    }

    const decoded = parseJWTClientSide(token);
    if (!decoded || Date.now() > decoded.exp * 1000) {
        console.error("初始化 OSS 失败：Token无效或已过期");
        return false;
    }

    const username = decoded.user;
    const isAdmin = username === 'admin';

    // 用户目录隔离
    window.CURRENT_OSS_PREFIX = isAdmin ? '' : `${username}/`;

    // =============================
    // 2️⃣ 构造请求体（关键修复）
    // =============================
    let postBody = {};

    if (isAdmin) {
        const cfg = window.OSS_CONFIG || {};

        const getValid = v =>
            (typeof v === 'string' && v.trim()) ? v.trim() : undefined;

        postBody = {
            OSS_ACCESS_KEY_ID:     getValid(cfg.ACCESS_KEY_ID),
            OSS_ACCESS_KEY_SECRET: getValid(cfg.ACCESS_KEY_SECRET),
            OSS_STS_ROLE_ARN:      getValid(cfg.STS_ROLE_ARN),
            OSS_REGION:            getValid(cfg.OSS_REGION)
        };
    }

    // =============================
    // 3️⃣ 请求 STS
    // =============================
    const reqHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
    };

    try {
        const res = await fetch(STS_API_URL, {
            method: 'POST',
            headers: reqHeaders,
            body: JSON.stringify(postBody) // ✅ 一定要 stringify
        });

        if (!res.ok) throw new Error(`STS fetch failed: ${res.status}`);
        const data = await res.json();

        // =============================
        // 4️⃣ 初始化 OSS
        // =============================

        // ✅ region 优先用 admin 配置，否则用默认
        const region = isAdmin
            ? window.OSS_CONFIG?.OSS_REGION
            : OSS_REGION; // 👉 建议你定义全局默认

        const finalRegion = region?.startsWith('oss-')
            ? region
            : `oss-${region}`;

        const bucket = window.OSS_CONFIG?.OSS_BUCKET || OSS_BUCKET;

        ossClient = new OSS({
            region: finalRegion,
            accessKeyId: data.AccessKeyId,
            accessKeySecret: data.AccessKeySecret,
            stsToken: data.SecurityToken,
            bucket: bucket,

            refreshSTSToken: async () => {
                console.log("正在刷新 STS Token...");

                const currentToken = localStorage.getItem('qgr_jwt_token');

                const r = await fetch(STS_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${currentToken}`
                    },
                    body: JSON.stringify(postBody)
                });

                if (!r.ok) {
                    // [新增] 如果刷新 STS 失败（通常是因为 JWT 过期），直接强制退出
                    alert("会话已失效，请重新登录");
                    handleLogout(); // 调用上面写好的登出函数
                    throw new Error("Refresh token failed");
                }

                const d = await r.json();

                return {
                    accessKeyId: d.AccessKeyId,
                    accessKeySecret: d.AccessKeySecret,
                    stsToken: d.SecurityToken
                };
            }
        });

        console.log(
            `OSS 初始化成功 [${isAdmin ? '管理员' : '普通用户'} | 目录: /${window.CURRENT_OSS_PREFIX}]`
        );

        return true;

    } catch (e) {
        console.error(e);

        const logBox = document.getElementById('systemLog');
        if (logBox) {
            logBox.innerHTML += `<div class="log-line" style="color:red">> OSS Init Fail</div>`;
        }

        return false;
    }
}

// ================= 独立函数: 读取 MarketDate.json 获取最大日期 =================
async function loadMarketDate() {
    log("Loading Market Date...", "cyan"); // 参照 loadStrategies 增加一条加载提示
    // 💡 【新增修改】防御性检查：确保 ossClient 已经初始化
    if (!ossClient) {
        log("读取 MarketDate 失败: OSS Client 未初始化", "red");
        return; 
    }
    
    try {
        // 请求 MarketDate.json 文件
        const result = await ossClient.get('MarketDate.json');
        
        // 解析 content
        const jsonStr = result.content 
            ? (typeof result.content === 'string' ? result.content : new TextDecoder("utf-8").decode(result.content)) 
            : "";
        
        if (jsonStr) {
            const marketData = JSON.parse(jsonStr);
            
            if (marketData && marketData.date) {
                gmarketdate = marketData.date;
                // 成功日志替换：使用 cyan (或 green) 颜色
                log(`✅ MarketDate 加载完成，全局日期: ${gmarketdate}`, "cyan");
            } else {
                // 警告日志替换：作为错误处理，使用 red (如果你的 log 支持 yellow 也可以换成 yellow)
                log(`⚠️ MarketDate.json 异常: 未找到 'date' 字段`, "red");
            }
        }
    } catch (e) {
        // 错误日志替换：使用 red 颜色
        log(`❌ 读取 MarketDate 失败: ${e.message}`, "red");
    }
    
    try {
        // 1. 确保 OSS 连接已就绪 (复用现有的全局函数)
        if (!ossClient) {
            log("正在初始化 OSS 连接...", "#aaa");
            const success = await initOSS();
            if (!success) throw new Error("OSS 连接初始化失败，请检查网络或配置");
        }

        // 2. 加载 MarketMap.json (新增代码)
        globalMarketMap = {};
        try {
            log("正在下载全市场行情数据: MarketMap.json...", "#88f");
            const marketResult = await ossClient.get('MarketMap.json');
            
            // 处理 Buffer 转 JSON
            const contentString = new TextDecoder("utf-8").decode(marketResult.content);
            globalMarketMap = JSON.parse(contentString);
            
            log(`✅ 行情数据加载成功，涵盖 ${Object.keys(globalMarketMap).length} 个交易日`, "#0f0");
        } catch (err) {
            log("⚠️ 未找到 MarketMap.json 或解析失败，将使用交易价格近似计算。", "orange");
            console.warn(err);
            // 失败不阻断流程，仅降级为旧逻辑
            globalMarketMap = {}; 
        }

    // =========================================================================
    // 步骤 3：根据 gmarketdate 和 globalMarketMap刷新 portfolio 和 adhocObservations 的 refPrice
    // =========================================================================
    if (typeof gmarketdate !== 'undefined' && gmarketdate && Object.keys(globalMarketMap).length > 0) {
        let updateCount = 0;
        
        // 【参考代码3】：提取当天数据，并去除 "000001.SZ" 的后缀，转为 6位 纯数字代码的映射表 O(1) 查找
        const priceLookup = {};
        const todayMarket = globalMarketMap[gmarketdate] || {}; 
        
        for (const [k, v] of Object.entries(todayMarket)) {
            const cleanCode = String(k).split('.')[0].trim();
            priceLookup[cleanCode] = parseFloat(v);
        }

        // 如果当天有行情数据，才执行遍历更新
        if (Object.keys(priceLookup).length > 0) {
            // 遍历所有 guardian
            for (let key in gameState.guardians) {
                const g = gameState.guardians[key];

                // 1. 更新 g.portfolio
                if (g.portfolio && g.portfolio.length > 0) {
                    g.portfolio.forEach(item => {
                        const safeCode = String(item.code).padStart(6, '0'); // 确保6位纯数字代码
                        const targetPrice = priceLookup[safeCode]; 
                        
                        // 校验找到了价格，且不是 NaN
                        if (targetPrice !== undefined && !isNaN(targetPrice)) {
                            item.refPrice = targetPrice; 
                            updateCount++;
                        }
                    });
                }

                // 2. 更新 g.adhocObservations
                if (g.adhocObservations && g.adhocObservations.length > 0) {
                    g.adhocObservations.forEach(item => {
                        const safeCode = String(item.code).padStart(6, '0');
                        const targetPrice = priceLookup[safeCode];
                        
                        if (targetPrice !== undefined && !isNaN(targetPrice)) {
                            item.refPrice = targetPrice; 
                            updateCount++;
                        }
                    });
                }
            }
        }

        // 【关键逻辑】：只要数据有更新，只触发纯 UI 渲染，不触发网络请求！
        if (updateCount > 0) {
            log(`>> REF PRICE SYNCED FOR ${updateCount} ITEMS BASED ON DATE: ${gmarketdate}`, "#0f0");
            
            // 遍历重新计算并渲染 UI
            Object.keys(gameState.guardians).forEach(k => {
                if (typeof recalculateAndRenderGuardian === 'function') {
                    recalculateAndRenderGuardian(k);
                }
            });
        }
    }        
}

function recordFlow(key, opType, code, name, inputWeight, price) {
    const g = gameState.guardians[key];
    const totalAssets = 100000;
    let actualWeight = (opType === 'Buy') ? inputWeight * g.power : inputWeight;
    const val = totalAssets * (actualWeight / 100);
    const qty = Math.floor(val / price);
    const value = (qty * price).toFixed(2);

    // 【关键】查找并保存 refPrice
      let item = g.strategy.find(s => s.code === code) ||
                 g.portfolio.find(p => p.code === code);
      const refPrice = item ? item.refPrice : price;  // 兜底用 price

    memoryFlows.push({
        sheet: GUARDIAN_CONFIG[key].flowName,
        data: {
            "组合名称": GUARDIAN_CONFIG[key].simpleName,
            "股票代码": code,
            "股票名称": name,
            "配置比例 (%)": actualWeight.toFixed(2),
            "标的数量": qty,
            "价格": price,
            "价值": value,
            "操作类型": opType,
            "修改时间": getOpTime(true),
            // 【新增】关键字段
            "参考价格": refPrice  // 保存当时的 refPrice！
        }
    });
}

async function loadTodayFlows() {
    if (!ossClient) return;

    try {
        const result = await ossClient.get(getSecureOssPath(OSS_FILE_NAME));
        const wb = XLSX.read(result.content, { type: 'array' });
        const todayStr = getOpTime().substring(0, 8);

        if (gmarketdate && gmarketdate.split('-').join('') >= todayStr) {
            log(`[${key}] Skipped: Date ${todayStr} Outdated`, "yellow");
            return; 
        }

        memoryFlows = []; // 清空内存记录

        for (let key in GUARDIAN_CONFIG) {
            const flowSheetName = GUARDIAN_CONFIG[key].flowName;
            const sheet = wb.Sheets[flowSheetName];

            if (sheet) {
                // 【关键】使用 {defval: null} 确保缺失列返回 null 而非 undefined
                const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

                const todayRows = rows.filter(r => {
                    const rowTime = String(r["修改时间"] || "");
                    return rowTime.startsWith(todayStr);
                });

                todayRows.forEach(r => {
                    // 【关键】兼容处理：如果"参考价格"列不存在或为null，尝试从其他字段推导
                    let refPrice = r["参考价格"];

                    // 兼容旧数据：如果没有参考价格，尝试使用"价格"作为兜底
                    // （不完美，但避免计算错误）
                    if (refPrice === null || refPrice === undefined || refPrice === '') {
                        // 尝试从 strategy 或 portfolio 查找（如果可用）
                        // 注意：此时可能还没加载完，所以主要依赖保存的值
                        refPrice = null; // 标记为 null，让 calculateUserRtn 处理兜底

                        console.warn(`[loadTodayFlows] 记录缺少参考价格: ${r["股票代码"]} @ ${r["修改时间"]}`);
                    } else {
                        refPrice = parseFloat(refPrice);
                    }

                    memoryFlows.push({
                        sheet: flowSheetName,
                        data: {
                            "组合名称": r["组合名称"],
                            "股票代码": r["股票代码"],
                            "股票名称": r["股票名称"],
                            "配置比例 (%)": r["配置比例 (%)"],
                            "标的数量": r["标的数量"],
                            "价格": r["价格"],
                            "价值": r["价值"],
                            "操作类型": r["操作类型"],
                            "修改时间": r["修改时间"],
                            "参考价格": refPrice  // 可能为 null（旧数据）
                        }
                    });
                });
            }
        }

        log(`Loaded ${memoryFlows.length} transactions from today.`, "#0f0");

    } catch (e) {
        console.error("Load flows error", e);
        log("Load flows error: " + e.message, "orange");
    }
}

// ==========================================
// OSS 路径辅助函数 (新增)
// ==========================================
/**
 * 自动根据用户权限拼接安全的 OSS 路径
 * @param {string} filename 文件名，例如 "AIPEQuantGuardiansPortfolio.xlsx"
 * @returns {string} 完整的 OSS Object Key
 */
function getSecureOssPath(filename) {
    // 1. 获取当前用户ID (username)
    const token = localStorage.getItem('qgr_jwt_token');
    let username = '';
    
    if (token) {
        const decoded = parseJWTClientSide(token);
        if (decoded) {
            username = decoded.user; // 例如 "user000001" 或 "admin"
        }
    }

    // 防御性拦截：如果未拿到用户名，默认使用原文件名（理论上前面已经被拦截）
    if (!username) return filename;

    // 3. 拼接最终 OSS 路径
    const isAdmin = username === 'admin';
    if (isAdmin) {
        // 如果是管理员，直接存根目录，使用新文件名
        return filename;
    } else {
        // 2. 处理文件名：在扩展名前面增加 "_用户ID" 后缀
        const lastDotIndex = filename.lastIndexOf('.');
        let newFilename = '';
        
        // 确保找到了 '.' 并且不是隐藏文件（如 ".gitignore"）
        if (lastDotIndex > 0) {
            const namePart = filename.substring(0, lastDotIndex); // 拿到 "AIPEQuantGuardiansPortfolio"
            const extPart = filename.substring(lastDotIndex);     // 拿到 ".xlsx"
            newFilename = `${namePart}_${username}${extPart}`;    // 组装："AIPEQuantGuardiansPortfolio_user000001.xlsx"
        } else {
            // 如果文件没有扩展名
            newFilename = `${filename}_${username}`;
        }
        // 如果是非管理员，按照您要求的格式增加双斜杠: { userID }//{新文件名}
        // 注意：这里的 // 符合后端 Policy "user000001/*" 的通配符规则
        return `${username}//${newFilename}`; 
    }
}

// ===================== 新增：通用带重试 fetch =====================
async function fetchWithRetry(url, options = {}, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            // ✅ 每次请求都加随机参数（绕缓存/风控）
            const finalUrl = url + (url.includes('?') ? '&' : '?') + `_t=${Date.now()}_${Math.random()}`;

            const res = await fetch(finalUrl, {
                ...options,
                cache: 'no-store'
            });

            const json = await res.json();

            // ✅ 关键：识别“假失败”（你这个接口的核心问题）
            if (json && json.detail) {
                throw new Error(`API fail: ${json.detail}`);
            }

            return json;

        } catch (e) {
            if (i === retries) throw e;

            // ✅ 轻微退避 + 随机抖动（模拟真实用户）
            await sleep(200 + Math.random() * 300);
        }
    }
}


