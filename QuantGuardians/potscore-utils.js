
// 从 OSS 下载 JSON，文件名直接传入，无需路径
const OSS_STOCK_DATA_FILE_A = 'FlowInfoBase.json';      // OSS 上的文件名
const OSS_STOCK_DATA_FILE_HK = 'HKFlowInfoBase.json';     // OSS 上的文件名

async function fetchAllStocksDatafromOSS() {
    try {
        if (typeof log === 'function') {
            log(">> INITIALIZING STOCK INDEX: LOADING BASE DATA FROM OSS...", "#0ff");
        }

        // 【核心改造】使用 OSS 客户端直接下载，无需 URL 拼接
        if (!ossClient) {
            log(">> OSS CLIENT NOT READY. RETRYING INIT...", "#ff0");
            const inited = await initOSS();
            if (!inited) throw new Error("OSS Client Init Failed");
        }

        // 并行下载两个文件
        const [aShareResult, hkShareResult] = await Promise.all([
            ossClient.get(OSS_STOCK_DATA_FILE_A),   // ← 直接传 OSS 文件名
            ossClient.get(OSS_STOCK_DATA_FILE_HK)   // ← 直接传 OSS 文件名
        ]);

        // OSS 返回的是 { content: ArrayBuffer/Buffer }，需要解析为 JSON
        const aData = JSON.parse(new TextDecoder("utf-8").decode(aShareResult.content));
        const hkData = JSON.parse(new TextDecoder("utf-8").decode(hkShareResult.content));

        // 后续逻辑完全不变
        const validAData = Array.isArray(aData) ? aData : [];
        const validHkData = Array.isArray(hkData) ? hkData : [];

        if (!Array.isArray(aData) || !Array.isArray(hkData)) {
            console.warn("Stock data format warning: received non-array data");
        }

        allStocks = [...validAData, ...validHkData].map(s => ({
            name: s.名称 || s.name,
            code: s.代码 || s.code
        }));

        console.log("Stock search engine ready. Total items:", allStocks.length);
        if (typeof log === 'function') {
            log(`>> STOCK INDEX SYNCHRONIZED. ENTITIES REGISTERED: ${allStocks.length}`, "#0f0");
        }

    } catch (e) {
        console.error("Error fetching stock lists from OSS", e);
        if (typeof log === 'function') {
            log(">> SYSTEM FAILURE: STOCK LIST RETRIEVAL FAILED. " + (e.message || e), "#f00");
        }
    }
}

// 从 OSS 下载 EEIFlow30Days.xlsx，直接传文件名
const OSS_EEI_30DAYS_FILE = 'EEIFlow30Days.xlsx';

