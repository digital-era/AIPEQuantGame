/**
 * AdhocManager.js
 * 处理用户手动增加标的的功能
 */

const GITHUB_ADD_USER = 'digital-era';
const GITHUB_REPO_ADD = 'AIPEHotTracker';
const GITHUB_ADD_BRANCH = 'main';
const PROXY_BASE_ADD_URL = "https://githubproxy.aivibeinvest.com"; 
const DATA_PATH_ADD = `https://raw.githubusercontent.com/digital-era/${GITHUB_REPO_ADD}/main/data`;

let allStocks = []; // 全量股票池
/**
 * 生成资源文件的完整URL
 */
function getAllStocksDataResourceUrl(filename) {
    // 基础路径结构: User/Repo/Branch/File
    const filePath = `${GITHUB_ADD_USER}/${GITHUB_REPO_ADD}/${GITHUB_ADD_BRANCH}/${filename}`;
    
    let finalUrl;
    if (typeof gitproxy !== 'undefined' && gitproxy === true) {
        // 走代理: https://proxy.com/User/Repo/Branch/File
        finalUrl = `${PROXY_BASE_ADD_URL}/${filePath}`;
    } else {
        // 走原生: https://raw.githubusercontent.com/User/Repo/Branch/File
        finalUrl = `https://raw.githubusercontent.com/${filePath}`;
    }
    
    // 添加时间戳防止缓存
    return `${finalUrl}?t=${Date.now()}`;
}

// 获取全量数据
async function fetchAllStocksData() {
    try {
        if (typeof log === 'function') {
            log(">> INITIALIZING STOCK INDEX: LOADING BASE DATA...", "#0ff");
        }

        // [核心修正] 这里必须调用 fetch，否则 Promise.all 等待的只是字符串
        const [aShareRes, hkShareRes] = await Promise.all([
            fetch(getAllStocksDataResourceUrl(`data/FlowInfoBase.json`)),
            fetch(getAllStocksDataResourceUrl(`data/HKFlowInfoBase.json`))
        ]);

        // 检查 HTTP 状态码
        if (!aShareRes.ok || !hkShareRes.ok) {
            throw new Error(`Network error: A-Share(${aShareRes.status}) / HK-Share(${hkShareRes.status})`);
        }

        const aData = await aShareRes.json();
        const hkData = await hkShareRes.json();
        
        // [安全性优化] 确保数据是数组，防止非数组数据导致崩溃
        const validAData = Array.isArray(aData) ? aData : [];
        const validHkData = Array.isArray(hkData) ? hkData : [];

        if (!Array.isArray(aData) || !Array.isArray(hkData)) {
            console.warn("Stock data format warning: received non-array data");
        }

        // 合并并清洗数据
        allStocks = [...validAData, ...validHkData].map(s => ({
            name: s.名称 || s.name,
            code: s.代码 || s.code
        }));

        console.log("Stock search engine ready. Total items:", allStocks.length);
        if (typeof log === 'function') {
            log(`>> STOCK INDEX SYNCHRONIZED. ENTITIES REGISTERED: ${allStocks.length}`, "#0f0");
        }

    } catch (e) {
        console.error("Error fetching stock lists", e);
        
        if (typeof log === 'function') {
            log(">> SYSTEM FAILURE: STOCK LIST RETRIEVAL FAILED. " + (e.message || e), "#f00");
        }
    }
}

