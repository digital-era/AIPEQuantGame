// ================= CONFIG =================
// const STS_API_URL = 'https://aiep-users.vercel.app/api/sts'; 
const STS_API_URL = 'https://aipeinvestmentagent.pages.dev/api/sts-credentials'; 
const OSS_BUCKET = 'aiep-users'; 
const OSS_REGION = 'oss-cn-hangzhou'; 
const OSS_FILE_NAME = 'AIPEQuantGuardiansPortfolio.xlsx';

const GITHUB_USER = 'digital-era';
const GITHUB_REPO = 'AIPEQModel';
const GITHUB_BRANCH = 'main';
const REAL_API_URL = 'https://aipeinvestmentagent.pages.dev/api/rtStockQueryProxy';

// 1. 定义甜点文件名常量
const SWEET_POINT_FILE = 'SweetPoint_New.json';

const GUARDIAN_CONFIG = {
    suzaku: { simpleName: "大成", flowName: "大成OR", file: '大成模型_New.json' },
    sirius: { simpleName: "流入", flowName: "流入OR", file: '流入模型_New.json' },    
    genbu:  { simpleName: "低波", flowName: "低波OR", file: '低波稳健模型_New.json' },
    kirin:  { simpleName: "大智", flowName: "大智OR", file: '大智模型_New.json' }
};

const HISTORY_FILES = {
    genbu: '低波稳健模型优化后评估.json', suzaku: '大成模型优化后评估.json',
    sirius: '流入模型优化后评估.json', kirin: '大智模型优化后评估.json'
};

// 【新增】额外的综合评估文件定义
const EXTRA_HISTORY_FILES = {
    guardians: 'QuantGuardians综合评估.json',
    user: 'User模型综合评估.json'
};

// [新增] 颜色映射和全局图表变量
const GUARDIAN_COLORS = { 
    genbu: '#10B981', 
    suzaku: '#EF4444', 
    sirius: '#8B5CF6', 
    kirin: '#3B82F6' 
};
let detailChart = null;
let playbackTimer = null;

// ================= STATE =================
let gameState = {
    active: false,
    guardians: {
        suzaku: { strategy: [], portfolio: [], power: 0, selectedBuy: null, selectedSell: null, initialAssets: 0 },
        sirius: { strategy: [], portfolio: [], power: 0, selectedBuy: null, selectedSell: null, initialAssets: 0 },        
        genbu: { strategy: [], portfolio: [], power: 0, selectedBuy: null, selectedSell: null, initialAssets: 0 },
        kirin: { strategy: [], portfolio: [], power: 0, selectedBuy: null, selectedSell: null, initialAssets: 0 }
    }
};
let memoryFlows = []; 
let ossClient = null;
let perfChart = null; 

let historyData = { dates: [], datasets: {} };

// ======== 新增全局变量和辅助函数 START ========
let priceUpdateInterval = null; // 用于存储 setInterval 的 ID，以便在市场关闭时清除
let hasClosedPrices = false;    // 标识收盘价格是否已获取并锁定

/**
 * 检查当前市场是否已休市 (16:30 后，或周末)
 * @returns {boolean} 如果市场已休市则返回 true
 */
function isMarketClosed() {
    const now = new Date();
    const day = now.getDay(); // 0 for Sunday, 6 for Saturday
    const hours = now.getHours();
    const minutes = now.getMinutes();

    // 假设周末市场关闭 (周六=6, 周日=0)
    if (day === 0 || day === 6) {
        return true;
    }

    // 市场在 16:30 后关闭
    if (hours > 16 || (hours === 16 && minutes >= 30)) {
        return true;
    }

    return false;
}
// ======== 新增全局变量和辅助函数 END ========


// ================= UTILS =================
function log(msg, color="#0f0") {
    const box = document.getElementById('systemLog');
    const time = new Date().toLocaleTimeString('en-US', {hour12:false});
    const div = document.createElement('div');
    div.className = 'log-line';
    div.innerHTML = `<span style="color:#666">[${time}]</span> <span style="color:${color}">${msg}</span>`;
    box.prepend(div);
}

function getOpTime(clamp = false) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth()+1).padStart(2,'0');
    const d = String(now.getDate()).padStart(2,'0');
    let h = now.getHours();
    let min = now.getMinutes();
    if (clamp) {
        if (h > 16 || (h === 16 && min > 30)) { h = 16; min = 30; }
    }
    return `${y}${m}${d}${String(h).padStart(2,'0')}${String(min).padStart(2,'0')}`;
}

// 全局代理开关：设置为 true 开启代理，false 使用原生链接
var gitproxy = true; 

// 替换为你刚才部署的 Cloudflare Worker 地址 (末尾不要带斜杠)
const PROXY_BASE_URL = "https://githubproxy.aivibeinvest.com"; 

/**
* 通用地址生成函数
* @param {string} filename - 文件名
* @returns {string} 最终的请求 URL
*/
function getResourceUrl(filename) {
// 基础路径结构: User/Repo/Branch/File
const filePath = `${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${filename}`;

let finalUrl;
if (typeof gitproxy !== 'undefined' && gitproxy === true) {
    // 走代理: https://proxy.com/User/Repo/Branch/File
    finalUrl = `${PROXY_BASE_URL}/${filePath}`;
} else {
    // 走原生: https://raw.githubusercontent.com/User/Repo/Branch/File
    finalUrl = `https://raw.githubusercontent.com/${filePath}`;
}

// 添加时间戳防止缓存
return `${finalUrl}?t=${Date.now()}`;
}

// ================= NEW CHART LOGIC =================

// [新增] 关闭模态框
function closeModal() {
    document.getElementById('chartModal').style.display = 'none';
    if (playbackTimer) clearInterval(playbackTimer);
}

// [新增] 触发微图点击的处理函数
function onSparkClick(event, key, type, idx) {
    event.stopPropagation(); // 阻止冒泡，避免触发选行
    let item;
    if (type === 'strategy') {
        item = gameState.guardians[key].strategy[idx];
    } else {
        item = gameState.guardians[key].portfolio[idx];
    }
    if (item) {
        const color = GUARDIAN_COLORS[key] || '#fff';
        openDetailChart(item, color);
    }
}

