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
        suzaku: { strategy: [], portfolio: [], adhocObservations: [], power: 0, selectedBuy: null, selectedSell: null, selectedSourcem: null, initialAssets: 0 },
        sirius: { strategy: [], portfolio: [], adhocObservations: [], power: 0, selectedBuy: null, selectedSell: null, selectedSourcem: null, initialAssets: 0 },        
        genbu: { strategy: [], portfolio: [], adhocObservations: [],  power: 0, selectedBuy: null, selectedSell: null, selectedSourcem: null, initialAssets: 0 },
        kirin: { strategy: [], portfolio: [], adhocObservations: [],  power: 0, selectedBuy: null, selectedSell: null, selectedSourcem: null, initialAssets: 0 }
    }
};
let memoryFlows = []; 
let ossClient = null;
let perfChart = null; 

let historyData = { dates: [], datasets: {} };

// ======== 新增全局变量和辅助函数 START ========
let priceUpdateInterval = null; // 用于存储 setInterval 的 ID，以便在市场关闭时清除
let hasClosedPrices = false;    // 标识收盘价格是否已获取并锁定

// [新增] 全局变量存储当前时间范围选择状态
let currentChartRange = 'all'; // 可选值: 'all', 'ytd', '1w'

// [新增] 切换时间范围的全局函数
window.updateChartRange = function(range) {
    currentChartRange = range;
    renderHistoryChart(); // 重新渲染图表
};

/**
 * 获取当前时刻对应的中国时间对象
 * 原理：将当前UTC时间转换为中国时区的字符串，再重新解析为 Date 对象
 * 结果：返回的 Date 对象虽然底层是本地时区，但其 getHours/getDate 等数值与中国时间一致
 */
function getChinaDate() {
    const now = new Date();
    // 使用 Intl API 强制转换为上海时间字符串
    const chinaTimeStr = now.toLocaleString("en-US", {timeZone: "Asia/Shanghai"});
    return new Date(chinaTimeStr);
}

/**
 * 检查当前市场是否已休市 (16:30 后，或周末)
 * @returns {boolean} 如果市场已休市则返回 true
 */
function isMarketClosed() {
    // 【修改点】获取中国时间对象
    const now = getChinaDate(); 
    
    const day = now.getDay(); // 如果英国是周五晚23点，中国是周六早7点，这里会正确返回 6 (周六)
    const hours = now.getHours();
    const minutes = now.getMinutes();

    // 假设周末市场关闭 (周六=6, 周日=0)
    if (day === 0 || day === 6) {
        return true;
    }

    // 市场在9:15前  16:15 后关闭
    if ((hours > 16 || (hours === 16 && minutes > 30)) || (hours < 9 || (hours === 9 && minutes < 30))) {
        return true;
    }
    
    return false;
}



// 【新增】全局开关函数，控制Historical Perforance中N+2与N+3模型曲线
// 1. 用户点击 Checkbox 时调用
window.toggleVariantState = function(type) {
    if (type === 'n2') {
        showN2 = document.getElementById('toggleN2').checked;
    } else if (type === 'n3') {
        showN3 = document.getElementById('toggleN3').checked;
    }
    // 状态变了，更新图表
    updateVariantVisibility();
};

// 2. 核心联动函数：根据 (主线可见性 + Checkbox状态) 决定变体可见性
function updateVariantVisibility() {
    if (!perfChart) return;

    // 获取所有 datasets
    const datasets = perfChart.data.datasets;

    // 第一步：找到所有 "主线" 的可见性状态，存入 Map
    // key: groupKey (如 'suzaku'), value: boolean (是否可见)
    const visibilityMap = {};
    
    datasets.forEach((ds, index) => {
        if (ds.isMain) {
            // 使用 chart 实例的方法检查可见性 (包含被图例隐藏的情况)
            visibilityMap[ds.groupKey] = perfChart.isDatasetVisible(index);
        }
    });

    // 第二步：遍历所有变体 (N+2/N+3)，根据规则设置显隐
    datasets.forEach((ds, index) => {
        if (!ds.isMain && ds.variantType) {
            const parentIsVisible = visibilityMap[ds.groupKey]; // 查找Parent在不在
            
            // 规则：
            // 1. 如果是 N+2：必须 CheckboxN2 勾选 AND Parent可见
            // 2. 如果是 N+3：必须 CheckboxN3 勾选 AND Parent可见
            let shouldShow = false;

            if (ds.variantType === 'n2') {
                shouldShow = showN2 && parentIsVisible;
            } else if (ds.variantType === 'n3') {
                shouldShow = showN3 && parentIsVisible;
            }

            // 执行显示或隐藏
            if (shouldShow) {
                perfChart.show(index);
            } else {
                perfChart.hide(index);
            }
        }
    });

    // 刷新图表
    perfChart.update('none'); 
}

