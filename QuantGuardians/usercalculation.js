// ==================================================================================
// 1. 配置信息
// ==================================================================================

// --- GitHub 配置 ---
const GITHUB_CONFIG = {
  USERNAME: "digital-era",
  REPO_NAME: "AIPEQModel",
  TARGET_BRANCH: "main",
  FILE_PATH: "HK/EEIFlowHK.xlsx" // 指定子目录 HK 下的文件
};

const window.OSS_CONFIG = {
  // OSS相关配置
  ACCESS_KEY_ID: '', 
  ACCESS_KEY_SECRET: '',
  REGION: 'oss-cn-hangzhou', 
  BUCKET_NAME: 'aiep-users',

  // OSS 路径配置
  OSS_REMOTE_PATH: 'AIPEQuantGuardiansPortfolio.xlsx',
  OSS_JSON_PATH: 'QuantGuardians综合评估.json',
  
  INITIAL_CAPITAL: 100000.0
};

const STRATEGY_MAP = {
  'genbu':  { sheet_flow: '低波OR', sheet_snap: '低波', name: '低波' },
  'suzaku': { sheet_flow: '大成OR', sheet_snap: '大成', name: '大成' },
  'sirius': { sheet_flow: '流入OR', sheet_snap: '流入', name: '流入' },
  'kirin':  { sheet_flow: '大智OR', sheet_snap: '大智', name: '大智' }
};


// 页面加载时尝试从 LocalStorage 读取配置覆盖默认值
document.addEventListener('DOMContentLoaded', function() {
    var savedConfig = localStorage.getItem('OSS_window.OSS_CONFIG_STORE');
    if (savedConfig) {
        try {
            var parsed = JSON.parse(savedConfig);
            // 更新全局变量
            window.OSS_window.OSS_CONFIG = parsed;
            // 更新 Input 显示的值
            document.getElementById('oss_region').value = parsed.region;
            document.getElementById('oss_bucket').value = parsed.bucket;
            document.getElementById('oss_ak_id').value = parsed.accessKeyId;
            document.getElementById('oss_ak_secret').value = parsed.accessKeySecret;
            console.log("OSS Config loaded from LocalStorage");
        } catch (e) {
            console.error("Failed to load OSS config", e);
        }
    }
});

// 保存配置函数
function saveOssSettings() {
    var newConfig = {
        region: document.getElementById('oss_region').value,
        bucket: document.getElementById('oss_bucket').value,
        accessKeyId: document.getElementById('oss_ak_id').value,
        accessKeySecret: document.getElementById('oss_ak_secret').value
    };
    
    // 更新全局变量
    window.OSS_window.OSS_CONFIG = newConfig;
    
    // 持久化存储
    localStorage.setItem('OSS_window.OSS_CONFIG_STORE', JSON.stringify(newConfig));
    
    alert("OSS Configuration Saved & Applied!");
    document.getElementById('settingsModal').style.display = 'none';
}

// 日志工具
function log(msg, type = 'info') {
  const logDiv = document.getElementById('log');
  const time = new Date().toLocaleTimeString();
  let color = 'black';
  if (type === 'error') color = 'red';
  if (type === 'success') color = 'green';
  
  logDiv.innerHTML += `<div style="color:${color}">[${time}] ${msg}</div>`;
  logDiv.scrollTop = logDiv.scrollHeight;
  console.log(`[${time}] ${msg}`);
}

// 初始化 OSS 客户端 (已修复: 增加 secure: true)
const client = new OSS({
  region: window.OSS_CONFIG.REGION,
  accessKeyId: window.OSS_CONFIG.ACCESS_KEY_ID,
  accessKeySecret: window.OSS_CONFIG.ACCESS_KEY_SECRET,
  bucket: window.OSS_CONFIG.BUCKET_NAME,
  secure: true // ⚠️ 关键修改：强制使用 HTTPS，避免混合内容错误
});