// 初始化 4 个卡片的自动补全
function setupAllAdhocAutoCompletes() {
    console.log("使用事件委托方式初始化 ADHOC 自动补全");

    // 在 document 级别监听 input 事件（捕获阶段）
    document.addEventListener('input', function(e) {
        if (!e.target.matches('input[id^="adhoc-search-"]')) return;

        const input = e.target;
        const key = input.id.replace('adhoc-search-', '');
        const suggestionsBox = document.getElementById(`suggestions-${key}`);

        // 调试：确认事件到达
        console.log(`[${key}] 捕获到 input 事件，当前值:`, input.value);

        // 清空旧建议
        suggestionsBox.innerHTML = '';

        const query = input.value.trim().toLowerCase();
        if (query.length < 2) return;

        const filtered = allStocks.filter(s =>
            s.name.toLowerCase().includes(query) ||
            String(s.code).includes(query)
        ).slice(0, 10);

        console.log(`[${key}] 匹配到 ${filtered.length} 条结果`);

        if (filtered.length > 0) {
            const ul = document.createElement('ul');
            ul.className = 'suggestions-list';

            filtered.forEach(stock => {
                const li = document.createElement('li');
                li.textContent = `${stock.name} (${stock.code})`;
                li.addEventListener('click', () => {
                    input.value = stock.name;  // 只填充名称，更符合用户习惯
                    input.dataset.selectedCode = stock.code;
                    input.dataset.selectedName = stock.name;
                    suggestionsBox.innerHTML = '';
                    console.log(`[${key}] 已选择: ${stock.name} (${stock.code})`);
                });
                ul.appendChild(li);
            });

            suggestionsBox.appendChild(ul);
        }
    }, { capture: true });

    // 点击页面其他地方关闭所有建议
    document.addEventListener('click', function(e) {
        if (!e.target.closest('input[id^="adhoc-search-"]') &&
            !e.target.closest('.suggestions-list-container')) {
            document.querySelectorAll('.suggestions-list-container').forEach(box => {
                box.innerHTML = '';
            });
        }
    });
}

// 执行添加 ADHOC 标的
async function addNewAdhoc(key) {
    const searchInput = document.getElementById(`adhoc-search-${key}`);
    const weightInput = document.getElementById(`adhoc-weight-${key}`);
    const msgEl = document.getElementById(`msg-${key}`);
   
    // 优先从 dataset 获取点击下拉列表时存入的 code
    const selectedCode = searchInput.dataset.selectedCode;
    const searchTerm = searchInput.value.trim();
    const weight = parseFloat(weightInput.value);
   
    // 1. 初始化消息框状态
    msgEl.style.color = "#ffff00";
    msgEl.innerText = "";
   
    // 2. 输入合法性检查
    if (!searchTerm) {
        msgEl.innerText = "ERR: 请输入股票名称或代码";
        return;
    }
    if (isNaN(weight) || weight <= 0) {
        msgEl.innerText = "ERR: 权重必须大于 0";
        return;
    }
   
    // 3. 查找股票
    let stock = null;
    if (typeof allStocks !== 'undefined') {
        if (selectedCode) {
            stock = allStocks.find(s => s.code === selectedCode);
        } else {
            stock = allStocks.find(s => s.name === searchTerm || s.code === searchTerm);
        }
    }
    if (!stock) {
        msgEl.innerText = "ERR: 未找到该股票，请检查输入";
        return;
    }
   
    // 4. 检查是否重复添加
    const isDuplicate = gameState.guardians[key].adhocObservations.some(s => s.code === stock.code);
    if (isDuplicate) {
        msgEl.innerText = "ERR: 该标的已在 ADDHOC OBSERVATIONS (USER) 中";
        return;
    }
   
    // 5. 尝试获取实时最新价格作为基准价（核心修改点）
    let basePrice = null;
    let addhocofficialChangePercent = null;   
    let addhocRefPrice = 0;                   
    try {
        const finalCode = stock.code.length === 5 ? 'HK' + stock.code : stock.code;
        const priceUrl = `${REAL_API_URL}?code=${finalCode}&type=price`;
        const res = await fetch(priceUrl, { cache: 'no-store' });
        const data = await res.json();
        
        // 兼容不同的 API 返回字段
        basePrice = parseFloat(
            data.latestPrice || 
            data.price || 
            data.current || 
            0
        );
        
        if (basePrice <= 0 || isNaN(basePrice)) {
            basePrice = null;
        }
        
        if (data.changePercent !== undefined) {
            addhocofficialChangePercent = parseFloat(data.changePercent);
        }
    } catch (err) {
        console.warn(`Failed to fetch realtime price for ${stock.code}:`, err);
    }
   
    // 6. 如果 API 获取失败，使用一个合理兜底值（避免 refPrice 为 0）
    if (basePrice === null || basePrice <= 0) {
        basePrice = 0;  // 可根据业务调整，或提示用户手动输入
        console.warn(`Using fallback base price 0 for new ADHOC: ${stock.code}`);
    }

     // 特殊处理：如果存在官方涨跌幅（说明已收盘或API数据有效），
    // 无论 Excel 中的 refPrice 是否被更新为今日收盘价，我们都利用涨跌幅反推“真正的昨日收盘价”
    // 公式：昨日收盘价 = 当前价格 / (1 + 涨跌幅%)
    if (addhocofficialChangePercent !== null && basePrice > 0 ) {
        addhocRefPrice = basePrice / (1 + addhocofficialChangePercent / 100);
    }
    else {
        addhocRefPrice = 0;
    }
   
    // 7. 构造完整对象（refPrice 不再是 0）
    const newItem = {
        name: stock.name,
        code: stock.code,
        weight: weight,
        isAdhoc: true,
        history: [],
        refPrice: addhocRefPrice,           // ★ 关键修改：使用实时获取或兜底的价格
        currentPrice: null,
        isSweet: false,
        joinPrice: basePrice,          // 可选：记录加入时的价格，便于后续对比/显示
        joinTime: new Date().toISOString()
    };
   
    gameState.guardians[key].adhocObservations.push(newItem);
   
    // 8. UI 更新确认
    msgEl.innerText = `ADHOC SUCCESS: ${stock.name} ADDED (基准价: ${basePrice.toFixed(2)})`;
    msgEl.style.color = "#0f0";
   
    // 9. 清空输入框和 dataset
    searchInput.value = "";
    delete searchInput.dataset.selectedCode;
    delete searchInput.dataset.selectedName;
    weightInput.value = "";
   
    // 10. 立即获取最新价格并刷新界面
    renderLists(key);
    if (typeof fetchPrice === 'function') {
        fetchPrice(newItem).then(() => {
            renderLists(key);
        });
    }
}

