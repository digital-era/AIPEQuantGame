// ================= CONFIG =================
// const STS_API_URL = 'https://aiep-users.vercel.app/api/sts'; 
// const STS_API_URL = 'https://aipeinvestmentagent.pages.dev/api/sts-credentials'; 
const STS_API_URL = "/api/user-sts-credentials"; 

let OSS_BUCKET = 'aiep-users'; 
let OSS_REGION = 'cn-hangzhou'; 
let ACCESS_KEY_ID = ''; 
let ACCESS_KEY_SECRET = ''; 
let STS_ROLE_ARN = ''; 

let OSS_FILE_NAME = 'AIPEQuantGuardiansPortfolio.xlsx';

const OSS_JSON_PATH = 'QuantGuardians综合评估.json';    
const INITIAL_CAPITAL = 100000.0;

window.OSS_CONFIG = {
  // 建议统一键名，这里保持原样，但下方的保存逻辑需要适配它
  OSS_REGION: 'cn-hangzhou', 
  OSS_BUCKET: '',    
  ACCESS_KEY_ID: '', 
  ACCESS_KEY_SECRET: '',
  STS_ROLE_ARN: '',
};

const GITHUB_USER = 'digital-era';
const GITHUB_REPO = 'AIPEQModel';
const GITHUB_BRANCH = 'main';
// const REAL_API_URL = 'https://aipeinvestmentagent.pages.dev/api/rtStockQueryProxy';
const REAL_API_URL = '/api/query';

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
    user: getSecureOssPath('User模型综合评估.json')
};

// 用于存储当前选择的指标，默认为累计收益率
let currentMetric = 'cumulative'; // 'cumulative' | 'drawdown' | 'sharpe'
let showN2 = false;
let showN3 = false;
// 缓存图表实例
let perfChart = null; 

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

let historyData = { dates: [], datasets: {} };

// ======== 新增全局变量和辅助函数 START ========
let priceUpdateInterval = null; // 用于存储 setInterval 的 ID，以便在市场关闭时清除
let hasClosedPrices = false;    // 标识收盘价格是否已获取并锁定

// [新增] 全局变量存储当前时间范围选择状态
let currentChartRange = 'all'; // 可选值: 'all', 'ytd', '1w'

// [新增] 行业数据存储（使用无原型对象极其节省内存）
let industryData = Object.create(null);

// 页面加载逻辑
document.addEventListener('DOMContentLoaded', function() {
    var saved = localStorage.getItem('OSS_CONFIG_STORE');
    if (saved) {
        try {
            var parsed = JSON.parse(saved);
            // 将读取到的配置覆盖到 window.OSS_CONFIG
            // 注意：这里假设 LocalStorage 存的键名与 window.OSS_CONFIG 一致
            if (parsed.OSS_REGION) window.OSS_CONFIG = parsed;

            // 填充 Input (确保这里读取的键名与保存时的一致)
            document.getElementById('oss_region').value = parsed.OSS_REGION || '';
            document.getElementById('oss_bucket').value = parsed.OSS_BUCKET || '';
            document.getElementById('oss_ak_id').value = parsed.ACCESS_KEY_ID || '';
            document.getElementById('oss_ak_secret').value = parsed.ACCESS_KEY_SECRET || '';
            document.getElementById('oss_stc_rolearn').value = parsed.STS_ROLE_ARN || '';
            
            // 同时更新全局变量
            OSS_REGION = parsed.OSS_REGION || OSS_REGION;
            OSS_BUCKET = parsed.OSS_BUCKET || OSS_BUCKET;
            ACCESS_KEY_ID = parsed.ACCESS_KEY_ID || '';
            ACCESS_KEY_SECRET = parsed.ACCESS_KEY_SECRET || '';
            STS_ROLE_ARN = parsed.STS_ROLE_ARN || '';

        } catch (e) {
            console.error("Config load error", e);
        }
    }
});

