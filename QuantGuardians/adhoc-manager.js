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
    console.log("setupAllAdhocAutoCompletes 被调用，时间：", new Date().toLocaleTimeString());
    ['genbu', 'suzaku', 'sirius', 'kirin'].forEach(key => {
        const input = document.getElementById(`adhoc-search-${key}`);
        const suggestionsBox = document.getElementById(`suggestions-${key}`);
        
        input.addEventListener('input', () => {
            // 每次输入变化，先清除之前选中的 ID
            delete input.dataset.selectedCode;
            delete input.dataset.selectedName;
            
            const query = input.value.trim().toLowerCase();
            suggestionsBox.innerHTML = '';
            if (query.length < 2) return;

            const filtered = allStocks.filter(s => 
                s.name.toLowerCase().includes(query) || 
                String(s.code).includes(query)
            ).slice(0, 10);

            if (filtered.length > 0) {
                const ul = document.createElement('ul');
                ul.className = 'suggestions-list';
                filtered.forEach(stock => {
                    const li = document.createElement('li');
                    li.textContent = `${stock.name} (${stock.code})`;
                    li.onclick = () => {
                        input.value = `${stock.name} (${stock.code})`;
                        // 保存当前选择的对象到 input 的 dataset 以供最后提交
                        input.dataset.selectedCode = stock.code;
                        input.dataset.selectedName = stock.name;
                        suggestionsBox.innerHTML = '';
                    };
                    ul.appendChild(li);
                });
                suggestionsBox.appendChild(ul);
            }
        });

        // 点击外部关闭建议
        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !suggestionsBox.contains(e.target)) {
                suggestionsBox.innerHTML = '';
            }
        });
    });
}

// 执行添加 ADHOC 标的
// 执行添加 ADHOC 标的
function addNewAdhoc(key) {
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

    // 3. 查找股票 (改进查找逻辑)
    let stock = null;
    if (typeof allStocks !== 'undefined') {
        if (selectedCode) {
            // 如果有 dataset (说明是从下拉列表选的)，精确匹配 code
            stock = allStocks.find(s => s.code === selectedCode);
        } else {
            // 如果用户是手动输入的（没有触发点击下拉），尝试匹配原名或代码
            stock = allStocks.find(s => s.name === searchTerm || s.code === searchTerm);
        }
    }

    if (!stock) {
        msgEl.innerText = "ERR: 未找到该股票，请检查输入";
        return;
    }

    // 4. 检查是否重复添加
    const isDuplicate = gameState.guardians[key].strategy.some(s => s.code === stock.code);
    if (isDuplicate) {
        msgEl.innerText = "ERR: 该标的已在 Suggestions 中";
        return;
    }

    // 5. 构造完整对象并存入 state
    const newItem = {
        name: stock.name,
        code: stock.code,
        weight: weight,
        isAdhoc: true,
        history: [],
        refPrice: 0,
        currentPrice: null,
        isSweet: false
    };

    gameState.guardians[key].strategy.push(newItem);

    // 6. UI 更新确认
    msgEl.innerText = `ADHOC SUCCESS: ${stock.name} ADDED`;
    
    // 清空输入框和 dataset
    searchInput.value = "";
    delete searchInput.dataset.selectedCode; // 记得清除缓存，防止下次误选
    delete searchInput.dataset.selectedName;
    weightInput.value = "";

    // 7. 渲染
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
    gameState.guardians[key].strategy.splice(idx, 1);
    
    // 重新渲染列表
    renderLists(key);
}
