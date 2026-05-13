// ================= 全局状态管理 =================
let eeiFlow30DaysData = null;  // 缓存 30天数据
const modalState = {};         // 记录每个股票的状态
let currentChartInstance = null; // 当前图表实例
let currentPlaybackTimer = null; // 当前播放定时器

// ================= 新增：从 allStocks 获取名称的高效工具 =================
let allStocksMapCache = null; 

function getStockNameFromAllStocks(code, defaultName = '未知') {
    if (typeof allStocks === 'undefined' || !Array.isArray(allStocks)) {
        return defaultName;
    }
    if (!allStocksMapCache || Object.keys(allStocksMapCache).length !== allStocks.length) {
        allStocksMapCache = {};
        for (let i = 0; i < allStocks.length; i++) {
            if (allStocks[i] && allStocks[i].code) {
                allStocksMapCache[allStocks[i].code] = allStocks[i].name;
            }
        }
    }
    return allStocksMapCache[code] || defaultName;
}

// ================= 新增：财务指标高效读取工具 =================
// 严格对应 JSON 中 "_x" 后缀数组的索引顺序，O(1) 访问
const METRIC_IDX = { PB: 0, PE: 1, ROE: 2, DY: 3 };

function getStockMetrics(code) {
    if (typeof industryData === 'undefined') return [null, null, null, null];
    return industryData[code + '_x'] || [null, null, null, null];
}

// ================= 多维特征与相似度计算工具函数 =================
function zScoreNormalize(arr) {
    let sum = 0, count = 0;
    for (let i = 0; i < arr.length; i++) {
        let v = Number(arr[i]);
        if (!isNaN(v) && isFinite(v)) { sum += v; count++; }
    }
    if (count === 0) return new Array(arr.length).fill(0);
    const mean = sum / count;

    let sumSq = 0, countSq = 0;
    for (let i = 0; i < arr.length; i++) {
        let v = Number(arr[i]);
        if (!isNaN(v) && isFinite(v)) { sumSq += Math.pow(v - mean, 2); countSq++; }
    }
    const std = countSq > 0 ? Math.sqrt(sumSq / countSq) : 0;
    if (std === 0 || !isFinite(std)) return new Array(arr.length).fill(0);

    return arr.map(val => {
        let v = Number(val);
        if (isNaN(v) || !isFinite(v)) return 0;
        let norm = (v - mean) / std;
        if (isNaN(norm) || !isFinite(norm)) return 0;
        return norm;
    });
}

function euclideanDistance(vecA, vecB) {
    let sumSq = 0;
    for (let i = 0; i < vecA.length; i++) { sumSq += Math.pow(vecA[i] - vecB[i], 2); }
    return Math.sqrt(sumSq);
}

function runManifoldApproximation(targetCode, topN = 10) {
    if (!eeiFlow30DaysData) return { error: "基础30天数据尚未加载完成" };
    const features =['PotScore', '涨跌幅', '超大单净流入-净占比', '大单净流入-净占比'];
    const targetDataRaw = eeiFlow30DaysData[targetCode] ||[];
    if (targetDataRaw.length === 0) return { error: `未找到目标代码 ${targetCode} 的近期数据！` };
    
    const targetData = targetDataRaw.slice(-30);
    const validDates = targetData.map(d => d['日期']);
    let targetName = getStockNameFromAllStocks(targetCode);
    
    let targetVec =[];
    for (let f of features) {
        const series = targetData.map(r => r[f]);
        targetVec.push(...zScoreNormalize(series));
    }

    let distances = [];
    for (const [code, rows] of Object.entries(eeiFlow30DaysData)) {
        if (code === targetCode) continue;
        const alignedRows = rows.filter(r => validDates.includes(r['日期']));
        if (alignedRows.length !== validDates.length) continue; 
        let candVec =[];
        for (let f of features) {
            const series = alignedRows.map(r => r[f]);
            candVec.push(...zScoreNormalize(series));
        }
        let candName = getStockNameFromAllStocks(code);
        const dist = euclideanDistance(targetVec, candVec);
        distances.push({ code, name: candName, dist });
    }
    distances.sort((a, b) => a.dist - b.dist);
    return { targetName, data: distances.slice(0, topN) };
}

function runIndustryLagged(targetCode, lagDays = 3, topN = 10) {
    if (!eeiFlow30DaysData || !industryData) return { error: "数据或行业字典尚未就绪" };
    const windowSize = 27; 
    const features =['PotScore', '涨跌幅', '超大单净流入-净占比', '大单净流入-净占比'];
    const targetL2Name = industryData[targetCode];
    if (!targetL2Name) return { error: `无法获取 ${targetCode} 的所属行业板块` };

    let allDatesSet = new Set();
    Object.values(eeiFlow30DaysData).forEach(rows => rows.forEach(r => allDatesSet.add(r['日期'])));
    const allValidDates = Array.from(allDatesSet).sort();
    if (allValidDates.length < windowSize + lagDays) return { error: `全集交易天数(${allValidDates.length})不足 ${windowSize + lagDays} 天` };

    const candidateDates = allValidDates.slice(-windowSize);
    const targetDates = allValidDates.slice(-(windowSize + lagDays), -lagDays); 

    const targetDataRaw = eeiFlow30DaysData[targetCode] ||[];
    const targetDf = targetDataRaw.filter(r => targetDates.includes(r['日期']));
    if (targetDf.length < windowSize) return { error: `目标 ${targetCode} 领先期内数据不完整，无法建立对比基准` };

    let targetName = getStockNameFromAllStocks(targetCode);
    let targetVec =[];
    for (let f of features) {
        const series = targetDf.map(r => r[f]);
        targetVec.push(...zScoreNormalize(series));
    }

    let distances = [];
    for (const [code, rows] of Object.entries(eeiFlow30DaysData)) {
        if (code === targetCode) continue;
        if (industryData[code] !== targetL2Name) continue; 

        const group = rows.filter(r => candidateDates.includes(r['日期']));
        if (group.length !== windowSize) continue;
        let candVec =[];
        for (let f of features) {
            const series = group.map(r => r[f]);
            candVec.push(...zScoreNormalize(series));
        }
        let candName = getStockNameFromAllStocks(code);
        const dist = euclideanDistance(targetVec, candVec);
        distances.push({ code, name: candName, dist });
    }
    distances.sort((a, b) => a.dist - b.dist);
    return { targetName, targetL2Name, data: distances.slice(0, topN) };
}