async function loadEEIFlow30DaysDatafromOSS() {
    if (eeiFlow30DaysData !== null) return;
    
    try {
        log(">> INITIATING DATA STREAM: 30-DAY FLOW ANALYSIS FROM OSS...", "#0ff");
    
        if (!ossClient) {
            const inited = await initOSS();
            if (!inited) throw new Error("OSS Client Init Failed");
        }
    
        // 1. 获取文件
        const result = await ossClient.get(OSS_EEI_30DAYS_FILE);
        
        // 【新增】2. 严格校验 OSS 返回状态 (防止把 404 XML 报错当成文件解析)
        if (result.res && result.res.status !== 200) {
            throw new Error(`OSS Request Failed. HTTP Status: ${result.res.status}`);
        }
    
        if (!result.content) {
            throw new Error("OSS returned empty content.");
        }
    
        // 【优化】3. 更安全的 Buffer -> ArrayBuffer 转换
        let arrayBuffer;
        if (result.content instanceof ArrayBuffer) {
            arrayBuffer = result.content;
        } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(result.content)) {
            // Node.js 环境下最稳妥的转换方式
            arrayBuffer = new Uint8Array(result.content).buffer;
        } else if (result.content.buffer instanceof ArrayBuffer) {
            // 浏览器下的 TypedArray (如 Uint8Array)
            arrayBuffer = result.content.buffer;
        } else {
            // 兜底方案：如果 result.content 是字符串（说明拿到了报错XML）
            if (typeof result.content === 'string') {
                console.error("Received string instead of binary:", result.content.substring(0, 100));
                throw new Error("Received text/XML instead of binary Excel file. Check OSS file path.");
            }
            arrayBuffer = result.content; 
        }
    
        // 【新增】4. 校验 ArrayBuffer 大小
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            throw new Error("File is empty (0 bytes).");
        }
    
        // 5. 解析 Excel
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
    
        const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: null });
        
        const dataMap = {};
        jsonData.forEach(row => {
            let rawCode = row['代码'];
            if (rawCode === undefined || rawCode === null) return;
            const code = String(rawCode).padStart(6, '0');
    
            let dateStr = row['日期'];
            if (typeof dateStr === 'number') {
                const dateObj = new Date(Math.round((dateStr - 25569)*86400*1000));
                dateStr = dateObj.toISOString().split('T')[0];
            } else {
                dateStr = String(dateStr || '').trim().split(' ')[0];
            }
    
            const cleanRow = {
                '代码': code,
                '名称': row['名称'] ? String(row['名称']) : '',
                '日期': dateStr,
                '收盘价': Number(row['收盘价'] || 0),
                '涨跌幅': Number(row['涨跌幅'] || 0), 
                'PotScore': Number(row['PotScore'] || 0),
                '超大单净流入-净占比': Number(row['超大单净流入-净占比'] || 0),
                '主力净流入-净占比': Number(row['主力净流入-净占比'] || 0),
                '大单净流入-净占比': Number(row['大单净流入-净占比'] || 0),
                '中单净流入-净占比': Number(row['中单净流入-净占比'] || 0),
                '小单净流入-净占比': Number(row['小单净流入-净占比'] || 0),
                '总净流入占比': Number(row['总净流入占比'] || 0)
            };
    
            if (!dataMap[code]) dataMap[code] = [];
            dataMap[code].push(cleanRow);
        });
    
        Object.keys(dataMap).forEach(key => {
            dataMap[key].sort((a, b) => a['日期'].localeCompare(b['日期']));
        });
    
        eeiFlow30DaysData = dataMap;
        log(`>> DATA STREAM SYNC COMPLETE. TARGETS ACQUIRED: ${Object.keys(dataMap).length}`, "#0f0");
    
    } catch (err) {
        log(">> CRITICAL ERROR: EEI FLOW DATA CORRUPTED. " + (err.message || err), "#f00");
        console.error("Full error:", err);
    }
}

/**
 * 将 30 日 EEI 数据的最后一日的 PotScore 绑定到所有标的对象上
 * @param {Object} potScoreMap - 格式: { "600519": 0.85, "000001": -0.12, ... }
 */
function attachPotScores() {
    if (!eeiFlow30DaysData) return;
    
    Object.keys(gameState.guardians).forEach(key => {
        const g = gameState.guardians[key];
        [g.strategy, g.portfolio, g.adhocObservations].forEach(list => {
            if (!Array.isArray(list)) return;
            list.forEach(item => attachSinglePotScore(item));
        });
    });
}

/**
 * 为单个 item 更新 PotScore 和资金条件
 * @param {Object} item - 标的对象
 */
// function attachSinglePotScore(item) {
//     if (!eeiFlow30DaysData || !item || !item.code) return;
    
//     // 重置默认值
//     item.lastPotScore = 0;
//     item.isSuperFlowPositive = false;
//     item.isBigFlowPositive = false;
    
//     const code = String(item.code).trim();
//     const history = eeiFlow30DaysData[code];
    
//     if (Array.isArray(history) && history.length >= 3) {
//         const last3Days = history.slice(-3);
        
//         const superFlowPositive = last3Days.every(day => {
//             const val = Number(day['超大单净流入-净占比']);
//             return !isNaN(val) && val > 0;
//         });
        
//         const bigFlowPositive = last3Days.every(day => {
//             const val = Number(day['大单净流入-净占比']);
//             return !isNaN(val) && val > 0;
//         });
        
//         if (superFlowPositive && bigFlowPositive) {
//             const lastDay = history[history.length - 1];
//             const potScore = Number(lastDay["PotScore"]);
//             item.lastPotScore = !isNaN(potScore) ? potScore : 0;
//             item.isSuperFlowPositive = true;
//             item.isBigFlowPositive = true;
//         }
//     }
// }


/**
 * 为单个 item 更新 PotScore 和资金条件
 * 规则：
 *   1. 超大单净流入-净占比：最后一天 > 0，且数值 > 前一天
 *   2. 大单净流入-净占比：最后一天 > 0，且数值 > 前一天
 *   3. PotScore：最后一天 > 0，且数值 > 前一天
 * @param {Object} item - 标的对象
 */