// 删除 ADHOC 标的
function removeAdhocItem(event, key, idx) {
    event.stopPropagation(); // 保持这一行：防止触发行选中逻辑
    
    // 直接执行删除，不再通过 if(confirm(...)) 询问
    gameState.guardians[key].adhocObservations.splice(idx, 1);
    
    // 重新渲染列表
    renderLists(key);
}

// --- 音乐控制逻辑 ---
function toggleMusic() {
    const music = document.getElementById('bgMusic');
    const btn = document.getElementById('musicBtn');
    
    // 如果音乐暂停中，则播放
    if (music.paused) {
        music.play().then(() => {
            // 1. 播放时，图标变为停止符号，提示用户可以点击停止
            btn.innerHTML = '⏹️'; 
            btn.title = "Stop Music";
            
            // 2. 仅改变文字/图标颜色为高亮色（绿色），不改变边框！
            // 这样能保持边框和其他图标一致，同时又能看出正在播放
            btn.style.color = "#10B981"; 
            
            // 【已删除】禁止修改边框颜色，保持 UI 统一
            // btn.style.borderColor = "#10B981"; 
        }).catch(error => {
            console.error("播放失败:", error);
            // 即使失败，也尽量重置回五线谱
            btn.innerHTML = '🎼';
        });
    } else {
        // 如果正在播放，则暂停
        music.pause();
        
        // 3. 暂停/停止后，图标恢复为五线谱 🎼
        btn.innerHTML = '🎼'; 
        btn.title = "Play Music";
        
        // 4. 清除颜色样式，恢复默认灰色
        btn.style.color = ""; 
        // btn.style.borderColor = ""; // 不需要清除，因为上面没加
    }
}
