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
     * 【核心修改】通用地址生成函数 (适配小说路径)
     * 逻辑参考用户提供的 getResourceUrl
     */
    function _generateUrl(filename) {
        // 处理路径中的空格 (Quantum Guardians -> Quantum%20Guardians)
        const safeFolder = encodeURIComponent(CONFIG.folder);
        
        // 构造完整的文件路径: User/Repo/Branch/Folder/File
        const filePath = `${CONFIG.user}/${CONFIG.repo}/${CONFIG.branch}/${safeFolder}/${filename}`;

        let finalUrl;
        
        // 检查全局代理开关 (兼容 window.gitproxy 定义)
        if (typeof window.gitproxy !== 'undefined' && window.gitproxy === true) {
            // 走代理: PROXY_BASE_URL/filePath
            // 假设 window.PROXY_BASE_URL 已在主程序定义
            const proxyBase = window.PROXY_BASE_URL || ''; 
            finalUrl = `${proxyBase}/${filePath}`;
        } else {
            // 走原生: raw.githubusercontent.com
            finalUrl = `https://raw.githubusercontent.com/${filePath}`;
        }

        // 添加时间戳防止缓存
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
        state.currentChapter = index;
        _updateUI();

        // 格式化文件名: 1 -> QGR01.md
        const numStr = String(index).padStart(2, '0');
        const filename = `${CONFIG.filePrefix}${numStr}.md`;

        // 检查内存缓存
        if (state.cache[index]) {
            _renderMarkdown(state.cache[index]);
            return;
        }

        // 显示加载动画
        els.content.innerHTML = `
            <div class="loading-text">
                正在接入量子网络...<br>
                Downloading Section ${filename}<br>
                <span style="font-size:0.6em;color:#666;">Source: ${_generateUrl(filename)}</span>
            </div>
        `;

        try {
            // 生成带代理和时间戳的 URL
            const url = _generateUrl(filename);
            
            // 发起请求，配置 no-store 
            const response = await fetch(url, { cache: 'no-store' });

            if (!response.ok) {
                if (response.status === 404) throw new Error("该章节尚未解密 (404 Not Found)");
                throw new Error(`网络链接中断 (${response.status})`);
            }

            const text = await response.text();
            state.cache[index] = text; // 写入缓存
            _renderMarkdown(text);

            // 移动端加载后自动收起目录
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
        for (let i = 1; i <= CONFIG.predictedChapters; i++) {
            const li = document.createElement('li');
            li.innerHTML = `<span style="color:#555">FILE:</span> QGR-${String(i).padStart(2, '0')}`;
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
