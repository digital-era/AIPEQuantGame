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
    /**
     * @param {Array} flowData - 交易流水数组
     * @param {Array} snapData - 持仓快照数组 (用于兜底初始化)
     * @param {Object} marketMap - 全市场行情字典 { "YYYY-MM-DD": { "code": price, ... } }
     */
    constructor(flowData, snapData, marketMap = {}) {
        this.cash = 100000; // 默认初始资金
        this.positions = {}; 
        this.marketMap = marketMap;
        
        // 1. 预处理流水数据
        this.flows = flowData.map(r => {
            // 兼容日期格式：Excel可能是 20230101 或 2023-01-01
            let dateRaw = String(r['修改时间'] || '');
            let dateFmt = null;
            
            // 简单处理两种常见格式
            if (dateRaw.length === 8 && !dateRaw.includes('-')) {
                dateFmt = `${dateRaw.substring(0,4)}-${dateRaw.substring(4,6)}-${dateRaw.substring(6,8)}`;
            } else if (dateRaw.includes('-')) {
                dateFmt = dateRaw.split(' ')[0]; // 去掉可能的时间部分
            }

            return {
                ...r,
                code: String(r['股票代码']).trim(),
                price: parseFloat(r['价格']),
                qty: parseFloat(r['标的数量']),
                type: r['操作类型'], // Buy / Sell
                dateFmt: dateFmt
            };
        }).filter(r => r.dateFmt).sort((a,b) => a.dateFmt.localeCompare(b.dateFmt));

        this.snap = snapData.map(r => ({
            ...r,
            code: String(r['股票代码']).trim(),
            weight: parseFloat(r['配置比例 (%)'] || 0)
        }));

        // 2. 确定回测的时间范围 (从最早一笔交易 到 今天)
        this.timeline = [];
        if (this.flows.length > 0) {
            const startDate = this.flows[0].dateFmt;
            const endDate = new Date().toISOString().split('T')[0]; // 今天
            this.timeline = this.generateDateRange(startDate, endDate);
        } else {
            // 如果没有流水，默认生成最近30天用于展示 Snap 效果
            const endDate = new Date().toISOString().split('T')[0];
            const startDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split('T')[0];
            this.timeline = this.generateDateRange(startDate, endDate);
        }
    }

    /**
     * 生成连续的日期数组字符串 ['2023-01-01', '2023-01-02', ...]
     */
    generateDateRange(start, end) {
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
        let currentCash = this.cash;
        let positions = {}; // { "600519": 100, ... }
        let lastPrices = {}; // { "600519": 1700.00, ... } 记录每只股票最新的已知价格

        // --- 初始化阶段：如果没有任何流水，尝试从 Snap 加载初始持仓 ---
        if (this.flows.length === 0 && this.snap.length > 0) {
            this.snap.forEach(s => {
                if (s.code !== '100000' && s.weight > 0 && s['收盘价格']) {
                    const p = parseFloat(s['收盘价格']);
                    // 假设总仓位按权重分配
                    const qty = Math.floor((this.cash * (s.weight/100)) / p);
                    if(qty > 0) {
                        positions[s.code] = qty;
                        lastPrices[s.code] = p;
                        currentCash -= qty * p;
                    }
                }
            });
        }

        const history = [];

        // --- 核心循环：遍历时间轴每一天 ---
        for (const date of this.timeline) {
            // 1. 获取当日的外部行情数据 (MarketMap)
            // 假设 marketMap 结构为: { "2023-01-01": { "600519": 100.5, ... } }
            const dailyMarketData = this.marketMap[date] || {};

            // 2. 处理当日发生的交易流水
            const dailyFlows = this.flows.filter(f => f.dateFmt === date);
            
            dailyFlows.forEach(f => {
                // 交易发生，更新该股票的最新“交易价”作为价格基准
                lastPrices[f.code] = f.price; 
                
                if (f.type === 'Buy') {
                    currentCash -= f.price * f.qty;
                    positions[f.code] = (positions[f.code] || 0) + f.qty;
                } else if (f.type === 'Sell') {
                    currentCash += f.price * f.qty;
                    if (positions[f.code]) {
                        positions[f.code] -= f.qty;
                        // 清理微小碎股误差
                        if (positions[f.code] <= 0.001) delete positions[f.code];
                    }
                }
            });

            // 3. 计算当日持仓市值 (Mark-to-Market)
            let stockMv = 0;
            
            // 遍历当前所有持仓
            for (let code in positions) {
                const qty = positions[code];
                
                // --- 价格获取优先级逻辑 ---
                // Priority 1: MarketMap 中当日的收盘价 (最准确)
                // Priority 2: 当日刚刚交易的价格 (如果 MarketMap 没数据，比如新股上市首日)
                // Priority 3: 昨天或以前的 lastPrices (前向填充，用于周末或停牌)
                
                let currentPrice = 0;
                
                // 尝试从 MarketMap 获取
                // 注意：这里需要确保 Excel 里的 code 和 MarketMap 里的 key 一致
                // 如果 MarketMap 带后缀 (如 "600519.SH")，需要自行处理匹配逻辑，这里假设完全一致
                if (dailyMarketData[code] !== undefined) {
                    currentPrice = parseFloat(dailyMarketData[code]);
                    // 更新历史价格缓存，供后续无行情日期使用
                    lastPrices[code] = currentPrice; 
                } else {
                    // 如果没行情，使用缓存的最后价格
                    currentPrice = lastPrices[code] || 0;
                }
                
                stockMv += qty * currentPrice;
            }

            const totalEquity = currentCash + stockMv;
            
            history.push({
                '日期': date,
                '总资产': totalEquity,
                '现金': currentCash,
                '持仓市值': stockMv
            });
        }

        return history;
    }
}

