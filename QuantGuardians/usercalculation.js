// ==================================================================================
// 5. 新增：用户收益回测与计算引擎 (复用全局 ossClient)
// ==================================================================================

// 定义计算结果输出的 JSON 文件名 (对应 EXTRA_HISTORY_FILES 中的 user)
const USER_REPORT_FILE = 'User模型综合评估.json';

/**
 * 核心入口：点击计算按钮触发
 */
async function triggerCalculation() {
    const btn = document.querySelector('button[title="Calculate Returns"]');
    const originalText = btn ? btn.innerHTML : '🧮';
    
    if(btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳'; // 转圈或沙漏
    }

    log("=== 启动收益计算引擎 (Calculation Engine) ===", "#00ccff");

    try {
        // 1. 确保 OSS 连接已就绪 (复用现有的全局函数)
        if (!ossClient) {
            log("正在初始化 OSS 连接...", "#aaa");
            const success = await initOSS();
            if (!success) throw new Error("OSS 连接初始化失败，请检查网络或配置");
        }

        // 2. 加载 MarketMap.json (新增代码)
        let globalMarketMap = {};
        try {
            log("正在下载全市场行情数据: MarketMap.json...", "#88f");
            const marketResult = await ossClient.get('MarketMap.json');
            
            // 处理 Buffer 转 JSON
            const contentString = new TextDecoder("utf-8").decode(marketResult.content);
            globalMarketMap = JSON.parse(contentString);
            
            log(`✅ 行情数据加载成功，涵盖 ${Object.keys(globalMarketMap).length} 个交易日`, "#0f0");
        } catch (err) {
            log("⚠️ 未找到 MarketMap.json 或解析失败，将使用交易价格近似计算。", "orange");
            console.warn(err);
            // 失败不阻断流程，仅降级为旧逻辑
            globalMarketMap = {}; 
        }


        // 2. 加载港股数据 (用于补充 Excel 中缺失的价格)
        // 使用现有的 fetchPrice 逻辑太慢(逐个请求)，这里我们并发加载或简化处理
        // 为简单起见，本次计算优先使用 Excel 内的价格，缺失的使用当前 API
        
        // 3. 下载云端主文件 (使用全局变量 OSS_FILE_NAME)
        log(`正在下载云端文件: ${OSS_FILE_NAME}...`, "#88f");
        
        let result;
        try {
            // 直接复用全局 ossClient
            result = await ossClient.get(OSS_FILE_NAME);
        } catch (ossErr) {
            console.error(ossErr);
            throw new Error("下载文件失败。请确保您已点击过 'Sync Cloud' 或配置正确。");
        }

        // 4. 使用 ExcelJS 读取数据 (注意：此处必须用 ExcelJS，因为需要复杂的行处理)
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(result.content);
        log("✅ 文件加载成功，开始回测计算...", "#0f0");

        // 5. 运行回测策略
        const allStrategiesResults = {};
        const enginesCache = {};
        
        // 遍历全局配置 GUARDIAN_CONFIG
        for (const [key, config] of Object.entries(GUARDIAN_CONFIG)) {
            // config.flowName = "大成OR", config.simpleName = "大成"
            const wsFlow = workbook.getWorksheet(config.flowName);
            const wsSnap = workbook.getWorksheet(config.simpleName);

            if (!wsFlow || !wsSnap) {
                log(`[跳过] 缺少工作表: ${config.simpleName}`, "orange");
                continue;
            }

            log(`>> 计算策略: ${config.simpleName}...`, "#ccc");

            const dataFlow = sheetToJsonEx(wsFlow);
            const dataSnap = sheetToJsonEx(wsSnap);

            // 实例化回测引擎 (类定义在下方)
            // 【修改点】：将 globalMarketMap 传入构造函数
            const engine = new PortfolioBacktestEngine(dataFlow, dataSnap, globalMarketMap);
            const history = await engine.run(); // run 现在是 async 的，以便内部获取价格

            allStrategiesResults[key] = history;
            enginesCache[key] = engine;
        }

        // 6. 生成并上传 JSON 报告
        log("正在生成综合评估报告...", "#88f");
        await generateAndUploadJsonReport(allStrategiesResults);

        // 7. (可选) 更新 Excel 中的最新价格和市值比例
        // 如果需要反写回 Excel，可以在这里调用 updateExcelLogic
        // 为防止意外覆盖，暂时只做 JSON 报告生成，反写 Excel 建议通过 "Sync Cloud" 按钮手动触发

        log("🎉 计算完成！请点击 'Battle Ranking' 查看最新 User 曲线。", "#0f0");

        // 如果图表已打开，刷新一下
        if(typeof renderHistoryChart === 'function') {
            // 重新加载历史数据以显示新曲线
            await loadHistoryData();
        }

    } catch (e) {
        log(`❌ 计算错误: ${e.message}`, "red");
        console.error(e);
    } finally {
        if(btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

// ==================================================================================
// 辅助类与函数
// ==================================================================================

// ExcelJS 转 JSON 辅助函数
function sheetToJsonEx(worksheet) {
    const data = [];
    let headers = [];
    if(!worksheet) return [];
    
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) {
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

// ==================================================================================
// 增强版回测引擎 (支持全量日期补全 + MarketMap行情结合)
// ==================================================================================
class PortfolioBacktestEngine {
    constructor(flowData, snapData, marketMap = {}) {
        this.cash = 100000;
        this.positions = {}; 
        this.marketMap = marketMap;
        
        // ... (预处理逻辑保持不变) ...
        this.flows = flowData.map(r => {
            let dateRaw = String(r['修改时间'] || '').trim(); // 去除可能存在的空格
            let dateFmt = null;

            // 修改点：只要长度大于等于8，且不含横杠，就截取前8位
            if (dateRaw.length >= 8 && !dateRaw.includes('-')) {
                // 截图中的数据是 '202512181630'，我们只需要前8位 '20251218'
                dateFmt = `${dateRaw.substring(0,4)}-${dateRaw.substring(4,6)}-${dateRaw.substring(6,8)}`;
            } 
            // 兼容 '2025-12-18 16:30' 这种情况
            else if (dateRaw.includes('-')) {
                dateFmt = dateRaw.split(' ')[0];
            }

            return {
                ...r,
                code: String(r['股票代码']).trim(),
                price: parseFloat(r['价格']),
                qty: parseFloat(r['标的数量']),
                type: r['操作类型'], // 截图显示是 'Buy'/'Sell'，大小写需注意，代码里如果是区分大小写的要注意
                dateFmt: dateFmt
            };
        }).filter(r => r.dateFmt).sort((a,b) => a.dateFmt.localeCompare(b.dateFmt));

        this.snap = snapData.map(r => ({
            ...r,
            code: String(r['股票代码']).trim(),
            weight: parseFloat(r['配置比例 (%)'] || 0)
        }));

        this.timeline = [];
        if (this.flows.length > 0) {
            const startDate = this.flows[0].dateFmt;
            const endDate = new Date().toISOString().split('T')[0];
            this.timeline = this.generateDateRange(startDate, endDate);
        } else {
            const endDate = new Date().toISOString().split('T')[0];
            const startDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split('T')[0];
            this.timeline = this.generateDateRange(startDate, endDate);
        }
    }

    generateDateRange(start, end) {
        // ... (保持不变) ...
        const arr = [];
        let dt = new Date(start);
        const endDt = new Date(end);
        while (dt <= endDt) {
            const y = dt.getFullYear();
            const m = String(dt.getMonth() + 1).padStart(2, '0');
            const d = String(dt.getDate()).padStart(2, '0');
            arr.push(`${y}-${m}-${d}`);
            dt.setDate(dt.getDate() + 1);
        }
        return arr;
    }

    async run() {
        console.log('====================================================');
        console.log(`🚀 开始回测 | 时间范围: ${this.timeline[0]} -> ${this.timeline[this.timeline.length-1]}`);
        console.log(`💰 初始资金: ${this.cash}`);
        console.log('====================================================');

        let currentCash = this.cash;
        let positions = {}; 
        let lastPrices = {}; 

        // --- 初始化阶段兜底 ---
        if (this.flows.length === 0 && this.snap.length > 0) {
            console.log('⚠️ 无流水，使用 Snap 快照初始化持仓...');
            this.snap.forEach(s => {
                if (s.code !== '100000' && s.weight > 0 && s['收盘价格']) {
                    const p = parseFloat(s['收盘价格']);
                    const qty = Math.floor((this.cash * (s.weight/100)) / p);
                    if(qty > 0) {
                        positions[s.code] = qty;
                        lastPrices[s.code] = p;
                        currentCash -= qty * p;
                        console.log(`   + 初始化买入: [${s.code}] ${qty}股 @ ${p} (权重${s.weight}%)`);
                    }
                }
            });
        }

        const history = [];

        // --- 核心循环 ---
        for (const date of this.timeline) {
            // 1. 获取行情
            const dailyMarketData = this.marketMap[date] || {};

            // 2. 处理当日交易
            const dailyFlows = this.flows.filter(f => f.dateFmt === date);
            
            if (dailyFlows.length > 0) {
                console.log(`\n📅 [${date}] 发现 ${dailyFlows.length} 笔交易:`);
            }

            dailyFlows.forEach(f => {
                lastPrices[f.code] = f.price; // 更新最新已知价格
                const tradeAmt = f.price * f.qty;
                
                if (f.type === 'Buy') {
                    currentCash -= tradeAmt;
                    positions[f.code] = (positions[f.code] || 0) + f.qty;
                    console.log(`   🟢 [买入] ${f.code} | 价格: ${f.price} | 数量: ${f.qty} | 金额: -${tradeAmt.toFixed(2)} | 剩余现金: ${currentCash.toFixed(2)}`);
                } else if (f.type === 'Sell') {
                    currentCash += tradeAmt;
                    if (positions[f.code]) {
                        positions[f.code] -= f.qty;
                        if (positions[f.code] <= 0.001) delete positions[f.code];
                    }
                    console.log(`   🔴 [卖出] ${f.code} | 价格: ${f.price} | 数量: ${f.qty} | 金额: +${tradeAmt.toFixed(2)} | 剩余现金: ${currentCash.toFixed(2)}`);
                }
            });

            // 3. 计算当日市值
            let stockMv = 0;
            let logDetails = []; // 用于收集当日持仓计价详情，避免刷屏，只在有交易日或特定日期查看

            for (let code in positions) {
                const qty = positions[code];
                let currentPrice = 0;
                let priceSource = '未知';

                if (dailyMarketData[code] !== undefined) {
                    currentPrice = parseFloat(dailyMarketData[code]);
                    lastPrices[code] = currentPrice; 
                    priceSource = 'MarketMap当日';
                } else {
                    currentPrice = lastPrices[code] || 0;
                    priceSource = '历史最后价';
                }
                
                stockMv += qty * currentPrice;
                
                // 如果当天有交易发生，顺便打印一下持仓的计价逻辑，方便排查
                if (dailyFlows.length > 0) {
                    logDetails.push(`      - 持仓 ${code}: ${qty}股 * ${currentPrice.toFixed(2)} (${priceSource}) = ${(qty*currentPrice).toFixed(2)}`);
                }
            }

            const totalEquity = currentCash + stockMv;
            
            // 如果当天有交易，或者每隔 30 天，打印一次结算日志，避免日志太多
            const isMonthEnd = date.endsWith('01'); // 简单用每月1号做心跳日志
            if (dailyFlows.length > 0 || isMonthEnd) {
                 if(logDetails.length > 0) console.log(logDetails.join('\n'));
                 console.log(`   🏁 [${date} 结算] 总资产: ${totalEquity.toFixed(2)} (现金: ${currentCash.toFixed(2)} + 持仓: ${stockMv.toFixed(2)})`);
            }

            history.push({
                '日期': date,
                '总资产': totalEquity,
                '现金': currentCash,
                '持仓市值': stockMv
            });
        }

        console.log('\n====================================================');
        console.log(`✅ 回测结束. 最终资产: ${history[history.length-1]['总资产'].toFixed(2)}`);
        console.log('====================================================');

        return history;
    }
}


async function generateAndUploadJsonReport(resultsDict) {
    console.log("Starting report generation (Detailed Analysis Mode - Strict Trading Days + History Merge)...");

    // ================= 配置区 =================
    const MARKET_FILE_NAME = 'MarketMap.json'; 
    const USER_REPORT_FILE = 'User模型综合评估.json';
    
    const ASSET_FIELD_NAME = '总资产'; 
    const DATE_FIELD_NAME  = '日期'; 
    const POSITION_FIELD_NAME = '持仓明细'; 
    const TRADE_FIELD_NAME = '交易记录';   
    const INITIAL_CASH = 100000;
    // ==========================================

    // --- 辅助函数：标准化日期 ---
    function normalizeDate(dateStr) {
        if (!dateStr) return null;
        const str = String(dateStr).trim();
        if (str.includes("-") && str.length === 10) return str;
        if (str.length >= 8 && !isNaN(str.substring(0, 8))) {
            const yyyy = str.substring(0, 4);
            const mm = str.substring(4, 6);
            const dd = str.substring(6, 8);
            return `${yyyy}-${mm}-${dd}`;
        }
        return str; 
    }

    // --- 辅助函数：获取历史数据 ---
    async function fetchHistoricalData() {
        console.log("📥 正在尝试获取历史评估数据...");
        let jsonStr = null;
        // 从 OSS 获取旧版文件
        if (!jsonStr) {
            try {
                const result = await ossClient.get(getSecureOssPath(USER_REPORT_FILE));
                jsonStr = result.content ? (typeof result.content === 'string' ? result.content : new TextDecoder("utf-8").decode(result.content)) : "";
                if(jsonStr) console.log(`✅ 已从 OSS 获取历史数据: ${getSecureOssPath(USER_REPORT_FILE)}`);
            } catch (e) {
                console.log(`ℹ️ OSS 未找到历史文件 (可能是首次运行或文件不存在)`);
            }
        }

        if (!jsonStr) return [];

        try {
            const data = JSON.parse(jsonStr);
            if (data && Array.isArray(data['每日评估数据'])) {
                // 仅提取我们需要的最简字段：日期和总资产
                // 因为其他指标（收益率、回撤）需要基于新长度重新计算
                return data['每日评估数据'].map(item => ({
                    date: item['日期'],
                    value: parseFloat(item['总资产'])
                })).filter(item => item.date && !isNaN(item.value));
            }
        } catch (e) {
            console.error(`❌ 解析历史 JSON 失败: ${e.message}`);
        }
        return [];
    }

    // ================= 1. 读取 MarketMap (确立本次计算的时间基准) =================
    const validTradingDatesSet = new Set();
    
    try {
        const result = await ossClient.get(MARKET_FILE_NAME);
        const marketJsonStr = result.content ? (typeof result.content === 'string' ? result.content : new TextDecoder("utf-8").decode(result.content)) : "";
        
        if (marketJsonStr) {
            const marketData = JSON.parse(marketJsonStr);
            const rawMarketDates = Array.isArray(marketData) ? marketData : Object.keys(marketData);
            rawMarketDates.forEach(d => {
                const stdDate = normalizeDate(d);
                if (stdDate) validTradingDatesSet.add(stdDate);
            });
            console.log(`✅ MarketMap 加载完成，本次计算基准日共 ${validTradingDatesSet.size} 天`);
        }
    } catch (e) {
        console.error(`❌ 读取 MarketMap 失败: ${e.message}`);
        return;
    }

    if (validTradingDatesSet.size === 0) {
        console.error("❌ 错误：MarketMap 中没有有效的日期数据");
        return;
    }

    // ================= 2. 提取策略流水 (处理本次数据) =================
    const strategyDailyMap = {}; 
    const strategyPositionsMap = {}; 
    const strategyTradesMap = {};    
    const strategies = Object.keys(resultsDict);
    
    strategies.forEach(key => {
        strategyDailyMap[key] = {};
        strategyPositionsMap[key] = {}; 
        strategyTradesMap[key] = {};    
        
        const records = resultsDict[key] || [];
        records.forEach(h => {
            const stdDate = normalizeDate(h[DATE_FIELD_NAME]);
            if (stdDate) {
                strategyDailyMap[key][stdDate] = h;
                if (h[POSITION_FIELD_NAME]) strategyPositionsMap[key][stdDate] = h[POSITION_FIELD_NAME];
                if (h[TRADE_FIELD_NAME]) strategyTradesMap[key][stdDate] = h[TRADE_FIELD_NAME];
            }
        });
    });

    // ================= 3. 构建本次计算的资产曲线 (Current Curve) =================
    const currentDates = Array.from(validTradingDatesSet).sort();
    const currentEquityCurve = [];
    const lastKnownValues = {};
    strategies.forEach(key => lastKnownValues[key] = INITIAL_CASH);

    currentDates.forEach((date) => {
        let dailySum = 0;
        strategies.forEach(key => {
            const dayRecord = strategyDailyMap[key][date];
            if (dayRecord) {
                let valStr = dayRecord[ASSET_FIELD_NAME];
                if (typeof valStr === 'string') valStr = valStr.replace(/,/g, '');
                const val = parseFloat(valStr);
                if (!isNaN(val)) lastKnownValues[key] = val;
            }
            dailySum += lastKnownValues[key];
        });
        currentEquityCurve.push({ date: date, value: dailySum });
    });

    // ================= 4. 合并历史数据与本次数据 (Merge Logic) =================
    console.log("🔗 开始合并历史数据与新数据...");
    
    // 获取历史数据
    const historicalData = await fetchHistoricalData();
    
    // 使用 Map 进行合并，Key 为日期，Value 为资产值
    // 逻辑：历史数据打底，新计算的数据覆盖旧数据（如果日期重复，信赖本次计算结果）
    const mergedEquityMap = new Map();

    // 4.1 填入历史
    historicalData.forEach(item => {
        mergedEquityMap.set(item.date, item.value);
    });

    // 4.2 填入本次 (覆盖重叠日期)
    currentEquityCurve.forEach(item => {
        mergedEquityMap.set(item.date, item.value);
    });

    // 4.3 生成最终时间轴并排序
    const finalSortedDates = Array.from(mergedEquityMap.keys()).sort();
    
    // 转换为数组对象供后续计算
    const totalEquityCurve = finalSortedDates.map(date => ({
        date: date,
        value: mergedEquityMap.get(date)
    }));

    console.log(`📊 [合并完成] 最终记录天数: ${totalEquityCurve.length} 天 (历史: ${historicalData.length}, 本次: ${currentEquityCurve.length})`);
    if (totalEquityCurve.length > 0) {
        console.log(`   时间范围: ${totalEquityCurve[0].date} -> ${totalEquityCurve[totalEquityCurve.length-1].date}`);
    }

    // ================= 5. 单日分析 (维持原逻辑，针对特定日期) =================
    // 注意：这里仍然使用 strategyDailyMap，所以只能分析本次 MarketMap 范围内的数据
    // 如果 targetDate 在历史数据里且不在本次计算里，这里无法展示详细 breakdown，这符合逻辑
    const targetDate = "2026-01-09";
    // 仅当 targetDate 在本次计算范围内时才打印详细分析
    if (validTradingDatesSet.has(targetDate)) {
        console.log("\n" + "=".repeat(80));
        console.log(`🔍 ${targetDate} 收益率详细来源分析`);
        
        // 为了计算 contribution，我们需要前一日的总资产
        // 在 mergedEquityMap 中查找
        const targetIdx = finalSortedDates.indexOf(targetDate);
        const prevDate = targetIdx > 0 ? finalSortedDates[targetIdx - 1] : null;
        
        const currentTotal = mergedEquityMap.get(targetDate);
        const prevTotal = prevDate ? mergedEquityMap.get(prevDate) : (INITIAL_CASH * strategies.length);
        const dailyRet = prevTotal !== 0 ? (currentTotal - prevTotal) / prevTotal : 0;

        console.log(`   前一交易日(${prevDate || '无'}): ${prevTotal.toFixed(2)}`);
        console.log(`   当前交易日(${targetDate}): ${currentTotal.toFixed(2)}`);
        console.log(`   日收益率: ${(dailyRet * 100).toFixed(2)}%`);
        console.log("-".repeat(80));
        
        // 策略明细打印 (代码保持原有逻辑，略...)
        // 这里为了简化代码展示，保留你原有的 strategies.forEach 逻辑即可
        // 核心是利用 strategyDailyMap[key][targetDate]
        strategies.forEach(key => {
             // ... 原有打印逻辑 ...
             // 简单示意：
             const currRec = strategyDailyMap[key][targetDate];
             if(currRec) {
                 // console.log(...)
             }
        });
        console.log("=".repeat(80) + "\n");
    }

    // ================= 6. 基于合并后的数据重新计算所有指标 =================
    console.log("🧮 正在基于完整历史重新计算指标...");
    
    const dailyDataList = [];
    const dailyReturns = []; 
    let maxPeak = -Infinity; 
    let maxDdSoFar = 0;      
    
    // 初始资产逻辑：
    // 如果有历史数据，第一天的前一天资产视为 "理论初始本金" 或者直接取第一天的资产作为基准
    // 为了计算累计收益率，通常需要一个恒定的本金。
    // 如果 strategies 数量没变，建议仍用 INITIAL_CASH * strategies.length
    // 或者取 totalEquityCurve[0].value 作为近似起点
    const initialEquity = INITIAL_CASH * strategies.length; 
    
    const days = totalEquityCurve.length;

    totalEquityCurve.forEach((dayData, idx) => {
        const currentEquity = dayData.value;
        const prevEquity = idx === 0 ? initialEquity : totalEquityCurve[idx - 1].value;

        let dailyRet = 0;
        if (prevEquity !== 0) {
            dailyRet = (currentEquity - prevEquity) / prevEquity;
        }

        // 修正点：总是记录收益率，包括第一天
        dailyReturns.push(dailyRet);

        const cumRet = (currentEquity - initialEquity) / initialEquity;

        if (currentEquity > maxPeak) maxPeak = currentEquity;
        const dd = maxPeak > 0 ? (currentEquity - maxPeak) / maxPeak : 0;
        if (Math.abs(dd) > maxDdSoFar) maxDdSoFar = Math.abs(dd);

        dailyDataList.push({
            "日期": dayData.date,
            "每日收益率": dailyRet,
            "累计收益率": cumRet,
            "最大回撤率（至当日）": maxDdSoFar,
            "总资产": currentEquity
        });
    });

    // ================= 7. 统计 & 上传 =================
    const lastDay = dailyDataList[dailyDataList.length - 1];
    const finalEquity = lastDay ? lastDay['总资产'] : initialEquity;

    // 1. 年化收益率 (CAGR)
    let annRet = 0;
    if (days > 1 && initialEquity > 0 && finalEquity > 0) {
        // days 是实际交易日，公式用 252 调整
        annRet = Math.pow((finalEquity / initialEquity), (252 / days)) - 1;
    }

    // 2. 夏普比率
    let sharpe = 0;
    if (dailyReturns.length > 1) {
        const sumRet = dailyReturns.reduce((a, b) => a + b, 0);
        const meanRet = sumRet / dailyReturns.length;
        const sumSqDiff = dailyReturns.reduce((sum, val) => sum + Math.pow(val - meanRet, 2), 0);
        const variance = sumSqDiff / (dailyReturns.length - 1); 
        const stdDev = Math.sqrt(variance);
        
        if (stdDev > 1e-8) {
            sharpe = (meanRet / stdDev) * Math.sqrt(252);
        }
    }

    const outputData = {
        "模型名称": "User模型",
        "更新时间": new Date().toISOString(),
        "总收益率": lastDay ? lastDay['累计收益率'] : 0,
        "年化收益率": annRet,
        "最大回撤率": maxDdSoFar,
        "夏普比率": sharpe,
        "分析天数": days,
        "初始资产": initialEquity,
        "最终资产": finalEquity,
        "每日评估数据": dailyDataList 
    };

    console.log("=".repeat(50));
    console.log("📋 综合报告 (含历史)");
    console.log("=".repeat(50));
    console.log(`总收益率: ${(outputData["总收益率"] * 100).toFixed(2)}%`);
    console.log(`年化收益率: ${(annRet * 100).toFixed(2)}%`);
    console.log(`最大回撤: ${(maxDdSoFar * 100).toFixed(2)}%`);
    console.log(`夏普比率: ${sharpe.toFixed(2)}`);
    console.log(`分析天数: ${days} 天`);
    console.log("=".repeat(50));

    try {
        const jsonString = JSON.stringify(outputData, null, 4);
        const blob = new Blob([jsonString], { type: 'application/json' });
        await ossClient.put(getSecureOssPath(USER_REPORT_FILE), blob);
        console.log(`✅ [User模型] 成功合并历史并上传至: ${getSecureOssPath(USER_REPORT_FILE)}`);
    } catch (e) {
        console.error("OSS上传失败", e);
    }
}