// ================= 数据加载函数 =================
async function loadEEIFlow30DaysData() {
    if (eeiFlow30DaysData !== null) return; 
    const filename = 'month/EEIFlow30Days.xlsx'; 
    const url = getResourceUrl(filename); 

    try {
        log(">> INITIATING DATA STREAM: 30-DAY FLOW ANALYSIS...", "#0ff");
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const arrayBuffer = await res.arrayBuffer();
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

            if (!dataMap[code]) dataMap[code] =[];
            dataMap[code].push(cleanRow);
        });

        Object.keys(dataMap).forEach(key => {
            dataMap[key].sort((a, b) => a['日期'].localeCompare(b['日期']));
        });

        eeiFlow30DaysData = dataMap;
    
        // =========================================================================
        log(`>> DATA STREAM SYNC COMPLETE. TARGETS ACQUIRED: ${Object.keys(dataMap).length}`, "#0f0");        

    } catch (err) {
        log(">> CRITICAL ERROR: EEI FLOW DATA CORRUPTED. " + (err.message || err), "#f00");
    }
}

// ================= 图表详情函数 (完整优化版) =================
function openDetailChart(items, item, color) {
    const rawCode = item.code || item; 
    const code = rawCode; 
    
    if (!item.name || item.name === '未知') {
        item.name = getStockNameFromAllStocks(code);
        if (item.name === '未知' && items) {
            const match = items.find(i => (i.code || i) === code);
            item.name = (match && match.name) ? match.name : '未知';
        }
    }

    log(`>> ENGAGING VISUAL LINK: TARGET [${code}]...`, "#ffff00");

    const isMobile = window.innerWidth <= 768;
    const oldModalCode = document.getElementById('modalCode');
    if (oldModalCode) oldModalCode.remove();

    if (!modalState[code]) {
        modalState[code] = { metric: '1min', view: 'chart', playing: true, progress: 0 };
    }
    const state = modalState[code];

    const modal = document.getElementById('chartModal');
    const modalContent = document.querySelector('.modal-content');
    modalContent.style.borderColor = color;
    
    modalContent.style.display = 'flex';
    modalContent.style.flexDirection = 'column';
    modalContent.style.maxHeight = isMobile ? '95vh' : '80vh';
    modal.style.display = 'flex';
    
    if (isMobile) {
        modalContent.style.width = '95vw';
        modalContent.style.margin = 'auto';
        modalContent.style.maxWidth = '95vw';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        modalContent.style.overflow = 'hidden';
    }

    const originalCloseBtn = modal.querySelector('.close-btn');
    if (originalCloseBtn) {
        const originalOnClick = originalCloseBtn.onclick;
        originalCloseBtn.onclick = (e) => {
            state.playing = false;
            if (currentPlaybackTimer) clearInterval(currentPlaybackTimer), currentPlaybackTimer = null;
            if (typeof originalOnClick === 'function') originalOnClick.call(originalCloseBtn, e);
            else modal.style.display = 'none';
            e.stopPropagation();
        };
        if (isMobile) {
            originalCloseBtn.style.fontSize = '12px';
            originalCloseBtn.style.padding = '4px 8px';
            originalCloseBtn.style.marginLeft = 'auto';
        }
    }

    const titleEl = document.getElementById('modalTitle');
    titleEl.innerHTML = '';

    const optionsList =[
        { value: '1min',      label: '分钟价' },
        { value: '30d_price', label: '30天价' },
        { value: '30d_pot',   label: 'Pot' },
        { value: '30d_super', label: '超大单' },
        { value: '30d_main',  label: '主力' },
        { value: 'industry',  label: '行业' },      
        { value: 'manifold',  label: '流形近似' },  
        { value: 'ind_lag',   label: '行业滑窗' }   
    ];

    if (isMobile) {
        const firstRow = document.createElement('div');
        firstRow.style.cssText = `display:flex; align-items:center; width:100%; gap:6px; margin-bottom:4px;`;
        
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = `flex:1; min-width:0; display:flex; align-items:center; gap:4px; overflow:hidden; white-space:nowrap;`;
        const nameSpan = document.createElement('span');
        nameSpan.textContent = item.name;
        nameSpan.style.cssText = `font-size:0.95em; font-weight:bold; overflow:hidden; text-overflow:ellipsis;`;
        const codeSpan = document.createElement('span');
        codeSpan.textContent = `(${code})`;
        codeSpan.style.cssText = `font-size:0.8em; opacity:0.85; font-family:monospace; flex-shrink:0;`;
        
        infoDiv.appendChild(nameSpan);
        infoDiv.appendChild(codeSpan);
    
        const select = document.createElement('select');
        select.id = 'metricSelect';
        select.style.cssText = `flex:0 0 92px; height:24px; background:#333; color:#fff; border:1px solid #555; border-radius:4px; font-size:11px; box-sizing:border-box;`;
        
        optionsList.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.value === state.metric) option.selected = true;
            select.appendChild(option);
        });
    
        select.addEventListener('change', (e) => {
            state.metric = e.target.value;
            state.progress = 0;
            state.playing = true;
            state.view = 'chart';
            renderContent();
        });
    
        firstRow.appendChild(infoDiv);
        firstRow.appendChild(select);
        titleEl.appendChild(firstRow);
    
        const valueDiv = document.createElement('div');
        valueDiv.id = 'modalPct';
        valueDiv.style.cssText = `width:100%; font-size:1em; font-weight:bold; color:#fff; font-family:monospace; font-variant-numeric: tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; transform: translateZ(0);`;
        titleEl.appendChild(valueDiv);
    }  else {
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'display:flex; align-items:center; justify-content:space-between; width:100%; gap:10px;';
        
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'display:flex; align-items:center; gap:5px; flex:1; overflow:hidden; white-space:nowrap; min-width:0;';
        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'font-size:1.1em; font-weight:bold; text-overflow:ellipsis; overflow:hidden;';
        nameSpan.textContent = item.name;
        infoDiv.appendChild(nameSpan);

        const codeSpan = document.createElement('span');
        codeSpan.style.cssText = 'font-size:0.9em; color:#fff; font-weight:normal; font-family:"Courier New", monospace; opacity:0.9; flex-shrink:0;';
        codeSpan.textContent = `(${code})`;
        infoDiv.appendChild(codeSpan);
        headerDiv.appendChild(infoDiv);
        
        const valueDiv = document.createElement('div');
        valueDiv.id = 'modalPct';
        valueDiv.style.cssText = 'font-size:1.05em; font-weight:bold; color:#fff; text-align:center; flex-shrink:0; width:180px; font-family:"Courier New", monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        headerDiv.appendChild(valueDiv);
        
        const actionDiv = document.createElement('div');
        actionDiv.style.cssText = 'display:flex; align-items:center; gap:8px; flex-shrink:0; margin-left:auto;';
        
        const select = document.createElement('select');
        select.id = 'metricSelect';
        select.style.cssText = 'background:#333; color:#fff; border:1px solid #555; padding:4px 8px; border-radius:4px; font-size:13px; cursor:pointer; width:auto; min-width:120px;';
        
        const pcOptionsList = optionsList.map(o => ({
            ...o, 
            label: o.value === '1min' ? '分钟价格' : (o.value === '30d_price' ? '30天价格' : (o.value === '30d_pot' ? 'PotScore' : (o.value === '30d_super' ? '超大单%' : (o.value === '30d_main' ? '主力%' : o.label))))
        }));

        pcOptionsList.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.value === state.metric) option.selected = true;
            select.appendChild(option);
        });
        
        actionDiv.appendChild(select);
        headerDiv.appendChild(actionDiv);
        titleEl.appendChild(headerDiv);
        
        select.addEventListener('change', (e) => {
            state.metric = e.target.value;
            state.progress = 0;
            state.playing = true;
            state.view = 'chart';
            renderContent();
        });
    }

    let controlsContainer = document.getElementById('chartControls');
    if (!controlsContainer) {
        controlsContainer = document.createElement('div');
        controlsContainer.id = 'chartControls';
        controlsContainer.style.cssText = isMobile 
            ? "display:flex; justify-content:center; gap:6px; margin-top:6px; padding-top:6px; border-top:1px solid #333; flex-shrink: 0; flex-wrap:wrap;"
            : "display:flex; justify-content:center; gap:12px; margin-top:8px; padding-top:8px; border-top:1px solid #333; flex-shrink: 0;";
        modalContent.appendChild(controlsContainer);
    }

    function getData() {
        let labels = [], values = [], pctChanges =[];
        let refValue = 0, yLabel = '', lineColor = color, currentValue = 0;

        if (state.metric === '1min') {
            if (item.history && item.history.length > 0) {
                values = item.history;
                labels = values.map((_, i) => i);
        
                // 基准价优先顺序：
                // 1. 官方涨跌幅反推 → 2. history[0] → 3. refPrice → 4. 兜底用 history[0]
                if (item.officialChangePercent != null && item.currentPrice) {
                    refValue = item.currentPrice / (1 + item.officialChangePercent / 100);
                } else {
                    const historyFirst = values[0];
                    if (historyFirst != null && historyFirst > 0) {
                        refValue = historyFirst;               // 优先分钟线第一个价格
                    } else if (item.refPrice && item.refPrice > 0) {
                        refValue = item.refPrice;              // 其次取 Excel 记录的参考价
                    } else {
                        refValue = historyFirst || 0;          // 最终兜底
                    }
                }
        
                yLabel = '价格';
                currentValue = values[values.length - 1] || 0;
            }
        } else if (!['industry', 'manifold', 'ind_lag'].includes(state.metric)) {
            const d30 = eeiFlow30DaysData?.[code] ||[];
            if (d30.length > 0) {
                const recent30 = d30.slice(-30);
                labels = recent30.map(r => r['日期']);
                switch (state.metric) {
                    case '30d_price':
                        values = recent30.map(r => Number(r['收盘价']));
                        pctChanges = recent30.map(r => Number(r['涨跌幅']));
                        refValue = values[0] || 0; yLabel = '收盘价';
                        lineColor = values[values.length-1] >= refValue ? '#EF4444' : '#10B981';
                        break;
                    case '30d_pot':
                        values = recent30.map(r => Number(r['PotScore'])); yLabel = 'PotScore'; lineColor = '#FFD700'; break;
                    case '30d_super':
                        values = recent30.map(r => Number(r['超大单净流入-净占比'])); yLabel = '超大单占比(%)'; lineColor = '#FF6B6B'; break;
                    case '30d_main':
                        values = recent30.map(r => Number(r['主力净流入-净占比'])); yLabel = '主力占比(%)'; lineColor = '#4ECDC4'; break;
                }
                currentValue = values[values.length - 1] || 0;
            }
        }
        return { labels, values, pctChanges, refValue, yLabel, lineColor, currentValue };
    }

    // --- 针对 3个新增分析选项的专用表格渲染函数 ---
    function renderAnalysisTable(metricTargetCode) {
        const canvas = document.getElementById('detailChartCanvas');
        let tableDiv = document.getElementById('detailTableContainer');
        if (!tableDiv) {
            tableDiv = document.createElement('div');
            tableDiv.id = 'detailTableContainer';
            canvas.parentNode.appendChild(tableDiv);
        }
        
        // 【修复重点 1】: 将外层容器直接设置为 overflow:auto，并去除原有导致 sticky 错位的内层包裹层
        tableDiv.style.cssText = isMobile 
            ? `flex:1; width:100%; max-height:calc(95vh - 120px); overflow:auto; display:block; background:#181818; color:#ddd; margin-top:6px; -webkit-overflow-scrolling: touch; border:1px solid #333;`
            : "flex:1; width:100%; max-height:45vh; overflow:auto; display:block; background:#181818; color:#ddd; margin-top:8px; border:1px solid #333;";
        canvas.style.display = 'none';
        controlsContainer.innerHTML = ''; 
        
        const pctEl = document.getElementById('modalPct');
        if (pctEl) {
            pctEl.innerText = '--';
            pctEl.style.color = '#888';
        }

        const tableFontSize = isMobile ? '11px' : '13px';
        const cellPadding = isMobile ? '6px 4px' : '8px 10px';
        
        const hasIndustryData = typeof industryData !== 'undefined';
        const fmt = (v) => (v === null || v === undefined) ? '--' : Number(v).toFixed(2);
        
        let html = '';

        if (state.metric === 'industry') {
            const targetInd = (hasIndustryData && industryData[metricTargetCode]) ? industryData[metricTargetCode] : '未知';

            // 【修复重点 2】: 提示栏合并进 thead 作为一个跨列（colspan="7"）的首行，统统 top: 0
            html += `<table style="width:100%; border-collapse:collapse; font-size:${tableFontSize}; white-space:nowrap;">
                     <thead style="position:sticky; top:0; z-index:2; box-shadow:0 2px 4px rgba(0,0,0,0.3);">
                         <tr style="background:#222; border-bottom:1px solid #333;">
                             <th colspan="7" style="padding:8px; color:#4ECDC4; font-weight:normal; text-align:left; white-space:normal; font-size:${tableFontSize};">
                                 当前标的行业: <b style="color:#fff;">${targetInd}</b> | 所在组共涵括 ${items.length} 支标的
                             </th>
                         </tr>
                         <tr style="background:#2d2d2d; border-bottom:1px solid #333;">
                             <th style="padding:${cellPadding}; text-align:left;">代码</th>
                             <th style="padding:${cellPadding}; text-align:left;">名称</th>
                             <th style="padding:${cellPadding}; text-align:left;">所属行业</th>
                             <th style="padding:${cellPadding}; text-align:right;">PB</th>
                             <th style="padding:${cellPadding}; text-align:right;">PE</th>
                             <th style="padding:${cellPadding}; text-align:right;">ROE</th>
                             <th style="padding:${cellPadding}; text-align:right;">DY</th>
                         </tr>
                     </thead><tbody>`;
            
            items.forEach(pItem => {
                const pCode = pItem.code || pItem; 
                let pName = pItem.name;
                if (!pName || pName === '未知') pName = getStockNameFromAllStocks(pCode);

                const pInd = (hasIndustryData && industryData[pCode]) ? industryData[pCode] : '未知';
                const metrics = getStockMetrics(pCode);

                const isCurrent = (pCode === metricTargetCode);
                const rowStyle = isCurrent ? 'background:#333;' : '';
                const codeColor = isCurrent ? '#4ECDC4' : '#aaa';
                const textColor = isCurrent ? '#fff' : '#ddd';

                html += `<tr style="border-bottom:1px solid #333; ${rowStyle}">
                    <td style="padding:${cellPadding}; color:${codeColor}; font-family:monospace;">${pCode}</td>
                    <td style="padding:${cellPadding}; color:${textColor};">${pName}</td>
                    <td style="padding:${cellPadding}; color:${textColor};">${pInd}</td>
                    <td style="padding:${cellPadding}; color:${textColor}; text-align:right; font-family:monospace;">${fmt(metrics[0])}</td>
                    <td style="padding:${cellPadding}; color:${textColor}; text-align:right; font-family:monospace;">${fmt(metrics[1])}</td>
                    <td style="padding:${cellPadding}; color:${textColor}; text-align:right; font-family:monospace;">${fmt(metrics[2])}</td>
                    <td style="padding:${cellPadding}; color:${textColor}; text-align:right; font-family:monospace;">${fmt(metrics[3])}</td>
                </tr>`;
            });
            html += `</tbody></table>`;
        } 
        else if (state.metric === 'manifold') {
            const res = runManifoldApproximation(metricTargetCode);
            if (res.error) { tableDiv.innerHTML = `<div style="padding:20px; text-align:center; color:#ff4444;">${res.error}</div>`; return; }
            
            html += `<table style="width:100%; border-collapse:collapse; font-size:${tableFontSize}; white-space:nowrap;">
                     <thead style="position:sticky; top:0; z-index:2; box-shadow:0 2px 4px rgba(0,0,0,0.3);">
                         <tr style="background:#222; border-bottom:1px solid #333;">
                             <th colspan="9" style="padding:8px; color:#FFD700; font-weight:normal; text-align:left; white-space:normal; font-size:${tableFontSize};">
                                 基准: <b style="color:#fff;"> 30天多维走势最接近标的</b>
                             </th>
                         </tr>
                         <tr style="background:#2d2d2d; border-bottom:1px solid #333;">
                             <th style="padding:${cellPadding}; text-align:center;">排名</th>
                             <th style="padding:${cellPadding}; text-align:left;">代码</th>
                             <th style="padding:${cellPadding}; text-align:left;">名称</th>
                             <th style="padding:${cellPadding}; text-align:left;">所属行业</th>
                             <th style="padding:${cellPadding}; text-align:right;">差异度距离</th>
                             <th style="padding:${cellPadding}; text-align:right;">PB</th>
                             <th style="padding:${cellPadding}; text-align:right;">PE</th>
                             <th style="padding:${cellPadding}; text-align:right;">ROE</th>
                             <th style="padding:${cellPadding}; text-align:right;">DY</th>
                         </tr>
                     </thead><tbody>`;
            res.data.forEach((r, i) => {
                let finalName = r.name;
                if (!finalName || finalName === '未知' || finalName === '') {
                    finalName = getStockNameFromAllStocks(r.code);
                    if ((!finalName || finalName === '未知') && items) {
                        const match = items.find(itm => (itm.code || itm) === r.code);
                        if (match && match.name) finalName = match.name;
                    }
                }

                const pInd = (hasIndustryData && industryData[r.code]) ? industryData[r.code] : '未知';
                const metrics = getStockMetrics(r.code);

                html += `<tr style="border-bottom:1px solid #333;">
                    <td style="padding:${cellPadding}; text-align:center; color:#888;">${i + 1}</td>
                    <td style="padding:${cellPadding}; color:#aaa; font-family:monospace;">${r.code}</td>
                    <td style="padding:${cellPadding}; color:#ddd;">${finalName}</td>
                    <td style="padding:${cellPadding}; color:#ddd;">${pInd}</td>
                    <td style="padding:${cellPadding}; text-align:right; color:#4ECDC4; font-family:monospace;">${r.dist.toFixed(4)}</td>
                    <td style="padding:${cellPadding}; color:#ddd; text-align:right; font-family:monospace;">${fmt(metrics[0])}</td>
                    <td style="padding:${cellPadding}; color:#ddd; text-align:right; font-family:monospace;">${fmt(metrics[1])}</td>
                    <td style="padding:${cellPadding}; color:#ddd; text-align:right; font-family:monospace;">${fmt(metrics[2])}</td>
                    <td style="padding:${cellPadding}; color:#ddd; text-align:right; font-family:monospace;">${fmt(metrics[3])}</td>
                </tr>`;
            });
            html += `</tbody></table>`;
        } 
        else if (state.metric === 'ind_lag') {
            const res = runIndustryLagged(metricTargetCode, 3); 
            if (res.error) { tableDiv.innerHTML = `<div style="padding:20px; text-align:center; color:#ff4444;">${res.error}</div>`; return; }

            html += `<table style="width:100%; border-collapse:collapse; font-size:${tableFontSize}; white-space:nowrap;">
                     <thead style="position:sticky; top:0; z-index:2; box-shadow:0 2px 4px rgba(0,0,0,0.3);">
                         <tr style="background:#222; border-bottom:1px solid #333;">
                             <th colspan="8" style="padding:8px; color:#FF6B6B; font-weight:normal; text-align:left; line-height:1.4; white-space:normal; font-size:${tableFontSize};">
                                 🎯 标的所在行业: <b style="color:#fff;">${res.targetL2Name}</b><br>
                                 ⏳ 寻找近27天内复刻标的[早3天] 走势的同板块股票
                             </th>
                         </tr>
                         <tr style="background:#2d2d2d; border-bottom:1px solid #333;">
                             <th style="padding:${cellPadding}; text-align:center;">排名</th>
                             <th style="padding:${cellPadding}; text-align:left;">代码</th>
                             <th style="padding:${cellPadding}; text-align:left;">名称</th>
                             <th style="padding:${cellPadding}; text-align:right;">差异度距离</th>
                             <th style="padding:${cellPadding}; text-align:right;">PB</th>
                             <th style="padding:${cellPadding}; text-align:right;">PE</th>
                             <th style="padding:${cellPadding}; text-align:right;">ROE</th>
                             <th style="padding:${cellPadding}; text-align:right;">DY</th>
                         </tr>
                     </thead><tbody>`;
            if (res.data.length === 0) {
                 html += `<tr><td colspan="8" style="padding:20px; text-align:center;">未找到符合条件的同板块标的</td></tr>`;
            } else {
                res.data.forEach((r, i) => {
                    let finalName = r.name; 
                    if (!finalName || finalName === '未知' || finalName === '') {
                        finalName = getStockNameFromAllStocks(r.code);
                        if ((!finalName || finalName === '未知') && items) {
                            const match = items.find(itm => (itm.code || itm) === r.code);
                            if (match && match.name) finalName = match.name;
                        }
                    }

                    const metrics = getStockMetrics(r.code);

                    html += `<tr style="border-bottom:1px solid #333;">
                        <td style="padding:${cellPadding}; text-align:center; color:#888;">${i + 1}</td>
                        <td style="padding:${cellPadding}; color:#aaa; font-family:monospace;">${r.code}</td>
                        <td style="padding:${cellPadding}; color:#ddd;">${finalName}</td>
                        <td style="padding:${cellPadding}; text-align:right; color:#4ECDC4; font-family:monospace;">${r.dist.toFixed(4)}</td>
                        <td style="padding:${cellPadding}; color:#ddd; text-align:right; font-family:monospace;">${fmt(metrics[0])}</td>
                        <td style="padding:${cellPadding}; color:#ddd; text-align:right; font-family:monospace;">${fmt(metrics[1])}</td>
                        <td style="padding:${cellPadding}; color:#ddd; text-align:right; font-family:monospace;">${fmt(metrics[2])}</td>
                        <td style="padding:${cellPadding}; color:#ddd; text-align:right; font-family:monospace;">${fmt(metrics[3])}</td>
                    </tr>`;
                });
            }
            html += `</tbody></table>`;
        }
        
        tableDiv.innerHTML = html;
    }
    
    function renderContent() {
        if (currentChartInstance) { currentChartInstance.destroy(); currentChartInstance = null; }
        if (currentPlaybackTimer) { clearInterval(currentPlaybackTimer); currentPlaybackTimer = null; }
        controlsContainer.innerHTML = '';

        const canvas = document.getElementById('detailChartCanvas');
        const container = canvas.parentNode;
        container.style.flex = "1";
        container.style.minHeight = "0"; 
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.overflow = "hidden";
        if (isMobile) container.style.padding = "0 2px";
        else container.style.padding = "5px 0 0 0";

        if (['industry', 'manifold', 'ind_lag'].includes(state.metric)) {
            state.playing = false; 
            renderAnalysisTable(code);
            return;
        }

        const dataObj = getData();

        if (state.view === 'chart') {
            const playBtn = document.createElement('button');
            playBtn.style.cssText = isMobile 
                ? "padding:3px 8px; background:#444; color:white; border:none; border-radius:3px; cursor:pointer; font-size:10px; flex:1; min-width:60px;"
                : "padding:4px 12px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px;";
            const isFinished = state.progress >= dataObj.values.length && dataObj.values.length > 0;
            playBtn.innerHTML = isFinished ? "↺ 重播" : (state.playing ? "❚❚ 暂停" : "▶ 播放");
            if (isFinished) playBtn.style.background = "#2d5a2d";
            playBtn.onclick = () => {
                if (isFinished) state.progress = 0, state.playing = true;
                else state.playing = !state.playing;
                renderContent();
            };
            controlsContainer.appendChild(playBtn);
        }

        const viewBtn = document.createElement('button');
        viewBtn.style.cssText = isMobile
            ? "padding:3px 8px; background:#444; color:white; border:none; border-radius:3px; cursor:pointer; font-size:10px; flex:1; min-width: 60px;"
            : "padding:4px 12px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px;";
        viewBtn.innerText = state.view === 'chart' ? "📅 表格" : "📈 动图";
        viewBtn.onclick = () => {
            state.view = state.view === 'chart' ? 'table' : 'chart';
            state.playing = false;
            renderContent();
        };
        controlsContainer.appendChild(viewBtn);

        let tableDiv = document.getElementById('detailTableContainer');
        if (!tableDiv) {
            tableDiv = document.createElement('div');
            tableDiv.id = 'detailTableContainer';
            container.appendChild(tableDiv);
        }

        updateHeaderInfo(dataObj);

        if (dataObj.values.length === 0) {
            canvas.style.display = 'none';
            tableDiv.style.display = 'block';
            tableDiv.style.cssText = isMobile 
                ? `flex:1; width:100%; max-height:calc(95vh - 120px); background:#181818; margin-top:6px;`
                : "flex:1; width:100%; max-height:35vh; background:#181818; margin-top:8px;";
            tableDiv.innerHTML = `<div style="padding:20px; text-align:center; color:#666;">暂无[${state.metric}] 数据<br></div>`;
            return;
        }

        if (state.view === 'table') {
            canvas.style.display = 'none';
            tableDiv.style.display = 'block';
            tableDiv.style.cssText = isMobile 
                ? `flex:1; width:100%; max-height:calc(95vh - 120px); overflow-y:auto; overflow-x:hidden; background:#181818; color:#ddd; border:1px solid #333; margin-top:6px; -webkit-overflow-scrolling: touch;`
                : "flex:1; width:100%; max-height:35vh; overflow-y:auto; overflow-x:hidden; background:#181818; color:#ddd; border:1px solid #333; margin-top:8px; -webkit-overflow-scrolling: touch;";

            const tableFontSize = isMobile ? '10px' : '12px';
            const cellPadding = isMobile ? '3px 2px' : '5px 6px';
            
            let html = `<table style="width:100%; border-collapse:collapse; font-size:${tableFontSize}; table-layout:fixed;">
                <thead style="background:#2d2d2d; position:sticky; top:0; z-index:1;">
                    <tr>
                        <th style="padding:${cellPadding}; text-align:left; width:${isMobile ? '35%' : 'auto'};">日期</th>
                        <th style="padding:${cellPadding}; text-align:right; width:${isMobile ? '30%' : 'auto'};">${dataObj.yLabel}</th>
                        ${state.metric === '30d_price' ? `<th style="padding:${cellPadding}; text-align:right; width:${isMobile ? '35%' : 'auto'};">涨跌幅</th>` : ''}
                    </tr>
                </thead><tbody>`;
            for (let i = dataObj.values.length - 1; i >= 0; i--) {
                const val = dataObj.values[i];
                let colorStyle = '#ddd';
                if (state.metric.includes('super') || state.metric.includes('main') || state.metric.includes('pot')) {
                   colorStyle = val >= 0 ? '#ff4444' : '#00cc00';
                }
                html += `<tr style="border-bottom:1px solid #333;">
                    <td style="padding:${cellPadding}; color:#aaa; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${dataObj.labels[i]}</td>
                    <td style="padding:${cellPadding}; text-align:right; color:${colorStyle}; font-family:monospace; white-space:nowrap;">${Number(val).toFixed(2)}</td>
                    ${state.metric === '30d_price' ? renderTablePctCell(dataObj.pctChanges[i], cellPadding, isMobile) : ''}
                </tr>`;
            }
            html += `</tbody></table>`;
            tableDiv.innerHTML = html;
        } 
        else {
            tableDiv.style.display = 'none';
            canvas.style.display = 'block';
            
            if (isMobile) {
                canvas.style.maxHeight = 'calc(95vh - 140px)';
                canvas.style.height = 'calc(95vh - 140px)';
            } else {
                canvas.style.maxHeight = 'calc(80vh - 180px)';
                canvas.style.height = 'calc(80vh - 180px)';
            }

            const ctx = canvas.getContext('2d');
            const gradient = ctx.createLinearGradient(0, 0, 0, 400);
            gradient.addColorStop(0, dataObj.lineColor + '40');
            gradient.addColorStop(1, dataObj.lineColor + '00');

            currentChartInstance = new Chart(ctx, {
                type: 'line',
                data: { 
                    labels: dataObj.labels, 
                    datasets:[{ 
                        label: dataObj.yLabel, data: [], borderColor: dataObj.lineColor, backgroundColor: gradient, 
                        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: true, tension: 0.1 
                    }] 
                },
                options: { 
                    responsive: true, maintainAspectRatio: false, animation: false, 
                    layout: { padding: { top: 15, bottom: isMobile ? 10 : 20, left: isMobile ? 5 : 15, right: 10 } }, 
                    interaction: { mode: 'index', intersect: false }, 
                    plugins: { 
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    let label = context.dataset.label ? context.dataset.label + ': ' : '';
                                    if (context.parsed.y !== null) label += context.parsed.y.toFixed(2);
                                    if (state.metric === '30d_price' && dataObj.pctChanges) {
                                        const pct = dataObj.pctChanges[context.dataIndex];
                                        if (pct !== null && pct !== undefined) label += ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
                                    }
                                    return label;
                                }
                            }
                        }
                    }, 
                    scales: { 
                        x: { display: false, ticks: { font: { size: isMobile ? 9 : 11 } } }, 
                        y: { 
                            position: 'left', grid: { color: '#333' }, 
                            ticks: { color: '#888', font: { size: isMobile ? 9 : 11 }, padding: 5 }, 
                            grace: '10%', afterFit: function(scale) { scale.width = isMobile ? 30 : 40; }
                        } 
                    } 
                }
            });

            runAnimation(dataObj);
        }
    }

    function renderTablePctCell(pct, padding, isMobile) {
        if (pct === null || pct === undefined) return `<td style="padding:${padding};"></td>`;
        const color = pct >= 0 ? '#ff4444' : '#00cc00';
        return `<td style="padding:${padding}; text-align:right; color:${color}; font-family:monospace; white-space:nowrap;">${pct >= 0 ? '+' : ''}${isMobile ? pct.toFixed(1) : pct.toFixed(2)}%</td>`;
    }

    function runAnimation(dataObj) {
        if (!state.playing) {
            updateChartData(dataObj.values.slice(0, state.progress));
            updateHeaderInfo(dataObj);
            return;
        }

        const total = dataObj.values.length;
        const speed = total < 100 ? 100 : 20;

        currentPlaybackTimer = setInterval(() => {
            if (!state.playing) {
                clearInterval(currentPlaybackTimer);
                renderContent();
                return;
            }

            state.progress++;
            updateChartData(dataObj.values.slice(0, state.progress));
            updateHeaderInfo(dataObj, state.progress - 1);

            if (state.progress >= total) {
                state.playing = false;
                clearInterval(currentPlaybackTimer);
                renderContent();
            }
        }, speed);
    }

    function updateChartData(data) {
        if (currentChartInstance) {
            currentChartInstance.data.datasets[0].data = data;
            currentChartInstance.update('none');
        }
    }

    function updateHeaderInfo(dataObj, currentIndex = null) {
        const pctEl = document.getElementById('modalPct');
        if (!pctEl || dataObj.values.length === 0) return;
        
        let displayIndex;
        if (currentIndex !== null && currentIndex >= 0 && currentIndex < dataObj.values.length) displayIndex = currentIndex;
        else if (state.view === 'table') displayIndex = dataObj.values.length - 1;
        else if (state.progress > 0 && state.progress <= dataObj.values.length) displayIndex = state.progress - 1;
        else displayIndex = dataObj.values.length - 1;
        
        const val = dataObj.values[displayIndex];
        const currentPct = dataObj.pctChanges ? dataObj.pctChanges[displayIndex] : null;
        if (val == null) return;

        let displayText = '', displayColor = '#fff';

        switch(state.metric) {
            case '30d_price':
                if (currentPct !== null && currentPct !== undefined) {
                    displayColor = currentPct >= 0 ? '#EF4444' : '#10B981';
                    displayText = `${val.toFixed(2)} (${currentPct >= 0 ? '+' : ''}${isMobile ? currentPct.toFixed(1) : currentPct.toFixed(2)}%)`;
                } else displayText = `${val.toFixed(2)}`;
                break;
            case '1min':
                if (dataObj.refValue && dataObj.refValue !== 0) {
                    const chg = ((val - dataObj.refValue) / dataObj.refValue * 100);
                    displayColor = chg >= 0 ? '#EF4444' : '#10B981';
                    displayText = `${val.toFixed(2)} (${chg >= 0 ? '+' : ''}${isMobile ? chg.toFixed(1) : chg.toFixed(2)}%)`;
                } else displayText = `${val.toFixed(2)}`;
                break;
            case '30d_pot':
            case '30d_super':
            case '30d_main':
                displayText = `${val.toFixed(isMobile ? 1 : 2)}${state.metric !== '30d_pot' ? '%' : ''}`;
                displayColor = val >= 0 ? '#EF4444' : '#10B981';
                break;
            default: displayText = `${val.toFixed(2)}`;
        }
        
        pctEl.innerText = displayText;
        pctEl.style.color = displayColor;
        
        if (isMobile) {
            pctEl.title = displayText;
            pctEl.style.cursor = 'pointer';
        }
    }

    renderContent();
}