// ==================================================================================
// 2. 核心类：回测引擎
// ==================================================================================
class PortfolioBacktest {
  constructor(flowData, snapData, marketDataMap, hkDataMap) {
      this.cash = window.OSS_CONFIG.INITIAL_CAPITAL;
      this.positions = {}; 
      this.history = [];
      this.marketMap = {...marketDataMap}; // 深拷贝一份基础A股行情

      // 合并港股行情到 marketMap
      for (let date in hkDataMap) {
          if (!this.marketMap[date]) this.marketMap[date] = {};
          Object.assign(this.marketMap[date], hkDataMap[date]);
      }
      
      // 预处理数据
      this.flows = flowData.map(r => ({
          ...r,
          code: String(r['股票代码']).trim(),
          date: r['修改时间'] ? String(r['修改时间']).substring(0, 8) : null, // YYYYMMDD
          dateFmt: r['修改时间'] ? moment(String(r['修改时间']).substring(0, 8), 'YYYYMMDD').format('YYYY-MM-DD') : null
      })).filter(r => r.dateFmt);

      this.snap = snapData.map(r => ({
          ...r,
          code: String(r['股票代码']).trim()
      }));

      this.allDates = Object.keys(this.marketMap).sort();
  }

  run() {
      let prevTotalEquity = window.OSS_CONFIG.INITIAL_CAPITAL;
      let initializedFromSnap = false;

      for (const date of this.allDates) {
          const dailyPrices = this.marketMap[date] || {};

          // --- A: 初始持仓 ---
          if (!initializedFromSnap) {
              for (const row of this.snap) {
                  const code = row.code;
                  if (code === '100000' || String(row['股票名称']).includes('现金')) continue;

                  const weight = (parseFloat(row['配置比例 (%)']) || 0) / 100.0;
                  const price = dailyPrices[code];

                  if (price && price > 0 && weight > 0) {
                      const qty = Math.floor((window.OSS_CONFIG.INITIAL_CAPITAL * weight) / price);
                      this.positions[code] = qty;
                      this.cash -= (qty * price);
                  }
              }
              initializedFromSnap = true;
          }

          // --- B: 当日交易 ---
          const dailyFlows = this.flows.filter(f => f.dateFmt === date);
          const activeStocks = [];

          for (const row of dailyFlows) {
              const code = row.code;
              const opType = row['操作类型'];
              const price = parseFloat(row['价格']);
              const qty = parseFloat(row['标的数量']);

              if (opType === 'Buy') {
                  this.cash -= (price * qty);
                  this.positions[code] = (this.positions[code] || 0) + qty;
                  activeStocks.push(`买入${row['股票名称']}`);
              } else if (opType === 'Sell') {
                  this.cash += (price * qty);
                  if (this.positions[code]) {
                      this.positions[code] -= qty;
                      if (this.positions[code] <= 0) delete this.positions[code];
                  }
                  activeStocks.push(`卖出${row['股票名称']}`);
              }
          }

          // --- C: 计算资产 ---
          let currentHoldingsMv = 0.0;
          for (const [code, qty] of Object.entries(this.positions)) {
              let p = dailyPrices[code];
              // 行情缺失处理：尝试用当日流水价格
              if (!p) {
                  const flowMatch = dailyFlows.find(f => f.code === code);
                  p = flowMatch ? parseFloat(flowMatch['价格']) : 0;
              }
              currentHoldingsMv += (qty * (p || 0));
          }

          const currentTotalEquity = this.cash + currentHoldingsMv;
          // 避免除以0
          const dailyRtn = prevTotalEquity > 0 ? (currentTotalEquity - prevTotalEquity) / prevTotalEquity : 0;

          this.history.push({
              '日期': date,
              '每日收益率': dailyRtn,
              '总资产': currentTotalEquity,
              '持仓市值': currentHoldingsMv,
              '现金余额': this.cash,
              '动态备注': activeStocks.length ? activeStocks.join(',') : "持仓随盘波动"
          });

          prevTotalEquity = currentTotalEquity;
      }
      return this.history;
  }
}

// ==================================================================================
// 3. 辅助函数
// ==================================================================================

