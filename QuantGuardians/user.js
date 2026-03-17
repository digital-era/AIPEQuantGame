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
            localStorage.removeItem('qgr_jwt_token'); 
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
            localStorage.setItem('qgr_jwt_token', data.token);
            showAuthMsg("ACCESS GRANTED", "#10B981");
            document.getElementById('auth_password').value = '';
            setTimeout(checkAuthStatus, 500);
        } else {
            showAuthMsg(data.error || "ACCESS DENIED", "#EF4444");
        }
    } catch (error) {
        showAuthMsg("NETWORK ERROR", "#EF4444");
        console.error('Login error:', error);
    }
}

function handleLogout() {
    localStorage.removeItem('qgr_jwt_token');
    checkAuthStatus();
    showAuthMsg("LOGGED OUT SUCCESSFULLY", "#10B981");
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
            showAuthMsg("PASSWORD UPDATED", "#10B981");
            document.getElementById('cpw_old').value = '';
            document.getElementById('cpw_new').value = '';
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
    
    // --- 新增：获取当前用户 Token 和身份信息 ---
    const token = localStorage.getItem('qgr_jwt_token');
    if (!token) {
        console.error("初始化 OSS 失败：用户未登录");
        return false;
    }

    const decoded = parseJWTClientSide(token);
    if (!decoded || Date.now() > decoded.exp) {
        console.error("初始化 OSS 失败：Token无效或已过期");
        return false;
    }

    const username = decoded.user; // 获取用户名，例如 "admin" 或 "user000001"
    const isAdmin = username === 'admin';
    
    // 全局记录当前用户的 OSS 操作目录前缀
    // 非管理员的操作会被强制限制在该目录下，如果传错目录会触发 403 权限拒绝
    window.CURRENT_OSS_PREFIX = isAdmin ? '' : `${username}/`

    // ────────────────────────────────────────────────
    // 凭证来源选择逻辑
    let ossCredentials;
    
    if (isAdmin) {
        // 管理员 → 强制使用 window.OSS_CONFIG
        ossCredentials = window.OSS_CONFIG || {};
    } else {
        // 普通用户 → 从 Cloudflare Pages Functions 的 env 对象读取
        ossCredentials = {
            ACCESS_KEY_ID:     env.OSS_CONFIG.ACCESS_KEY_ID     || '',
            ACCESS_KEY_SECRET: env.OSS_CONFIG.ACCESS_KEY_SECRET || '',
            STS_ROLE_ARN:      env.OSS_CONFIG.STS_ROLE_ARN      || '',
            OSS_REGION:        env.OSS_CONFIG.OSS_REGION        || ''
        };
    }
    
    // 辅助函数：获取非空字符串值，否则返回 undefined（不会出现在最终 JSON 中）
    function getValidCredential(value) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
        return undefined;
    }
    
    // 构建发送用的 body（只包含有效凭证字段）
    const postBody = JSON.stringify({
        OSS_ACCESS_KEY_ID:     getValidCredential(ossCredentials.ACCESS_KEY_ID),
        OSS_ACCESS_KEY_SECRET: getValidCredential(ossCredentials.ACCESS_KEY_SECRET),
        OSS_STS_ROLE_ARN:      getValidCredential(ossCredentials.STS_ROLE_ARN),
        OSS_REGION:            getValidCredential(ossCredentials.OSS_REGION)
    });

    // 可选：发送前做完整性检查（根据业务需求决定是否启用）
    if (!postBody || postBody === '{}') {
        console.error('No valid OSS credentials available for current user');
        // 根据实际场景可抛出错误、显示提示或禁用相关功能
        // throw new Error('Missing OSS credentials');
    }

    // --- 新增：构造带有鉴权信息的 Headers ---
    const reqHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}` // 让后端知道当前是哪个用户申请STS凭证
    };

    try {
        // --- 第一次获取 Token ---
        const res = await fetch(STS_API_URL, {
            method: 'POST',
            headers: reqHeaders,
            body: postBody 
        });

        if (!res.ok) throw new Error(`STS fetch failed: ${res.status}`);
        const data = await res.json();

        // --- 初始化 OSS 客户端 ---
        ossClient = new OSS({
            region: window.OSS_CONFIG.OSS_REGION.startsWith('oss-') 
                    ? window.OSS_CONFIG.OSS_REGION 
                    : `oss-${window.OSS_CONFIG.OSS_REGION}`, 
            accessKeyId: data.AccessKeyId,
            accessKeySecret: data.AccessKeySecret,
            stsToken: data.SecurityToken,
            bucket: window.OSS_CONFIG.OSS_BUCKET || OSS_BUCKET, 
            
            // --- 刷新 Token 的逻辑 ---
            refreshSTSToken: async () => {
                console.log("正在刷新 STS Token...");
                // 刷新时也要重新获取本地最新 Token，防止期间发生改变
                const currentToken = localStorage.getItem('qgr_jwt_token');
                
                const r = await fetch(STS_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${currentToken}` // 刷新同样需要携带JWT
                    },
                    body: postBody 
                });
                
                if (!r.ok) throw new Error("Refresh token failed");
                const d = await r.json();
                
                return {
                    accessKeyId: d.AccessKeyId,
                    accessKeySecret: d.AccessKeySecret,
                    stsToken: d.SecurityToken
                };
            }
        });
        
        console.log(`OSS 初始化成功 [角色: ${isAdmin ? '管理员' : '普通用户'}, 专属目录: /${window.CURRENT_OSS_PREFIX}]`);
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

    // 3. 拼接最终 OSS 路径
    const isAdmin = username === 'admin';
    if (isAdmin) {
        // 如果是管理员，直接存根目录，使用新文件名
        return newFilename;
    } else {
        // 如果是非管理员，按照您要求的格式增加双斜杠: { userID }//{新文件名}
        // 注意：这里的 // 符合后端 Policy "user000001/*" 的通配符规则
        return `${username}//${newFilename}`; 
    }
}
