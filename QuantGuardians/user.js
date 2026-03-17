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