// ExcelJS Worksheet 转 JSON Array
function sheetToJson(worksheet) {
  const data = [];
  let headers = [];
  if(!worksheet) return [];
  
  worksheet.eachRow((row, rowNumber) => {
      const rowValues = row.values;
      if (rowNumber === 1) {
          headers = (rowValues || []).map(v => v ? String(v).trim() : null);
      } else {
          const rowData = {};
          row.eachCell((cell, colNumber) => {
              const header = headers[colNumber];
              if (header) {
                  let val = cell.value;
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
  
  // 1. 尝试从 Excel 数据找
  if (hkTargetDataMap && hkTargetDataMap[cleanCode]) {
      return parseFloat(hkTargetDataMap[cleanCode]);
  }

  // 2. 尝试 API
  log(`正在通过 API 查询港股 ${cleanCode}...`);
  const fullCode = "HK" + cleanCode;
  const apiUrl = `https://aipeinvestmentagent.pages.dev/api/rtStockQueryProxy?code=${fullCode}&type=price`;
  try {
      const res = await axios.get(apiUrl, { timeout: 10000 });
      if (res.data && res.data.latestPrice > 0) {
          return parseFloat(res.data.latestPrice);
      }
  } catch (e) {
      console.warn("API Error", e);
  }
  return 0.0;
}

// ==================================================================================
// 4. 业务逻辑
// ==================================================================================

// 从 GitHub 读取港股数据
async function loadHkData() {
  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_CONFIG.USERNAME}/${GITHUB_CONFIG.REPO_NAME}/${GITHUB_CONFIG.TARGET_BRANCH}/${GITHUB_CONFIG.FILE_PATH}`;
  
  try {
      log(`正在从 GitHub 下载港股数据: ${rawUrl}`);
      const response = await axios.get(rawUrl, { responseType: 'arraybuffer' });
      const buffer = response.data;
      
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      const ws = wb.getWorksheet('ARHK');
      
      if (!ws) throw new Error("Excel 中找不到名为 'ARHK' 的工作表");

      const rawData = sheetToJson(ws);
      const hkMap = {};
      
      rawData.forEach(row => {
          let dateStr = row['日期'];
          if (dateStr instanceof Date) dateStr = moment(dateStr).format('YYYY-MM-DD');
          else dateStr = moment(String(dateStr)).format('YYYY-MM-DD');
          
          const code = String(row['代码']).padStart(5, '0');
          const price = parseFloat(row['Price'] || row['收盘价']);
          
          if (!hkMap[dateStr]) hkMap[dateStr] = {};
          hkMap[dateStr][code] = price;
      });
      
      log(`港股数据加载完成，包含 ${Object.keys(hkMap).length} 个交易日`);
      return hkMap;
  } catch (e) {
      log(`⚠️ 港股数据加载失败: ${e.message}`, 'error');
      return {};
  }
}

async function startProcess() {
  const btn = document.getElementById('startBtn');
  btn.disabled = true;
  log("=== 任务开始 ===");

  try {
      // 1. 加载港股数据
      const hkDataFullMap = await loadHkData();
      const hkDates = Object.keys(hkDataFullMap).sort();
      const lastHkDate = hkDates[hkDates.length - 1];
      const hkTargetData = lastHkDate ? hkDataFullMap[lastHkDate] : {};
      
      // 2. 下载主 Excel
      log(`正在下载 Portfolio: ${window.OSS_CONFIG.OSS_REMOTE_PATH}`);
      
      // 增加错误捕获，提示 CORS 问题
      let result;
      try {
          result = await client.get(window.OSS_CONFIG.OSS_REMOTE_PATH);
      } catch (ossErr) {
          if (String(ossErr).includes('XHR error') || ossErr.status === -1 || ossErr.status === 0) {
              throw new Error("OSS 连接被拦截。请检查：1. 是否开启了 CORS？2. 代码中是否已开启 secure: true？3. 浏览器控制台是否有混合内容报错？");
          }
          throw ossErr;
      }

      const portfolioBuffer = result.content;
      
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(portfolioBuffer);
      log("✅ Excel 加载到内存成功");

      const dfCombinedMap = {}; 
      const allStrategiesResults = {};
      const enginesCache = {};

      // 3. 运行回测
      for (const [key, config] of Object.entries(STRATEGY_MAP)) {
          log(`正在回测策略: ${config.name}...`);
          const wsFlow = workbook.getWorksheet(config.sheet_flow);
          const wsSnap = workbook.getWorksheet(config.sheet_snap);
          
          if (!wsFlow || !wsSnap) {
              log(`跳过 ${key}: 找不到 Worksheet`, 'error');
              continue;
          }

          const dataFlow = sheetToJson(wsFlow);
          const dataSnap = sheetToJson(wsSnap);

          const engine = new PortfolioBacktest(dataFlow, dataSnap, dfCombinedMap, hkDataFullMap);
          const history = engine.run();

          allStrategiesResults[key] = history;
          enginesCache[key] = engine;
      }

      // 4. 生成 JSON 报告
      log("正在生成 JSON 报告...");
      const jsonFilterDate = "2025-12-18";
      const jsonResults = {};
      for(let key in allStrategiesResults) {
          jsonResults[key] = allStrategiesResults[key].filter(r => r['日期'] >= jsonFilterDate);
      }
      await generateAndUploadJson(jsonResults);

      // 5. 更新 Excel 并上传
      log("正在更新 Excel 数据...");
      await updateExcelAndUpload(workbook, enginesCache, hkTargetData);

      log("🎉 所有任务执行完毕！", 'success');

  } catch (e) {
      log(`❌ 致命错误: ${e.message}`, 'error');
      console.error(e);
  } finally {
      btn.disabled = false;
  }
}

// 生成 JSON 并上传
async function generateAndUploadJson(resultsDict) {
  const dateSet = new Set();
  for(let k in resultsDict) {
      resultsDict[k].forEach(r => dateSet.add(r['日期']));
  }
  const sortedDates = Array.from(dateSet).sort();
  
  if(sortedDates.length === 0) {
      log("无有效回测数据，跳过 JSON 生成", 'error');
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
          const dayRow = resultsDict[k].find(r => r['日期'] === date);
          if(dayRow) lastVals[k] = dayRow['总资产'];
          dailySum += lastVals[k];
      });

      if (dailySum <= 0) return;
      if (initialTotal === 0) initialTotal = dailySum;

      const prevSum = idx > 0 ? totalCurve[idx-1] : dailySum;
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

  const finalEquity = totalCurve[totalCurve.length - 1];
  const days = dailyDataList.length;
  const annRet = days > 1 ? Math.pow(finalEquity / initialTotal, 252 / days) - 1 : 0;
  
  const returns = dailyDataList.map(d => d['每日收益率']);
  const mean = ss.mean(returns);
  const std = ss.standardDeviation(returns);
  const sharpe = std !== 0 ? (mean / std) * Math.sqrt(252) : 0;

  const outputData = {
      "模型名称": "User模型",
      "总收益率": dailyDataList[dailyDataList.length - 1]['累计收益率'],
      "年化收益率": annRet,
      "最大回撤率": maxDdSoFar,
      "夏普比率": sharpe,
      "每日评估数据": dailyDataList
  };

  const jsonString = JSON.stringify(outputData, null, 4);
  const blob = new Blob([jsonString], { type: 'application/json' });
  
  await client.put(window.OSS_CONFIG.OSS_JSON_PATH, blob);
  log(`✅ JSON 报告已上传至 OSS: ${window.OSS_CONFIG.OSS_JSON_PATH}`, 'success');
}

// 更新 Excel 内容
async function updateExcelAndUpload(workbook, enginesCache, hkTargetData) {
  if (Object.keys(enginesCache).length === 0) return;

  const sampleEngine = Object.values(enginesCache)[0];
  const lastDateFmt = sampleEngine.allDates[sampleEngine.allDates.length - 1];
  const lastDateCompact = moment(lastDateFmt).format('YYYYMMDD');
  const targetTimeStr = lastDateCompact + "1630";

  const sheetToKey = {};
  for (let k in STRATEGY_MAP) sheetToKey[STRATEGY_MAP[k].sheet_snap] = k;

  const rawMarket = sampleEngine.marketMap[lastDateFmt] || {};
  const priceMap = {};
  for(let k in rawMarket) {
      priceMap[String(k).split('.')[0].trim()] = rawMarket[k];
  }

  const sheets = ['ADHOC', '低波', '大成', '流入', '大智'];
  
  async function getPrice(code) {
      const c = String(code).split('.')[0].trim();
      if (c === '100000') return 1.0;
      let p = priceMap[c];
      
      if (!p || p === 0) {
          const hkCode = c.slice(-5);
          const hkP = await getHkStockPrice(hkCode, hkTargetData);
          if (hkP) p = hkP;
      }
      return p || 0.0;
  }

  for (let sheetName of sheets) {
      const ws = workbook.getWorksheet(sheetName);
      if (!ws) continue;

      const headerRow = ws.getRow(1);
      const colMap = {};
      headerRow.eachCell((cell, colNum) => {
          const val = cell.value ? String(cell.value).trim() : '';
          if(val) colMap[val] = colNum;
      });

      if (!colMap['股票代码'] || !colMap['修改时间']) continue;

      const strategyKey = sheetToKey[sheetName];
      const weightMap = {};
      
      if (strategyKey && enginesCache[strategyKey]) {
          const eng = enginesCache[strategyKey];
          let currentEquity = eng.cash;
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
          log(`   [${sheetName}] 计算权重完毕, 资产: ${Math.round(currentEquity)}`);
      }

      let targetRows = [];
      let maxDateStr = "";
      let templateRows = [];

      ws.eachRow((row, rowNum) => {
          if (rowNum === 1) return;
          
          const timeVal = row.getCell(colMap['修改时间']).value;
          const timeStr = timeVal ? String(timeVal).trim() : "";
          const datePart = timeStr.substring(0, 8);
          
          if (datePart === lastDateCompact) {
              targetRows.push(row);
          }
          
          if (datePart > maxDateStr) {
              maxDateStr = datePart;
              templateRows = [row];
          } else if (datePart === maxDateStr) {
              templateRows.push(row);
          }
      });

      if (sheetName === 'ADHOC') {
           ws.eachRow((row, rowNum) => { if(rowNum > 1) targetRows.push(row); });
      } else if (targetRows.length === 0 && templateRows.length > 0) {
          log(`   [${sheetName}] 新增日期 ${lastDateCompact} (复制自 ${maxDateStr})`);
          for (let tRow of templateRows) {
              const newValues = JSON.parse(JSON.stringify(tRow.values));
              const newRow = ws.addRow(newValues);
              targetRows.push(newRow);
          }
      } else {
          log(`   [${sheetName}] 更新现有日期 ${lastDateCompact}`);
      }

      for (let row of targetRows) {
          const rawCode = row.getCell(colMap['股票代码']).value;
          const fmtCode = String(rawCode).split('.')[0].trim();
          
          if (colMap['收盘价格']) {
              const price = await getPrice(fmtCode);
              row.getCell(colMap['收盘价格']).value = price;
          }
          
          if (sheetName !== 'ADHOC') {
              row.getCell(colMap['修改时间']).value = targetTimeStr;
          }
          
          if (colMap['配置比例 (%)'] && weightMap[fmtCode] !== undefined) {
              row.getCell(colMap['配置比例 (%)']).value = weightMap[fmtCode];
          }
      }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  
  log(`正在上传更新后的 Excel: ${window.OSS_CONFIG.OSS_REMOTE_PATH}`);
  await client.put(window.OSS_CONFIG.OSS_REMOTE_PATH, blob);
  log(`✅ Excel 更新并上传成功！`, 'success');
}