// 保存设置并显示提示
function saveOssSettings() {
    var regionVal = document.getElementById('oss_region').value;
    var bucketVal = document.getElementById('oss_bucket').value;
    var idVal = document.getElementById('oss_ak_id').value;
    var secretVal = document.getElementById('oss_ak_secret').value;
    var arnVal = document.getElementById('oss_stc_rolearn').value;
    var statusMsg = document.getElementById('save-status-msg');

    // 简单的非空校验
    if(!regionVal || !bucketVal || !idVal || !secretVal || !arnVal) {
        if(statusMsg) {
            statusMsg.style.color = "#EF4444"; 
            statusMsg.innerText = ">> ERROR: MISSING FIELDS <<";
        }
        return;
    }

    // 【修正】结构与 window.OSS_CONFIG 保持一致
    var newConfig = {
        OSS_REGION: regionVal,
        OSS_BUCKET: bucketVal,
        ACCESS_KEY_ID: idVal,
        ACCESS_KEY_SECRET: secretVal,
        STS_ROLE_ARN: arnVal
    };
    
    // 更新全局配置对象
    window.OSS_CONFIG = newConfig;
    
    // 【修正】更新全局独立变量 (使用正确的值来源)
    OSS_BUCKET = regionVal; // 注意：原代码逻辑可能是想分别赋值，但通常有了 OSS_CONFIG 就不需要单独变量，这里为了兼容保留
    OSS_REGION = bucketVal; // ⚠️ 注意：原代码这里 OSS_BUCKET 和 OSS_REGION 可能弄反了，请根据实际情况检查
    // 修正后的赋值：
    OSS_REGION = regionVal;
    OSS_BUCKET = bucketVal;
    ACCESS_KEY_ID = idVal; 
    ACCESS_KEY_SECRET = secretVal;
    STS_ROLE_ARN = arnVal; 
    
    localStorage.setItem('OSS_CONFIG_STORE', JSON.stringify(newConfig));

    // 成功的视觉反馈
    if(statusMsg) {
        statusMsg.style.color = "#10B981"; 
        statusMsg.innerText = ">> SYSTEM UPDATED SUCCESSFULLY <<";
        setTimeout(function() {
            statusMsg.innerText = "";
        }, 1500);
    }
};

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
    if ((hours > 16 || (hours === 16 && minutes > 30)) || (hours < 9 || (hours === 9 && minutes < 15))) {
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
    let items; // 【修正】增加 items 变量声明，防止污染全局变量
    const guardian = gameState.guardians[key];

    switch(type) {
        case 'strategy':
            item = guardian.strategy[idx];
            items = guardian.strategy;
            break;
        case 'portfolio':
            item = guardian.portfolio[idx];
            items = guardian.portfolio;
            break;
        case 'adhocObservations':               // ← 新增这个分支
            item = guardian.adhocObservations[idx];
            items = guardian.adhocObservations;
            break;
        default:
            console.warn('Unknown sparkline type:', type);
            return;
    }

    // 【核心修改】：放开对 history 数组长度的严格限制
    // 只要 item 对象存在，就允许打开模态框，以便用户查看 30日、行业 等其他数据
    if (!item) {
        console.warn('No valid item for spark click', {key, type, idx});
        return;
    }

    // 防御性编程：如果 history 不存在，给一个空数组，防止 openDetailChart 内部报错
    if (!item.history) {
        item.history = [];
    }

    const color = GUARDIAN_COLORS[key] || '#fff';
    
    // 打开详情图表（此时即使用户的分钟线画出来是空的，也可以手动切到 30Days 或 Industry）
    openDetailChart(items, item, color);
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
            
            // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
            // 优雅新增: 如果全局日期大于策略决策日期，则跳过后续加载 (Early Return)
            if (gmarketdate && gmarketdate > data.风控因子信息.决策日期) {
                log(`[${key}] Skipped: Date ${data.风控因子信息.决策日期} Outdated`, "yellow");
                return; 
            }
            // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
          
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
    // --- 修改结束 ---            
    
    try {
        // 1. 发起请求
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error("SweetPoint fetch failed");
        
        // 【核心修复点】：添加下面这一行，将响应解析为 JSON 数据赋值给 json 变量
        const json = await res.json(); 

        // 2. 这里的 json 变量现在定义好了，可以使用了
        const sweetCodes = new Set(json.map(item => item.代码));

        let count = 0;
        // 遍历所有守护者
        for (let key in gameState.guardians) {
            gameState.guardians[key].strategy.forEach(stock => {
                // 注意：你的JSON里"代码"是字符串(如"001255")，请确保 stock.code 也是字符串格式
                if (sweetCodes.has(stock.code)) {
                    stock.isSweet = true; // 标记为真
                    count++;
                }
            });
        }
        log(`Sweet Points Applied: ${count}`, "#d8bfd8");
    } catch (e) { 
        log("SweetPoint Err: " + e.message, "orange"); 
    }
}

