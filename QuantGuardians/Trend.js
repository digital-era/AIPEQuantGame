// ================= 全局状态管理 =================
let eeiFlow30DaysData = null;  // 缓存 30天数据
const modalState = {};         // 记录每个股票的状态
let currentChartInstance = null; // 当前图表实例
let currentPlaybackTimer = null; // 当前播放定时器

// ================= 新增：多维特征与相似度计算工具函数 =================

// 【修复重点 2】：极其严谨的 Z-score 标准化函数 (JS 复刻版)
function zScoreNormalize(arr) {
    let sum = 0, count = 0;
    // 忽略 NaN 计算均值
    for (let i = 0; i < arr.length; i++) {
        let v = Number(arr[i]);
        if (!isNaN(v) && isFinite(v)) {
            sum += v;
            count++;
        }
    }
    if (count === 0) return new Array(arr.length).fill(0);
    const mean = sum / count;

    // 忽略 NaN 计算标准差
    let sumSq = 0, countSq = 0;
    for (let i = 0; i < arr.length; i++) {
        let v = Number(arr[i]);
        if (!isNaN(v) && isFinite(v)) {
            sumSq += Math.pow(v - mean, 2);
            countSq++;
        }
    }
    const std = countSq > 0 ? Math.sqrt(sumSq / countSq) : 0;

    if (std === 0 || !isFinite(std)) {
        return new Array(arr.length).fill(0);
    }

    // 标准化，兜底 NaN/Inf 强制转 0.0
    return arr.map(val => {
        let v = Number(val);
        if (isNaN(v) || !isFinite(v)) return 0;
        let norm = (v - mean) / std;
        if (isNaN(norm) || !isFinite(norm)) return 0;
        return norm;
    });
}

// 欧式距离计算
function euclideanDistance(vecA, vecB) {
    let sumSq = 0;
    for (let i = 0; i < vecA.length; i++) {
        sumSq += Math.pow(vecA[i] - vecB[i], 2);
    }
    return Math.sqrt(sumSq);
}

// [新功能 1] 流形近似逻辑计算
function runManifoldApproximation(targetCode, topN = 10) {
    if (!eeiFlow30DaysData) return { error: "基础30天数据尚未加载完成" };
    
    const features =['PotScore', '涨跌幅', '超大单净流入-净占比', '大单净流入-净占比'];
    const targetDataRaw = eeiFlow30DaysData[targetCode] ||[];
    
    if (targetDataRaw.length === 0) return { error: `未找到目标代码 ${targetCode} 的近期数据！` };
    
    // 截取最近的最多30个交易日数据
    const targetData = targetDataRaw.slice(-30);
    const validDates = targetData.map(d => d['日期']);
    const targetName = targetData[0]['名称'] || "未知";

    // 构建目标向量
    let targetVec =[];
    for (let f of features) {
        const series = targetData.map(r => r[f]);
        targetVec.push(...zScoreNormalize(series));
    }

    let distances = [];
    for (const [code, rows] of Object.entries(eeiFlow30DaysData)) {
        if (code === targetCode) continue;

        // 对齐日期
        const alignedRows = rows.filter(r => validDates.includes(r['日期']));
        if (alignedRows.length !== validDates.length) continue; // 只有天数完全一致的才参与

        let candVec =[];
        for (let f of features) {
            const series = alignedRows.map(r => r[f]);
            candVec.push(...zScoreNormalize(series));
        }

        const dist = euclideanDistance(targetVec, candVec);
        distances.push({ 
            code, 
            name: alignedRows[0]['名称'] || '未知', 
            dist 
        });
    }

    distances.sort((a, b) => a.dist - b.dist);
    return { targetName, data: distances.slice(0, topN) };
}