// [新增] 替换原来的 openDetailChart 函数（核心逻辑带涨跌幅量化）
function openDetailChart(item, color) {
    if (!item.history || item.history.length === 0) return;
    
    const refPrice = item.refPrice || item.history[0]; // 基准价（开盘价）
    const pctEl = document.getElementById('modalPct');
    
    document.getElementById('modalTitle').innerText = item.name;
    document.getElementById('modalCode').innerText = `(${item.code})`;
    document.getElementById('chartModal').style.display = 'flex';
    document.querySelector('.modal-content').style.borderColor = color;

    const ctx = document.getElementById('detailChartCanvas').getContext('2d');
    if (detailChart) detailChart.destroy();
    if (playbackTimer) clearInterval(playbackTimer);

    const gradient = ctx.createLinearGradient(0, 0, 0, 450);
    gradient.addColorStop(0, color + '55');
    gradient.addColorStop(1, color + '00');

    detailChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: item.history.map((_, i) => i),
            datasets: [
                {
                    label: 'Price',
                    data: [], // 动态生长数据
                    borderColor: color,
                    borderWidth: 3,
                    pointRadius: 0,
                    fill: true,
                    backgroundColor: gradient,
                    tension: 0.3,
                    yAxisID: 'y'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: function(context) {
                            const val = context.parsed.y;
                            const chg = ((val - refPrice) / refPrice * 100).toFixed(2);
                            return ` Price: ${val.toFixed(2)} (${chg > 0 ? '+' : ''}${chg}%)`;
                        }
                    }
                }
            },
            scales: {
                x: { display: false },
                y: {
                    position: 'left',
                    grid: { color: '#222' },
                    ticks: { color: '#888' }
                },
                // 修改处：右侧轴隐藏刻度数值
                y1: {
                    position: 'right',
                    grid: { display: false },
                    ticks: { display: false } 
                }
            }
        }
    });

    let step = 0;
    const fullHistory = item.history;
    
    playbackTimer = setInterval(() => {
        step++;
        if (step > fullHistory.length + 10) step = 0;

        const currentSlice = fullHistory.slice(0, step);
        const lastPrice = currentSlice[currentSlice.length - 1];

        // 更新大图数据
        detailChart.data.datasets[0].data = currentSlice;
        detailChart.update('none');

        // 更新顶部 HUD 的百分比和颜色
        if (lastPrice) {
            const currentChg = ((lastPrice - refPrice) / refPrice * 100).toFixed(2);
            pctEl.innerText = (currentChg > 0 ? '+' : '') + currentChg + '%';
            pctEl.style.color = lastPrice >= refPrice ? '#EF4444' : '#10B981';
        } else {
            pctEl.innerText = '0.00%';
        }
    }, 30);
}

// ================= LOGIC =================

async function initOSS() {
    if (ossClient) return true;
    try {
        // const res = await fetch(STS_API_URL);
        const res = await fetch(STS_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                } 
            }); // 指向你创建的STS凭证颁发函数

        const data = await res.json();
        ossClient = new OSS({
            region: OSS_REGION, accessKeyId: data.AccessKeyId, accessKeySecret: data.AccessKeySecret,
            stsToken: data.SecurityToken, bucket: OSS_BUCKET,
            refreshSTSToken: async () => {
                // const r = await fetch(STS_API_URL); 
                const r = await fetch(STS_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                } 
            }); // 指向你创建的STS凭证颁发函数
                const d = await r.json();
                return { accessKeyId: d.AccessKeyId, accessKeySecret: d.AccessKeySecret, stsToken: d.SecurityToken };
            }
        });
        return true;
    } catch (e) { log("OSS Init Fail", "red"); return false; }
}

async function loadStrategies() {
    log("Loading Strategy Models...", "cyan");
    const promises = Object.keys(GUARDIAN_CONFIG).map(async (key) => {
    // --- 修改开始: 调用通用代理函数 ---
    const url = getResourceUrl(GUARDIAN_CONFIG[key].file);
        //const url = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${GUARDIAN_CONFIG[key].file}?t=${Date.now()}`;				
        // --- 修改结束 ---
        try {
            const res = await fetch(url);
            const json = await res.json();
            const data = json.结果 || json;
            gameState.guardians[key].power = parseFloat(data.风控因子信息.综合建议仓位因子);
            gameState.guardians[key].strategy = data.最优投资组合配置.配置详情.map(p => ({
                name: p.名称, 
                code: p.代码, 
               // 优先读取“收盘价格”，如果没有则回退到“最近一日价格”
                refPrice: parseFloat(p["收盘价格"] || p["最近一日价格"]), 
                weight: parseFloat(p["最优权重(%)"]), 
                currentPrice: null, 
                history: [],
                isSweet: false // 2. 数据结构初始化默认为 false
            }));
            document.getElementById(`power-${key}`).innerText = (gameState.guardians[key].power * 100).toFixed(0) + "%";
        } catch (e) { log(`[${key}] Model Err`, "red"); }
    });
    await Promise.all(promises);
}

// 3. 加载并标记 Sweet Points 的核心逻辑函数
async function loadSweetPoints() {
    log("Scanning Sweet Points...", "#d8bfd8");
    // --- 修改开始: 调用通用代理函数 ---
    const url = getResourceUrl(SWEET_POINT_FILE);
    //const url = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${SWEET_POINT_FILE}?t=${Date.now()}`;
    // --- 修改结束 ---            
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("SweetPoint fetch failed");
        const json = await res.json();
        
        // 创建代码集合用于快速匹配
        const sweetCodes = new Set(json.map(item => item.代码));

        let count = 0;
        // 遍历所有守护者
        for (let key in gameState.guardians) {
            gameState.guardians[key].strategy.forEach(stock => {
                if (sweetCodes.has(stock.code)) {
                    stock.isSweet = true; // 标记为真
                    count++;
                }
            });
        }
        log(`Sweet Points Applied: ${count}`, "#d8bfd8");
    } catch (e) { log("SweetPoint Err: " + e.message, "orange"); }
}

