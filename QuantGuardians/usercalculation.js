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
            const engine = new PortfolioBacktestEngine(dataFlow, dataSnap);
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

// 简易回测引擎
class PortfolioBacktestEngine {
    constructor(flowData, snapData) {
        this.cash = 100000; // 默认初始资金
        this.positions = {}; 
        this.history = [];
        
        // 预处理数据
        this.flows = flowData.map(r => {
            // 兼容日期格式
            let dateStr = String(r['修改时间'] || '').substring(0, 8);
            return {
                ...r,
                code: String(r['股票代码']).trim(),
                price: parseFloat(r['价格']),
                qty: parseFloat(r['标的数量']),
                type: r['操作类型'],
                date: dateStr,
                dateFmt: dateStr.length === 8 ? `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}` : null
            };
        }).filter(r => r.dateFmt).sort((a,b) => a.date - b.date);

        this.snap = snapData.map(r => ({
            ...r,
            code: String(r['股票代码']).trim(),
            weight: parseFloat(r['配置比例 (%)'] || 0)
        }));

        // 提取所有涉及的日期
        this.dates = [...new Set(this.flows.map(f => f.dateFmt))].sort();
        // 如果没有流水，给一个今天的日期
        if (this.dates.length === 0) {
            const today = new Date().toISOString().split('T')[0];
            this.dates = [today];
        }
    }

    async run() {
        // 简单模拟逻辑：仅根据流水计算资金变动
        // 注意：要在浏览器端精确复现历史净值，需要完整的历史行情数据(MarketMap)
        // 由于这里没有完整的历史行情库，我们采用 "近似市值法"：
        // 1. 现金流绝对准确
        // 2. 持仓市值 = 持仓量 * (流水中的最新价格 OR 现在的价格)
        
        let currentCash = this.cash;
        let positions = {}; // code -> qty
        let lastPrices = {}; // code -> price

        // 如果没有流水，尝试从 Snap 初始化 (视为初始买入)
        if (this.flows.length === 0 && this.snap.length > 0) {
            this.snap.forEach(s => {
                if (s.code !== '100000' && s.weight > 0 && s['收盘价格']) {
                    const p = parseFloat(s['收盘价格']);
                    const qty = Math.floor((this.cash * (s.weight/100)) / p);
                    positions[s.code] = qty;
                    lastPrices[s.code] = p;
                    currentCash -= qty * p;
                }
            });
        }

        const history = [];

        // 遍历每一天
        for (const date of this.dates) {
            const dailyFlows = this.flows.filter(f => f.dateFmt === date);
            
            // 处理当日交易
            dailyFlows.forEach(f => {
                lastPrices[f.code] = f.price; // 更新最新价格
                
                if (f.type === 'Buy') {
                    currentCash -= f.price * f.qty;
                    positions[f.code] = (positions[f.code] || 0) + f.qty;
                } else if (f.type === 'Sell') {
                    currentCash += f.price * f.qty;
                    if (positions[f.code]) {
                        positions[f.code] -= f.qty;
                        if (positions[f.code] <= 0.01) delete positions[f.code];
                    }
                }
            });

            // 计算当日市值
            let stockMv = 0;
            for (let code in positions) {
                const qty = positions[code];
                // 如果当日没有交易，价格沿用之前的。
                // *优化*：此处最好能获取当日收盘价，但为减少API请求，暂用最近一次交易价近似
                // 或使用全局 fetchPrice 获取当前价（如果是最后一天）
                let price = lastPrices[code] || 0;
                stockMv += qty * price;
            }

            const totalEquity = currentCash + stockMv;
            
            // 记录历史
            history.push({
                '日期': date,
                '总资产': totalEquity,
                '现金': currentCash,
                '持仓市值': stockMv
            });
        }
        
        // 修正最后一天的数据：尝试获取实时价格更新市值
        if (history.length > 0) {
            const lastEntry = history[history.length - 1];
            let realMv = 0;
            for (let code in positions) {
                // 利用主代码中的 fetchPrice 逻辑 (如果已缓存)
                // 这里简单发个请求获取最新价
                let price = lastPrices[code];
                try {
                     // 简单去重请求，这里略过，直接用最近流水的价格兜底
                     // 如果需要更精确，可以调用 external API
                } catch(e) {}
                realMv += positions[code] * price;
            }
            lastEntry['持仓市值'] = realMv;
            lastEntry['总资产'] = currentCash + realMv;
        }

        return history;
    }
}

async function generateAndUploadJsonReport(resultsDict) {
    // 合并所有策略的日期
    const dateSet = new Set();
    Object.values(resultsDict).forEach(hist => {
        hist.forEach(h => dateSet.add(h['日期']));
    });
    const sortedDates = Array.from(dateSet).sort();

    if (sortedDates.length === 0) return;

    const dailyDataList = [];
    const totalCurve = [];
    let initialTotal = 0;
    
    // 假设每个策略初始资金 10w，总共 40w (或者按实际配置)
    // 这里为了展示 User 整体收益，我们将所有策略的 PnL 加总
    
    let maxDd = 0;
    let globalPeak = 0;

    sortedDates.forEach((date, idx) => {
        let dailySum = 0;
        
        Object.values(resultsDict).forEach(hist => {
            // 找到该策略在该日的资产，若无则取最近一天
            const dayData = hist.find(h => h['日期'] === date);
            if (dayData) {
                dailySum += dayData['总资产'];
            } else {
                // 找这一天之前的最后一条数据
                const prev = hist.filter(h => h['日期'] < date).pop();
                dailySum += prev ? prev['总资产'] : 100000; // 默认初始值
            }
        });

        if (idx === 0) initialTotal = dailySum;

        const cumRtn = (dailySum - initialTotal) / initialTotal;
        
        // 回撤计算
        if (dailySum > globalPeak) globalPeak = dailySum;
        const dd = globalPeak > 0 ? (dailySum - globalPeak) / globalPeak : 0;
        if (Math.abs(dd) > maxDd) maxDd = Math.abs(dd);

        dailyDataList.push({
            "日期": date,
            "累计收益率": cumRtn,
            "总资产": dailySum,
            "最大回撤率（至当日）": Math.abs(dd)
        });
    });

    const lastDay = dailyDataList[dailyDataList.length - 1];
    
    // 构建输出对象
    const outputData = {
        "模型名称": "UserComposed",
        "总收益率": lastDay ? lastDay['累计收益率'] : 0,
        "最大回撤率": maxDd,
        "每日评估数据": dailyDataList
    };

    // 上传到 OSS
    const jsonString = JSON.stringify(outputData, null, 4);
    const blob = new Blob([jsonString], { type: 'application/json' });
    
    // 复用全局 ossClient 上传
    await ossClient.put(USER_REPORT_FILE, blob);
    log(`✅ JSON 报告已上传至: ${USER_REPORT_FILE}`, "#0f0");
}
