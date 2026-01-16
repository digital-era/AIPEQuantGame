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
    console.log("Starting report generation (Simple Union Mode)...");

    // ================= 配置区 =================
    const MARKET_FILE_NAME = 'MarketMap.json'; 
    const USER_REPORT_FILE = 'User模型综合评估.json';
    const ASSET_FIELD_NAME = '总资产'; 
    const DATE_FIELD_NAME  = '日期'; 
    const INITIAL_CASH = 100000; // 初始资金
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

    const dateSet = new Set();
    const strategyDailyMap = {}; 
    const strategies = Object.keys(resultsDict);
    const flowDates = new Set(); // 专门记录有真实流水的日期
    
    // 在外部声明 marketDates，确保在整个函数中都可以访问
    let marketDates = [];  // 在外部声明，初始化为空数组

    // --- 1. 首先读取 MarketMap (基准交易日) ---
    try {
        const result = await ossClient.get(MARKET_FILE_NAME);
        const marketJsonStr = result.content ? (typeof result.content === 'string' ? result.content : new TextDecoder("utf-8").decode(result.content)) : "";
        
        if (marketJsonStr) {
            const marketData = JSON.parse(marketJsonStr);
            marketDates = Array.isArray(marketData) ? marketData : Object.keys(marketData);
            
            // 将所有MarketMap日期添加到日期池
            marketDates.forEach(d => {
                const stdDate = normalizeDate(d);
                if (stdDate) dateSet.add(stdDate);
            });
            console.log(`✅ [Step 1] MarketMap 加载完成，添加了 ${marketDates.length} 个基准交易日`);
        } else {
            console.warn(`⚠️ MarketMap 文件内容为空`);
        }
    } catch (e) {
        console.warn(`⚠️ 读取 MarketMap 失败 (将仅使用策略流水日期): ${e.message}`);
    }

    // --- 2. 提取策略流水具体日期 (与MarketMap日期取并集) ---
    console.log(`📊 正在处理 ${strategies.length} 个策略的流水数据...`);
    
    strategies.forEach(key => {
        strategyDailyMap[key] = {};
        const records = resultsDict[key];
        
        if (!records || records.length === 0) {
            console.log(`⚠️ 策略 [${key}] 没有流水记录，跳过`);
            return;
        }

        // 排序
        const sortedRecords = records.sort((a, b) => 
            String(a[DATE_FIELD_NAME]).localeCompare(String(b[DATE_FIELD_NAME]))
        );

        const validDatesForStrategy = [];  // 这个策略有流水的所有日期
        let newDatesAdded = 0;  // 新添加到日期池的日期数量
        
        sortedRecords.forEach(h => {
            const rawDate = h[DATE_FIELD_NAME];
            const stdDate = normalizeDate(rawDate);
            
            if (stdDate) {
                // 保存这个策略在这个日期的流水记录
                strategyDailyMap[key][stdDate] = h;
                validDatesForStrategy.push(stdDate);
                flowDates.add(stdDate); // 添加到有流水的日期集合
                
                // 如果这个日期不在日期池中，添加到日期池
                if (!dateSet.has(stdDate)) {
                    dateSet.add(stdDate);
                    newDatesAdded++;
                }
            }
        });
        
        console.log(`✅ 策略 [${key}] 处理完毕:`);
        console.log(`   📊 有 ${validDatesForStrategy.length} 个流水日期`);
        console.log(`   ➕ 新增了 ${newDatesAdded} 个日期到日期池`);
        if (validDatesForStrategy.length > 0) {
            console.log(`   📅 流水日期范围: ${validDatesForStrategy[0]} 到 ${validDatesForStrategy[validDatesForStrategy.length - 1]}`);
        }
    });

    // --- 3. 生成最终时间轴 (MarketMap日期 + 所有流水日期) ---
    const sortedDates = Array.from(dateSet).sort();
    const sortedFlowDates = Array.from(flowDates).sort(); // 只有有流水的日期
    
    console.log(`📊 [最终合并结果]`);
    console.log(`   总日期数: ${sortedDates.length} 天`);
    console.log(`   有流水的日期: ${sortedFlowDates.length} 天`);
    console.log(`   时间范围: ${sortedDates[0] || '无'} -> ${sortedDates[sortedDates.length-1] || '无'}`);
    console.log(`   📆 日期池完整列表: ${JSON.stringify(sortedDates)}`);
    console.log(`   📆 有流水日期列表: ${JSON.stringify(sortedFlowDates)}`);

    if (sortedFlowDates.length === 0) {
        console.warn("❌ [严重] 没有找到任何有流水的日期，无法生成报告");
        return;
    }

    // --- 4. 构建总资产曲线（只基于有流水的日期）---
    console.log("📈 开始构建总资产曲线（仅基于有流水的日期）...");
    const totalEquityCurve = [];
    const lastKnownValues = {};
    
    // 初始资金分配
    if (strategies.length > 0) {
        const initialPerStrategy = INITIAL_CASH / strategies.length;
        strategies.forEach(key => lastKnownValues[key] = initialPerStrategy);
    } else {
        console.warn("⚠️ 没有策略数据，使用默认初始资金");
        lastKnownValues['default'] = INITIAL_CASH;
    }

    // 关键修改：只遍历有流水的日期
    sortedFlowDates.forEach((date, index) => {
        let dailySum = 0;
        
        strategies.forEach(key => {
            const dayRecord = strategyDailyMap[key][date];
            if (dayRecord) {
                // 这个策略在这个日期有流水
                let valStr = dayRecord[ASSET_FIELD_NAME];
                if (typeof valStr === 'string') valStr = valStr.replace(/,/g, '');
                const val = parseFloat(valStr);
                if (!isNaN(val)) {
                    lastKnownValues[key] = val;
                    dailySum += val;
                }
            } else {
                // 这个策略在这个日期没有流水，使用上一次的值（资产保持不变）
                dailySum += lastKnownValues[key];
            }
        });

        // 如果没有策略（特殊情况），使用默认值
        if (strategies.length === 0) {
            dailySum = lastKnownValues['default'];
        }

        // 添加这个日期的数据到总资产曲线
        totalEquityCurve.push({ date: date, value: dailySum });
        
        console.log(`   ${date}: ${dailySum.toFixed(2)}`);
    });

    // --- 5. 指标计算（修复除零问题）---
    console.log("🧮 开始计算收益率指标...");
    
    const dailyDataList = [];
    const dailyReturns = []; 
    let maxPeak = -Infinity; 
    let maxDdSoFar = 0;      
    
    if (totalEquityCurve.length === 0) {
        console.warn("❌ [严重] 有效资产数据为空");
        return;
    }

    // 确保初始资产不为0
    let initialEquity = totalEquityCurve[0].value;
    if (initialEquity <= 0) {
        console.warn(`⚠️ 初始资产为 ${initialEquity}，使用初始资金 ${INITIAL_CASH}`);
        initialEquity = INITIAL_CASH;
        totalEquityCurve[0].value = INITIAL_CASH;
    }
    
    const days = totalEquityCurve.length;
    
    console.log(`   初始资产: ${initialEquity.toFixed(2)}`);
    console.log(`   总分析天数: ${days}`);

    totalEquityCurve.forEach((dayData, idx) => {
        const currentEquity = dayData.value;
        const prevEquity = idx === 0 ? initialEquity : totalEquityCurve[idx - 1].value;

        let dailyRet = 0;
        if (idx > 0 && prevEquity !== 0) {
            dailyRet = (currentEquity - prevEquity) / prevEquity;
            dailyReturns.push(dailyRet);
        }

        const cumRet = prevEquity !== 0 ? (currentEquity - initialEquity) / initialEquity : 0;

        if (currentEquity > maxPeak) maxPeak = currentEquity;
        const dd = maxPeak > 0 ? (currentEquity - maxPeak) / maxPeak : 0;
        if (Math.abs(dd) > maxDdSoFar) maxDdSoFar = Math.abs(dd);

        // 只添加有流水的日期到dailyDataList
        dailyDataList.push({
            "日期": dayData.date,
            "每日收益率": dailyRet,
            "累计收益率": cumRet,
            "最大回撤率（至当日）": maxDdSoFar,
            "总资产": currentEquity
        });
    });

    // --- 6. 统计 & 上传 ---
    console.log("📊 生成最终报告...");
    
    const lastDay = dailyDataList[dailyDataList.length - 1];
    const finalEquity = totalEquityCurve[days - 1].value;

    let annRet = 0;
    if (days > 1 && initialEquity > 0) {
        annRet = Math.pow((finalEquity / initialEquity), (252 / days)) - 1;
    }

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
        "每日评估数据": dailyDataList  // 只包含有流水的日期
    };

    // 打印简版报告
    console.log("=".repeat(50));
    console.log("📋 简版报告");
    console.log("=".repeat(50));
    console.log(`总收益率: ${(outputData["总收益率"] * 100).toFixed(2)}%`);
    console.log(`年化收益率: ${(annRet * 100).toFixed(2)}%`);
    console.log(`最大回撤: ${(maxDdSoFar * 100).toFixed(2)}%`);
    console.log(`夏普比率: ${sharpe.toFixed(2)}`);
    console.log(`分析天数: ${days}`);
    console.log(`初始资产: ${initialEquity.toFixed(2)}`);
    console.log(`最终资产: ${finalEquity.toFixed(2)}`);
    console.log(`日期池天数: ${sortedDates.length}`);
    console.log(`有流水天数: ${sortedFlowDates.length}`);
    console.log(`JSON输出天数: ${dailyDataList.length}`);
    console.log("=".repeat(50));

    try {
        const jsonString = JSON.stringify(outputData, null, 4);
        const blob = new Blob([jsonString], { type: 'application/json' });
        await ossClient.put(USER_REPORT_FILE, blob);
        
        console.log(`✅ [User模型] 成功上传至: ${USER_REPORT_FILE}`);
    } catch (e) {
        console.error("OSS上传失败", e);
    }
}