async function loadCloudPortfolio() {
    log("Syncing Cloud Portfolio...", "#88f");
    if (!await initOSS()) return;
    try {
        const result = await ossClient.get(OSS_FILE_NAME);
        const wb = XLSX.read(result.content, { type: 'array' });
        
        for (let key in GUARDIAN_CONFIG) {
            const sheetName = GUARDIAN_CONFIG[key].simpleName;
            const g = gameState.guardians[key];
            g.portfolio = []; 

            if (wb.Sheets[sheetName]) {                        
                // 关键修改：使用 { raw: true } 获取原始单元格值，然后手动处理
                const ws = wb.Sheets[sheetName];
                const range = XLSX.utils.decode_range(ws['!ref']);
                
                // 找到表头行
                const headers = {};
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cellAddress = XLSX.utils.encode_cell({r: 0, c: C});
                    const cell = ws[cellAddress];
                    if (cell) {
                        headers[C] = cell.v;
                    }
                }
                
                // 手动解析数据行，确保股票代码保持原始字符串格式
                let raw = [];
                for (let R = 1; R <= range.e.r; ++R) {
                    const row = {};
                    for (let C = range.s.c; C <= range.e.c; ++C) {
                        const cellAddress = XLSX.utils.encode_cell({r: R, c: C});
                        const cell = ws[cellAddress];
                        if (cell) {
                            const header = headers[C];
                            if (header === '股票代码') {
                                // 关键：对于股票代码，使用cell.w（格式化文本）或cell.v（原始值）
                                // 优先使用w（显示文本），如果没有则使用v
                                row[header] = cell.w !== undefined ? String(cell.w) : 
                                              (cell.v !== undefined ? String(cell.v) : '');
                            } else {
                                // 其他列正常处理
                                row[header] = cell.w !== undefined ? cell.w : 
                                              (cell.v !== undefined ? cell.v : '');
                            }
                        }
                    }
                    if (Object.keys(row).length > 0) {
                        raw.push(row);
                    }
                }
                
                let maxDateInt = 0;
                raw.forEach(row => {
                    const t = String(row['修改时间'] || '');
                    if (t.length >= 8) {
                        const dateVal = parseInt(t.substring(0, 8));
                        if (!isNaN(dateVal) && dateVal > maxDateInt) {
                            maxDateInt = dateVal;
                        }
                    }
                });

                let holdingsMap = {};
                const targetPrefix = String(maxDateInt);

                raw.forEach(row => {
                    const t = String(row['修改时间'] || '');
                    if (maxDateInt > 0 && t.startsWith(targetPrefix)) {
                        // 保持原始股票代码字符串，不做任何格式化
                        const stockCode = String(row['股票代码'] || '');
                        holdingsMap[stockCode] = row;
                    }
                });

                Object.values(holdingsMap).forEach(row => {
                    if (parseFloat(row['配置比例 (%)']) > 0) {
                        // 使用原始股票代码，保持Excel中的格式
                        const code = String(row['股票代码'] || '');
                        
                        const strategyItem = g.strategy.find(s => s.code === code);
                        const yesterdayClose = strategyItem ? strategyItem.refPrice : null;
                
                        g.portfolio.push({
                            code: code,
                            name: row['股票名称'],
                            weight: parseFloat(row['配置比例 (%)']), 
                            currentPrice: null, 
                            refPrice: yesterdayClose,
                            history: []
                        });
                    }
                });
            }
            updateCash(key);
        }
        log("Cloud Portfolio Loaded.", "#0f0");
    } catch (e) {
        if (e.name === 'NoSuchKeyError' || e.code === 'NoSuchKey') {
            log("No Cloud Save. Starting Fresh.", "#888");
            for (let k in GUARDIAN_CONFIG) updateCash(k);
        } else {
            log("Cloud Load Error: " + e.message, "red");
        }
    }
}

// 建议增加的内存结构
let todayInitialAssets = 100000; // 假设每日初始资金

async function loadTodayFlows() {
    if (!ossClient) return;
    try {
        const result = await ossClient.get(OSS_FILE_NAME);
        const wb = XLSX.read(result.content, { type: 'array' });
        const todayStr = getOpTime().substring(0, 8); // 获取 YYYYMMDD
        
        memoryFlows = []; // 清空内存记录
        
        for (let key in GUARDIAN_CONFIG) {
            const flowSheetName = GUARDIAN_CONFIG[key].flowName;
            const sheet = wb.Sheets[flowSheetName];
            if (sheet) {
                const rows = XLSX.utils.sheet_to_json(sheet);
                const todayRows = rows.filter(r => String(r["修改时间"]).startsWith(todayStr));
                
                // 将今日已存在的记录读入内存
                todayRows.forEach(r => {
                    memoryFlows.push({
                        sheet: flowSheetName,
                        data: r
                    });
                });
            }
        }
        log(`Loaded ${memoryFlows.length} transactions from today.`, "#0f0");
    } catch (e) { console.error("Load flows error", e); }
}

function calculateUserRtn(key) {
    const g = gameState.guardians[key];
    const flowName = GUARDIAN_CONFIG[key].flowName;
    const initialTotalAssets = 100000; // 每日初始虚拟资金基数
    
    // 1. 获取今日该守护者的所有内存操作记录
    const todayFlows = memoryFlows.filter(f => f.sheet === flowName);
    
    let totalPnL = 0;

    /**
     * 核心逻辑：
     * 收益 = Σ(当前持仓价值 - 当前持仓昨日价值) + Σ(今日卖出贡献) - Σ(今日买入产生的成本偏差)
     * 
     * 简单推演公式：
     * 1. 对于当前持仓：贡献 = (现价 - 今日开盘价) * 当前数量
     * 2. 对于今日买入：因为第1步用了开盘价，所以要扣除 (买入价 - 今日开盘价) * 买入数量
     * 3. 对于今日卖出：贡献 = (卖出价 - 今日开盘价) * 卖出数量
     */

    // --- 第一部分：计算当前 Portfolio 中标的的浮动盈亏 (相对于开盘价/基准价) ---
    g.portfolio.forEach(p => {
        if (p.isCash) return; // 跳过现金
        
        // 优先从 portfolio 找现价，找不到则视为无波动
        const nowPrice = p.currentPrice;
        const refPrice = p.refPrice; // 这里的 refPrice 是今日开盘价

        if (nowPrice && refPrice) {
            // 计算当前持仓在今日的波动：(当前价 - 开盘价) * 持仓数量
            // 持仓数量 = (总资产 * 权重 / 100) / 当前价
            const currentWeightValue = initialTotalAssets * (p.weight / 100);
            const quantity = currentWeightValue / nowPrice;
            totalPnL += (nowPrice - refPrice) * quantity;
        }
    });

    // --- 第二部分：通过 memoryFlows 修正买入成本，并累加卖出已实现收益 ---
    todayFlows.forEach(f => {
        const code = f.data["股票代码"];
        const tradePrice = f.data["价格"];
        const tradeQty = f.data["标的数量"];
        
        // 尝试获取该标的的基准价（今日开盘价）
        // 逻辑：先看 strategy（策略里存了 refPrice），再看 portfolio
        const item = g.strategy.find(s => s.code === code) || 
                     g.portfolio.find(p => p.code === code);
        
        const refPrice = item ? item.refPrice : tradePrice;

        if (f.data["操作类型"] === "Buy") {
            /**
             * 买入修正：
             * 在第一部分计算中，我们假设所有持仓都是从 refPrice（开盘）开始波动的。
             * 但今日买入的标的，其实是从 tradePrice 开始波动的。
             * 所以要减去 (买入价 - 开盘价) 这一段多算的/少算的差额。
             */
            if (tradePrice && refPrice) {
                totalPnL -= (tradePrice - refPrice) * tradeQty;
            }
        } 
        else if (f.data["操作类型"] === "Sell") {
            /**
             * 卖出贡献（按您要求的逻辑）：
             * 卖出时的价格与今日开盘价（refPrice）的差额作为今日收益贡献。
             * 卖出后标的不在 portfolio 了，所以这部分是“锁定”的今日收益。
             */
            if (tradePrice && refPrice) {
                totalPnL += (tradePrice - refPrice) * tradeQty;
            }
        }
    });

    // 3. 计算收益率百分比
    const rtnPercentage = (totalPnL / initialTotalAssets) * 100;
    
    // 返回数值，外层调用可以用 .toFixed(2)
    return isNaN(rtnPercentage) ? 0 : rtnPercentage;
}

