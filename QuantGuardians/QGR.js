/**
 * QGR.js - Quantum Guardians Renaissance Novel Reader
 * 集成动态代理切换与 Markdown 解析
 */

const QGR = (function() {
    // --- 基础配置 ---
    const CONFIG = {
        user: 'digital-era',
        repo: 'NorthStar',
        branch: 'main',
        folder: 'Quantum Guardians', // 注意包含空格
        filePrefix: 'QGR',           // 文件名前缀 QGR01.md
        predictedChapters: 30        // 预生成目录数量
    };

    // --- 状态管理 ---
    let state = {
        currentChapter: 1,
        isOpen: false,
        cache: {} // 内存缓存
    };

    // --- DOM 引用 ---
    const els = {
        modal: null,
        content: null,
        list: null,
        sidebar: null,
        label: null
    };

    function initDOM() {
        els.modal = document.getElementById('novelModal');
        els.content = document.getElementById('novelContent');
        els.list = document.getElementById('chapterList');
        els.sidebar = document.getElementById('novelSidebar');
        els.label = document.getElementById('currentChapterLabel');
    }

    /**
     * 【修复版】通用地址生成函数
     * 1. 修复了全局变量(gitproxy/PROXY_BASE_URL)可能无法读取的问题
     * 2. 增加了控制台日志，方便排查生成的 URL 对不对
     */
    function _generateUrl(filename) {
        // 1. 获取全局配置的代理状态
        // 尝试读取全局变量 gitproxy，如果未定义则默认为 false
        let useProxy = false;
        try {
            if (typeof gitproxy !== 'undefined') useProxy = gitproxy;
            else if (typeof window.gitproxy !== 'undefined') useProxy = window.gitproxy;
        } catch(e) {}

        // 2. 处理文件夹路径中的空格
        // 大多数代理支持 encoded 路径，但如果您的代理报 404，
        // 可以尝试把下一行改为: const safeFolder = CONFIG.folder; (即不转义)
        const safeFolder = encodeURIComponent(CONFIG.folder); 
        
        // 3. 构造路径: User/Repo/Branch/Folder/File
        const filePath = `${CONFIG.user}/${CONFIG.repo}/${CONFIG.branch}/${safeFolder}/${filename}`;

        let finalUrl;
        
        if (useProxy) {
            // --- 代理模式 ---
            // 尝试获取全局定义的代理地址
            let proxyBase = '';
            try {
                if (typeof PROXY_BASE_URL !== 'undefined') proxyBase = PROXY_BASE_URL;
                else if (typeof window.PROXY_BASE_URL !== 'undefined') proxyBase = window.PROXY_BASE_URL;
            } catch(e) {
                console.warn("QGR: 检测到代理开启，但找不到 PROXY_BASE_URL 变量");
            }
            
            // 拼接代理地址
            // 注意：有些代理需要在后面加 /, 这里做了防重复处理
            const separator = proxyBase.endsWith('/') ? '' : '/';
            finalUrl = `${proxyBase}${separator}${filePath}`;
            
        } else {
            // --- 原生模式 ---
            finalUrl = `https://raw.githubusercontent.com/${filePath}`;
        }

        // 4. [调试] 在控制台打印生成的地址，请按 F12 查看
        console.log(`[QGR] Loading: ${filename}`);
        console.log(`[QGR] Mode: ${useProxy ? 'Proxy' : 'Raw'}`);
        console.log(`[QGR] URL: ${finalUrl}`);

        // 5. 添加时间戳防缓存
        return `${finalUrl}?t=${Date.now()}`;
    }

    // --- 主要功能 ---

    // 1. 打开阅读器
    function openReader() {
        if (!els.modal) initDOM();
        els.modal.style.display = 'flex';
        state.isOpen = true;

        // 初次加载目录和第一章
        if (els.list.children.length === 0) {
            _renderDirectory();
            loadChapter(1);
        }
    }

    // 2. 关闭阅读器
    function closeReader() {
        if (els.modal) els.modal.style.display = 'none';
        state.isOpen = false;
    }

    // 3. 切换侧边栏 (Mobile)
    function toggleSidebar() {
        if (els.sidebar) els.sidebar.classList.toggle('show');
    }

    // 4. 加载章节
    async function loadChapter(index) {
        // ================= 新增：权限验证拦截 =================
        if (index > 1) {
            // 防御性调用：如果当前环境没有 checkActionAuth 函数，默认拦截(false)以保证安全
            const isAuthorized = typeof checkActionAuth === 'function' ? checkActionAuth(`加载第 ${index} 节`) : false;
            
            if (!isAuthorized) {
                // 拦截提示 UI
                els.content.innerHTML = `
                    <div style="text-align:center; padding:50px; color:#EF4444; border: 1px dashed #EF4444; margin: 20px;">
                        <h3>⛔ ACCESS DENIED</h3>
                        <p>小说章节已被锁定 (Encryption Level: HIGH)</p>
                        <p style="font-size: 0.9em; color:#888;">游客权限仅能访问第一节，请在 Settings 中完成登录验证后解锁完整小说内容。</p>
                        <button class="nav-btn" style="margin-top:20px; padding: 10px 20px;" onclick="QGR.loadChapter(1)">
                            返回第一节 (RETURN)
                        </button>
                    </div>
                `;
                
                // 移动端如果目录是打开的，拦截后自动收起
                if (window.innerWidth < 768 && els.sidebar.classList.contains('show')) {
                    els.sidebar.classList.remove('show');
                }
                return; // 【核心】直接中断，保护老的状态逻辑不被污染
            }
        }
        // ======================================================

        state.currentChapter = index;
        _updateUI();

        const numStr = String(index).padStart(2, '0');
        const filename = `${CONFIG.filePrefix}${numStr}.md`;

        if (state.cache[index]) {
            _renderMarkdown(state.cache[index]);
            return;
        }

        els.content.innerHTML = `
            <div class="loading-text">
                正在接入量子网络...<br>
                Downloading Section ${filename}<br>
                <span style="font-size:0.6em;color:#666;">Source: ${_generateUrl(filename)}</span>
            </div>
        `;

        try {
            const url = _generateUrl(filename);
            const response = await fetch(url, { cache: 'no-store' });

            if (!response.ok) {
                if (response.status === 404) throw new Error("该章节尚未解密 (404 Not Found)");
                throw new Error(`网络链接中断 (${response.status})`);
            }

            const text = await response.text();
            state.cache[index] = text; 
            _renderMarkdown(text);

            if (window.innerWidth < 768 && els.sidebar.classList.contains('show')) {
                els.sidebar.classList.remove('show');
            }

        } catch (error) {
            console.error("Novel Load Error:", error);
            els.content.innerHTML = `
                <div style="text-align:center; padding:50px; color:#EF4444;">
                    <h3>⛔ CONNECTION LOST</h3>
                    <p>${error.message}</p>
                    <button class="nav-btn" onclick="QGR.loadChapter(${index})">重试连接 / RETRY</button>
                </div>
            `;
        }
    }

    // 5. 渲染 Markdown
    function _renderMarkdown(text) {
        if (typeof marked !== 'undefined') {
            els.content.innerHTML = marked.parse(text);
            els.content.scrollTop = 0; // 回到顶部
        } else {
            els.content.innerText = text;
        }
    }

    // 6. 渲染目录 (生成预设数量的章节)
    function _renderDirectory() {
        els.list.innerHTML = '';
        
        let isLoggedIn = false;
        // 加入 try-catch，防止用户的隐私模式阻断本地存储读取，造成老功能(目录渲染)崩溃
        try {
            if (localStorage.getItem('qgr_jwt_token')) {
                isLoggedIn = true; 
            }
        } catch (e) {
            console.warn('无法访问 localStorage，默认显示锁定状态');
        }

        for (let i = 1; i <= CONFIG.predictedChapters; i++) {
            const li = document.createElement('li');
            
            const lockIcon = (!isLoggedIn && i > 1) ? '<span style="font-size:12px; margin-left:5px;">🔒</span>' : '';
            
            li.innerHTML = `<span style="color:#555">FILE:</span> QGR-${String(i).padStart(2, '0')} ${lockIcon}`;
            li.dataset.idx = i;
            li.onclick = () => loadChapter(i);
            els.list.appendChild(li);
        }
    }


    // 7. 更新 UI 高亮
    function _updateUI() {
        if (els.label) els.label.textContent = `SECTION ${String(state.currentChapter).padStart(2,'0')}`;
        
        const items = els.list.querySelectorAll('li');
        items.forEach(item => {
            if (parseInt(item.dataset.idx) === state.currentChapter) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }

    // 8. 翻页控制
    function nextChapter() { loadChapter(state.currentChapter + 1); }
    function prevChapter() { if(state.currentChapter > 1) loadChapter(state.currentChapter - 1); }

    // 公开接口
    return {
        openReader,
        closeReader,
        toggleSidebar,
        loadChapter,
        nextChapter,
        prevChapter
    };

})();
