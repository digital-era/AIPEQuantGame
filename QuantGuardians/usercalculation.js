/**
 * usercalculation.js
 * 适配 Quantum Guardians HTML 结构的收益计算引擎
 */

// ==================================================================================
// 0. 全局配置与工具准备
// ==================================================================================

// 策略映射，对应 HTML 中的 ID (suzaku, sirius 等)
const STRATEGY_MAP = {
    'genbu':  { sheet_flow: '低波OR', sheet_snap: '低波', name: '低波' },
    'suzaku': { sheet_flow: '大成OR', sheet_snap: '大成', name: '大成' },
    'sirius': { sheet_flow: '流入OR', sheet_snap: '流入', name: '流入' },
    'kirin':  { sheet_flow: '大智OR', sheet_snap: '大智', name: '大智' }
};

// Github 配置 (请根据实际情况修改，或者在 Settings 面板增加对应输入框)
const GITHUB_CONFIG = {
    USERNAME: 'YiVal-AIPE',    // 替换为您的 Github 用户名
    REPO_NAME: 'investment-data', // 替换为您的仓库名
    TARGET_BRANCH: 'main',
    FILE_PATH: 'hk_data.xlsx'  // 假设的港股数据路径
};

// 简单的日期格式化工具 (替代 moment.js)
const DateUtils = {
    format: (date, fmt = 'YYYY-MM-DD') => {
        const d = new Date(date);
        if (isNaN(d.getTime())) return '';
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        if (fmt === 'YYYYMMDD') return `${year}${month}${day}`;
        return `${year}-${month}-${day}`;
    },
    nowStr: () => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
};

// 简单的统计学工具 (替代 simple-statistics)
const StatsUtils = {
    mean: (data) => {
        if (!data.length) return 0;
        return data.reduce((a, b) => a + b, 0) / data.length;
    },
    stdDev: (data) => {
        if (!data.length) return 0;
        const m = StatsUtils.mean(data);
        const variance = data.reduce((sum, val) => sum + Math.pow(val - m, 2), 0) / data.length;
        return Math.sqrt(variance);
    }
};

// 获取 OSS 客户端实例 (从 HTML 输入框读取配置)
function getOssClient() {
    const region = document.getElementById('oss_region').value.trim();
    const bucket = document.getElementById('oss_bucket').value.trim();
    const accessKeyId = document.getElementById('oss_ak_id').value.trim();
    const accessKeySecret = document.getElementById('oss_ak_secret').value.trim();
    const stsToken = document.getElementById('oss_stc_rolearn').value.trim(); // 假设这里的 ARN 实际存的是 Token，如果是 STS 模式

    if (!region || !bucket || !accessKeyId || !accessKeySecret) {
        throw new Error("OSS 配置不完整，请在设置(Settings)中填写。");
    }

    const config = {
        region: region,
        accessKeyId: accessKeyId,
        accessKeySecret: accessKeySecret,
        bucket: bucket,
        secure: true // 强制 HTTPS
    };
    
    // 如果使用了 STS Token
    if (stsToken && stsToken.length > 20) {
        config.stsToken = stsToken;
    }

    // eslint-disable-next-line no-undef
    return new OSS(config);
}

// 动态获取配置路径
function getOssPaths() {
    return {
        // 假设 Excel 文件名为 portfolio.xlsx
        REMOTE_PATH: 'portfolio.xlsx', 
        JSON_PATH: 'user_returns.json',
        INITIAL_CAPITAL: 1000000 // 默认初始资金，可视情况修改
    };
}