/**
 * 验证并保存本地 API 地址
 */
document.addEventListener('DOMContentLoaded', function() {
    const saved = localStorage.getItem('gLocalAPIBase');
    const input = document.getElementById('localApiInput');
    
    if (saved && input) {
        input.value = saved;
        // 不直接赋值，而是让 validateAndSaveLocalApi 统一处理
        validateAndSaveLocalApi(); 
    }
    
    // 【新增】失去焦点时触发验证保存
    if (input) {
        input.addEventListener('blur', validateAndSaveLocalApi);
        // 可选：回车也触发
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                validateAndSaveLocalApi();
                input.blur(); // 收起键盘
            }
        });
    }
});

/**
 * 页面加载时恢复已保存的地址（如有 localStorage 需求可扩展）
 */
document.addEventListener('DOMContentLoaded', function() {
    const saved = localStorage.getItem('gLocalAPIBase');
    if (saved) {
        document.getElementById('localApiInput').value = saved;
        gLocalAPIBase = saved;
    }
});

function validateAndSaveLocalApi() {
    const input = document.getElementById('localApiInput');
    const hint = document.getElementById('localApiHint');
    const value = input.value.trim();
    
    // 空值视为清除
    if (value === "") {
        gLocalAPIBase = "";
        input.classList.remove('input-error');
        hint.style.display = 'none';
        // 在 validateAndSaveLocalApi() 的验证成功分支内添加：
        localStorage.setItem('gLocalAPIBase', gLocalAPIBase);
        return true;
    }
    
    // 验证 URL 格式
    if (isValidUrl(value)) {
        gLocalAPIBase = value.endsWith('/') ? value.slice(0, -1) : value;
        input.classList.remove('input-error');
        hint.style.display = 'none';
      
        // 在 validateAndSaveLocalApi() 的验证成功分支内添加：
        localStorage.setItem('gLocalAPIBase', gLocalAPIBase);
      
        return true;
    } else {
        gLocalAPIBase = "";
        input.classList.add('input-error');
        hint.style.display = 'block';
        // 重新触发动画
        hint.style.animation = 'none';
        hint.offsetHeight; // 强制重排
        hint.style.animation = 'hintShake 0.3s ease';
        return false;
    }
}

