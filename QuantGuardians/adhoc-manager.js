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
    ['genbu', 'suzaku', 'sirius', 'kirin'].forEach(key => {
        const input = document.getElementById(`adhoc-search-${key}`);
        const suggestionsBox = document.getElementById(`suggestions-${key}`);
        
        input.addEventListener('input', () => {
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
function addNewAdhoc(key) {
    const input = document.getElementById(`adhoc-search-${key}`);
    const weightInput = document.getElementById(`adhoc-weight-${key}`);
    const weight = parseFloat(weightInput.value);
    
    const code = input.dataset.selectedCode;
    const name = input.dataset.selectedName;

    // 参数校验
    if (!code || !name) {
        alert("Please select a stock from the dropdown suggestions.");
        return;
    }
    if (isNaN(weight) || weight <= 0) {
        alert("Suggested weight (%) must be greater than 0.");
        return;
    }

    // 检查是否已经在 strategy 列表中
    const exists = gameState.guardians[key].strategy.some(s => s.code === code);
    if (exists) {
        alert("This stock is already in the suggestion list.");
        return;
    }

    // 构建新标的对象
    const newStock = {
        name: name,
        code: code,
        refPrice: null, // 将在 updateMarketData 中获取
        weight: weight,
        currentPrice: null,
        history: [],
        isSweet: false,
        isAdhoc: true // 标记为用户手动增加，允许删除
    };

    // 增加到对应守护者的策略列表末尾
    gameState.guardians[key].strategy.push(newStock);

    // 清空输入框
    input.value = '';
    weightInput.value = '';
    delete input.dataset.selectedCode;
    delete input.dataset.selectedName;

    // 立即触发一次价格更新和重新渲染
    updateMarketData(); 
    
    const msgEl = document.getElementById(`msg-${key}`);
    msgEl.innerText = `ADHOC ADDED: ${name}`;
    msgEl.style.color = "#0f0";
}

// 删除 ADHOC 标的
function removeAdhocItem(event, key, idx) {
    event.stopPropagation(); // 防止触发行选中逻辑
    const name = gameState.guardians[key].strategy[idx].name;
    if (confirm(`Remove ${name} from suggestions?`)) {
        gameState.guardians[key].strategy.splice(idx, 1);
        renderLists(key);
    }
}
