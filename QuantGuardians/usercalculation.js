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
    console.log("Starting report generation (Detailed Analysis Mode)...");

    // ================= 配置区 =================
    const MARKET_FILE_NAME = 'MarketMap.json'; 
    const USER_REPORT_FILE = 'User模型综合评估.json';
    const ASSET_FIELD_NAME = '总资产'; 
    const DATE_FIELD_NAME  = '日期'; 
    const POSITION_FIELD_NAME = '持仓明细'; // 新增：持仓明细字段
    const TRADE_FIELD_NAME = '交易记录';   // 新增：交易记录字段
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

    const dateSet = new Set();
    const strategyDailyMap = {}; 
    const strategyPositionsMap = {}; // 新增：存储每日持仓明细
    const strategyTradesMap = {};    // 新增：存储每日交易记录
    const strategies = Object.keys(resultsDict);
    const flowDates = new Set();
    
    let marketDates = [];

    // --- 1. 读取 MarketMap ---
    try {
        const result = await ossClient.get(MARKET_FILE_NAME);
        const marketJsonStr = result.content ? (typeof result.content === 'string' ? result.content : new TextDecoder("utf-8").decode(result.content)) : "";
        
        if (marketJsonStr) {
            const marketData = JSON.parse(marketJsonStr);
            marketDates = Array.isArray(marketData) ? marketData : Object.keys(marketData);
            
            marketDates.forEach(d => {
                const stdDate = normalizeDate(d);
                if (stdDate) dateSet.add(stdDate);
            });
            console.log(`✅ MarketMap 加载完成，${marketDates.length} 个交易日`);
        }
    } catch (e) {
        console.warn(`⚠️ 读取 MarketMap 失败: ${e.message}`);
    }

    // --- 2. 提取策略流水具体日期 ---
    console.log(`📊 正在处理 ${strategies.length} 个策略的流水数据...`);
    
    strategies.forEach(key => {
        strategyDailyMap[key] = {};
        strategyPositionsMap[key] = {}; // 初始化持仓明细
        strategyTradesMap[key] = {};    // 初始化交易记录
        
        const records = resultsDict[key];
        
        if (!records || records.length === 0) {
            console.log(`⚠️ 策略 [${key}] 没有流水记录，跳过`);
            return;
        }

        const sortedRecords = records.sort((a, b) => 
            String(a[DATE_FIELD_NAME]).localeCompare(String(b[DATE_FIELD_NAME]))
        );

        sortedRecords.forEach(h => {
            const rawDate = h[DATE_FIELD_NAME];
            const stdDate = normalizeDate(rawDate);
            
            if (stdDate) {
                // 保存总资产
                strategyDailyMap[key][stdDate] = h;
                flowDates.add(stdDate);
                dateSet.add(stdDate);
                
                // 保存持仓明细（如果有）
                if (h[POSITION_FIELD_NAME]) {
                    strategyPositionsMap[key][stdDate] = h[POSITION_FIELD_NAME];
                }
                
                // 保存交易记录（如果有）
                if (h[TRADE_FIELD_NAME]) {
                    strategyTradesMap[key][stdDate] = h[TRADE_FIELD_NAME];
                }
            }
        });
        
        console.log(`✅ 策略 [${key}] 处理完毕`);
    });

    // --- 3. 生成最终时间轴 ---
    const sortedDates = Array.from(dateSet).sort();
    
    console.log(`📊 [最终合并结果]`);
    console.log(`   总日期数: ${sortedDates.length} 天`);
    console.log(`   时间范围: ${sortedDates[0] || '无'} -> ${sortedDates[sortedDates.length-1] || '无'}`);

    // --- 4. 构建总资产曲线 ---
    console.log("📈 开始构建总资产曲线...");
    const totalEquityCurve = [];
    const lastKnownValues = {};
    strategies.forEach(key => lastKnownValues[key] = INITIAL_CASH);

    // 专门分析 2026-01-09 的数据
    const targetDate = "2026-01-09";
    const targetDateIndex = sortedDates.indexOf(targetDate);
    
    if (targetDateIndex === -1) {
        console.warn(`❌ 目标日期 ${targetDate} 不在日期列表中`);
    }

    sortedDates.forEach((date, index) => {
        let dailySum = 0;
        
        strategies.forEach(key => {
            const dayRecord = strategyDailyMap[key][date];
            if (dayRecord) {
                let valStr = dayRecord[ASSET_FIELD_NAME];
                if (typeof valStr === 'string') valStr = valStr.replace(/,/g, '');
                const val = parseFloat(valStr);
                if (!isNaN(val)) {
                    lastKnownValues[key] = val;
                    dailySum += val;
                }
            } else {
                dailySum += lastKnownValues[key];
            }
        });

        totalEquityCurve.push({ date: date, value: dailySum });
    });

    // --- 5. 专门分析 2026-01-09 的收益率来源 ---
    console.log("\n" + "=".repeat(80));
    console.log("🔍 2026-01-09 收益率详细来源分析");
    console.log("=".repeat(80));
    
    if (targetDateIndex !== -1) {
        const prevDate = sortedDates[targetDateIndex - 1];
        const currentEquity = totalEquityCurve[targetDateIndex].value;
        const prevEquity = totalEquityCurve[targetDateIndex - 1].value;
        const dailyRet = prevEquity !== 0 ? (currentEquity - prevEquity) / prevEquity : 0;
        
        console.log(`📅 分析日期: ${targetDate}`);
        console.log(`📊 总体情况:`);
        console.log(`   前一日(${prevDate})总资产: ${prevEquity.toFixed(2)}`);
        console.log(`   当日(${targetDate})总资产: ${currentEquity.toFixed(2)}`);
        console.log(`   收益率: ${(dailyRet * 100).toFixed(2)}%`);
        
        // 分析每个策略的贡献
        console.log("\n📊 各策略贡献分析:");
        console.log("策略名称              前一日资产        当日资产        变化金额        贡献度");
        console.log("-".repeat(80));
        
        let totalContribution = 0;
        strategies.forEach(key => {
            const prevDayRecord = strategyDailyMap[key][prevDate];
            const currDayRecord = strategyDailyMap[key][targetDate];
            
            let prevValue = 0;
            let currValue = 0;
            
            // 获取前一日资产
            if (prevDayRecord) {
                let valStr = prevDayRecord[ASSET_FIELD_NAME];
                if (typeof valStr === 'string') valStr = valStr.replace(/,/g, '');
                prevValue = parseFloat(valStr) || lastKnownValues[key];
            }
            
            // 获取当日资产
            if (currDayRecord) {
                let valStr = currDayRecord[ASSET_FIELD_NAME];
                if (typeof valStr === 'string') valStr = valStr.replace(/,/g, '');
                currValue = parseFloat(valStr) || lastKnownValues[key];
            }
            
            const change = currValue - prevValue;
            const contribution = prevEquity !== 0 ? change / prevEquity : 0;
            totalContribution += contribution;
            
            console.log(
                `${key.padEnd(20)} ` +
                `${prevValue.toFixed(2).padStart(15)} ` +
                `${currValue.toFixed(2).padStart(15)} ` +
                `${change.toFixed(2).padStart(15)} ` +
                `${(contribution * 100).toFixed(2)}%`.padStart(15)
            );
            
            // 如果该策略有持仓明细，打印具体持仓变化
            if (strategyPositionsMap[key][targetDate] || strategyPositionsMap[key][prevDate]) {
                console.log(`   └─ 持仓分析:`);
                
                const prevPositions = strategyPositionsMap[key][prevDate] || [];
                const currPositions = strategyPositionsMap[key][targetDate] || [];
                
                // 简单的持仓对比分析
                const prevPosMap = new Map();
                const currPosMap = new Map();
                
                prevPositions.forEach(pos => {
                    if (pos.code && pos.marketValue) {
                        prevPosMap.set(pos.code, parseFloat(pos.marketValue));
                    }
                });
                
                currPositions.forEach(pos => {
                    if (pos.code && pos.marketValue) {
                        currPosMap.set(pos.code, parseFloat(pos.marketValue));
                    }
                });
                
                // 找出变化的持仓
                const allCodes = new Set([...prevPosMap.keys(), ...currPosMap.keys()]);
                allCodes.forEach(code => {
                    const prevVal = prevPosMap.get(code) || 0;
                    const currVal = currPosMap.get(code) || 0;
                    const changeVal = currVal - prevVal;
                    
                    if (Math.abs(changeVal) > 0.01) {
                        console.log(`      ${code}: ${prevVal.toFixed(2)} → ${currVal.toFixed(2)} (${changeVal > 0 ? '+' : ''}${changeVal.toFixed(2)})`);
                    }
                });
            }
            
            // 如果该策略有交易记录，打印交易详情
            if (strategyTradesMap[key][targetDate]) {
                const trades = strategyTradesMap[key][targetDate];
                if (Array.isArray(trades) && trades.length > 0) {
                    console.log(`   └─ 当日交易记录(${trades.length}笔):`);
                    
                    trades.forEach((trade, idx) => {
                        const type = trade.type || (trade.amount > 0 ? '买入' : '卖出');
                        const code = trade.code || '未知';
                        const amount = parseFloat(trade.amount || 0);
                        const price = parseFloat(trade.price || 0);
                        const volume = parseFloat(trade.volume || 0);
                        
                        console.log(`      ${idx+1}. ${type} ${code}: ${volume}股 @ ${price.toFixed(2)} 金额:${amount.toFixed(2)}`);
                    });
                }
            }
        });
        
        console.log(`\n📊 贡献度验证:`);
        console.log(`   各策略贡献度合计: ${(totalContribution * 100).toFixed(2)}%`);
        console.log(`   实际日收益率: ${(dailyRet * 100).toFixed(2)}%`);
        console.log(`   差异: ${Math.abs((totalContribution - dailyRet) * 100).toFixed(4)}%`);
        
        // 如果没有持仓和交易明细，给出建议
        let hasDetailedData = false;
        strategies.forEach(key => {
            if (strategyPositionsMap[key][targetDate] || strategyTradesMap[key][targetDate]) {
                hasDetailedData = true;
            }
        });
        
        if (!hasDetailedData) {
            console.log("\n⚠️ 注意: 未找到持仓明细或交易记录数据");
            console.log("   要分析收益率的具体来源，需要流水数据包含以下字段:");
            console.log("   1. '持仓明细': 包含股票代码、数量、市值等信息");
            console.log("   2. '交易记录': 包含买卖操作、股票代码、价格、数量等信息");
            console.log("\n   请检查流水数据格式或修改字段名称配置。");
        }
        
    } else {
        console.log(`❌ 无法分析: 目标日期 ${targetDate} 不在日期列表中`);
    }
    
    console.log("=".repeat(80) + "\n");

    // --- 6. 继续原来的指标计算和报告生成 ---
    console.log("🧮 开始计算收益率指标...");
    
    const dailyDataList = [];
    const dailyReturns = []; 
    let maxPeak = -Infinity; 
    let maxDdSoFar = 0;      
    
    if (totalEquityCurve.length === 0) {
        console.warn("❌ [严重] 有效资产数据为空");
        return;
    }

    // 显式计算：初始本金 = 单个策略本金 * 策略数量
    const theoreticalInitialEquity = INITIAL_CASH * strategies.length;

    // 在计算 dailyDataList 循环之前，强制修正初始基准（可选，视具体需求）
    // 或者在计算 annRet 时使用：
    const initialEquity = theoreticalInitialEquity
    
    const days = totalEquityCurve.length;

    totalEquityCurve.forEach((dayData, idx) => {
        const currentEquity = dayData.value;
        const prevEquity = idx === 0 ? initialEquity : totalEquityCurve[idx - 1].value;

        let dailyRet = 0;
        if (idx > 0 && prevEquity !== 0) {
            dailyRet = (currentEquity - prevEquity) / prevEquity;
            dailyReturns.push(dailyRet);
        }

        const cumRet = (currentEquity - initialEquity) / initialEquity;

        if (currentEquity > maxPeak) maxPeak = currentEquity;
        const dd = maxPeak > 0 ? (currentEquity - maxPeak) / maxPeak : 0;
        if (Math.abs(dd) > maxDdSoFar) maxDdSoFar = Math.abs(dd);

        // 只添加有流水的日期到dailyDataList
        if (flowDates.has(dayData.date)) {
            dailyDataList.push({
                "日期": dayData.date,
                "每日收益率": dailyRet,
                "累计收益率": cumRet,
                "最大回撤率（至当日）": maxDdSoFar,
                "总资产": currentEquity
            });
        }
    });

    // --- 6. 统计 & 上传 ---
    console.log("📊 生成最终报告...");
    
    if (dailyDataList.length === 0) {
        console.warn("❌ 没有生成有效的每日数据");
        return;
    }
    
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
    console.log(`有流水天数: ${flowDates.size}`);
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