/**
 * 检查是否为合法 URL
 */
function isValidUrl(string) {
    try {
        const url = new URL(string);
        // 只允许 http 和 https 协议
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

/**
 * 更新市场数据，根据市场状态决定是否获取最新价格
 * @param {boolean} forceFetch - 强制获取价格，即使 hasClosedPrices 为 true。用于系统初始化。
 */
// ===================== 新增辅助函数 =====================
// 用于控制请求间隔的 sleep 函数
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
        let intradayUrl;
        if (gLocalAPIBase !== null  && gLocalAPIBase.length > 0) {
              intradayUrl = `${gLocalAPIBase}${REAL_API_LOCAL_URL}?code=${finalCode}&type=intraday`;
        } else {
              intradayUrl = `${REAL_API_URL}?code=${finalCode}&type=intraday`;    
        }
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
            let closePriceUrl;
            if (gLocalAPIBase !== null  && gLocalAPIBase.length > 0) {
                  closePriceUrl = `${gLocalAPIBase}${REAL_API_LOCAL_URL}?code=${finalCode}&type=intraday`;
            } else {
                  closePriceUrl = `${REAL_API_URL}?code=${finalCode}&type=price`; // 参数修改为 price   
            }
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


// ===================== 新增：批量辅助函数 =====================
async function fetchBatchPrices(codes, type) {
    if (!codes || codes.length === 0) return {};
    
    const finalCodes = codes.map(code => code.length === 5 ? 'HK' + code : code);
    
    // 只有本地 QMT 支持批量 POST
    if (!gLocalAPIBase) {
        return {}; // 云端模式返回空，让 fetchPrice 自己处理
    }
    
    try {
        const res = await fetch(`${gLocalAPIBase}/api/querylocal`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0' 
            },
            body: JSON.stringify({ codes: finalCodes, type: type })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.error("Batch fetch error:", e);
        return {};
    }
}

async function fetchBatchIntraday(codes) {
    return fetchBatchPrices(codes, 'intraday');
}

// ===================== 修改：updateMarketData =====================
async function updateMarketData(forceFetch = false) {
    // 1. 休市检查（保持原有逻辑）
    if (hasClosedPrices && !forceFetch) {
        log("Market closed. Skipping price data fetch.", "#666");
        Object.keys(gameState.guardians).forEach(k => recalculateAndRenderGuardian(k));
        return true;
    }

    // 2. 判断模式：本地 QMT 批量 vs 云端单只
    const useBatch = gLocalAPIBase && gLocalAPIBase.length > 0;
    
    if (useBatch) {
        log("Sync Price Data (Batch Mode, size=20) Started", "#aaa");
        return await updateMarketDataBatch(forceFetch);
    } else {
        log("Sync Price Data (Single Mode) Started", "#aaa");
        return await updateMarketDataSingle(forceFetch);
    }
}

// ===================== 单个逻辑 =====================
async function updateMarketDataSingle(forceFetch = false) {
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
                // targetItem.refPrice = baseItem.refPrice;   // 删除或注释这一行
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

// ===================== 批量逻辑（已优化）====================
async function updateMarketDataBatch(forceFetch = false) {
    // 1. 收集所有股票（去重）+ 构建 Guardian 专属队列
    const uniqueStocksMap = new Map();
    const guardianKeys = Object.keys(gameState.guardians);
    const guardianQueues = {};
    
    guardianKeys.forEach(key => guardianQueues[key] = []);

    guardianKeys.forEach(key => {
        const g = gameState.guardians[key];
        const allItems = [
            ...g.strategy,
            ...g.adhocObservations,
            ...g.portfolio.filter(p => !p.isCash)
        ];

        allItems.forEach(item => {
            if (!item.code) return;
            if (!uniqueStocksMap.has(item.code)) {
                uniqueStocksMap.set(item.code, []);
                guardianQueues[key].push(item.code); // 放入首次发现它的 Guardian 队列
            }
            uniqueStocksMap.get(item.code).push({ item, guardianKey: key });
        });
    });

    // 2. Round-Robin 合并队列，生成公平排序的代码列表
    // 效果：A1, B1, C1, D1, A2, B2, C2, D2... 确保 4 个面板交错分布
    const fairUniqueCodes = [];
    let hasMore = true;
    while (hasMore) {
        hasMore = false;
        for (let key of guardianKeys) {
            if (guardianQueues[key].length > 0) {
                hasMore = true;
                const code = guardianQueues[key].shift();
                if (!fairUniqueCodes.includes(code)) {
                    fairUniqueCodes.push(code);
                }
            }
        }
    }

    const BATCH_SIZE = 20;
    let allPricesFetchedSuccessfully = true;
    const marketIsClosed = isMarketClosed();
    const priceResults = {};

    // 3. 如果休市，先批量获取收盘价（量小，通常 1-2 批就完）
    if (marketIsClosed) {
        for (let i = 0; i < fairUniqueCodes.length; i += BATCH_SIZE) {
            const batch = fairUniqueCodes.slice(i, i + BATCH_SIZE);
            log(`Fetching price batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(fairUniqueCodes.length / BATCH_SIZE)}`, "#666");

            const batchResults = await fetchBatchPrices(batch, 'price');
            Object.assign(priceResults, batchResults);

            if (i + BATCH_SIZE < fairUniqueCodes.length) {
                await sleep(250);
            }
        }
    }

    // 4. 【核心优化】按 RR 顺序分批获取分时数据，每批回来后立即处理并渲染
    for (let i = 0; i < fairUniqueCodes.length; i += BATCH_SIZE) {
        const batch = fairUniqueCodes.slice(i, i + BATCH_SIZE);
        log(`Fetching intraday batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(fairUniqueCodes.length / BATCH_SIZE)}`, "#666");

        const batchResults = await fetchBatchIntraday(batch);

        // 立即处理本批次，不等后续批次
        for (const code of batch) {
            const references = uniqueStocksMap.get(code);
            if (!references) continue;

            const baseItem = references[0].item;
            / 【修正】后端返回字典 key 带 HK 前缀，前端原始 code 是纯数字，需要映射
            const lookupCode = code.length === 5 ? 'HK' + code : code;
            const intradayRaw =  batchResults[lookupCode];           

            try {
                // ---- 内联 fetchPrice 核心逻辑，避免重复请求 ----
                let intradayData = [];
                let officialChangePercent = null;
                let closingPriceApiResult = null;

                // 4.1 解析批量返回的分时数据
                if (intradayRaw && Array.isArray(intradayRaw) && intradayRaw.length > 0) {
                    intradayData = intradayRaw.map(d => parseFloat(d.price));
                }

                // 4.2 注入收盘价（休市时）
                if (marketIsClosed) {
                    const lookupCode = code.length === 5 ? 'HK' + code : code;
                    const priceData = priceResults[lookupCode];
                    if (priceData) {
                        if (priceData.latestPrice !== undefined) {
                            closingPriceApiResult = parseFloat(priceData.latestPrice);
                            officialChangePercent = priceData.changePercent !== undefined
                                ? parseFloat(priceData.changePercent)
                                : null;
                        } else if (priceData.price !== undefined) {
                            closingPriceApiResult = parseFloat(priceData.price);
                        }
                        if (priceData.name) baseItem.name = priceData.name;
                    }
                }

                // 4.3 状态机：确定 currentPrice / history / refPrice（与 fetchPrice 完全一致）
                if (marketIsClosed && closingPriceApiResult !== null) {
                    baseItem.currentPrice = closingPriceApiResult;
                    baseItem.officialChangePercent = officialChangePercent;
                    baseItem.history = intradayData.length > 0 ? intradayData : [closingPriceApiResult, closingPriceApiResult];
                    if (baseItem.refPrice == null) baseItem.refPrice = closingPriceApiResult;
                } else if (intradayData.length > 0) {
                    baseItem.currentPrice = intradayData[intradayData.length - 1];
                    baseItem.officialChangePercent = null; // 交易中清除官方涨幅，强制实时计算
                    baseItem.history = intradayData;
                    if (baseItem.refPrice == null) baseItem.refPrice = intradayData[0];
                } else {
                    if (!baseItem.currentPrice) {
                        baseItem.officialChangePercent = null;
                        if (baseItem.refPrice != null) {
                            baseItem.currentPrice = baseItem.refPrice;
                            baseItem.history = [baseItem.refPrice, baseItem.refPrice];
                        } else {
                            baseItem.currentPrice = null;
                            baseItem.history = [];
                        }
                    }
                }

                // 4.4 refPrice 智能修正（与 fetchPrice 完全一致）
                if (baseItem.currentPrice) {
                    if (baseItem.officialChangePercent != null && baseItem.officialChangePercent !== undefined) {
                        const deducedRefPrice = baseItem.currentPrice / (1 + baseItem.officialChangePercent / 100);
                        if (!baseItem.refPrice) baseItem.refPrice = deducedRefPrice;
                    } else if (baseItem.refPrice == null || baseItem.refPrice === 0) {
                        baseItem.refPrice = intradayData.length > 0 ? intradayData[0] : baseItem.currentPrice;
                    }
                }

                // 4.5 验证结果
                if (baseItem.currentPrice === null) {
                    allPricesFetchedSuccessfully = false;
                }

                // 4.6 克隆到同代码的其他 Guardian 引用
                for (let j = 1; j < references.length; j++) {
                    const targetItem = references[j].item;
                    targetItem.currentPrice = baseItem.currentPrice;
                    targetItem.history = baseItem.history;
                    targetItem.refPrice = baseItem.refPrice;
                    targetItem.officialChangePercent = baseItem.officialChangePercent;
                    targetItem.name = baseItem.name;
                }

                // 4.7 【渐进式渲染】立即更新受影响的 Guardian
                const affectedGuardians = new Set(references.map(ref => ref.guardianKey));
                affectedGuardians.forEach(k => recalculateAndRenderGuardian(k));

                // 4.8 【修正】ADHOC 标的特殊处理（与原 fetchPrice 逻辑一致）
                if (baseItem.isAdhoc) {
                    for (let k in gameState.guardians) {
                        if (gameState.guardians[k].strategy.includes(baseItem)) {
                            renderLists(k);
                            break;
                        }
                    }
                }

            } catch (e) {
                console.error(`Process failed for ${code}:`, e);
                allPricesFetchedSuccessfully = false;
            }
        }

        if (i + BATCH_SIZE < fairUniqueCodes.length) {
            await sleep(250);
        }
    }

    log(`Sync Price Data Finish. Total processed: ${fairUniqueCodes.length} unique stocks`, "#aaa");

    // 5. 休市锁定（保持原版逻辑）
    if (marketIsClosed && allPricesFetchedSuccessfully && !hasClosedPrices) {
        hasClosedPrices = true;
        if (priceUpdateInterval) {
            clearInterval(priceUpdateInterval);
            priceUpdateInterval = null;
        }
        log("Market closed. Prices locked.", "yellow");
    }

    return allPricesFetchedSuccessfully;
}

