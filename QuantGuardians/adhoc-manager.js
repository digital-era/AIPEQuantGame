/**
 * AdhocManager.js
 * 处理用户手动增加标的的功能
 */

const GITHUB_REPO_ADD = 'AIPEHotTracker';
const DATA_PATH_ADD = `https://raw.githubusercontent.com/digital-era/${GITHUB_REPO_ADD}/main/data`;

let allStocks = []; // 全量股票池

// 获取全量数据
async function fetchAllStocksData() {
    try {
        const [aShareRes, hkShareRes] = await Promise.all([
            fetch(`${DATA_PATH_ADD}/FlowInfoBase.json`),
            fetch(`${DATA_PATH_ADD}/HKFlowInfoBase.json`)
        ]);
        const aData = await aShareRes.json();
        const hkData = await hkShareRes.json();
        
        // 合并并清洗数据
        allStocks = [...aData, ...hkData].map(s => ({
            name: s.名称 || s.name,
            code: s.代码 || s.code
        }));
        console.log("Stock search engine ready. Total items:", allStocks.length);
    } catch (e) {
        console.error("Error fetching stock lists", e);
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
    } catch (err) {
        console.warn(`Failed to fetch realtime price for ${stock.code}:`, err);
    }
   
    // 6. 如果 API 获取失败，使用一个合理兜底值（避免 refPrice 为 0）
    if (basePrice === null || basePrice <= 0) {
        basePrice = 0;  // 可根据业务调整，或提示用户手动输入
        console.warn(`Using fallback base price 0 for new ADHOC: ${stock.code}`);
    }
   
    // 7. 构造完整对象（refPrice 不再是 0）
    const newItem = {
        name: stock.name,
        code: stock.code,
        weight: weight,
        isAdhoc: true,
        history: [],
        refPrice: basePrice,           // ★ 关键修改：使用实时获取或兜底的价格
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