function updateCash(key) {
    const g = gameState.guardians[key];
    g.portfolio = g.portfolio.filter(p => p.code !== '100000');
    const totalStockWeight = g.portfolio.reduce((sum, p) => sum + p.weight, 0);
    const cashWeight = Math.max(0, 100 - totalStockWeight);
    g.portfolio.push({
        code: '100000', name: '现金', weight: cashWeight, 
        currentPrice: 1, history: [], isCash: true
    });
}

/**
 * 更新市场数据，根据市场状态决定是否获取最新价格
 * @param {boolean} forceFetch - 强制获取价格，即使 hasClosedPrices 为 true。用于系统初始化。
 */
async function updateMarketData(forceFetch = false) {
    // 如果市场已关闭且已获取收盘价，且不是强制获取，则跳过价格数据请求
    if (hasClosedPrices && !forceFetch) {
        log("Market closed. Skipping price data fetch.", "#666");
        // 即使不获取新价格，仍需要重新计算和渲染，因为用户可能进行了交易
        for (let k in gameState.guardians) {
            const g = gameState.guardians[k];
            let portRtn = calculateUserRtn(k);
            const userRtnElem = document.getElementById(`user-rtn-${k}`);
            userRtnElem.innerText = portRtn.toFixed(2) + "%";
            userRtnElem.className = portRtn >= 0 ? "stat-value user-stat text-up" : "stat-value user-stat text-down";
            renderLists(k); 
        }
        return; // 退出函数
    }

    log("Sync Price Data", "#aaa"); 
    let allPricesFetchedSuccessfully = true; // 跟踪是否所有价格都成功获取

    for (let k in gameState.guardians) {
        const g = gameState.guardians[k];
        let currentAssets = 0;
        
        // 1. Update Strategy Prices and Calc System Rtn
        let systemRtn = 0; 
        for (let s of g.strategy) {
            await fetchPrice(s); // fetchPrice 内部会处理市场关闭逻辑
            if (s.currentPrice === null) allPricesFetchedSuccessfully = false; // 任何一个价格未获取成功，就标记为失败

            // 【核心修改】：只有当标的存在价格，且不是 ADHOC 临时标的时，才计算入 System Rtn
            if (s.currentPrice && s.refPrice) {
                 if (s.isAdhoc !== true) { 
                     const chg = (s.currentPrice - s.refPrice) / s.refPrice;
                     systemRtn += chg * (s.weight / 100);
                 }
            }
        }

        // --- 2. 更新数值和颜色 ---
        const sysRtnElem = document.getElementById(`rtn-${k}`);
        const cardElem = document.getElementById(`card-${k}`);
        
        if (sysRtnElem) {
            sysRtnElem.innerText = (systemRtn * 100).toFixed(2) + "%";
            sysRtnElem.className = systemRtn >= 0 ? "stat-value text-up" : "stat-value text-down";
        }

        // --- 3. 根据系统收益率正负切换边框发光状态 ---
        if (systemRtn > 0) {
            cardElem.classList.add('active'); // 收益为正，激活发光
        } else {
            cardElem.classList.remove('active'); // 收益为负或零，移除发光
        }              
       
        // 2. Update Portfolio Prices & Value (用户持仓部分不受影响，买入即计算)
        for (let p of g.portfolio) {
            if (p.isCash) {
                currentAssets += 100000 * (p.weight / 100); 
            } else {
                await fetchPrice(p); // fetchPrice 内部会处理市场关闭逻辑
                if (p.currentPrice === null) allPricesFetchedSuccessfully = false; // 任何一个价格未获取成功，就标记为失败
                currentAssets += 100000 * (p.weight / 100); 
            }
        }
        
        if (g.initialAssets === 0 && currentAssets > 0) {
            g.initialAssets = 100000;
        }

        let portRtn = calculateUserRtn(k);         
        const userRtnElem = document.getElementById(`user-rtn-${k}`);
        userRtnElem.innerText = portRtn.toFixed(2) + "%";
        userRtnElem.className = portRtn >= 0 ? "stat-value user-stat text-up" : "stat-value user-stat text-down";
        
        renderLists(k);
    }
    // 2. 在循环结束后打印完成提示
    log("Sync Price Data Finish", "#aaa"); 

    // 在所有价格获取并显示成功后，检查市场是否已关闭
    if (isMarketClosed() && allPricesFetchedSuccessfully && !hasClosedPrices) {
        hasClosedPrices = true; // 设置收盘标识
        if (priceUpdateInterval) {
            clearInterval(priceUpdateInterval); // 清除定时器，停止价格轮询
            priceUpdateInterval = null; // 重置 interval ID
        }
        log("Market closed. Prices locked to official closing prices. Price requests stopped.", "yellow");
    }
}

/**
 * 获取股票价格及历史数据
 * @param {object} item - 包含股票代码、名称、历史价格等的对象
 */