// ======== 新增全局变量和辅助函数 END ========


// ================= UTILS =================
function log(msg, color="#0f0") {
    const box = document.getElementById('systemLog');
    // 直接指定时区输出字符串
    const time = new Date().toLocaleTimeString('en-US', {
        hour12: false, 
        timeZone: 'Asia/Shanghai' // 【修改点】强制显示中国时间
    });
    const div = document.createElement('div');
    div.className = 'log-line';
    div.innerHTML = `<span style="color:#666">[${time}]</span> <span style="color:${color}">${msg}</span>`;
    box.prepend(div);
}

function getOpTime(clamp = false) {
    // 【修改点】获取中国时间对象
    const now = getChinaDate(); 
    
    const y = now.getFullYear();
    const m = String(now.getMonth()+1).padStart(2,'0');
    const d = String(now.getDate()).padStart(2,'0');
    let h = now.getHours();
    let min = now.getMinutes();
    
    if (clamp) {
        // 这里的 16:30 也是指中国时间的 16:30
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
    event.stopPropagation();

    let item;
    const guardian = gameState.guardians[key];

    switch(type) {
        case 'strategy':
            item = guardian.strategy[idx];
            break;
        case 'portfolio':
            item = guardian.portfolio[idx];
            break;
        case 'adhocObservations':               // ← 新增这个分支
            item = guardian.adhocObservations[idx];
            break;
        default:
            console.warn('Unknown sparkline type:', type);
            return;
    }

    if (!item || !item.history || item.history.length === 0) {
        console.warn('No valid item or history for spark click', {key, type, idx});
        return;
    }

    const color = GUARDIAN_COLORS[key] || '#fff';
    openDetailChart(item, color);
}

// [新增] 替换原来的 openDetailChart 函数（核心逻辑带涨跌幅量化）
function openDetailChart(item, color) {
    if (!item.history || item.history.length === 0) return;
    
    // ================== 核心修改开始 ==================
    // 默认使用 Excel/策略中的基准价
    let calcRefPrice = item.refPrice;

    // 特殊处理：如果存在官方涨跌幅（说明已收盘或API数据有效），
    // 无论 Excel 中的 refPrice 是否被更新为今日收盘价，我们都利用涨跌幅反推“真正的昨日收盘价”
    // 公式：昨日收盘价 = 当前价格 / (1 + 涨跌幅%)
    if (item.officialChangePercent !== null && item.officialChangePercent !== undefined && item.currentPrice) {
        calcRefPrice = item.currentPrice / (1 + item.officialChangePercent / 100);
    }
    
    // 兜底：如果算出来是 NaN 或者 0（新股），就用历史第一笔数据
    if (!calcRefPrice) {
        calcRefPrice = item.history[0];
    }
    // ================== 核心修改结束 ==================

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
                    data: [], 
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
                            // 使用反算出来的 calcRefPrice 进行计算
                            const chg = ((val - calcRefPrice) / calcRefPrice * 100).toFixed(2);
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

        detailChart.data.datasets[0].data = currentSlice;
        detailChart.update('none');

        if (lastPrice) {
            // 使用反算出来的 calcRefPrice 计算顶部的动态百分比
            const currentChg = ((lastPrice - calcRefPrice) / calcRefPrice * 100).toFixed(2);
            pctEl.innerText = (currentChg > 0 ? '+' : '') + currentChg + '%';
            // 颜色逻辑：涨跌对比基准
            pctEl.style.color = lastPrice >= calcRefPrice ? '#EF4444' : '#10B981';
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
            // 【修改处】：增加 { cache: 'no-store' } 配置
            const res = await fetch(url, { cache: 'no-store' });
            const json = await res.json();            
            const data = json.结果 || json;
            // 后续代码保持不变
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
        // 【修改处】：增加 { cache: 'no-store' }
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error("SweetPoint fetch failed");
        //后续代码保持不变
        
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

                        // 【核心修复】不仅在 strategy 中找，也要在 adhocObservations 中找
                        // 这样刷新页面后，买入的 Adhoc 股票也能获取到正确的昨日收盘价(refPrice)
                        let sourceItem = g.strategy.find(s => s.code === code);
                        if (!sourceItem) {
                            sourceItem = g.adhocObservations.find(s => s.code === code);
                        }

                        // 3. 获取昨日收盘价（参考价）
                        let yesterdayClose = sourceItem ? sourceItem.refPrice : null;

                        // 【修改点】: 如果 sourceItem 为空（或者找到了但没有价格），尝试从 Excel 的“收盘价格”读取
                        if (!sourceItem || yesterdayClose === null || yesterdayClose === undefined) {
                            const excelClosePrice = row['收盘价格']; // 获取Excel该行数据
                            if (excelClosePrice !== undefined && excelClosePrice !== '') {
                                const parsedPrice = parseFloat(excelClosePrice);
                                if (!isNaN(parsedPrice)) {
                                    yesterdayClose = parsedPrice;
                                    // 可选：如果是新出现的股票，这里也可以打印个日志方便调试
                                    // console.log(`使用Excel收盘价作为参考: ${code} - ${parsedPrice}`);
                                }
                            }
                        }
                
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
    if (hasClosedPrices && !forceFetch) {
        log("Market closed. Skipping price data fetch.", "#666");
        for (let k in gameState.guardians) {
            const g = gameState.guardians[k];
            let portRtn = calculateUserRtn(k);
            const userRtnElem = document.getElementById(`user-rtn-${k}`);
            userRtnElem.innerText = portRtn.toFixed(2) + "%";
            userRtnElem.className = portRtn >= 0 ? "stat-value user-stat text-up" : "stat-value user-stat text-down";
            renderLists(k); 
        }
        return; 
    }

    log("Sync Price Data", "#aaa"); 
    let allPricesFetchedSuccessfully = true; 

    for (let k in gameState.guardians) {
        const g = gameState.guardians[k];
        let currentAssets = 0;
        
        // 1. Update Strategy Prices
        let systemRtn = 0; 
        for (let s of g.strategy) {
            await fetchPrice(s); 
            if (s.currentPrice === null) allPricesFetchedSuccessfully = false; 

            if (s.currentPrice && s.refPrice) {
                 if (s.isAdhoc !== true) { 
                     const chg = (s.currentPrice - s.refPrice) / s.refPrice;
                     systemRtn += chg * (s.weight / 100);
                 }
            }
        }

         // =========== 【修改开始】 ===========
        // 将计算出的组合满仓收益率，乘以策略的风控仓位因子 (Power)
        // 例如：组合涨幅 1%，但 Power 为 0.5 (半仓)，则系统收益应为 0.5%
        if (g.power !== undefined && g.power !== null) {
            systemRtn = systemRtn * g.power;
        }
        // =========== 【修改结束】 ===========

        // 【新增】Update ADHOC Prices (修复问题1：Adhoc区域微图为空)
        // 必须获取价格，adhoc对象才有history数据用于画图
        for (let s of g.adhocObservations) {
            await fetchPrice(s);
            // adhoc 股票通常不计入 systemRtn 模型收益，所以这里不累加 systemRtn
        }

        // --- 更新数值和颜色 ---
        const sysRtnElem = document.getElementById(`rtn-${k}`);
        const cardElem = document.getElementById(`card-${k}`);
        
        if (sysRtnElem) {
            sysRtnElem.innerText = (systemRtn * 100).toFixed(2) + "%";
            sysRtnElem.className = systemRtn >= 0 ? "stat-value text-up" : "stat-value text-down";
        }

        if (systemRtn > 0) {
            cardElem.classList.add('active'); 
        } else {
            cardElem.classList.remove('active'); 
        }              
       
        // 2. Update Portfolio Prices & Value
        for (let p of g.portfolio) {
            if (p.isCash) {
                currentAssets += 100000 * (p.weight / 100); 
            } else {
                await fetchPrice(p); 
                if (p.currentPrice === null) allPricesFetchedSuccessfully = false; 
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
    
    log("Sync Price Data Finish", "#aaa"); 

    if (isMarketClosed() && allPricesFetchedSuccessfully && !hasClosedPrices) {
        hasClosedPrices = true; 
        if (priceUpdateInterval) {
            clearInterval(priceUpdateInterval); 
            priceUpdateInterval = null; 
        }
        log("Market closed. Prices locked.", "yellow");
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
        // 【建议修改】：加上 cache: 'no-store'
        const intradayRes = await fetch(intradayUrl, { cache: 'no-store' }); 
        const intradayJson = await intradayRes.json();
        if (intradayJson && intradayJson.length > 0) {
            intradayData = intradayJson.map(d => parseFloat(d.price));
        }

        // 步骤 2: 如果市场已关闭，额外获取官方收盘价格
        if (marketIsClosed) {
            const closePriceUrl = `${REAL_API_URL}?code=${finalCode}&type=price`; // 参数修改为 price
             // 【建议修改】：加上 cache: 'no-store'
            const closePriceRes = await fetch(closePriceUrl, { cache: 'no-store' });
            const closePriceJson = await closePriceRes.json();
            // =========== 修改开始 ===========
            if (closePriceJson) {
                // 情况 A: API 返回对象且包含 latestPrice (你的当前情况)
                if (closePriceJson.latestPrice !== undefined) {
                    closingPriceApiResult = parseFloat(closePriceJson.latestPrice);
                    // 【优化点】提取官方涨跌幅 (API返回的是 4.68 这种直接数值，不是 0.0468)
                    if (closePriceJson.changePercent !== undefined) {
                        officialChangePercent = parseFloat(closePriceJson.changePercent);
                    }
                } 
                // 情况 B: API 返回对象但字段名为 price (防御性编程)
                else if (closePriceJson.price !== undefined) {
                    closingPriceApiResult = parseFloat(closePriceJson.price);
                }
                // 情况 C: API 返回数组 (兼容旧逻辑)
                else if (Array.isArray(closePriceJson) && closePriceJson.length > 0) {
                    closingPriceApiResult = parseFloat(closePriceJson[closePriceJson.length - 1].price);
                }
            }
            // =========== 修改结束 ===========
        }
        
        // 步骤 3: 根据市场状态和获取到的数据，确定最终的 currentPrice, refPrice 和 history
        if (marketIsClosed && closingPriceApiResult !== null) {
            // 市场已关闭，且成功获取到官方收盘价
            item.currentPrice = closingPriceApiResult;
            // 【优化点】保存官方涨跌幅到 item 对象
            item.officialChangePercent = officialChangePercent; 
            
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
            // 交易时间段，清除官方收盘涨跌幅，强制使用实时计算
            item.officialChangePercent = null; 
            item.history = intradayData;
            
            // 如果 refPrice 未设置 (Excel 中没有)，则使用分钟线的第一个价格作为开盘价
            if (item.refPrice === undefined || item.refPrice === null) {
                item.refPrice = intradayData[0];
            }
        } else {
            item.officialChangePercent = null;
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
        // 错误处理中也要清除官方涨跌幅，防止显示过期数据
        item.officialChangePercent = null; 
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

    const adhoclistEl = document.getElementById(`adhoc-list-${key}`);
    adhoclistEl.innerHTML = '';
    g.adhocObservations.forEach((s, i) => {
        const el = createRow(key, s, i, 'adhocObservations');
        el.onclick = () => selectadhocObservationsItem(key, i);
        if(g.selectedBuy === i) el.classList.add('selected');
        adhoclistEl.appendChild(el);
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
    let deleteHtml = (type === 'adhocObservations' && item.isAdhoc) ? 
        `<span class="delete-btn" onclick="removeAdhocItem(event, '${key}', ${idx})">−</span>` : '';

    let nameHtml = `<div class="h-name-wrapper"><span class="h-name">${iconPrefix}${item.name}</span>${deleteHtml}</div>`;
    //let nameHtml = `${iconPrefix}${item.name}`;

    let wHtml = "";
    let pHtml = "";
    
    // --- 修改开始：显示逻辑优化 ---
    if (item.currentPrice) {
        let chgPctDisplay = 0; // 用于显示的百分比数值 (例如 4.68)
        let rawChgForColor = 0; // 用于判断颜色的数值

        // 1. 如果有 API 返回的官方收盘涨跌幅，优先使用
        if (item.officialChangePercent !== null && item.officialChangePercent !== undefined) {
            chgPctDisplay = item.officialChangePercent;
            rawChgForColor = chgPctDisplay; // 正数即涨，负数即跌
        } 
        // 2. 否则使用本地计算: (现价 - 基准价) / 基准价
        else if (item.refPrice) {
            const chgDecimal = (item.currentPrice - item.refPrice) / item.refPrice;
            chgPctDisplay = chgDecimal * 100; // 转换为百分比，例如 0.0468 -> 4.68
            rawChgForColor = chgDecimal;
        }

        const cls = rawChgForColor >= 0 ? "text-up" : "text-down";
        
        // 渲染 HTML
        pHtml = `<span class="h-price ${cls}">${item.currentPrice.toFixed(2)}</span>
                 <span class="h-pct ${cls}">${chgPctDisplay.toFixed(2)}%</span>`;
    } else {
        pHtml = `<span class="h-price">${item.currentPrice ? item.currentPrice.toFixed(2) : '--'}</span>`;
    }
    // --- 修改结束 ---

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
                // 1. 计算画图用的基准价 (沿用之前的逻辑，反算或兜底)
                // 这一步是为了防止微图变成一条直线，必须保证 safeRefPrice 是“昨收”
                let safeRefPrice = item.refPrice;
                if (item.officialChangePercent !== null && item.officialChangePercent !== undefined && item.currentPrice) {
                     safeRefPrice = item.currentPrice / (1 + item.officialChangePercent / 100);
                } else {
                     safeRefPrice = (item.refPrice && item.refPrice > 0) ? item.refPrice : item.history[0];
                }
        
                // 2. 【核心修复】决定线条颜色
                let lineColor = '#EF4444'; // 默认红色
                
                // 优先根据官方涨跌幅判断颜色
                if (item.officialChangePercent !== null && item.officialChangePercent !== undefined) {
                    // 如果涨跌幅 < 0 则绿，否则红 (>=0)
                    lineColor = item.officialChangePercent < 0 ? '#10B981' : '#EF4444';
                } else {
                    // 兜底：如果没有官方涨跌幅，才比较现价和基准价
                    lineColor = item.currentPrice < safeRefPrice ? '#10B981' : '#EF4444';
                }
                
                drawSpark(`chart-${key}-${type}-${idx}`, item.history, safeRefPrice, lineColor);
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
    gameState.guardians[key].selectedSource = 'strategy'; // 【新增】标记来源
    const item = gameState.guardians[key].strategy[idx];
    const price = item.currentPrice || item.refPrice;
    document.getElementById(`buy-price-${key}`).value = price ? price.toFixed(2) : ""; 
    document.getElementById(`buy-weight-${key}`).value = item.weight.toFixed(2);
    renderLists(key);
    calcQty(key, 'buy');
}

function selectadhocObservationsItem(key, idx) {
    gameState.guardians[key].selectedBuy = idx;
    gameState.guardians[key].selectedSource = 'adhoc'; // 【新增】标记来源
    const item = gameState.guardians[key].adhocObservations[idx];
    const price = item.currentPrice || item.refPrice;
    document.getElementById(`buy-price-${key}`).value = price ? price.toFixed(2) : ""; 
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
        
        // 【核心修复】根据来源获取正确的 Item
        let item;
        if (g.selectedSource === 'adhoc') {
            item = g.adhocObservations[g.selectedBuy];
        } else {
            // 默认为 strategy，兼容旧逻辑
            item = g.strategy[g.selectedBuy];
        }

        // 防御性检查
        if (!item) {
             msgEl.innerText = `ERR: Item not found`; msgEl.style.color="red"; return;
        }

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
            // Adhoc 股票买入后将进入 Portfolio
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
                    if (!g.adhocObservations.some(s => s.code === String(row["股票代码"]))) {
                        // --- 修改：读取收盘价格作为基准价 ---
                        const excelClosePrice = row["收盘价格"] ? parseFloat(row["收盘价格"]) : null;
                        
                        g.adhocObservations.push({
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
            const adhocItems = g.adhocObservations; // 不再从 strategy 中 filter
            
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

// ================= MODIFIED: loadHistoryData =================
async function loadHistoryData() {
    log("Loading Historical Data...", "#88f");

    // 1. 定义基础文件 (Main Lines)
    const basicFiles = { ...HISTORY_FILES, ...EXTRA_HISTORY_FILES };
    
    // 2. 定义变体文件映射 (N+2 和 N+3)
    const variantFiles = [];
    const variants = ['N+2', 'N+3'];
    
    // 【关键修复】：辅助函数确保 GENBU 返回 '低波稳健' 而不是 '低波'
    const getPrefix = (key) => {
        if (key === 'suzaku') return '大成';
        if (key === 'sirius') return '流入';
        if (key === 'genbu') return '低波稳健'; // <--- 必须完全匹配文件名中的中文
        if (key === 'kirin') return '大智';
        return '';
    };

    // 构建待请求列表
    // 最终生成的文件名示例：'低波稳健模型优化后评估_N+2.json'
    variants.forEach(v => {
        ['suzaku', 'sirius', 'genbu', 'kirin'].forEach(key => {
            const prefix = getPrefix(key);
            // 只有当 v 是 'N+2' 时后缀为 'n2'，用于内部 dataKey (如 genbu_n2)
            const suffix = v === 'N+2' ? 'n2' : 'n3';
            
            if (prefix) {
                variantFiles.push({
                    dataKey: `${key}_${suffix}`, // 这里的 key 必须对应 historyData.datasets 的索引
                    file: `${prefix}模型优化后评估_${v}.json` // 这里必须对应实际 OSS/GitHub 文件名
                });
            }
        });
    });

    // 3. 发起所有请求 (基础 + 变体)
    const basicKeys = Object.keys(basicFiles);
    const basicPromises = basicKeys.map(key => {
        const url = getResourceUrl(basicFiles[key]);
        // 【修改处】：增加 { cache: 'no-store' }
        return fetch(url, { cache: 'no-store' }).then(res => {
            if (!res.ok) throw new Error(res.statusText);
            return res.json();
        }).catch(err => {
            console.warn(`Failed to load base file for ${key}:`, err);
            return null;
        });
    });

    const variantPromises = variantFiles.map(item => {
        const url = getResourceUrl(item.file);
        // 【修改处】：增加 { cache: 'no-store' }
        return fetch(url, { cache: 'no-store' }).then(res => {
            if (!res.ok) throw new Error(res.statusText);
            return res.json();
        }).catch(err => {
            console.warn(`Failed to load variant file ${item.file}:`, err);
            return null;
        });
    });

    const [basicResults, variantResults] = await Promise.all([
        Promise.all(basicPromises),
        Promise.all(variantPromises)
    ]);

    // 4. 处理日期 (收集所有可能出现的日期，确保 N+2/N+3 的日期也被包含)
    let allDatesSet = new Set();
    const collectDates = (json) => {
        if (json && json.每日评估数据) {
            json.每日评估数据.forEach(item => allDatesSet.add(item.日期));
        }
    };
    basicResults.forEach(collectDates);
    variantResults.forEach(collectDates);

    historyData.dates = Array.from(allDatesSet).sort();

    // 5. 解析基础数据
    basicResults.forEach((json, index) => {
        const key = basicKeys[index];
        historyData.datasets[key] = mapJsonToData(json, historyData.dates);
        
        // 特殊处理 Guardians 里的标普500
        if (key === 'guardians' && json) {
            let sp500Val = json["标普500收益率"] !== undefined ? json["标普500收益率"] * 100 : 0;
            historyData.datasets['sp500'] = historyData.dates.map(() => sp500Val);
        }
    });

   // 6. 解析变体数据
    variantResults.forEach((json, index) => {
        const item = variantFiles[index];
        
        // 【修复点 1】：先判断 json 及其关键属性是否存在，再进行处理
        if (json && Array.isArray(json.每日评估数据)) {
            historyData.datasets[item.dataKey] = mapJsonToData(json, historyData.dates);
            // 【修复点 2】：安全地访问 length
            console.log(`Loaded ${item.file} -> ${item.dataKey}, points: ${json.每日评估数据.length}`);
        } else {
            console.warn(`Data missing or invalid format for ${item.file}`);
            // 【建议】：如果数据缺失，给一个空数组，防止图表渲染时报错
            historyData.datasets[item.dataKey] = [];
        }
    });

    renderHistoryChart();
}

// 辅助函数：将JSON数据映射到对齐的日期数组
function mapJsonToData(json, sortedDates) {
    if (!json || !json.每日评估数据) return [];
    const map = new Map();
    json.每日评估数据.forEach(d => map.set(d.日期, d.累计收益率 * 100));
    // 如果某天没有数据，图表库会自动处理 null (断开或跨越)
    return sortedDates.map(date => map.has(date) ? map.get(date) : null);
}

// ================= MODIFIED: renderHistoryChart =================
// 1. 定义全局变量存储 Checkbox 状态，避免每次去 DOM 读取
let showN2 = false;
let showN3 = false;

// ================= FIXED: renderHistoryChart =================
// ================= 修复：使用ResizeObserver确保DOM稳定 =================

    const chartContainer = document.getElementById('settlementPanel');
    const canvas = document.getElementById('performanceChart');
    
    // 1. 显示容器
    chartContainer.style.display = 'block';
    
    // [修改] 优化 Canvas 高度，防止手机上太扁
    canvas.style.minHeight = "300px"; 

    // 2. 插入控制开关 (包含 Checkbox 和 新增的下拉菜单)
    let controlsDiv = document.getElementById('chartVariantControls');
    
    // 如果控制栏不存在，则创建
    if (!controlsDiv) {
        controlsDiv = document.createElement('div');
        controlsDiv.id = 'chartVariantControls';
        // [修改] 样式调整，适应手机端换行
        controlsDiv.style.cssText = "display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px; margin-bottom:10px; font-size:12px; color:#aaa;";
        canvas.parentNode.insertBefore(controlsDiv, canvas);
    }

    // 动态刷新控制栏内容 (确保 Select 状态同步)
    // 注意：这里使用 innerHTML 重新生成，确保下拉框选中状态正确
    controlsDiv.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px; margin-right:auto;">
            <span style="color:#888;">Range:</span>
            <select onchange="window.updateChartRange(this.value)" style="background:#222; color:#fff; border:1px solid #444; padding:2px 5px; border-radius:4px; font-size:11px;">
                <option value="all" ${currentChartRange === 'all' ? 'selected' : ''}>All History</option>
                <option value="ytd" ${currentChartRange === 'ytd' ? 'selected' : ''}>Year to Date</option>
                <option value="1w"  ${currentChartRange === '1w' ? 'selected' : ''}>Last 5 Days</option>
            </select>
        </div>

        <label style="cursor:pointer; display:flex; align-items:center;">
            <input type="checkbox" id="toggleN2" onchange="window.toggleVariantState('n2')" ${typeof showN2 !== 'undefined' && showN2 ? 'checked' : ''} style="margin-right:5px;"> 
            <span style="border-bottom: 2px dashed #888">N+2</span>
        </label>
        <label style="cursor:pointer; display:flex; align-items:center;">
            <input type="checkbox" id="toggleN3" onchange="window.toggleVariantState('n3')" ${typeof showN3 !== 'undefined' && showN3 ? 'checked' : ''} style="margin-right:5px;"> 
            <span style="border-bottom: 2px dotted #888">N+3</span>
        </label>
    `;

    // 3. 销毁旧图表
    if (perfChart) {
        perfChart.destroy();
        perfChart = null;
    }

    // 4. 计算数据切片 (核心新增逻辑)
    // 根据 selected range 决定从哪里开始 slice
    let sliceStartIndex = 0;
    const allDates = historyData.dates || [];
    const totalPoints = allDates.length;

    if (currentChartRange === 'ytd') {
        // 今年 (Year to Date)
        const currentYear = new Date().getFullYear(); // 获取本地当前年份
        // 找到第一个日期大于等于 "YYYY-01-01" 的索引
        // 假设日期格式为 "YYYY-MM-DD" 或类似可比较字符串
        const startStr = `${currentYear}-01-01`;
        const idx = allDates.findIndex(d => d >= startStr);
        sliceStartIndex = idx >= 0 ? idx : 0;
    } else if (currentChartRange === '1w') {
        // 最近一周 (最近5个交易日)
        sliceStartIndex = Math.max(0, totalPoints - 5);
    } else {
        // All
        sliceStartIndex = 0;
    }

    // 生成当前视图用的 Label
    const viewDates = allDates.slice(sliceStartIndex);

    // 5. 延迟初始化图表
    setTimeout(() => {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // --- 数据集构建逻辑 (修改：增加 .slice(sliceStartIndex)) ---
        const createDataset = (label, color, dataKey, groupKey, options = {}) => {
            const fullData = historyData.datasets[dataKey] || [];
            return {
                label: label, 
                borderColor: color, 
                backgroundColor: color + '1A',
                data: fullData.slice(sliceStartIndex), // [核心修改] 切片数据
                tension: 0.3, 
                pointRadius: 0, 
                borderWidth: 2, 
                spanGaps: true,
                order: 1, 
                isMain: true,
                groupKey: groupKey, 
                ...options
            };
        };

        const createVariantDataset = (parentLabel, parentKey, type, color, groupKey) => {
            const isN2 = type === 'n2';
            const fullData = historyData.datasets[`${parentKey}_${type}`] || [];
            return {
                label: `${parentLabel} ${isN2 ? '(N+2)' : '(N+3)'}`,
                data: fullData.slice(sliceStartIndex), // [核心修改] 切片数据
                borderColor: color,
                borderWidth: 1.5,
                borderDash: isN2 ? [6, 4] : [2, 3], 
                pointRadius: 0,
                tension: 0.3,
                fill: false,
                hidden: true, // 默认隐藏，由 updateVariantVisibility 控制
                order: 10,
                variantType: type,
                groupKey: groupKey,
                isMain: false
            };
        };

        const datasets = [
            createDataset('Guardians', '#FFD700', 'guardians', 'guardians', { borderWidth: 3, order: 0 }),
            createDataset('User', '#00FFFF', 'user', 'user', { borderWidth: 2, order: 2 }),
            createDataset('S&P 500', '#666666', 'sp500', 'sp500', { borderDash: [5, 5], borderWidth: 1, order: 99 }),
        ];

        const beasts = [
            { key: 'suzaku', label: 'SUZAKU' },
            { key: 'sirius', label: 'SIRIUS' },
            { key: 'genbu',  label: 'GENBU' },
            { key: 'kirin',  label: 'KIRIN' }
        ];

        beasts.forEach(b => {
            const color = GUARDIAN_COLORS[b.key];
            datasets.push(createDataset(b.label, color, b.key, b.key));
            datasets.push(createVariantDataset(b.label, b.key, 'n2', color, b.key));
            datasets.push(createVariantDataset(b.label, b.key, 'n3', color, b.key));
        });

        // --- 初始化 Chart ---
        perfChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: viewDates, // 使用切片后的日期
                datasets: datasets
            },
            options: {
                responsive: true, 
                maintainAspectRatio: false, 
                // [修改] 增加底部 Padding，解决手机上X轴标签被切断的问题
                layout: {
                    padding: {
                        left: 0,
                        right: 0,
                        top: 10,
                        bottom: 25 // 增加底部空间
                    }
                },
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
                plugins: { 
                    legend: { 
                        display: true,
                        labels: { 
                            color: '#ccc',
                            font: { size: 12 },
                            boxWidth: 12, // 稍微调小图例图标以节省空间
                            padding: 15,
                            filter: function(item, chartData) {
                                const ds = chartData.datasets[item.datasetIndex];
                                return ds.isMain === true;
                            }
                        },
                        onClick: function(e, legendItem, legend) {
                            // 保持原有的图例点击逻辑
                            const chart = legend.chart;
                            const clickedDatasetIndex = legendItem.datasetIndex;
                            const dataset = chart.data.datasets[clickedDatasetIndex];
                            
                            if (!legendItem.datasetIndex && legendItem.datasetIndex !== 0) return;
                            
                            const meta = chart.getDatasetMeta(clickedDatasetIndex);
                            const isCurrentlyVisible = !meta.hidden;
                        
                            chart.data.datasets.forEach((ds, idx) => {
                                if (ds.groupKey === dataset.groupKey) {
                                    if (isCurrentlyVisible) chart.hide(idx);
                                    else chart.show(idx);
                                }
                            });
                        
                            legendItem.hidden = isCurrentlyVisible;
                            chart.update();
                        
                            if (typeof window.updateVariantVisibility === 'function') {
                                setTimeout(window.updateVariantVisibility, 50);
                            }
                        }
                    },       
                    tooltip: {
                        itemSort: (a, b) => {
                            const A = a.dataset.isMain ? 0 : 1;
                            const B = b.dataset.isMain ? 0 : 1;
                            return A - B;
                        }
                    }
                },
                scales: { 
                    y: { 
                        ticks: { color: '#666' }, 
                        grid: { color: '#333' } 
                    }, 
                    x: { 
                        ticks: { 
                            color: '#666', 
                            maxTicksLimit: 6, // 限制X轴标签数量，防止拥挤
                            maxRotation: 0,   // 防止标签倾斜导致占用过多垂直空间
                            autoSkip: true
                        }, 
                        grid: { color: '#333' } 
                    } 
                }
            }
        });

        // 强制刷新 N+2/N+3 的显示状态
        if (typeof window.updateVariantVisibility === 'function') {
            window.updateVariantVisibility();
        }

    }, 50);
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