// 日志工具 - 对接 HTML 的 #systemLog
function log(msg, type = 'info') {
    const logDiv = document.getElementById('systemLog');
    if (!logDiv) return console.log(msg);

    const now = new Date();
    const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    
    let color = '#0f0'; // 默认绿色
    if (type === 'error') color = '#ff3333';
    if (type === 'warn') color = '#ffff00';
    if (type === 'process') color = '#00ccff';

    const line = document.createElement('div');
    line.className = 'log-line';
    line.style.color = color;
    line.innerHTML = `[${timeStr}] ${msg}`;
    
    logDiv.appendChild(line);
    logDiv.scrollTop = logDiv.scrollHeight;
    console.log(`%c[${type}] ${msg}`, `color:${color}`);
}

// ==================================================================================
// 1. 核心类：回测引擎 (PortfolioBacktest)
// ==================================================================================
class PortfolioBacktest {
    constructor(flowData, snapData, marketDataMap, hkDataMap) {
        const paths = getOssPaths();
        this.cash = paths.INITIAL_CAPITAL;
        this.positions = {}; 
        this.history = [];
        this.marketMap = JSON.parse(JSON.stringify(marketDataMap)); // 深拷贝

        // 合并港股行情
        for (let date in hkDataMap) {
            if (!this.marketMap[date]) this.marketMap[date] = {};
            Object.assign(this.marketMap[date], hkDataMap[date]);
        }
        
        // 预处理流水数据
        this.flows = flowData.map(r => {
            // 兼容不同的列名写法
            const dateRaw = r['修改时间'] || r['Date'] || ''; 
            const dateStr = String(dateRaw).substring(0, 8); // YYYYMMDD
            
            return {
                ...r,
                code: String(r['股票代码'] || r['Code']).trim(),
                date: dateStr,
                dateFmt: dateStr.length === 8 ? 
                         `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}` : null
            };
        }).filter(r => r.dateFmt);

        this.snap = snapData.map(r => ({
            ...r,
            code: String(r['股票代码'] || r['Code']).trim()
        }));

        this.allDates = Object.keys(this.marketMap).sort();
    }

    run() {
        const paths = getOssPaths();
        let prevTotalEquity = paths.INITIAL_CAPITAL;
        let initializedFromSnap = false;

        for (const date of this.allDates) {
            const dailyPrices = this.marketMap[date] || {};

            // --- A: 初始持仓 (Snap 逻辑) ---
            if (!initializedFromSnap) {
                for (const row of this.snap) {
                    const code = row.code;
                    const name = String(row['股票名称'] || row['Name'] || '');
                    if (code === '100000' || name.includes('现金')) continue;

                    const weightRaw = parseFloat(row['配置比例 (%)'] || row['Weight'] || 0);
                    const weight = weightRaw / 100.0;
                    const price = dailyPrices[code];

                    if (price && price > 0 && weight > 0) {
                        const qty = Math.floor((paths.INITIAL_CAPITAL * weight) / price);
                        this.positions[code] = qty;
                        this.cash -= (qty * price);
                    }
                }
                initializedFromSnap = true;
            }

            // --- B: 当日交易 (Flow 逻辑) ---
            const dailyFlows = this.flows.filter(f => f.dateFmt === date);
            const activeStocks = [];

            for (const row of dailyFlows) {
                const code = row.code;
                const opType = row['操作类型'] || row['Type'];
                const price = parseFloat(row['价格'] || row['Price']);
                const qty = parseFloat(row['标的数量'] || row['Qty']);

                if (opType === 'Buy') {
                    this.cash -= (price * qty);
                    this.positions[code] = (this.positions[code] || 0) + qty;
                    activeStocks.push(`Buy ${row['股票名称'] || code}`);
                } else if (opType === 'Sell') {
                    this.cash += (price * qty);
                    if (this.positions[code]) {
                        this.positions[code] -= qty;
                        if (this.positions[code] <= 0) delete this.positions[code];
                    }
                    activeStocks.push(`Sell ${row['股票名称'] || code}`);
                }
            }

            // --- C: 计算当日资产 ---
            let currentHoldingsMv = 0.0;
            for (const [code, qty] of Object.entries(this.positions)) {
                let p = dailyPrices[code];
                // 行情缺失处理：尝试用当日流水价格
                if (!p) {
                    const flowMatch = dailyFlows.find(f => f.code === code);
                    p = flowMatch ? parseFloat(flowMatch['价格'] || flowMatch['Price']) : 0;
                }
                currentHoldingsMv += (qty * (p || 0));
            }

            const currentTotalEquity = this.cash + currentHoldingsMv;
            const dailyRtn = prevTotalEquity > 0 ? (currentTotalEquity - prevTotalEquity) / prevTotalEquity : 0;

            this.history.push({
                '日期': date,
                '每日收益率': dailyRtn,
                '总资产': currentTotalEquity,
                '持仓市值': currentHoldingsMv,
                '现金余额': this.cash,
                '动态备注': activeStocks.length ? activeStocks.join(',') : "Hold"
            });

            prevTotalEquity = currentTotalEquity;
        }
        return this.history;
    }
}