async function generateAndUploadJsonReport(resultsDict) {
    console.log("Starting report generation (Final Fix)...");

    // ================= 配置区 =================
    const MARKET_FILE_NAME = 'MarketMap.json'; 
    const USER_REPORT_FILE = 'User模型综合评估.json';
    
    // ✅ 根据日志修正：字段名必须完全匹配 console 输出的 keys
    const ASSET_FIELD_NAME = '总资产'; 
    const DATE_FIELD_NAME  = '日期';   // 之前这里写的是 '修改日期'，导致了错误
    // ==========================================

    // --- 辅助函数：标准化日期 ---
    // 兼容：202512181630 (数字/字符) -> 2025-12-18
    // 兼容：2025-12-18 (原本格式) -> 2025-12-18
    function normalizeDate(dateStr) {
        if (!dateStr) return null;
        const str = String(dateStr).trim();
        
        // 如果已经是 YYYY-MM-DD (10位且有横杠)，直接返回
        if (str.includes("-") && str.length === 10) return str;
        
        // 处理长字符串 202512181630 或 20251218
        // 只要前8位是数字，就尝试截取
        if (str.length >= 8 && !isNaN(str.substring(0, 8))) {
            const yyyy = str.substring(0, 4);
            const mm = str.substring(4, 6);
            const dd = str.substring(6, 8);
            return `${yyyy}-${mm}-${dd}`;
        }
        return str; // 其他无法识别的格式，原样返回
    }

    // --- 1. 日期收集与预处理 ---
    const dateSet = new Set();
    const strategies = Object.keys(resultsDict);
    const strategyDailyMap = {}; 

    // 1.1 处理流水表
    strategies.forEach(key => {
        strategyDailyMap[key] = {};
        const records = resultsDict[key];

        // 排序：为了确保同一天取到最后一条，先按原日期字符串排序
        const sortedRecords = records.sort((a, b) => 
            String(a[DATE_FIELD_NAME]).localeCompare(String(b[DATE_FIELD_NAME]))
        );

        sortedRecords.forEach(h => {
            // 使用修正后的字段名 '日期'
            const rawDate = h[DATE_FIELD_NAME];
            const stdDate = normalizeDate(rawDate);
            
            if (stdDate) {
                dateSet.add(stdDate); 
                strategyDailyMap[key][stdDate] = h;
            } else {
                // 如果日期解析失败，打印一条日志看看到底长什么样（仅第一条）
                if (Math.random() < 0.01) console.warn(`⚠️ 日期解析失败: [${rawDate}] (策略: ${key})`);
            }
        });
    });

    console.log(`✅ 策略数据预处理完成，当前日期池: ${dateSet.size} 天 (仅包含策略实际交易日)`);

    // 1.2 处理 MarketMap (基准交易日补全)
    try {
        const result = await ossClient.get(MARKET_FILE_NAME);
        const marketJsonStr = result.content ? (typeof result.content === 'string' ? result.content : new TextDecoder("utf-8").decode(result.content)) : "";
        
        if (marketJsonStr) {
            const marketData = JSON.parse(marketJsonStr);
            // 兼容 Array 或 Object keys
            const marketDates = Array.isArray(marketData) ? marketData : Object.keys(marketData);
            
            let addedCount = 0;
            marketDates.forEach(d => {
                const stdDate = normalizeDate(d);
                if (stdDate) {
                    if (!dateSet.has(stdDate)) addedCount++;
                    dateSet.add(stdDate);
                }
            });
            console.log(`✅ MarketMap 合并完成，补充了 ${addedCount} 个空仓交易日，总计: ${dateSet.size} 天`);
        }
    } catch (e) {
        console.warn(`⚠️ 读取 MarketMap 异常 (不影响已有数据计算): ${e.message}`);
    }

    // 1.3 最终时间轴排序
    const sortedDates = Array.from(dateSet).sort();

    if (sortedDates.length === 0) {
        console.warn("❌ [严重] 最终日期列表为空。请检查流水表里的 '日期' 字段内容格式是否正确 (应为 202512181630 或 2025-12-18)");
        return;
    }

    // --- 2. 构建总资产曲线 ---
    const totalEquityCurve = [];
    const lastKnownValues = {};
    strategies.forEach(key => lastKnownValues[key] = 0);

    sortedDates.forEach(date => {
        let dailySum = 0;
        
        strategies.forEach(key => {
            const dayRecord = strategyDailyMap[key][date];
            if (dayRecord) {
                // 获取 '总资产'，去除可能存在的逗号
                let valStr = dayRecord[ASSET_FIELD_NAME];
                if (typeof valStr === 'string') valStr = valStr.replace(/,/g, '');
                
                const val = parseFloat(valStr);
                if (!isNaN(val)) {
                    lastKnownValues[key] = val;
                }
            }
            // 累加（FFill逻辑：如果没有新数据，沿用上一次的值）
            dailySum += lastKnownValues[key];
        });

        // 过滤掉总资产为0的初期阶段（可视需求保留）
        if (dailySum > 0) {
            totalEquityCurve.push({ date: date, value: dailySum });
        }
    });

    console.log(`📊 资产曲线构建完成，有效数据点: ${totalEquityCurve.length}`);

    if (totalEquityCurve.length === 0) {
        console.warn("❌ 资产曲线为空，请检查 '总资产' 数值是否全部为 0");
        return;
    }

    // --- 3. 指标计算 ---
    const dailyDataList = [];
    const dailyReturns = []; 
    let maxPeak = -Infinity; 
    let maxDdSoFar = 0;      
    const initialEquity = totalEquityCurve[0].value;
    const days = totalEquityCurve.length;

    totalEquityCurve.forEach((dayData, idx) => {
        const currentEquity = dayData.value;
        const prevEquity = idx === 0 ? initialEquity : totalEquityCurve[idx - 1].value;

        // 每日收益率
        let dailyRet = 0;
        if (idx > 0 && prevEquity !== 0) {
            dailyRet = (currentEquity - prevEquity) / prevEquity;
        }
        dailyReturns.push(dailyRet);

        // 累计收益率
        const cumRet = (currentEquity - initialEquity) / initialEquity;

        // 最大回撤
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

    // --- 4. 统计 & 上传 ---
    const lastDay = dailyDataList[dailyDataList.length - 1];
    const finalEquity = totalEquityCurve[days - 1].value;

    let annRet = 0;
    if (days > 1) {
        annRet = Math.pow((finalEquity / initialEquity), (252 / days)) - 1;
    }

    let sharpe = 0;
    if (dailyReturns.length > 1) {
        const sumRet = dailyReturns.reduce((a, b) => a + b, 0);
        const meanRet = sumRet / dailyReturns.length;
        // 样本方差
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
        "每日评估数据": dailyDataList
    };

    try {
        const jsonString = JSON.stringify(outputData, null, 4);
        const blob = new Blob([jsonString], { type: 'application/json' });
        await ossClient.put(USER_REPORT_FILE, blob);
        
        console.log(`✅ [User模型] 成功上传至: ${USER_REPORT_FILE}`);
        console.log(`📊 简报: 总收益 ${(outputData["总收益率"]*100).toFixed(2)}%, 夏普 ${sharpe.toFixed(2)}, 回撤 ${(maxDdSoFar*100).toFixed(2)}%`);
    } catch (e) {
        console.error("OSS上传失败", e);
    }
}