async function fetchPrice(item) {
    if (!item.code) return;
    const finalCode = item.code.length === 5 ? 'HK' + item.code : item.code;
    const marketIsClosed = isMarketClosed();

    try {
        let intradayData = []; // 分钟级历史数据
        let closingPriceApiResult = null; // 收盘价格 API 的结果

        // 步骤 1: 始终尝试获取分钟级历史数据，用于微图绘制
        const intradayUrl = `${REAL_API_URL}?code=${finalCode}&type=intraday`; 
        const intradayRes = await fetch(intradayUrl);
        const intradayJson = await intradayRes.json();
        if (intradayJson && intradayJson.length > 0) {
            intradayData = intradayJson.map(d => parseFloat(d.price));
        }

        // 步骤 2: 如果市场已关闭，额外获取官方收盘价格
        if (marketIsClosed) {
            const closePriceUrl = `${REAL_API_URL}?code=${finalCode}&type=price`; // 参数修改为 price
            const closePriceRes = await fetch(closePriceUrl);
            const closePriceJson = await closePriceRes.json();
            if (closePriceJson && closePriceJson.length > 0) {
                closingPriceApiResult = parseFloat(closePriceJson[closePriceJson.length - 1].price);
            }
        }
        
        // 步骤 3: 根据市场状态和获取到的数据，确定最终的 currentPrice, refPrice 和 history
        if (marketIsClosed && closingPriceApiResult !== null) {
            // 市场已关闭，且成功获取到官方收盘价
            item.currentPrice = closingPriceApiResult;
            
            // 历史数据优先使用分钟线，如果分钟线为空，则用收盘价绘制一条平线
            item.history = intradayData.length > 0 ? intradayData : [closingPriceApiResult, closingPriceApiResult];

            // refPrice (昨日收盘价/今日开盘价) 不应被今日收盘价覆盖。
            // 只有当 refPrice 尚未设置 (即 Excel 中没有，也未从分钟线获取到开盘价) 时，才将其设置为收盘价
            if (item.refPrice === undefined || item.refPrice === null) {
                item.refPrice = closingPriceApiResult; 
            }

        } else if (intradayData.length > 0) {
            // 市场未关闭，或已关闭但未获取到官方收盘价，则使用分钟线数据
            item.currentPrice = intradayData[intradayData.length - 1]; // 最新价格
            item.history = intradayData;
            
            // 如果 refPrice 未设置 (Excel 中没有)，则使用分钟线的第一个价格作为开盘价
            if (item.refPrice === undefined || item.refPrice === null) {
                item.refPrice = intradayData[0];
            }
        } else {
            // 既无分钟线数据，也无收盘价数据 (例如，今天尚未交易或 API 异常)
            // 此时 currentPrice 保持为 refPrice (来自 Excel 的昨日收盘)，如果 refPrice 也为空，则为 null
            if (item.refPrice !== null && item.refPrice !== undefined) {
                item.currentPrice = item.refPrice;
                // 如果没有交易数据，则用 refPrice 绘制一条平线
                item.history = [item.refPrice, item.refPrice];
            } else {
                item.currentPrice = null;
                item.history = []; // 没有数据，历史曲线为空
            }
        }

        // 如果是 ADHOC 标的，数据回来后立即强制刷新列表 (原逻辑)
        if (item.isAdhoc) {
            for (let key in gameState.guardians) {
                if (gameState.guardians[key].strategy.includes(item)) {
                    renderLists(key);
                    break;
                }
            }
        }
    } catch (e) {
        console.error(`Error fetching price for ${item.code}:`, e);
        // 出现网络或其他错误时，尝试回退到 refPrice，或保持现有价格
        if (item.refPrice !== null && item.refPrice !== undefined) {
            item.currentPrice = item.refPrice;
            item.history = item.history || [item.refPrice, item.refPrice]; // 保持现有历史或用 refPrice 绘制平线
        } else {
            item.currentPrice = null;
            item.history = item.history || []; // 保持现有历史或为空
        }
    }
}

function renderLists(key) {
    const g = gameState.guardians[key];
    const listEl = document.getElementById(`list-${key}`);
    listEl.innerHTML = '';
    g.strategy.forEach((s, i) => {
        const el = createRow(key, s, i, 'strategy');
        el.onclick = () => selectStrategyItem(key, i);
        if(g.selectedBuy === i) el.classList.add('selected');
        listEl.appendChild(el);
    });

    const portEl = document.getElementById(`portfolio-${key}`);
    portEl.innerHTML = '';
    g.portfolio.forEach((p, i) => {
        const el = createRow(key, p, i, 'portfolio');
        if (p.isCash) el.classList.add('is-cash');
        else el.onclick = () => selectPortfolioItem(key, i);
        
        if(g.selectedSell === i && !p.isCash) el.classList.add('selected');
        portEl.appendChild(el);
    });
}

function createRow(key, item, idx, type) {
    const div = document.createElement('div');
    div.className = 'holding-item';

    if (!item.isCash) {
        const stockUrl = `https://aipeinvestmentagent.pages.dev/PotScoreFundAnalytics?stock=${encodeURIComponent(item.name)}`;
        div.ondblclick = (e) => { 
            e.stopPropagation(); 
            window.open(stockUrl, '_blank'); 
        };
    }
    
    // 4. 界面渲染逻辑：如果是甜点，在股票名称前添加糖果图标 🍬
    let iconPrefix = "";
    if(item.isSweet) iconPrefix += "🍬"; 
    if(iconPrefix !== "") iconPrefix += " ";
    // --- 修改点：如果是 strategy 且是 adhoc 类型，增加减号 ---
    let deleteHtml = (type === 'strategy' && item.isAdhoc) ? 
        `<span class="delete-btn" onclick="removeAdhocItem(event, '${key}', ${idx})">−</span>` : '';

    let nameHtml = `<div class="h-name-wrapper"><span class="h-name">${iconPrefix}${item.name}</span>${deleteHtml}</div>`;
    //let nameHtml = `${iconPrefix}${item.name}`;

    let wHtml = "";
    let pHtml = "";
    
    if (item.currentPrice && item.refPrice) {
        const chg = (item.currentPrice - item.refPrice) / item.refPrice;
        const cls = chg >= 0 ? "text-up" : "text-down";
        pHtml = `<span class="h-price ${cls}">${item.currentPrice.toFixed(2)}</span>
                 <span class="h-pct ${cls}">${(chg*100).toFixed(2)}%</span>`;
    } else {
        pHtml = `<span class="h-price">${item.currentPrice ? item.currentPrice.toFixed(2) : '--'}</span>`;
    }

    if (type === 'strategy') {
        wHtml = `<span class="h-weight">[${item.weight.toFixed(2)}%]</span>`;
    } else {
        wHtml = `<span class="user-weight-display">[${item.weight.toFixed(2)}%]</span>`;
    }

    // ... 后面的 innerHTML 拼接中使用 nameHtml ...
    div.innerHTML = `
        <div class="h-info">${nameHtml}<div class="h-weight-row">${wHtml}</div></div>
        <div class="h-price-col">${pHtml}</div>
        <div class="mini-chart-container" onclick="onSparkClick(event, '${key}', '${type}', ${idx})">
            <canvas id="chart-${key}-${type}-${idx}" class="sparkline"></canvas>
        </div>
    `;
    
    setTimeout(() => {
if(item.history && item.history.length > 1) {
            // 【修复】：如果 refPrice 为空、0 或无效，使用历史数据的第一个点作为基准，避免图表被压扁
            const safeRefPrice = (item.refPrice && item.refPrice > 0) ? item.refPrice : item.history[0];
            
            drawSpark(`chart-${key}-${type}-${idx}`, item.history, safeRefPrice, (item.currentPrice >= safeRefPrice ? '#EF4444' : '#10B981'));
        }
    }, 0);
    return div;
}