// ==================================================================================
// 2. 辅助函数 (Excel, API)
// ==================================================================================

// ExcelJS Worksheet 转 JSON
function sheetToJson(worksheet) {
    const data = [];
    let headers = [];
    if(!worksheet) return [];
    
    worksheet.eachRow((row, rowNumber) => {
        const rowValues = row.values;
        if (rowNumber === 1) {
            // ExcelJS 的 row.values[1] 才是第一列，需要处理索引
            headers = [];
            row.eachCell((cell, colNum) => {
                headers[colNum] = cell.value ? String(cell.value).trim() : null;
            });
        } else {
            const rowData = {};
            row.eachCell((cell, colNumber) => {
                const header = headers[colNumber];
                if (header) {
                    let val = cell.value;
                    // 处理 ExcelJS 的公式/链接对象
                    if (val && typeof val === 'object') {
                        if (val.result !== undefined) val = val.result;
                        else if (val.text !== undefined) val = val.text;
                    }
                    rowData[header] = val;
                }
            });
            data.push(rowData);
        }
    });
    return data;
}

// 获取港股实时价格 (API)
async function getHkStockPrice(code5Digit, hkTargetDataMap) {
    const cleanCode = String(code5Digit).trim().padStart(5, '0');
    
    // 1. 尝试从 Excel 历史数据找
    if (hkTargetDataMap && hkTargetDataMap[cleanCode]) {
        return parseFloat(hkTargetDataMap[cleanCode]);
    }

    // 2. 尝试 API (需要确保该 API 可用且允许 CORS)
    // 如果您有其他 API 端点，请在这里替换
    const fullCode = "HK" + cleanCode;
    const apiUrl = `https://aipeinvestmentagent.pages.dev/api/rtStockQueryProxy?code=${fullCode}&type=price`;
    try {
        const res = await axios.get(apiUrl, { timeout: 5000 });
        if (res.data && res.data.latestPrice > 0) {
            return parseFloat(res.data.latestPrice);
        }
    } catch (e) {
        // 静默失败，返回 0
    }
    return 0.0;
}

// 加载港股数据 (GitHub)
async function loadHkData() {
    // 检查是否有代理开关
    const useProxy = document.getElementById('chkGitProxy') ? document.getElementById('chkGitProxy').checked : true;
    let baseUrl = `https://raw.githubusercontent.com/${GITHUB_CONFIG.USERNAME}/${GITHUB_CONFIG.REPO_NAME}/${GITHUB_CONFIG.TARGET_BRANCH}/${GITHUB_CONFIG.FILE_PATH}`;
    if (useProxy) {
        baseUrl = `https://ghproxy.com/${baseUrl}`; // 使用通用代理前缀
    }

    try {
        log(`正在获取港股数据...`, 'process');
        const response = await axios.get(baseUrl, { responseType: 'arraybuffer' });
        const buffer = response.data;
        
        // eslint-disable-next-line no-undef
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer);
        const ws = wb.getWorksheet('ARHK'); // 确保 Sheet 名正确
        
        if (!ws) {
            log("未找到 ARHK 表，跳过港股数据", 'warn');
            return {};
        }

        const rawData = sheetToJson(ws);
        const hkMap = {};
        
        rawData.forEach(row => {
            let dateStr = row['日期'];
            // 处理日期对象或字符串
            dateStr = DateUtils.format(dateStr);
            
            const code = String(row['代码']).padStart(5, '0');
            const price = parseFloat(row['Price'] || row['收盘价']);
            
            if (!hkMap[dateStr]) hkMap[dateStr] = {};
            hkMap[dateStr][code] = price;
        });
        
        log(`港股数据加载完成 (HK Stock Data Loaded)`, 'success');
        return hkMap;
    } catch (e) {
        log(`港股数据获取失败 (可忽略): ${e.message}`, 'warn');
        return {};
    }
}