// [新功能 2] 行业滑窗逻辑计算 (避免溢出，窗口限定 27 天)
function runIndustryLagged(targetCode, lagDays = 3, topN = 10) {
    if (!eeiFlow30DaysData || !industryData) return { error: "数据或行业字典尚未就绪" };
    
    const windowSize = 27; // 修改为27天，配合领先3天，正好容纳在30天数据内
    const features =['PotScore', '涨跌幅', '超大单净流入-净占比', '大单净流入-净占比'];
    
    const targetL2Name = industryData[targetCode];
    if (!targetL2Name) return { error: `无法获取 ${targetCode} 的所属行业板块` };

    // 获取全市场排序好的所有日期
    let allDatesSet = new Set();
    Object.values(eeiFlow30DaysData).forEach(rows => rows.forEach(r => allDatesSet.add(r['日期'])));
    const allValidDates = Array.from(allDatesSet).sort();

    if (allValidDates.length < windowSize + lagDays) {
        return { error: `全集交易天数(${allValidDates.length})不足 ${windowSize + lagDays} 天` };
    }

    // 时间窗错配分配
    const candidateDates = allValidDates.slice(-windowSize);
    const targetDates = allValidDates.slice(-(windowSize + lagDays), -lagDays); // 提取老数据

    const targetDataRaw = eeiFlow30DaysData[targetCode] ||[];
    const targetDf = targetDataRaw.filter(r => targetDates.includes(r['日期']));
    
    if (targetDf.length < windowSize) {
        return { error: `目标 ${targetCode} 领先期内数据不完整，无法建立对比基准` };
    }

    const targetName = targetDf[0]['名称'] || "未知";

    let targetVec =[];
    for (let f of features) {
        const series = targetDf.map(r => r[f]);
        targetVec.push(...zScoreNormalize(series));
    }

    let distances = [];
    for (const [code, rows] of Object.entries(eeiFlow30DaysData)) {
        if (code === targetCode) continue;
        if (industryData[code] !== targetL2Name) continue; // 必须是同板块

        const group = rows.filter(r => candidateDates.includes(r['日期']));
        if (group.length !== windowSize) continue;

        let candVec =[];
        for (let f of features) {
            const series = group.map(r => r[f]);
            candVec.push(...zScoreNormalize(series));
        }

        const dist = euclideanDistance(targetVec, candVec);
        distances.push({ 
            code, 
            name: group[0]['名称'] || '未知', 
            dist 
        });
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

            // 【重点修改】：在此处拦截并缓存股票 '名称' 以供后续分析表格使用
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
        log(`>> DATA STREAM SYNC COMPLETE. TARGETS ACQUIRED: ${Object.keys(dataMap).length}`, "#0f0");

    } catch (err) {
        log(">> CRITICAL ERROR: EEI FLOW DATA CORRUPTED. " + (err.message || err), "#f00");
    }
}