function drawSpark(id, data, base, color) {
    const cvs = document.getElementById(id);
    if(!cvs) return;
    const ctx = cvs.getContext('2d');
    const w = ctx.canvas.width = cvs.offsetWidth;
    const h = ctx.canvas.height = cvs.offsetHeight;
    const min = Math.min(...data, base), max = Math.max(...data, base);
    const range = max - min || 1;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    data.forEach((p, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - ((p - min) / range) * h;
        i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    ctx.stroke();
}

function selectStrategyItem(key, idx) {
    gameState.guardians[key].selectedBuy = idx;
    const item = gameState.guardians[key].strategy[idx];
    const price = item.currentPrice || item.refPrice;
    document.getElementById(`buy-price-${key}`).value = price ? price.toFixed(2) : ""; // 修改点
    document.getElementById(`buy-weight-${key}`).value = item.weight.toFixed(2);
    renderLists(key);
    calcQty(key, 'buy');
}

function selectPortfolioItem(key, idx) {
    const p = gameState.guardians[key].portfolio[idx];
    if (p.isCash) return;
    gameState.guardians[key].selectedSell = idx;
    const price = p.currentPrice || p.refPrice;
    document.getElementById(`sell-price-${key}`).value = price ? price.toFixed(2) : ""; // 修改点
    document.getElementById(`sell-weight-${key}`).value = p.weight.toFixed(2);
    renderLists(key);
    calcQty(key, 'sell');
}

function calcQty(key, type) {
    const g = gameState.guardians[key];
    const price = parseFloat(document.getElementById(`${type}-price-${key}`).value);
    const weight = parseFloat(document.getElementById(`${type}-weight-${key}`).value);
    const resEl = document.getElementById(`calc-${type}-${key}`);
    
    if (price > 0 && weight > 0) {
        const totalAssets = 100000; 
        let actualWeight = weight;
        if (type === 'buy') actualWeight = weight * g.power; 
        const val = totalAssets * (actualWeight / 100);
        const qty = Math.floor(val / price);
        resEl.innerText = `Qty: ${qty}`;
    } else {
        resEl.innerText = "";
    }
}

function executeOrder(key, type) {
    const g = gameState.guardians[key];
    const msgEl = document.getElementById(`msg-${key}`);
    const price = parseFloat(document.getElementById(`${type}-price-${key}`).value);
    const weight = parseFloat(document.getElementById(`${type}-weight-${key}`).value);
    
    if (!price || !weight) return;

    if (type === 'buy') {
        if (g.selectedBuy === null) return;
        const item = g.strategy[g.selectedBuy];
        const increment = weight * g.power;
        const currentSum = g.portfolio.reduce((s, p) => p.isCash ? s : s + p.weight, 0);
        if (currentSum + increment > 100.1) { 
            msgEl.innerText = `ERR: Limit Exceeded (Max 100%)`; msgEl.style.color="red"; return;
        }
        let existing = g.portfolio.find(p => p.code === item.code);
        if (existing) {
            existing.weight += increment;
            existing.currentPrice = price; 
        } else {
            g.portfolio.unshift({ 
                code: item.code, name: item.name, weight: increment,
                currentPrice: price, refPrice: item.refPrice, history: item.history
            });
        }
        recordFlow(key, 'Buy', item.code, item.name, weight, price);
        msgEl.innerText = `BOUGHT ${item.name}`;

    } else if (type === 'sell') {
        if (g.selectedSell === null) return;
        const item = g.portfolio[g.selectedSell];
        if (weight > item.weight + 0.01) {
            msgEl.innerText = `ERR: Insufficient Holdings`; msgEl.style.color="red"; return;
        }
        item.weight -= weight;
        if (item.weight < 0.01) {
            g.portfolio.splice(g.selectedSell, 1);
            g.selectedSell = null;
        }
        recordFlow(key, 'Sell', item.code, item.name, weight, price);
        msgEl.innerText = `SOLD ${item.name}`;
    }

    msgEl.style.color = "#FFD700";
    updateCash(key);
    // 【新增】：操作完后立即刷新一次收益率显示
    const portRtn = calculateUserRtn(key);
    const userRtnElem = document.getElementById(`user-rtn-${key}`);
    userRtnElem.innerText = portRtn.toFixed(2) + "%";
    renderLists(key);
}

function recordFlow(key, opType, code, name, inputWeight, price) {
    const g = gameState.guardians[key];
    const totalAssets = 100000;
    let actualWeight = (opType === 'Buy') ? inputWeight * g.power : inputWeight;
    const val = totalAssets * (actualWeight / 100);
    const qty = Math.floor(val / price);
    const value = (qty * price).toFixed(2);
    
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
            "修改时间": getOpTime(true)
        }
    });
}