// ==================================================================================
// 3. 主入口函数：triggerCalculation
// ==================================================================================

/**
 * 对应 HTML 按钮的点击事件
 */
async function triggerCalculation() {
    const btn = document.querySelector('button[onclick="triggerCalculation()"]');
    const originalText = btn ? btn.innerHTML : '';
    if(btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳'; // 转圈状态
    }

    log("=== 开始计算收益 (Start Calculation) ===", 'process');

    try {
        // 0. 初始化客户端
        const client = getOssClient();
        const paths = getOssPaths();

        // 1. 加载港股数据 (并行或串行均可)
        const hkDataFullMap = await loadHkData();
        const hkDates = Object.keys(hkDataFullMap).sort();
        const lastHkDate = hkDates[hkDates.length - 1];
        const hkTargetData = lastHkDate ? hkDataFullMap[lastHkDate] : {};
        
        // 2. 下载主 Excel (Portfolio)
        log(`正在下载云端记录: ${paths.REMOTE_PATH}...`, 'process');
        
        let result;
        try {
            result = await client.get(paths.REMOTE_PATH);
        } catch (ossErr) {
            throw new Error("下载云端文件失败，请检查设置中的 AK/Secret/Bucket 是否正确。");
        }

        // 使用 ExcelJS 读取 Buffer
        // eslint-disable-next-line no-undef
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(result.content);
        log("✅ Excel 文件加载成功");

        const dfCombinedMap = {}; // 如果有 A 股基础行情这里可以填入
        const allStrategiesResults = {};
        const enginesCache = {};

        // 3. 运行回测循环
        for (const [key, config] of Object.entries(STRATEGY_MAP)) {
            // 更新 UI 状态
            log(`>> 计算策略: ${config.name} (${key})...`);
            
            const wsFlow = workbook.getWorksheet(config.sheet_flow);
            const wsSnap = workbook.getWorksheet(config.sheet_snap);
            
            if (!wsFlow || !wsSnap) {
                log(`⚠️ 跳过 ${config.name}: 找不到 Worksheet (${config.sheet_flow}/${config.sheet_snap})`, 'warn');
                continue;
            }

            const dataFlow = sheetToJson(wsFlow);
            const dataSnap = sheetToJson(wsSnap);

            const engine = new PortfolioBacktest(dataFlow, dataSnap, dfCombinedMap, hkDataFullMap);
            const history = engine.run();

            allStrategiesResults[key] = history;
            enginesCache[key] = engine;
            
            // 简单的 UI 反馈：更新面板上的收益数字 (可选)
            if (history.length > 0) {
                const last = history[history.length - 1];
                const rpyId = `user-rtn-${key}`;
                const rpyEl = document.getElementById(rpyId);
                if (rpyEl) {
                    const totalRtn = (last['总资产'] - paths.INITIAL_CAPITAL) / paths.INITIAL_CAPITAL * 100;
                    rpyEl.innerText = totalRtn.toFixed(2) + "%";
                }
            }
        }

        // 4. 生成 JSON 报告并上传
        log("生成收益报告...", 'process');
        await generateAndUploadJson(client, paths.JSON_PATH, allStrategiesResults);

        // 5. 更新 Excel 中的实时价格与权重 (Update Logic)
        log("更新 Excel 持仓市值...", 'process');
        await updateExcelAndUpload(client, paths.REMOTE_PATH, workbook, enginesCache, hkTargetData);

        log("🎉 计算与同步全部完成！(All Done)", 'success');

    } catch (e) {
        log(`❌ 错误: ${e.message}`, 'error');
        console.error(e);
        alert(`计算失败: ${e.message}`);
    } finally {
        if(btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

// ==================================================================================
// 4. 数据上传与更新逻辑
// ==================================================================================

async function generateAndUploadJson(client, jsonPath, resultsDict) {
    const dateSet = new Set();
    for(let k in resultsDict) {
        resultsDict[k].forEach(r => dateSet.add(r['日期']));
    }
    const sortedDates = Array.from(dateSet).sort();
    
    if(sortedDates.length === 0) {
        log("无有效回测数据，跳过 JSON 生成", 'warn');
        return;
    }

    const dailyDataList = [];
    const totalCurve = [];
    let initialTotal = 0;
    let globalMax = -Infinity;
    let maxDdSoFar = 0;

    const lastVals = {};
    Object.keys(resultsDict).forEach(k => lastVals[k] = 0);

    sortedDates.forEach((date, idx) => {
        let dailySum = 0;
        Object.keys(resultsDict).forEach(k => {
            // 找到该策略在该日的资产，如果没有则沿用上一日
            const dayRow = resultsDict[k].find(r => r['日期'] === date);
            if(dayRow) lastVals[k] = dayRow['总资产'];
            dailySum += lastVals[k];
        });

        // 过滤掉还未开始的数据
        if (dailySum <= 0) return;
        if (initialTotal === 0) initialTotal = dailySum;

        const prevSum = idx > 0 && totalCurve.length > 0 ? totalCurve[totalCurve.length - 1] : dailySum;
        const dailyRtn = prevSum > 0 ? (dailySum - prevSum) / prevSum : 0;
        const cumRtn = (dailySum - initialTotal) / initialTotal;

        if (dailySum > globalMax) globalMax = dailySum;
        const dd = (dailySum - globalMax) / globalMax;
        if (Math.abs(dd) > maxDdSoFar) maxDdSoFar = Math.abs(dd);

        totalCurve.push(dailySum);
        dailyDataList.push({
            "日期": date,
            "每日收益率": dailyRtn,
            "累计收益率": cumRtn,
            "最大回撤率（至当日）": maxDdSoFar
        });
    });

    if (dailyDataList.length === 0) return;

    const finalEquity = totalCurve[totalCurve.length - 1];
    const days = dailyDataList.length;
    // 简单年化计算 (252天)
    const annRet = days > 1 ? Math.pow(finalEquity / initialTotal, 252 / days) - 1 : 0;
    
    const returns = dailyDataList.map(d => d['每日收益率']);
    const mean = StatsUtils.mean(returns);
    const std = StatsUtils.stdDev(returns);
    const sharpe = std !== 0 ? (mean / std) * Math.sqrt(252) : 0;

    const outputData = {
        "模型名称": "UserComposed",
        "总收益率": dailyDataList[dailyDataList.length - 1]['累计收益率'],
        "年化收益率": annRet,
        "最大回撤率": maxDdSoFar,
        "夏普比率": sharpe,
        "每日评估数据": dailyDataList
    };

    const jsonString = JSON.stringify(outputData, null, 4);
    const blob = new Blob([jsonString], { type: 'application/json' });
    
    await client.put(jsonPath, blob);
    log(`✅ 收益数据 JSON 已上传`, 'success');
}

async function updateExcelAndUpload(client, remotePath, workbook, enginesCache, hkTargetData) {
    if (Object.keys(enginesCache).length === 0) return;

    // 获取最后一个交易日作为更新时间基准
    const sampleEngine = Object.values(enginesCache)[0];
    const lastDateFmt = sampleEngine.allDates[sampleEngine.allDates.length - 1];
    if (!lastDateFmt) return;

    const lastDateCompact = DateUtils.format(lastDateFmt, 'YYYYMMDD');
    const targetTimeStr = lastDateCompact + "1600"; // 模拟收盘时间

    // 反向映射 Sheet Name -> Key
    const sheetToKey = {};
    for (let k in STRATEGY_MAP) sheetToKey[STRATEGY_MAP[k].sheet_snap] = k;

    // 基础行情提取 (从缓存的 Engine 中拿)
    const rawMarket = sampleEngine.marketMap[lastDateFmt] || {};
    const priceMap = {};
    for(let k in rawMarket) {
        priceMap[String(k).split('.')[0].trim()] = rawMarket[k];
    }

    const sheets = ['ADHOC', '低波', '大成', '流入', '大智'];
    
    // 价格获取辅助函数
    async function getPrice(code) {
        const c = String(code).split('.')[0].trim();
        if (c === '100000') return 1.0;
        let p = priceMap[c];
        
        if (!p || p === 0) {
            const hkCode = c.slice(-5);
            // 尝试 HK 数据
            const hkP = await getHkStockPrice(hkCode, hkTargetData);
            if (hkP) p = hkP;
        }
        return p || 0.0;
    }

    for (let sheetName of sheets) {
        const ws = workbook.getWorksheet(sheetName);
        if (!ws) continue;

        // 映射列名到索引
        const headerRow = ws.getRow(1);
        const colMap = {};
        headerRow.eachCell((cell, colNum) => {
            const val = cell.value ? String(cell.value).trim() : '';
            if(val) colMap[val] = colNum;
        });

        // 必要的列检查
        if (!colMap['股票代码']) continue;

        const strategyKey = sheetToKey[sheetName];
        const weightMap = {};
        
        // 计算当前最新持仓的权重
        if (strategyKey && enginesCache[strategyKey]) {
            const eng = enginesCache[strategyKey];
            let currentEquity = eng.cash;
            // 异步计算总资产
            for (let c in eng.positions) {
                currentEquity += (eng.positions[c] * await getPrice(c));
            }
            if (currentEquity > 0) {
                weightMap['100000'] = (eng.cash / currentEquity) * 100;
                for (let c in eng.positions) {
                    const fmtC = String(c).split('.')[0].trim();
                    const val = eng.positions[c] * await getPrice(c);
                    weightMap[fmtC] = (val / currentEquity) * 100;
                }
            }
        }

        // 遍历行更新数据
        ws.eachRow(async (row, rowNum) => {
            if (rowNum === 1) return;
            
            // 仅对非空行处理
            const rawCode = row.getCell(colMap['股票代码']).value;
            if(!rawCode) return;
            const fmtCode = String(rawCode).split('.')[0].trim();

            // 1. 更新价格 (如果有列)
            if (colMap['收盘价格']) {
                const price = await getPrice(fmtCode);
                if(price > 0) row.getCell(colMap['收盘价格']).value = price;
            }
            
            // 2. 更新时间 (ADHOC除外)
            if (sheetName !== 'ADHOC' && colMap['修改时间']) {
                 // 简单处理：仅当有持仓时更新时间，或者全部更新
                 row.getCell(colMap['修改时间']).value = targetTimeStr;
            }
            
            // 3. 更新权重
            if (colMap['配置比例 (%)'] && weightMap[fmtCode] !== undefined) {
                row.getCell(colMap['配置比例 (%)']).value = weightMap[fmtCode];
            }
        });
    }

    // 写回 Buffer 并上传
    // eslint-disable-next-line no-undef
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    
    await client.put(remotePath, blob);
    log(`✅ 云端 Excel 文件已更新`, 'success');
}