// ================= 图表详情函数 (完整优化版) =================
// ================= 图表详情函数 (完整优化版) =================
function openDetailChart(items, item, color) {
    const rawCode = item.code || item; 
    const code = rawCode; 
    
    // 【修复重点 2】：确保标的名称被成功获取，防止头部显示缺失
    if (!item.name || item.name === '未知') {
        if (eeiFlow30DaysData && eeiFlow30DaysData[code] && eeiFlow30DaysData[code].length > 0) {
            item.name = eeiFlow30DaysData[code][0]['名称'] || '未知';
        } else {
            // 尝试通过 items 传入的列表获取名称兜底
            const match = items.find(i => (i.code || i) === code);
            item.name = (match && match.name) ? match.name : '未知';
        }
    }

    log(`>> ENGAGING VISUAL LINK: TARGET [${code}]...`, "#ffff00");

    const isMobile = window.innerWidth <= 768;
    
    const oldModalCode = document.getElementById('modalCode');
    if (oldModalCode) oldModalCode.remove();

    if (!modalState[code]) {
        modalState[code] = {
            metric: '1min',
            view: 'chart',
            playing: true,
            progress: 0
        };
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

    // --- 3. 数据获取 (仅服务于传统折线图/普通表) ---
    function getData() {
        let labels = [], values = [], pctChanges =[];
        let refValue = 0, yLabel = '', lineColor = color, currentValue = 0;

        if (state.metric === '1min') {
            if (item.history && item.history.length > 0) {
                values = item.history;
                labels = values.map((_, i) => i);
                refValue = item.refPrice || values[0];
                if (item.officialChangePercent != null && item.currentPrice) {
                    refValue = item.currentPrice / (1 + item.officialChangePercent / 100);
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

    // --- 【修改点】：新增针对 3个新增分析选项的专用表格渲染函数 ---
    function renderAnalysisTable(metricTargetCode) {
        const canvas = document.getElementById('detailChartCanvas');
        let tableDiv = document.getElementById('detailTableContainer');
        if (!tableDiv) {
            tableDiv = document.createElement('div');
            tableDiv.id = 'detailTableContainer';
            canvas.parentNode.appendChild(tableDiv);
        }
        
        tableDiv.style.cssText = isMobile 
            ? `flex:1; width:100%; max-height:calc(95vh - 120px); overflow-y:auto; display:block; background:#181818; color:#ddd; margin-top:6px; -webkit-overflow-scrolling: touch; border:1px solid #333;`
            : "flex:1; width:100%; max-height:45vh; overflow-y:auto; display:block; background:#181818; color:#ddd; margin-top:8px; border:1px solid #333;";
        canvas.style.display = 'none';
        controlsContainer.innerHTML = ''; 
        
        const pctEl = document.getElementById('modalPct');
        if (pctEl) {
            pctEl.innerText = '--';
            pctEl.style.color = '#888';
        }

        const tableFontSize = isMobile ? '11px' : '13px';
        const cellPadding = isMobile ? '6px 4px' : '8px 10px';
        let html = '';

        if (state.metric === 'industry') {
            // 【修复重点 1】：设计意图为显示所在组（items）的每个标的对应的行业情况
            const hasIndustryData = typeof industryData !== 'undefined';
            const targetInd = (hasIndustryData && industryData[metricTargetCode]) ? industryData[metricTargetCode] : '未知';

            html += `<div style="padding:8px; color:#4ECDC4; background:#222; border-bottom:1px solid #333; font-size:${tableFontSize}; position:sticky; top:0; z-index:2;">
                        当前标的行业: <b style="color:#fff;">${targetInd}</b> | 所在组共涵括 ${items.length} 支标的
                     </div>
                     <table style="width:100%; border-collapse:collapse; font-size:${tableFontSize};">
                     <thead style="background:#2d2d2d; position:sticky; top:33px;">
                         <tr>
                             <th style="padding:${cellPadding}; text-align:left;">代码</th>
                             <th style="padding:${cellPadding}; text-align:left;">名称</th>
                             <th style="padding:${cellPadding}; text-align:left;">所属行业</th>
                         </tr>
                     </thead><tbody>`;
            
            // 遍历传入的所在组的 items 数组
            items.forEach(pItem => {
                const pCode = pItem.code || pItem; 
                let pName = pItem.name;

                // 【修复重点 2】：名称缺失兜底逻辑，保证名称能获取到
                if (!pName || pName === '未知') {
                    if (eeiFlow30DaysData && eeiFlow30DaysData[pCode] && eeiFlow30DaysData[pCode].length > 0) {
                        pName = eeiFlow30DaysData[pCode][0]['名称'] || '未知';
                    } else {
                        pName = '未知';
                    }
                }

                const pInd = (hasIndustryData && industryData[pCode]) ? industryData[pCode] : '未知';
                
                // 让当前正在查看的标的行稍微高亮，增强对比体验
                const isCurrent = (pCode === metricTargetCode);
                const rowStyle = isCurrent ? 'background:#333;' : '';
                const codeColor = isCurrent ? '#4ECDC4' : '#aaa';
                const textColor = isCurrent ? '#fff' : '#ddd';

                html += `<tr style="border-bottom:1px solid #333; ${rowStyle}">
                    <td style="padding:${cellPadding}; color:${codeColor}; font-family:monospace;">${pCode}</td>
                    <td style="padding:${cellPadding}; color:${textColor};">${pName}</td>
                    <td style="padding:${cellPadding}; color:${textColor};">${pInd}</td>
                </tr>`;
            });
            html += `</tbody></table>`;
        } 
        else if (state.metric === 'manifold') {
            const res = runManifoldApproximation(metricTargetCode);
            if (res.error) { tableDiv.innerHTML = `<div style="padding:20px; text-align:center; color:#ff4444;">${res.error}</div>`; return; }
            
            html += `<div style="padding:8px; color:#FFD700; background:#222; border-bottom:1px solid #333; font-size:${tableFontSize}; position:sticky; top:0; z-index:2;">
                        基准: <b style="color:#fff;"> 30天多维走势最接近标的
                     </div>
                     <table style="width:100%; border-collapse:collapse; font-size:${tableFontSize};">
                     <thead style="background:#2d2d2d; position:sticky; top:33px;">
                         <tr>
                             <th style="padding:${cellPadding}; text-align:center;">排名</th>
                             <th style="padding:${cellPadding}; text-align:left;">代码</th>
                             <th style="padding:${cellPadding}; text-align:left;">名称</th>
                             <th style="padding:${cellPadding}; text-align:right;">差异度距离</th>
                         </tr>
                     </thead><tbody>`;
            res.data.forEach((r, i) => {
                html += `<tr style="border-bottom:1px solid #333;">
                    <td style="padding:${cellPadding}; text-align:center; color:#888;">${i + 1}</td>
                    <td style="padding:${cellPadding}; color:#aaa; font-family:monospace;">${r.code}</td>
                    <td style="padding:${cellPadding}; color:#ddd;">${r.name}</td>
                    <td style="padding:${cellPadding}; text-align:right; color:#4ECDC4; font-family:monospace;">${r.dist.toFixed(4)}</td>
                </tr>`;
            });
            html += `</tbody></table>`;
        } 
        else if (state.metric === 'ind_lag') {
            const res = runIndustryLagged(metricTargetCode, 3); 
            if (res.error) { tableDiv.innerHTML = `<div style="padding:20px; text-align:center; color:#ff4444;">${res.error}</div>`; return; }

            html += `<div style="padding:8px; color:#FF6B6B; background:#222; border-bottom:1px solid #333; font-size:${tableFontSize}; line-height:1.4; position:sticky; top:0; z-index:2;">
                        🎯 标的所在行业: <b style="color:#fff;">${res.targetL2Name}<br>
                        ⏳ 寻找近27天内复刻标的 [早3天] 走势的同板块股票
                     </div>
                     <table style="width:100%; border-collapse:collapse; font-size:${tableFontSize};">
                     <thead style="background:#2d2d2d; position:sticky; top:48px;">
                         <tr>
                             <th style="padding:${cellPadding}; text-align:center;">排名</th>
                             <th style="padding:${cellPadding}; text-align:left;">代码</th>
                             <th style="padding:${cellPadding}; text-align:left;">名称</th>
                             <th style="padding:${cellPadding}; text-align:right;">差异度距离</th>
                         </tr>
                     </thead><tbody>`;
            if (res.data.length === 0) {
                 html += `<tr><td colspan="4" style="padding:20px; text-align:center;">未找到符合条件的同板块标的</td></tr>`;
            } else {
                res.data.forEach((r, i) => {
                    html += `<tr style="border-bottom:1px solid #333;">
                        <td style="padding:${cellPadding}; text-align:center; color:#888;">${i + 1}</td>
                        <td style="padding:${cellPadding}; color:#aaa; font-family:monospace;">${r.code}</td>
                        <td style="padding:${cellPadding}; color:#ddd;">${r.name}</td>
                        <td style="padding:${cellPadding}; text-align:right; color:#4ECDC4; font-family:monospace;">${r.dist.toFixed(4)}</td>
                    </tr>`;
                });
            }
            html += `</tbody></table>`;
        }
        
        tableDiv.innerHTML = html;
    }

    // --- 4. 主渲染内容 ---
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