function attachSinglePotScore(item) {
    if (!eeiFlow30DaysData || !item || !item.code) return;
    
    // 重置默认值
    item.lastPotScore = 0;
    item.isSuperFlowPositive = false;
    item.isBigFlowPositive = false;
    
    const code = String(item.code).trim();
    const history = eeiFlow30DaysData[code];
    
    if (Array.isArray(history) && history.length >= 2) {
        const lastDay = history[history.length - 1];
        const prevDay = history[history.length - 2];
        
        // 【规则1】超大单：最后一天 > 0，且数值 > 前一天
        const lastSuper = Number(lastDay['超大单净流入-净占比']);
        const prevSuper = Number(prevDay['超大单净流入-净占比']);
        const superFlowPositive = !isNaN(lastSuper) && lastSuper > 0 && lastSuper > prevSuper;
        
        // 【规则2】大单：最后一天 > 0，且数值 > 前一天
        const lastBig = Number(lastDay['大单净流入-净占比']);
        const prevBig = Number(prevDay['大单净流入-净占比']);
        const bigFlowPositive = !isNaN(lastBig) && lastBig > 0 && lastBig > prevBig;
        
        // 【新增规则3】PotScore：最后一天 > 0，且数值 > 前一天
        const lastPot = Number(lastDay["PotScore"]);
        const prevPot = Number(prevDay["PotScore"]);
        const potScorePositive = !isNaN(lastPot) && lastPot > 0 && lastPot > prevPot;
        
        // 三个条件同时满足才绑定
        if (superFlowPositive && bigFlowPositive && potScorePositive) {
            item.lastPotScore = lastPot;
            item.isSuperFlowPositive = true;
            item.isBigFlowPositive = true;
        }
    }


function attachSweetPoints() {
    if (!eeiFlow30DaysData) return;

    // 收集所有满足双规则的候选标的
    const candidates = [];

    Object.keys(gameState.guardians).forEach(key => {
        const g = gameState.guardians[key];
        [g.strategy, g.portfolio, g.adhocObservations].forEach(list => {
            if (!Array.isArray(list)) return;
            list.forEach(item => {
                // 先重置 Sweet 标记，避免历史残留
                item.isSweet = false;
                item.sweetPointsScore = null;

                if (!item || !item.code) return;

                const code = String(item.code).trim();
                const history = eeiFlow30DaysData[code];

                if (Array.isArray(history) && history.length >= 2) {
                    const lastDay = history[history.length - 1];
                    const prevDay = history[history.length - 2];

                    // 【规则1】超大单净流入-净占比：最后一天 > 0，且数值 > 前一天
                    const lastSuper = Number(lastDay['超大单净流入-净占比']);
                    const prevSuper = Number(prevDay['超大单净流入-净占比']);
                    const rule1 = !isNaN(lastSuper) && lastSuper > 0 && lastSuper > prevSuper;

                    // 【规则2】PotScore：最后一天 > 0
                    const lastPot = Number(lastDay["PotScore"]);
                    const rule2 = !isNaN(lastPot) && lastPot > 0;

                    // 同时满足规则1和规则2
                    if (rule1 && rule2) {
                        // 取最后一天相关数值
                        const lastBig = Number(lastDay['大单净流入-净占比']);
                        const lastChange = Number(lastDay['涨跌幅']);

                        // 计算 SweetPointsScore
                        const sweetPointsScore = 0.110180
                            + (0.021117 * lastSuper)
                            - (0.000826 * (isNaN(lastBig) ? 0 : lastBig))
                            + (0.000668 * (isNaN(lastChange) ? 0 : lastChange))
                            + (0.331706 * lastPot);

                        candidates.push({
                            item: item,
                            score: sweetPointsScore
                        });
                    }
                }
            });
        });
    });

    // 按 SweetPointsScore 逆序排列，取 Top3
    candidates.sort((a, b) => b.score - a.score);
    const top3 = candidates.slice(0, 3);

    // Attach：参考 loadSweetPoints 对 isSweet 的赋值方式
    top3.forEach(candidate => {
        candidate.item.isSweet = true;
        candidate.item.sweetPointsScore = candidate.score;
    });
}
}