async function loadAdhocFromCloud() {
    log("Loading ADHOC Suggestions...", "#da70d6");
    if (!ossClient) return;
    try {
        const result = await ossClient.get(OSS_FILE_NAME);
        const wb = XLSX.read(result.content, { type: 'array' });
        const sheet = wb.Sheets["ADHOC"];
        
        if (sheet) {
            const raw = XLSX.utils.sheet_to_json(sheet, { raw: false });
            raw.forEach(row => {
                const simpleName = row["组合名称"];
                const key = Object.keys(GUARDIAN_CONFIG).find(k => GUARDIAN_CONFIG[k].simpleName === simpleName);
                
                if (key) {
                    const g = gameState.guardians[key];
                    if (!g.strategy.some(s => s.code === String(row["股票代码"]))) {
                        // --- 修改：读取收盘价格作为基准价 ---
                        const excelClosePrice = row["收盘价格"] ? parseFloat(row["收盘价格"]) : null;
                        
                        g.strategy.push({
                            name: row["股票名称"],
                            code: String(row["股票代码"]),
                            weight: parseFloat(row["建议比例 (%)"]),
                            refPrice: excelClosePrice, // 这里的 refPrice 就是你要求的“奇点价格”
                            currentPrice: excelClosePrice, // 初始现价也设为它，防止没买卖时显示错误
                            history: [],
                            isSweet: false,
                            isAdhoc: true 
                        });
                    }
                }
            });
            log("ADHOC Suggestions Imported.", "#0f0");
        }
    } catch (e) {
        log("No ADHOC data found.", "#888");
    }
}

async function syncToCloud() {
    if (!await initOSS()) return;
    const dot = document.getElementById('ossStatusDot');
    dot.className = "oss-status syncing";
    
    try {
        let wb;
        try {
            const r = await ossClient.get(OSS_FILE_NAME);
            wb = XLSX.read(r.content, { type: 'array' });
        } catch { wb = XLSX.utils.book_new(); }

        const timeStr = getOpTime(true);
        const todayPrefix = timeStr.substring(0, 8); // 提取如 "20231027"

        for (let key in GUARDIAN_CONFIG) {
            const cfg = GUARDIAN_CONFIG[key];
            const g = gameState.guardians[key];
            hasNewData = false;

            let snapData = [];
            if (wb.Sheets[cfg.simpleName]) {
                // 1. 先把 Sheet 里的旧数据全读出来
                const oldSnapData = XLSX.utils.sheet_to_json(wb.Sheets[cfg.simpleName]);
                
                // 2. 【核心修改】过滤掉“修改时间”前8位等于今天的数据
                snapData = oldSnapData.filter(row => {
                    const rowTime = String(row["修改时间"] || "");
                    return rowTime.substring(0, 8) !== todayPrefix; 
                });
            }
            g.portfolio.forEach(p => {
                snapData.push({
                    "组合名称": cfg.simpleName,
                    "股票代码": p.code,
                    "股票名称": p.name,
                    "来源": "QuantGuardians",
                    "配置比例 (%)": p.weight.toFixed(2),
                    "修改时间": timeStr
                });
            });
            const newSnapWs = XLSX.utils.json_to_sheet(snapData, { header: ["组合名称","股票代码","股票名称","来源","配置比例 (%)","修改时间"] });
            if(wb.Sheets[cfg.simpleName]) wb.Sheets[cfg.simpleName] = newSnapWs;
            else XLSX.utils.book_append_sheet(wb, newSnapWs, cfg.simpleName);

            // 在 syncToCloud 内部处理 flowName Sheet 的逻辑
            let flowData = [];
            if (wb.Sheets[cfg.flowName]) {
                flowData = XLSX.utils.sheet_to_json(wb.Sheets[cfg.flowName]);
            }
            
            const pending = memoryFlows.filter(f => f.sheet === cfg.flowName);
            
            pending.forEach(newItem => {
                // 严格匹配逻辑：将对象转为 JSON 字符串进行比对
                const isDuplicate = flowData.some(existingItem => {
                    return existingItem["股票代码"] === newItem.data["股票代码"] &&
                           existingItem["修改时间"] === newItem.data["修改时间"] &&
                           existingItem["操作类型"] === newItem.data["操作类型"] &&
                           parseFloat(existingItem["价格"]) === parseFloat(newItem.data["价格"]) &&
                           parseFloat(existingItem["标的数量"]) === parseFloat(newItem.data["标的数量"]);
                });
            
                if (!isDuplicate) {
                    flowData.push(newItem.data);
                     hasNewData = true; // 【新增】只有真正插入数据时才标记为 true
                }
            });

            // 【核心保护】只有当确实有新数据写入，或者原本没有这个 Sheet (初始化) 时，才执行写入
            // 如果 flowData 不为空且没有 Sheet，说明是第一次创建，也要写入
            const sheetExists = !!wb.Sheets[cfg.flowName];
            
            if (hasNewData || (!sheetExists && flowData.length > 0)) {
                const headers = [
                    "组合名称",
                    "股票代码",
                    "股票名称",
                    "配置比例 (%)",
                    "标的数量",
                    "价格",
                    "价值",
                    "操作类型",
                    "修改时间"
                ];
                
                const newFlowWs = XLSX.utils.json_to_sheet(flowData, {
                    header: headers,
                    skipHeader: false
                });;
            
                if (sheetExists) {
                    wb.Sheets[cfg.flowName] = newFlowWs;
                } else {
                    XLSX.utils.book_append_sheet(wb, newFlowWs, cfg.flowName);
                }
                console.log(`[${cfg.flowName}] 更新完成，新增 ${pending.length} 条记录`);
            } else {
                // 没变化时什么都不做，wb 中保留原有的 Sheet 对象，最大程度保留原格式
                console.log(`[${cfg.flowName}] 无新增记录，跳过写入`);
            }

        }

        // 收集所有守护者的 ADHOC 标的
        let adhocData = [];
        const adhocTimeStr = getOpTime(true);
        
        for (let key in GUARDIAN_CONFIG) {
            const cfg = GUARDIAN_CONFIG[key];
            const g = gameState.guardians[key];
            const adhocItems = g.strategy.filter(s => s.isAdhoc === true);
            
            adhocItems.forEach(item => {
                adhocData.push({
                    "组合名称": GUARDIAN_CONFIG[key].simpleName,
                    "股票代码": item.code,
                    "股票名称": item.name,
                    "来源": "QuantGuardians",
                    "建议比例 (%)": item.weight.toFixed(2),
                    "修改时间": adhocTimeStr,
                    "收盘价格": item.refPrice // --- 保存当前记录的基准价到 Excel ---
                });
            });   
       
        }
        
        // 将收集到的 ADHOC 数据写入 Sheet (全量覆盖)
        const adhocWs = XLSX.utils.json_to_sheet(adhocData, { 
            header: ["组合名称", "股票代码", "股票名称", "来源", "建议比例 (%)", "修改时间"] 
        });
        
        if (wb.Sheets["ADHOC"]) {
            wb.Sheets["ADHOC"] = adhocWs;
        } else {
            XLSX.utils.book_append_sheet(wb, adhocWs, "ADHOC");
        }

        const wopts = { bookType:'xlsx', bookSST:false, type:'array' };
        const wbout = XLSX.write(wb, wopts);
        const blob = new Blob([wbout], {type:"application/octet-stream"});
        await ossClient.put(OSS_FILE_NAME, blob);
        
        dot.className = "oss-status done";
        log("Cloud Sync Success.", "#0f0");
        memoryFlows = []; 
    } catch (e) {
        dot.className = "oss-status";
        log("Sync Error: " + e.message, "red");
    }
}