async function loadCloudPortfolio() {
    log("Syncing Cloud Portfolio...", "#88f");
    if (!await initOSS()) return;
    try {
        const result = await ossClient.get(getSecureOssPath(OSS_FILE_NAME));
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

function calculateUserRtn(key) {
    const g = gameState.guardians[key];
    const flowName = GUARDIAN_CONFIG[key].flowName;
    const initialTotalAssets = 100000; // 每日初始虚拟资金基数
    
    // 1. 获取今日该守护者的所有内存操作记录
    const todayFlows = memoryFlows.filter(f => f.sheet === flowName);
    
    let totalPnL = 0;

    // --- 第一部分：计算当前 Portfolio 中标的的浮动盈亏 (相对于开盘价/基准价) ---
    g.portfolio.forEach(p => {
        if (p.isCash) return; // 跳过现金
        
        // 优先从 portfolio 找现价，找不到则视为无波动
        const nowPrice = p.currentPrice;
        const refPrice = p.refPrice; // 这里的 refPrice 是今日开盘价/基准价

       // 【增加 refPrice > 0 校验防崩溃】
        if (nowPrice && refPrice && refPrice > 0) {
            const chgRatio = (nowPrice - refPrice) / refPrice; 
            const currentWeightValue = initialTotalAssets * (p.weight / 100); 
            
            totalPnL += currentWeightValue * chgRatio; 
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
// ===================== 新增辅助函数 =====================
// 用于控制请求间隔的 sleep 函数
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function updateMarketData(forceFetch = false) {
    // 1. 休市检查逻辑 (保持原版逻辑)
    if (hasClosedPrices && !forceFetch) {
        log("Market closed. Skipping price data fetch.", "#666");
        Object.keys(gameState.guardians).forEach(k => recalculateAndRenderGuardian(k));
        return true; 
    }

    log("Sync Price Data (Fair-Throttled Mode) Started", "#aaa"); 
    
    // 2. 全局去重，并按照 Guardian 建立各自的“专属队列”
    const uniqueStocksMap = new Map(); 
    const guardianQueues = {}; 
    const guardianKeys = Object.keys(gameState.guardians);
    
    guardianKeys.forEach(key => {
        guardianQueues[key] = [];
    });

    // 遍历收集数据
    guardianKeys.forEach(guardianKey => {
        const g = gameState.guardians[guardianKey];
        const allItems = [
            ...g.strategy, 
            ...g.adhocObservations, 
            ...g.portfolio.filter(p => !p.isCash)
        ];

        allItems.forEach(item => {
            if (!item.code) return;
            
            // 全局首次遇到该代码
            if (!uniqueStocksMap.has(item.code)) {
                uniqueStocksMap.set(item.code, []);
                // 放入首次发现它的 Guardian 队列
                guardianQueues[guardianKey].push(item.code);
            }
            
            // 记录引用关系
            uniqueStocksMap.get(item.code).push({ item, guardianKey });
        });
    });

    // 3. 轮询发牌（Round-Robin）合并队列，保证 4 个面板进度公平
    const fairUniqueCodes = [];
    let hasMore = true;
    
    while (hasMore) {
        hasMore = false;
        for (let key of guardianKeys) {
            if (guardianQueues[key].length > 0) {
                hasMore = true;
                fairUniqueCodes.push(guardianQueues[key].shift()); 
            }
        }
    }

    let allPricesFetchedSuccessfully = true;

    // 4. 平滑且公平地排队请求 (限流核心)
    for (let i = 0; i < fairUniqueCodes.length; i++) {
        const code = fairUniqueCodes[i];
        const references = uniqueStocksMap.get(code);
        const baseItem = references[0].item;

        try {
            // 发起单次网络请求
            await fetchPrice(baseItem);
            
            // 【还原原版逻辑】原版依赖 currentPrice === null 判断获取是否成功
            if (baseItem.currentPrice === null) {
                allPricesFetchedSuccessfully = false;
            }
            
            // 将数据克隆给所有持有该股票的其他引用
            for (let j = 1; j < references.length; j++) {
                const targetItem = references[j].item;
                targetItem.currentPrice = baseItem.currentPrice;
                targetItem.history = baseItem.history;
                targetItem.refPrice = baseItem.refPrice;
                targetItem.officialChangePercent = baseItem.officialChangePercent;
            }
        } catch (e) {
            console.error(`Fetch failed for ${code}:`, e);
            allPricesFetchedSuccessfully = false;
        }

        // 渐进式更新 UI
        const affectedGuardians = new Set(references.map(ref => ref.guardianKey));
        affectedGuardians.forEach(k => {
            recalculateAndRenderGuardian(k);
        });

        // 增加延迟防限流 (最后一次请求不用等)
        if (i < fairUniqueCodes.length - 1) {
            await sleep(250); 
        }
    }
    
    log(`Sync Price Data Finish. Total processed: ${fairUniqueCodes.length} unique stocks`, "#aaa"); 

    // 5. 休市锁定逻辑 (保持原版)
    if (isMarketClosed() && allPricesFetchedSuccessfully && !hasClosedPrices) {
        hasClosedPrices = true; 
        if (priceUpdateInterval) {
            clearInterval(priceUpdateInterval); 
            priceUpdateInterval = null; 
        }
        log("Market closed. Prices locked.", "yellow");
    }

    return allPricesFetchedSuccessfully;
}

// ===================== 抽离的纯计算与渲染函数 =====================
/**
 * 替代原 processSingleGuardian 中的计算与 UI 更新部分
 * 完全保留原有的数学公式和条件判断
 */
function recalculateAndRenderGuardian(k) {
    const g = gameState.guardians[k];

    // 1. 计算 System Return
    let systemRtn = 0; 
    for (let s of g.strategy) {
        // 【增加 s.refPrice > 0 校验防崩溃】
        if (s.currentPrice && s.refPrice && s.refPrice > 0) {
             if (s.isAdhoc !== true) { 
                 const chg = (s.currentPrice - s.refPrice) / s.refPrice;
                 systemRtn += chg * (s.weight / 100);
             }
        }
    }
    // 风控仓位因子修正 (Power Logic)
    if (g.power !== undefined && g.power !== null) {
        systemRtn = systemRtn * g.power;
    }

    // 2. 计算 Portfolio Assets
    let currentAssets = 0;
    for (let p of g.portfolio) {
        // 【还原原版逻辑】无论 isCash 或者 currentPrice 是否为 null，原版均按权重累加了基数
        currentAssets += 100000 * (p.weight / 100); 
    }
    
    if (g.initialAssets === 0 && currentAssets > 0) {
        g.initialAssets = 100000; // 原版只在初始且 currentAssets 大于 0 时赋值
    }

    // 3. 更新 UI (DOM操作)
    const sysRtnElem = document.getElementById(`rtn-${k}`);
    const cardElem = document.getElementById(`card-${k}`);
    
    if (sysRtnElem) {
        sysRtnElem.innerText = (systemRtn * 100).toFixed(2) + "%";
        sysRtnElem.className = systemRtn >= 0 ? "stat-value text-up" : "stat-value text-down";
    }

    if (cardElem) {
        if (systemRtn > 0) {
            cardElem.classList.add('active'); 
        } else {
            cardElem.classList.remove('active'); 
        }
    }

    let portRtn = calculateUserRtn(k);         
    updateUserRtnUI(k, portRtn);
    
    // 渲染该 Guardian 的股票列表视图
    renderLists(k);
}

// ===================== 辅助函数 2：UI 工具 =====================
function updateUserRtnUI(k, portRtn) {
    const userRtnElem = document.getElementById(`user-rtn-${k}`);
    if (userRtnElem) {
        userRtnElem.innerText = portRtn.toFixed(2) + "%";
        userRtnElem.className = portRtn >= 0 ? "stat-value user-stat text-up" : "stat-value user-stat text-down";
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
    
    // 【修复点 1】必须在这里声明，否则会污染全局变量
    let officialChangePercent = null; 

    try {
        let intradayData = []; // 分钟级历史数据
        let closingPriceApiResult = null; // 收盘价格 API 的结果

        // 步骤 1: 始终尝试获取分钟级历史数据，用于微图绘制
        // const intradayUrl = `${REAL_API_URL}?code=${finalCode}&type=intraday`; 
        // 【建议修改】：加上 cache: 'no-store'
        // const intradayRes = await fetch(intradayUrl, { cache: 'no-store' }); 
        // 步骤 1: 始终尝试获取分钟级历史数据，用于微图绘制, 加随机参数绕过缓存/风控
        // const intradayUrl = `${REAL_API_URL}?code=${finalCode}&type=intraday&_t=${Date.now()}_${Math.random()}`; 
        // const intradayRes = await fetch(intradayUrl, { cache: 'no-store' });       
        // const intradayJson = await intradayRes.json();
        const intradayUrl = `${REAL_API_URL}?code=${finalCode}&type=intraday`; 
        const intradayJson = await fetchWithRetry(intradayUrl);
        if (intradayJson && intradayJson.length > 0) {
            intradayData = intradayJson.map(d => parseFloat(d.price));
        }

        // 步骤 2: 如果市场已关闭，额外获取官方收盘价格
        if (marketIsClosed) {
             // const closePriceUrl = `${REAL_API_URL}?code=${finalCode}&type=price`; // 参数修改为 price
             // 【建议修改】：加上 cache: 'no-store'
             // const closePriceRes = await fetch(closePriceUrl, { cache: 'no-store' });
            // 步骤 2: 收盘价接口, 加随机参数绕过缓存/风控
            // const closePriceUrl = `${REAL_API_URL}?code=${finalCode}&type=price&_t=${Date.now()}_${Math.random()}`;
            // const closePriceRes = await fetch(closePriceUrl, { cache: 'no-store' });  
            // const closePriceJson = await closePriceRes.json();
            const closePriceUrl = `${REAL_API_URL}?code=${finalCode}&type=price`; // 参数修改为 price
            const closePriceJson = await fetchWithRetry(closePriceUrl);
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
            // 如果无currentPrice
            if (!item.currentPrice) {
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
        }

        // ================= 【核心优化：refPrice 智能修正与反推】 =================
        if (item.currentPrice) {
            // 1. 如果接口提供了官方涨跌幅，利用数学公式绝对反推出精确的“昨收价/基准价”
            if (item.officialChangePercent !== null && item.officialChangePercent !== undefined) {
                const deducedRefPrice = item.currentPrice / (1 + item.officialChangePercent / 100);
                
                // 如果本地没有 refPrice，或者本地 Excel 记录的 refPrice 和官方反推差距过大 (如发生除权除息)，则覆盖
                if (!item.refPrice) {
                    item.refPrice = deducedRefPrice; 
                }
            } 
            // 2. 如果依然没有 refPrice (例如交易时间内，且 Excel 中没有记录)，做最后的降级兜底
            else if (item.refPrice === undefined || item.refPrice === null || item.refPrice === 0) {
                item.refPrice = intradayData.length > 0 ? intradayData[0] : item.currentPrice;
            }
        }
        // =========================================================================

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
      
        // 【核心修复】只有从未获取过价格时，才回退到 refPrice
        // 保持已有数据，避免显示过时价格
        if (!item.currentPrice) {
            if (item.refPrice !== null && item.refPrice !== undefined) {
                item.currentPrice = item.refPrice;
                item.history = item.history || [item.refPrice, item.refPrice];
            } else {
                item.currentPrice = null;
                item.history = item.history || [];
            }
        }
        // 如果已有 currentPrice，保持不变
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

async function loadAdhocFromCloud() {
    log("Loading ADHOC Suggestions...", "#da70d6");
    if (!ossClient) return;
    try {
        const result = await ossClient.get(getSecureOssPath(OSS_FILE_NAME));
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
    // 【新增保护功能】检查系统是否在线
    if (!gameState.active) {
        log(" >> ACCESS DENIED: System Offline. Please Engage System first. <<", "#EF4444");
        return; // 终止后续处理
    }
    if (!await initOSS()) return;
    const dot = document.getElementById('ossStatusDot');
    dot.className = "oss-status syncing";

    try {
        let wb;
        try {
            const r = await ossClient.get(getSecureOssPath(OSS_FILE_NAME));
            wb = XLSX.read(r.content, { type: 'array' });
        } catch { wb = XLSX.utils.book_new(); }

        const timeStr = getOpTime(true);
        const todayPrefix = timeStr.substring(0, 8); // 提取如 "20231027"

        for (let key in GUARDIAN_CONFIG) {
            const cfg = GUARDIAN_CONFIG[key];
            const g = gameState.guardians[key];
            // 【修复点 2】 增加 let 声明
            let hasNewData = false;

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
                    "修改时间": timeStr,
                    // 【新增】：必须保存收盘价格（参考价），否则手动买入的标的第二天刷新会丢失基准价
                    "收盘价格": p.refPrice
                });
            });
            const newSnapWs = XLSX.utils.json_to_sheet(snapData, { header: ["组合名称","股票代码","股票名称","来源","配置比例 (%)","修改时间","收盘价格"] });
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
                    "修改时间",
                    "参考价格"  // 【新增】兼容列
                ];

                const newFlowWs = XLSX.utils.json_to_sheet(flowData, {
                    header: headers,  // 强制指定表头顺序
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
                    "收盘价格": item.refPrice
                });
            });

        }

        // 将收集到的 ADHOC 数据写入 Sheet (全量覆盖)
        const adhocWs = XLSX.utils.json_to_sheet(adhocData, {
            header: ["组合名称", "股票代码", "股票名称", "来源", "建议比例 (%)", "修改时间", "收盘价格"]
        });

        if (wb.Sheets["ADHOC"]) {
            wb.Sheets["ADHOC"] = adhocWs;
        } else {
            XLSX.utils.book_append_sheet(wb, adhocWs, "ADHOC");
        }

        const wopts = { bookType:'xlsx', bookSST:false, type:'array' };
        const wbout = XLSX.write(wb, wopts);
        const blob = new Blob([wbout], {type:"application/octet-stream"});
        await ossClient.put(getSecureOssPath(OSS_FILE_NAME), blob);

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

    const basicFiles = { ...HISTORY_FILES, ...EXTRA_HISTORY_FILES };
    const variantFiles = [];
    const variants = ['N+2', 'N+3'];

    const getPrefix = (key) => {
        if (key === 'suzaku') return '大成';
        if (key === 'sirius') return '流入';
        if (key === 'genbu') return '低波稳健';
        if (key === 'kirin') return '大智';
        return '';
    };

    variants.forEach(v => {
        ['suzaku', 'sirius', 'genbu', 'kirin'].forEach(key => {
            const prefix = getPrefix(key);
            const suffix = v === 'N+2' ? 'n2' : 'n3';
            if (prefix) {
                variantFiles.push({
                    dataKey: `${key}_${suffix}`,
                    file: `${prefix}模型优化后评估_${v}.json`
                });
            }
        });
    });

    const basicKeys = Object.keys(basicFiles);

    // 1. 加载基础模型
    const basicPromises = basicKeys.map(async key => {
        if (key === 'user') {
            try {
                if (!ossClient) {
                     const inited = await initOSS();
                     if(!inited) throw new Error("OSS Client Init Failed");
                }
                const result = await ossClient.get(basicFiles[key]);
                const text = new TextDecoder("utf-8").decode(result.content);
                return JSON.parse(text);
            } catch (err) {
                console.warn(`Failed to load OSS file for ${key}:`, err);
                return null;
            }
        } else {
            const url = getResourceUrl(basicFiles[key]);
            return fetch(url, { cache: 'no-store' }).then(res => {
                if (!res.ok) throw new Error(res.statusText);
                return res.json();
            }).catch(err => {
                console.warn(`Failed to load base file for ${key}:`, err);
                return null;
            });
        }
    });

    // 2. 加载变体模型
    const variantPromises = variantFiles.map(item => {
        const url = getResourceUrl(item.file);
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

    // 3. 收集所有日期
    let allDatesSet = new Set();
    const collectDates = (json) => {
        if (json && json.每日评估数据) {
            json.每日评估数据.forEach(item => allDatesSet.add(item.日期));
        }
    };
    basicResults.forEach(collectDates);
    variantResults.forEach(collectDates);

    historyData.dates = Array.from(allDatesSet).sort();

    // 4. 解析数据 (结构化存储：cumulative, drawdown, sharpe)
    // 辅助函数：解析特定字段
    const parseMetricSeries = (json, dates, fieldName) => {
        if (!json || !json.每日评估数据) return [];
        const map = new Map();
        // 这里的 100 是将小数转换为百分比，仅对收益率和回撤有效，夏普比率单独处理
        json.每日评估数据.forEach(d => {
            // 确保数据存在，防止 undefined
            const val = d[fieldName] !== undefined ? d[fieldName] * 100 : null;
            map.set(d.日期, val);
        });
        return dates.map(date => map.has(date) ? map.get(date) : null);
    };

    // 5. 存储基础模型数据
    basicResults.forEach((json, index) => {
        const key = basicKeys[index];
        if (json) {
            historyData.datasets[key] = {
                cumulative: parseMetricSeries(json, historyData.dates, "累计收益率"),
                drawdown: parseMetricSeries(json, historyData.dates, "最大回撤率（至当日）"),
                sharpe: json["夏普比率"] !== undefined ? json["夏普比率"] : 0
            };
        } else {
            historyData.datasets[key] = { cumulative: [], drawdown: [], sharpe: 0 };
        }
        
        // 特殊处理 Guardians 里的标普500 (通常只包含收益率)
        if (key === 'guardians' && json && json["标普500收益率"] !== undefined) {
             // 标普500可能没有回撤和夏普数据，给默认值
            let sp500Series = historyData.dates.map(() => json["标普500收益率"] * 100);
            historyData.datasets['sp500'] = {
                cumulative: sp500Series,
                drawdown: [], // 暂无数据
                sharpe: 0     // 暂无数据
            };
        }
    });

    // 6. 存储变体模型数据
    variantResults.forEach((json, index) => {
        const item = variantFiles[index];
        if (json) {
            historyData.datasets[item.dataKey] = {
                cumulative: parseMetricSeries(json, historyData.dates, "累计收益率"),
                drawdown: parseMetricSeries(json, historyData.dates, "最大回撤率（至当日）"),
                sharpe: json["夏普比率"] !== undefined ? json["夏普比率"] : 0
            };
        } else {
            historyData.datasets[item.dataKey] = { cumulative: [], drawdown: [], sharpe: 0 };
        }
    });

    renderHistoryChart();
}

// [新增] 加载行业数据
async function loadIndustryData() {
    log("Loading Industry Data...", "#88f");
    
    // 使用你封装的代理/源获取链接
    const url = getResourceUrl('a_industry_l2.json');
    
    try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error("IndustryData fetch failed");
        
        const json = await res.json();
        
        // 内存优化：创建行业字符串池，避免为每个股票创建重复的字符串对象
        const sharedStrings = Object.create(null);
        
        // 清空旧数据(如果有)
        industryData = Object.create(null);

        let count = 0;
        for (const code in json) {
            const ind = json[code];
            // 如果字符串池中还没有这个行业名称，则放入池中
            if (!sharedStrings[ind]) {
                sharedStrings[ind] = ind;
            }
            // 将股票代码映射到池中唯一的字符串引用上
            industryData[code] = sharedStrings[ind];
            count++;
        }
        
        log(`Industry Data Loaded: ${count} stocks`, "#0f0");
    } catch (e) { 
        log("IndustryData Err: " + e.message, "orange"); 
    }
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
//  1. 定义全局变量存储 Checkbox 状态，避免每次去 DOM 读取，已经在开头定义
// ================= FIXED: renderHistoryChart =================
// ================= 修复：使用ResizeObserver确保DOM稳定 =================
// ================= 修复与增强：renderHistoryChart =================
// ================= MODIFIED: renderHistoryChart =================
function renderHistoryChart() {
    const chartContainer = document.getElementById('settlementPanel');
    const canvas = document.getElementById('performanceChart');
    
    chartContainer.style.display = 'block';
    // 建议：给容器也加一个最小高度，防止 destroy 时 canvas 瞬间变小导致页面滚动条跳动
    chartContainer.style.minHeight = "340px"; 
    canvas.style.minHeight = "300px"; 

    // 1. 插入/更新 UI 控制栏
    let controlsDiv = document.getElementById('chartVariantControls');
    
    if (!controlsDiv) {
        controlsDiv = document.createElement('div');
        controlsDiv.id = 'chartVariantControls';
        controlsDiv.style.cssText = "display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px; margin-bottom:10px; font-size:12px; color:#aaa;";
        canvas.parentNode.insertBefore(controlsDiv, canvas);

        controlsDiv.innerHTML = `
            <!-- 指标选择 -->
            <div style="display:flex; align-items:center; gap:5px; margin-right:auto;">
                <span style="color:#888;">Metric:</span>
                <select id="metricSelect" onchange="window.updateChartMetric(this.value)" style="background:#222; color:#fff; border:1px solid #444; padding:2px 5px; border-radius:4px; font-size:11px;">
                    <option value="cumulative">累计收益率 (Return)</option>
                    <option value="drawdown">最大回撤 (Max Drawdown)</option>
                    <option value="sharpe">夏普比率 (Sharpe Ratio)</option>
                </select>
            </div>

            <!-- 时间范围 (仅对时间序列有效) -->
            <div id="rangeControlGroup" style="display:flex; align-items:center; gap:5px;">
                <span style="color:#888;">Range:</span>
                <select id="chartRangeSelect" onchange="window.updateChartRange(this.value)" style="background:#222; color:#fff; border:1px solid #444; padding:2px 5px; border-radius:4px; font-size:11px;">
                    <option value="all">All History</option>
                    <option value="ytd">Year to Date</option>
                    <option value="1w">Last 5 Days</option>
                </select>
            </div>

            <!-- 变体开关 -->
            <label style="cursor:pointer; display:flex; align-items:center;">
                <input type="checkbox" id="toggleN2" onchange="window.toggleVariantState('n2')" style="margin-right:5px;"> 
                <span style="border-bottom: 2px dashed #888">N+2</span>
            </label>
            <label style="cursor:pointer; display:flex; align-items:center;">
                <input type="checkbox" id="toggleN3" onchange="window.toggleVariantState('n3')" style="margin-right:5px;"> 
                <span style="border-bottom: 2px dotted #888">N+3</span>
            </label>
        `;
    }

     // ================= 核心修复开始：同步 UI 状态 =================
    // 只有当 DOM 的值与 JS 变量不一致时才赋值
    // 这样避免了在手机上打断用户的交互焦点，解决了焦点跳动问题
    const metricSelect = document.getElementById('metricSelect');
    if (metricSelect && metricSelect.value !== currentMetric) {
        metricSelect.value = currentMetric;
    }

    const rangeSelect = document.getElementById('chartRangeSelect');
    if (rangeSelect && rangeSelect.value !== currentChartRange) {
        rangeSelect.value = currentChartRange;
    }

    const chkN2 = document.getElementById('toggleN2');
    if (chkN2 && chkN2.checked !== showN2) {
        chkN2.checked = showN2;
    }
    
    const chkN3 = document.getElementById('toggleN3');
    if (chkN3 && chkN3.checked !== showN3) {
        chkN3.checked = showN3;
    }
    // ================= 核心修复结束 =================

    // 当选择夏普比率时，隐藏时间范围选择，因为它是单值
    const rangeGroup = document.getElementById('rangeControlGroup');
    if (rangeGroup) rangeGroup.style.display = currentMetric === 'sharpe' ? 'none' : 'flex';

    // 2. 销毁旧图表
    if (perfChart) {
        perfChart.destroy();
        perfChart = null;
    }

    // 3. 数据准备逻辑
    setTimeout(() => {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const isMobile = window.innerWidth < 768;

        // === 分支 A: 夏普比率 (柱状图) ===
        if (currentMetric === 'sharpe') {
            renderSharpeChart(ctx, isMobile);
            return;
        }

        // === 分支 B: 时间序列 (收益率 / 回撤) ===
        renderTimeSeriesChart(ctx, isMobile);

   }, 0); // 这里的延时从50ms改为了 0，提升响应速度
}

// 渲染柱状图 (夏普比率)
function renderSharpeChart(ctx, isMobile) {
    const beasts = [
        { key: 'guardians', label: 'Guardians', color: '#FFD700' },
        { key: 'user', label: 'User', color: '#00FFFF' },
        { key: 'suzaku', label: 'SUZAKU', color: GUARDIAN_COLORS['suzaku'] },
        { key: 'sirius', label: 'SIRIUS', color: GUARDIAN_COLORS['sirius'] },
        { key: 'genbu',  label: 'GENBU',  color: GUARDIAN_COLORS['genbu'] },
        { key: 'kirin',  label: 'KIRIN',  color: GUARDIAN_COLORS['kirin'] }
    ];

    // 构建 Label 和 Data
    const labels = [];
    const dataPoints = [];
    const backgroundColors = [];
    const borderColors = [];

    beasts.forEach(b => {
        // 主模型
        const ds = historyData.datasets[b.key];
        if (ds && ds.sharpe !== undefined) {
            labels.push(b.label);
            dataPoints.push(ds.sharpe);
            backgroundColors.push(b.color + '66'); // 半透明填充
            borderColors.push(b.color);
        }

        // 变体 (N+2)
        if (showN2 && ['suzaku','sirius','genbu','kirin'].includes(b.key)) {
            const ds2 = historyData.datasets[`${b.key}_n2`];
            if (ds2) {
                labels.push(`${b.label} (N+2)`);
                dataPoints.push(ds2.sharpe);
                backgroundColors.push(b.color + '33'); 
                borderColors.push(b.color);
            }
        }
        // 变体 (N+3)
        if (showN3 && ['suzaku','sirius','genbu','kirin'].includes(b.key)) {
            const ds3 = historyData.datasets[`${b.key}_n3`];
            if (ds3) {
                labels.push(`${b.label} (N+3)`);
                dataPoints.push(ds3.sharpe);
                backgroundColors.push(b.color + '1A');
                borderColors.push(b.color);
            }
        }
    });

    perfChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Sharpe Ratio',
                data: dataPoints,
                backgroundColor: backgroundColors,
                borderColor: borderColors,
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            // ============ 修改开始：增加底部内边距 ============
            layout: {
              padding: {
                  bottom: 40  // 这里设置 10-40 像素通常足够解决文字截断问题
              }
            },
            // ============ 修改结束 ============
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `Sharpe: ${context.parsed.y.toFixed(2)}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: '#333' },
                    ticks: { color: '#888' },
                    title: { display: true, text: 'Sharpe Ratio', color: '#666' }
                },
                x: {
                    ticks: { color: '#aaa', autoSkip: false, maxRotation: 45, minRotation: 0 },
                    grid: { display: false }
                }
            }
        }
    });
}

// 渲染时间序列 (收益率 / 回撤)
function renderTimeSeriesChart(ctx, isMobile) {
    const allDates = historyData.dates || [];
    const totalPoints = allDates.length;
    let sliceStartIndex = 0;

    // 计算时间切片
    if (currentChartRange === 'ytd') {
        const currentYear = new Date().getFullYear();
        const startStr = `${currentYear}-01-01`;
        const idx = allDates.findIndex(d => d >= startStr);
        sliceStartIndex = idx > 0 ? idx - 1 : 0;
    } else if (currentChartRange === '1w') {
        sliceStartIndex = Math.max(0, totalPoints - 6);
    }

    const viewDates = allDates.slice(sliceStartIndex);

    // 数据处理函数
    const processData = (fullDataObj, type) => {
        // 从对象中取出对应的数组 (cumulative 或 drawdown)
        const series = fullDataObj ? fullDataObj[currentMetric] : [];
        if (!series || series.length === 0) return [];
        
        const sliced = series.slice(sliceStartIndex);

        // 如果是“累计收益率”，并且选择了特定的时间段，我们通常希望归一化（即起点为0）
        // 如果是“最大回撤”，通常不归一化，直接显示当前的回撤深度
        if (currentMetric === 'cumulative') {
            let anchor = null;
            // 找到切片里的第一个有效值作为锚点
            for (let val of sliced) {
                if (val !== null && val !== undefined) {
                    anchor = val;
                    break;
                }
            }
            if (anchor === null) return sliced;
            return sliced.map(val => (val === null || val === undefined) ? null : val - anchor);
        } else {
            // 回撤直接返回原始值
            return sliced;
        }
    };

    const createDataset = (label, color, dataKey, groupKey, options = {}) => {
        const processed = processData(historyData.datasets[dataKey]);
        return {
            label: label, 
            borderColor: color, 
            backgroundColor: color + '1A',
            data: processed, 
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
        const dataKey = `${parentKey}_${type}`;
        const processed = processData(historyData.datasets[dataKey]);
        
        return {
            label: `${parentLabel} ${isN2 ? '(N+2)' : '(N+3)'}`,
            data: processed, 
            borderColor: color,
            borderWidth: 1.5,
            borderDash: isN2 ? [6, 4] : [2, 3], 
            pointRadius: 0,
            tension: 0.3,
            fill: false,
            hidden: true, // 默认隐藏，除非 Checkbox 打开
            order: 10,
            variantType: type,
            groupKey: groupKey,
            isMain: false
        };
    };

    const datasets = [
        createDataset('Guardians', '#FFD700', 'guardians', 'guardians', { borderWidth: 3, order: 0 }),
        createDataset('User', '#00FFFF', 'user', 'user', { borderWidth: 2, order: 2 })
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

    perfChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: viewDates, 
            datasets: datasets
        },
        options: {
            responsive: true, 
            maintainAspectRatio: false, 
            // ============ 修改开始：增加底部内边距 ============
            layout: {
              padding: {
                  bottom: 40  // 这里设置 10-35 像素通常足够解决文字截断问题
              }
            },
            // ============ 修改结束 ============
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            plugins: { 
                legend: { 
                    display: true,
                    labels: { color: '#ccc', filter: (item, chartData) => chartData.datasets[item.datasetIndex].isMain },
                    onClick: function(e, legendItem, legend) {
                        // 保持原有的点击图例显示/隐藏变体的逻辑
                        const chart = legend.chart;
                        const clickedIndex = legendItem.datasetIndex;
                        const dataset = chart.data.datasets[clickedIndex];
                        const meta = chart.getDatasetMeta(clickedIndex);
                        const isVisible = !meta.hidden;
                        
                        chart.data.datasets.forEach((ds, idx) => {
                            if (ds.groupKey === dataset.groupKey) {
                                if (isVisible) chart.hide(idx);
                                else chart.show(idx);
                            }
                        });
                        legendItem.hidden = isVisible;
                        chart.update();
                        if (typeof window.updateVariantVisibility === 'function') setTimeout(window.updateVariantVisibility, 50);
                    }
                },       
                tooltip: {
                    itemSort: (a, b) => (a.dataset.isMain ? 0 : 1) - (b.dataset.isMain ? 0 : 1),
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) {
                                // 夏普比率不用百分号，其他两个用
                                label += context.parsed.y.toFixed(2) + '%';
                            }
                            return label;
                        }
                    }
                }
            },
            scales: { 
                y: { 
                    ticks: { color: '#666' }, 
                    grid: { color: '#333' },
                    title: { 
                        display: true, 
                        text: currentMetric === 'drawdown' ? 'Drawdown (%)' : 'Return (%)',
                        color: '#555'
                    }
                }, 
                x: { 
                    ticks: { 
                        color: '#666', 
                        maxTicksLimit: isMobile ? 5 : 10, 
                        maxRotation: isMobile ? 45 : 0, 
                        minRotation: isMobile ? 45 : 0, 
                        autoSkip: true
                    }, 
                    grid: { color: '#333' } 
                } 
            }
        }
    });

    if (typeof window.updateVariantVisibility === 'function') {
        window.updateVariantVisibility();
    }
}

// ================= 新增全局辅助函数 =================
window.updateChartMetric = function(metric) {
    if (currentMetric === metric) return;
    currentMetric = metric;
    renderHistoryChart();
};

window.toggleVariantState = function(type) {
    if (type === 'n2') showN2 = !showN2;
    if (type === 'n3') showN3 = !showN3;
    
    // 更新 checkbox 状态
    const chk = document.getElementById(type === 'n2' ? 'toggleN2' : 'toggleN3');
    if (chk) chk.checked = (type === 'n2' ? showN2 : showN3);

    // 如果是柱状图，需要完全重绘才能增删柱子
    if (currentMetric === 'sharpe') {
        renderHistoryChart();
    } else {
        // 如果是折线图，可以调用现有的可见性更新函数（如果存在）
        if (typeof window.updateVariantVisibility === 'function') {
            window.updateVariantVisibility();
        } else {
            renderHistoryChart(); // fallback
        }
    }
};

// 确保 updateVariantVisibility 能够处理新逻辑
window.updateVariantVisibility = function() {
    if (!perfChart || currentMetric === 'sharpe') return; // 夏普图在 render 中处理了

    perfChart.data.datasets.forEach((ds, index) => {
        if (!ds.isMain) {
            const isN2 = ds.variantType === 'n2';
            const isN3 = ds.variantType === 'n3';
            
            // 找到主数据集的状态
            const mainDsIndex = perfChart.data.datasets.findIndex(d => d.groupKey === ds.groupKey && d.isMain);
            const mainMeta = perfChart.getDatasetMeta(mainDsIndex);
            const isMainVisible = !mainMeta.hidden;

            const shouldShow = isMainVisible && ((isN2 && showN2) || (isN3 && showN3));
            
            const meta = perfChart.getDatasetMeta(index);
            meta.hidden = !shouldShow;
        }
    });
    perfChart.update();
};

// [新增] 渲染中间态列表（有名字，但价格显示 --）
// 用于在策略加载完但价格还没到的时候调用
function renderStaticLists() {
    Object.keys(gameState.guardians).forEach(key => {
        renderLists(key); // renderLists 内部已经处理了 currentPrice 为 null 的情况
    });
}

async function initSystem() {
    if (gameState.active) return;
    const btn = document.getElementById('engageBtn');
    btn.innerText = "加载中...";
    
    try {
        // ============================================================
        // Phase 0: 初始化OSS (互相独立，但被后续步骤依赖)
        // ============================================================
        // 1. initOSS: 后续读取云端 Excel 必须先有 Client 
        await Promise.all([
            initOSS()     
        ]);
              
        //2. loadMarketDate: 读取OSS端json文件MarketDate.json 获取最新市场日期
        await Promise.all([   
            loadMarketDate()
        ]);
        
        // ============================================================
        // Phase 1: 基础建设 (互相独立，但被后续步骤依赖)
        // ============================================================
        // 1. loadStrategies: 后续关联持仓价格、标记甜点必须先有策略列表
        // 2. loadHistoryData: 独立的大文件下载，尽早开始
        // 3. loadIndustryData: 独立的大文件下载，尽早开始
        await Promise.all([
            loadStrategies(),
            loadHistoryData(),
            loadIndustryData() // <-- [新增的函数调用]
        ]);

        // ============================================================
        // Phase 2: 依赖数据的加载 (必须等待 Phase 1 完成)
        // ============================================================
        // 1. loadCloudPortfolio: 依赖 OSS Client 和 策略列表(用于获取refPrice)
        // 2. loadSweetPoints: 依赖 策略列表(用于标记 isSweet)
        // 3. loadAdhocFromCloud: 依赖 OSS Client
        await Promise.all([
            loadCloudPortfolio(),
            loadSweetPoints(),
            loadAdhocFromCloud(),
            loadTodayFlows()  // <-- 【新增】恢复今日交易流水
        ]);

        // --- 【关键修改】在此处立即渲染“静态”列表 ---
        // 此时我们有了：股票名字、代码、持仓数量。
        // 我们缺的是：实时价格。
        // 立刻渲染，让用户看到文字内容，价格显示为 "--" 
        // log("Rendering Static UI...", "#88f");
        // renderStaticLists(); 

        // ============================================================
        // Phase 3: 市场数据与渲染 (此时所有列表已就绪)
        // ============================================================
        // 并行获取行情、全量股票列表、EEI数据
        const [marketDataResult, allStocksData, eeiFlowData] = await Promise.allSettled([
            updateMarketData(true), // 这里会触发 renderLists，此时 Adhoc 和 SweetPoint 均已就绪
            fetchAllStocksData(),
            loadEEIFlow30DaysData()
        ]);

        // 处理市场数据结果，启动定时器
        if (marketDataResult.status === 'fulfilled') {
            if (hasClosedPrices) { 
                log("Market currently closed on init. Price polling will not start.", "yellow");
            } else {
                // 只有市场开启时才启动轮询
                // priceUpdateInterval = setInterval(() => updateMarketData(false), 300000);
                priceUpdateInterval = setInterval(() => updateMarketData(false), 180000);
                // 每3分钟开始刷新数据，用时2分钟，总计5分钟
                log("Market is open. Price polling started every 5 minutes.", "#0f0");
            }
        } else {
            // [修改] 风格化日志：替换 console.error
            log(">> MARKET DATA SYNC FAILURE: " + (marketDataResult.reason?.message || "Unknown Error"), "#f00");
            log("Market Data Error", "red");
        }
     
        // 3. 设置自动补全（依赖于 fetchAllStocksData 的结果）
        setupAllAdhocAutoCompletes();

        gameState.active = true;
        btn.innerText = "系统在线";
        btn.style.boxShadow = "0 0 20px #0f0";

    } catch (err) {
        // [修改] 风格化日志：替换 console.error
        console.error("Init System Critical Failure:", err); // 保留系统级 error 用于浏览器调试
        btn.innerText = "INIT FAILED";
        btn.style.color = "red";
        log(">> SYSTEM INITIALIZATION FATAL ERROR: " + err.message, "#f00");
    }
}
