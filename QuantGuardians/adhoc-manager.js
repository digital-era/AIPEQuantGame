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
    const searchInput = document.getElementById(`adhoc-search-${key}`);
    const weightInput = document.getElementById(`adhoc-weight-${key}`);
    const msgEl = document.getElementById(`msg-${key}`);
    
    const searchTerm = searchInput.value.trim();
    const weight = parseFloat(weightInput.value);

    // 统一设置消息颜色为黄色并清空旧内容
    msgEl.style.color = "#ffff00"; 
    msgEl.innerText = "";

    // --- 1. 输入检查 ---
    if (!searchTerm) {
        msgEl.innerText = "ERR: 请输入股票名称或代码";
        return;
    }
    if (isNaN(weight) || weight <= 0) {
        msgEl.innerText = "ERR: 权重必须大于 0";
        return;
    }

    // --- 2. 匹配股票 (假设你已有关联好的 allStocks 库) ---
    const stock = typeof allStocks !== 'undefined' ? 
                  allStocks.find(s => s.name === searchTerm || s.code === searchTerm) : null;

    if (!stock) {
        msgEl.innerText = "ERR: 未找到匹配标的";
        return;
    }

    // --- 3. 执行添加并提示成功 ---
    const exists = gameState.guardians[key].strategy.find(s => s.code === stock.code);
    if (exists) {
        msgEl.innerText = "ERR: 该标的已在列表中";
    } else {
        const newItem = {
            ...stock,
            weight: weight,
            isAdhoc: true, // 标记为手动添加
            history: [],
            currentPrice: null
        };
        gameState.guardians[key].strategy.push(newItem);
        
        // 成功提示：统一黄色
        msgEl.innerText = `ADHOC成功: 已添加 ${stock.name}`;
        
        // 重置输入框
        searchInput.value = "";
        weightInput.value = "";
        
        // 刷新列表并获取实时价
        renderLists(key);
        fetchPrice(newItem).then(() => renderLists(key));
    }
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