async function loadHistoryData() {
    log("Loading Historical Data...", "#88f");
    // 1. 合并原有四大神兽文件 + 新增的 Guardians/User 文件
    const allFiles = { ...HISTORY_FILES, ...EXTRA_HISTORY_FILES };
    const keys = Object.keys(allFiles);
    
    const requests = keys.map(key => {
      // --- 修改开始: 调用通用代理函数 ---
      const url = getResourceUrl(allFiles[key]);
      //const url = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${allFiles[key]}?t=${Date.now()}`;
      // --- 修改结束 --- 				
         return fetch(url).then(res => res.json()).catch(e => null);
    });
    const results = await Promise.all(requests);
    
    let allDatesSet = new Set();
    results.forEach(json => { 
        if(json && json.每日评估数据) {
            json.每日评估数据.forEach(item => allDatesSet.add(item.日期)); 
        }
    });
    
    historyData.dates = Array.from(allDatesSet).sort();
    
    results.forEach((json, index) => {
        const key = keys[index];
        if (json && json.每日评估数据) {
            const returnMap = new Map();
            
            // 1. 处理每日评估数据 (仅处理累计收益率)
            json.每日评估数据.forEach(d => {
                returnMap.set(d.日期, d.累计收益率 * 100);
            });
            
            // 2. 从 JSON 外层获取固定的标普500收益率
            let sp500FixedValue = null;
            if (json["标普500收益率"] !== undefined) {
                sp500FixedValue = json["标普500收益率"] * 100;
            }

            // 3. 保存主要曲线数据 (策略收益率)
            historyData.datasets[key] = historyData.dates.map(date => returnMap.has(date) ? returnMap.get(date) : null);
            
            // 4. 如果是 guardians 文件，额外生成 sp500 数据
            // 逻辑：创建一个与日期数组等长的数组，每个元素都是那个固定的 sp500FixedValue
            if (key === 'guardians') {
                historyData.datasets['sp500'] = historyData.dates.map(() => sp500FixedValue);
            }
        } else {
            historyData.datasets[key] = [];
            if (key === 'guardians') historyData.datasets['sp500'] = [];
        }
    });
    
    renderHistoryChart();
}

function renderHistoryChart() {
    document.getElementById('settlementPanel').style.display = 'block';
    
    const ctx = document.getElementById('performanceChart').getContext('2d');
    if (perfChart) perfChart.destroy();
    
    const createDataset = (label, color, dataKey, extraOptions = {}) => ({
        label: label, borderColor: color, backgroundColor: color + '1A',
        data: historyData.datasets[dataKey] || [], tension: 0.3, pointRadius: 0, borderWidth: 2, spanGaps: true,
        ...extraOptions
    });
    
    perfChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: historyData.dates,
            datasets: [
                // 新增：Guardians (总护卫队)
                createDataset('Guardians', '#FFD700', 'guardians', { borderWidth: 3, order: 1 }),
                // 新增：User (用户)
                createDataset('User', '#00FFFF', 'user', { borderWidth: 2, order: 2 }),
                // 新增：S&P 500 (作为基准线，虚线)
                createDataset('S&P 500', '#666666', 'sp500', { borderDash: [5, 5], borderWidth: 1, order: 99 }),                        
                // 原有四大神兽
                createDataset('GENBU', '#10B981', 'genbu', { hidden: false }), // 默认显示，可点击图例隐藏
                createDataset('SUZAKU', '#EF4444', 'suzaku', { hidden: false }),
                createDataset('SIRIUS', '#8B5CF6', 'sirius', { hidden: false }),
                createDataset('KIRIN', '#3B82F6', 'kirin', { hidden: false })
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, 
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { color: '#ccc' } } },
            scales: { 
                y: { ticks: { color: '#666' }, grid: { color: '#333' } }, 
                x: { ticks: { color: '#666', maxTicksLimit: 8 }, grid: { color: '#333' } } 
            }
        }
    });
}

async function initSystem() {
    if (gameState.active) return;
    const btn = document.getElementById('engageBtn');
    btn.innerText = "INITIALIZING...";
    
    await initOSS();
    
    // 加载策略和历史数据
    await Promise.all([
        loadStrategies(),
        loadHistoryData()
    ]);

    // 5. 在系统初始化流程中，策略加载后立即调用加载函数
    await loadSweetPoints(); 

    //  【新增】从云端导入 ADHOC 标的到 Strategy Suggestions
    await loadAdhocFromCloud();
    
    await loadCloudPortfolio();
    
    // 首次获取市场数据，强制获取一次，因为这是系统启动，需要确定初始价格和市场状态
    await updateMarketData(true); 

    // 根据首次获取后的状态，决定是否启动定时器
    if (hasClosedPrices) { 
        // 如果市场已关闭且价格已锁定，则不再启动定时器
        log("Market currently closed on init. Price polling will not start.", "yellow");
    } else {
        // 市场开放，启动定时器，每 5 分钟更新一次（非强制获取）
        priceUpdateInterval = setInterval(() => updateMarketData(false), 300000); // 5 minutes = 300000 ms
        log("Market is open. Price polling started every 5 minutes.", "#0f0");
    }

    await fetchAllStocksData(); // 新增：获取全量搜索数据
    setupAllAdhocAutoCompletes(); // 新增：设置自动补全
    
    
    gameState.active = true;
    btn.innerText = "SYSTEM ONLINE";
    btn.style.boxShadow = "0 0 20px #0f0";
}
