// ================= 全局状态管理 =================
let eeiFlow30DaysData = null;  // 缓存 30天数据
const modalState = {};         // 记录每个股票的状态 { code: { metric: '1min', view: 'chart', playing: true } }
let currentChartInstance = null; // 当前图表实例
let currentPlaybackTimer = null; // 当前播放定时器

// ================= 数据加载函数 =================
async function loadEEIFlow30DaysData() {
    if (eeiFlow30DaysData !== null) return; // 避免重复加载

    const filename = 'month/EEIFlow30Days.xlsx'; // 指定路径
    const url = getResourceUrl(filename); // 假设你有这个获取路径的函数

    try {
        console.log("正在加载 30 天资金流向数据...");
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const arrayBuffer = await res.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: null });
        
        const dataMap = {};
        
        jsonData.forEach(row => {
            // 1. 处理代码：强制转字符串并补0
            let rawCode = row['代码'];
            if (rawCode === undefined || rawCode === null) return;
            const code = String(rawCode).padStart(6, '0');

            // 2. 处理日期：统一格式为 YYYY-MM-DD
            let dateStr = row['日期'];
            if (typeof dateStr === 'number') {
                const dateObj = new Date(Math.round((dateStr - 25569)*86400*1000));
                dateStr = dateObj.toISOString().split('T')[0];
            } else {
                dateStr = String(dateStr || '').trim().split(' ')[0];
            }

            // 3. 构建数据对象
            const cleanRow = {
                '代码': code,
                '日期': dateStr,
                '收盘价': Number(row['收盘价'] || 0),
                '涨跌幅': Number(row['涨跌幅'] || 0), // 重点：保留原始涨跌幅
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

        // 4. 排序：按日期升序
        Object.keys(dataMap).forEach(key => {
            dataMap[key].sort((a, b) => a['日期'].localeCompare(b['日期']));
        });

        eeiFlow30DaysData = dataMap;
        console.log(`30天数据加载完成，覆盖 ${Object.keys(dataMap).length} 只股票`);

    } catch (err) {
        console.error("加载 EEIFlow30Days.xlsx 失败:", err);
    }
}

// ================= 图表详情函数 =================/
// ================= 图表详情函数 (完整优化版) =================
function openDetailChart(item, color) {
    const rawCode = item.code;
    const code = rawCode; 
    console.log(`正在打开图表: 原始代码=${rawCode}, 查找代码=${code}`);

    // 移动端检测
    const isMobile = window.innerWidth <= 768;
    
    // 彻底移除原有的 modalCode 元素，避免显示 (--)
    const oldModalCode = document.getElementById('modalCode');
    if (oldModalCode) {
        oldModalCode.remove();
    }

    // 初始化状态
    if (!modalState[code]) {
        modalState[code] = {
            metric: '1min',
            view: 'chart',
            playing: true,
            progress: 0
        };
    }
    const state = modalState[code];

    // --- 1. 基础 DOM 设置 (含移动端布局修复) ---
    const modal = document.getElementById('chartModal');
    const modalContent = document.querySelector('.modal-content');
    modalContent.style.borderColor = color;
    
    modalContent.style.display = 'flex';
    modalContent.style.flexDirection = 'column';
    modalContent.style.maxHeight = isMobile ? '95vh' : '80vh';
    modal.style.display = 'flex';
    
    // 移动端调整模态框宽度和位置
    if (isMobile) {
        modalContent.style.width = '95vw';
        modalContent.style.margin = 'auto';
        modalContent.style.maxWidth = '95vw';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        modalContent.style.overflow = 'hidden';
    }

    // 修改原有关闭按钮的点击事件，确保能停止播放
    const originalCloseBtn = modal.querySelector('.close-btn');
    if (originalCloseBtn) {
        const originalOnClick = originalCloseBtn.onclick;
        
        originalCloseBtn.onclick = (e) => {
            state.playing = false;
            if (currentPlaybackTimer) {
                clearInterval(currentPlaybackTimer);
                currentPlaybackTimer = null;
            }
            
            if (typeof originalOnClick === 'function') {
                originalOnClick.call(originalCloseBtn, e);
            } else {
                modal.style.display = 'none';
            }
            
            e.stopPropagation();
        };
        
        if (isMobile) {
            originalCloseBtn.style.fontSize = '12px';
            originalCloseBtn.style.padding = '4px 8px';
            originalCloseBtn.style.marginLeft = 'auto';
        }
    }

    // --- 2. 标题栏重构 (含移动端适配) ---
    const titleEl = document.getElementById('modalTitle');
    titleEl.innerHTML = '';

    // 【修复下拉框跳动问题】：将下拉框固定在右侧
    if (isMobile) {
        // 移动端：第一行显示名称、代码和关闭按钮
        const firstRow = document.createElement('div');
        firstRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:6px;';
        
        // 左侧信息
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'display:flex; align-items:center; gap:3px; flex:1; overflow:hidden; white-space:nowrap; min-width:0;';
        
        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'font-size:0.9em; font-weight:bold; text-overflow:ellipsis; overflow:hidden; max-width:50vw;';
        nameSpan.textContent = item.name;
        infoDiv.appendChild(nameSpan);

        const codeSpan = document.createElement('span');
        codeSpan.style.cssText = 'font-size:0.75em; color:#fff; font-weight:normal; font-family:"Courier New", monospace; opacity:0.9; flex-shrink:0;';
        codeSpan.textContent = `(${code})`;
        infoDiv.appendChild(codeSpan);
        firstRow.appendChild(infoDiv);
        
        titleEl.appendChild(firstRow);        
        
        // =========【修改开始：移动端第二行】=========
        const secondRow = document.createElement('div');
        // 1. 增加 position:relative 以便内部使用绝对定位
        // 2. 增加 height 确保高度塌陷不会影响布局
        //secondRow.style.cssText = 'position:relative; display:flex; align-items:center; width:100%; margin-top:2px; height:24px;'; 
        secondRow.style.cssText = `
                          display:flex;
                          align-items:center;
                          width:100%;
                          margin-top:2px;
                          height:26px;
                          gap:6px;
                        
                          /* 防止安卓重绘抖动 */
                          transform: translateZ(0);
                        `;

       
        // 数值显示区域（左侧）
        const valueDiv = document.createElement('div');
        valueDiv.id = 'modalPct';
        // 1. 去掉 flex:1，改为 width: 100%
        // 2. 增加 padding-right: 110px (预留给右侧下拉框的空间)，防止文字重叠
        //valueDiv.style.cssText = 'font-size:0.85em; font-weight:bold; color:#fff; text-align:left; width:100%; padding-right:110px; box-sizing:border-box; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:"Courier New", monospace; line-height:24px;';
        valueDiv.style.cssText = `
                          flex:1;                    /* ✅ 吃掉所有剩余空间 */
                          min-width:0;               /* ✅ 关键：允许被压缩但不撑爆 */
                          
                          font-size:0.9em;
                          font-weight:bold;
                          color:#fff;
                          text-align:left;
                        
                          /* 数字等宽，防止轻微抖动 */
                          font-variant-numeric: tabular-nums;
                          font-family:"Courier New", monospace;
                        
                          white-space:nowrap;
                          overflow:hidden;
                          text-overflow:ellipsis;
                        
                          line-height:26px;
                        `;

        secondRow.appendChild(valueDiv);
        
        // 下拉框容器
        const selectWrapper = document.createElement('div');
        // 核心修复：使用 absolute 定位，彻底脱离文档流，不再受左侧文字宽度抖动影响
        //selectWrapper.style.cssText = 'position:absolute; right:0; top:0; bottom:0; display:flex; align-items:center; justify-content:flex-end;';
        selectWrapper.style.cssText = `
                      flex:0 0 92px;      /* ✅ 固定宽度，但比以前更合理 */
                      display:flex;
                      align-items:center;
                      justify-content:flex-end;
                    `;
        
        const select = document.createElement('select');
        select.id = 'metricSelect';
        //select.style.cssText = 'background:#333; color:#fff; border:1px solid #555; padding:2px 5px; border-radius:3px; font-size:10px; cursor:pointer; width:auto; box-sizing:border-box; min-width:100px;';
        select.style.cssText = `
                      width:100%;
                      height:22px;
                      background:#333;
                      color:#fff;
                      border:1px solid #555;
                      border-radius:3px;
                      font-size:11px;
                      box-sizing:border-box;
                    
                      -webkit-text-size-adjust:100%;
                    `;

        
        selectWrapper.appendChild(select);
        secondRow.appendChild(selectWrapper);
        
        titleEl.appendChild(secondRow);
        // =========【修改结束：移动端第二行】=========
        
        // 为移动端添加选项
        const optionsList = [
            { value: '1min',      label: '分钟价格' },
            { value: '30d_price', label: '30天价格' },
            { value: '30d_pot',   label: 'PotScore' },
            { value: '30d_super', label: '超大单%' },
            { value: '30d_main',  label: '主力%'  }
        ];
        
        optionsList.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label.replace('价格', '价').replace('占比', '占');
            if (opt.value === state.metric) option.selected = true;
            select.appendChild(option);
        });
        
        // 绑定事件
        select.addEventListener('change', (e) => {
            const newMetric = e.target.value;
            state.metric = newMetric;
            state.progress = 0;
            state.playing = true;
            state.view = 'chart';
            renderContent();
        });
        
    } else {
        // 桌面端：保持原有单行布局
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'display:flex; align-items:center; justify-content:space-between; width:100%; gap:10px;';
        
        // 左侧信息
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
        
        // =========【修改开始：PC端数值区域】=========
        // 中间数值显示
        const valueDiv = document.createElement('div');
        valueDiv.id = 'modalPct';
        // 核心修复：
        // 1. 使用 width: 180px (固定宽度) 而不是 min-width
        // 2. 增加 flex-shrink: 0 防止被挤压
        // 3. 增加 text-align: center 保持美观
        valueDiv.style.cssText = 'font-size:1.05em; font-weight:bold; color:#fff; text-align:center; flex-shrink:0; width:180px; font-family:"Courier New", monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        headerDiv.appendChild(valueDiv);
        // =========【修改结束：PC端数值区域】=========
        
        
        // 【下拉框固定在右侧】- 使用margin-left:auto推至最右侧
        const actionDiv = document.createElement('div');
        actionDiv.style.cssText = 'display:flex; align-items:center; gap:8px; flex-shrink:0; margin-left:auto;';
        
        const select = document.createElement('select');
        select.id = 'metricSelect';
        select.style.cssText = 'background:#333; color:#fff; border:1px solid #555; padding:4px 8px; border-radius:4px; font-size:13px; cursor:pointer; width:auto; min-width:120px;';
        actionDiv.appendChild(select);
        
        const optionsList = [
            { value: '1min',      label: '分钟价格' },
            { value: '30d_price', label: '30天价格' },
            { value: '30d_pot',   label: 'PotScore' },
            { value: '30d_super', label: '超大单%' },
            { value: '30d_main',  label: '主力%'  }
        ];
        
        optionsList.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.value === state.metric) option.selected = true;
            select.appendChild(option);
        });
        
        headerDiv.appendChild(actionDiv);
        titleEl.appendChild(headerDiv);
        
        // 绑定事件
        select.addEventListener('change', (e) => {
            const newMetric = e.target.value;
            state.metric = newMetric;
            state.progress = 0;
            state.playing = true;
            state.view = 'chart';
            renderContent();
        });
    }

    // 确保控制栏存在
    let controlsContainer = document.getElementById('chartControls');
    if (!controlsContainer) {
        controlsContainer = document.createElement('div');
        controlsContainer.id = 'chartControls';
        if (isMobile) {
            controlsContainer.style.cssText = "display:flex; justify-content:center; gap:6px; margin-top:6px; padding-top:6px; border-top:1px solid #333; flex-shrink: 0; flex-wrap:wrap;";
        } else {
            controlsContainer.style.cssText = "display:flex; justify-content:center; gap:12px; margin-top:8px; padding-top:8px; border-top:1px solid #333; flex-shrink: 0;";
        }
        modalContent.appendChild(controlsContainer);
    }

    // --- 3. 数据获取 ---
    function getData() {
        let labels = [];
        let values = [];
        let pctChanges = [];
        let refValue = 0;
        let yLabel = '';
        let lineColor = color;
        let currentValue = 0;

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
        } else {
            const d30 = eeiFlow30DaysData?.[code] || [];
            if (d30.length > 0) {
                const recent30 = d30.slice(-30);
                labels = recent30.map(r => r['日期']);
                switch (state.metric) {
                    case '30d_price':
                        values = recent30.map(r => Number(r['收盘价']));
                        pctChanges = recent30.map(r => Number(r['涨跌幅']));
                        refValue = values[0] || 0;
                        yLabel = '收盘价';
                        lineColor = values[values.length-1] >= refValue ? '#EF4444' : '#10B981';
                        currentValue = values[values.length - 1] || 0;
                        break;
                    case '30d_pot':
                        values = recent30.map(r => Number(r['PotScore']));
                        yLabel = 'PotScore';
                        lineColor = '#FFD700';
                        currentValue = values[values.length - 1] || 0;
                        break;
                    case '30d_super':
                        values = recent30.map(r => Number(r['超大单净流入-净占比']));
                        yLabel = '超大单占比(%)';
                        lineColor = '#FF6B6B';
                        currentValue = values[values.length - 1] || 0;
                        break;
                    case '30d_main':
                        values = recent30.map(r => Number(r['主力净流入-净占比']));
                        yLabel = '主力占比(%)';
                        lineColor = '#4ECDC4';
                        currentValue = values[values.length - 1] || 0;
                        break;
                }
            }
        }
        return { labels, values, pctChanges, refValue, yLabel, lineColor, currentValue };
    }

    // --- 4. 渲染内容 ---
    function renderContent() {
        const dataObj = getData();

        if (currentChartInstance) {
            currentChartInstance.destroy();
            currentChartInstance = null;
        }
        if (currentPlaybackTimer) {
            clearInterval(currentPlaybackTimer);
            currentPlaybackTimer = null;
        }

        controlsContainer.innerHTML = '';

        // 4.1 播放/暂停按钮
        if (state.view === 'chart') {
            const playBtn = document.createElement('button');
            if (isMobile) {
                playBtn.style.cssText = "padding:3px 8px; background:#444; color:white; border:none; border-radius:3px; cursor:pointer; font-size:10px; flex:1; min-width: 60px; font-weight:normal;";
            } else {
                playBtn.style.cssText = "padding:4px 12px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px; font-weight:normal;";
            }
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

        // 4.2 切换视图按钮
        const viewBtn = document.createElement('button');
        if (isMobile) {
            viewBtn.style.cssText = "padding:3px 8px; background:#444; color:white; border:none; border-radius:3px; cursor:pointer; font-size:10px; flex:1; min-width: 60px; font-weight:normal;";
        } else {
            viewBtn.style.cssText = "padding:4px 12px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px; font-weight:normal;";
        }
        viewBtn.innerText = state.view === 'chart' ? "📅 表格" : "📈 动图";
        viewBtn.onclick = () => {
            state.view = state.view === 'chart' ? 'table' : 'chart';
            state.playing = false;
            renderContent();
        };
        controlsContainer.appendChild(viewBtn);

        // 4.3 容器与表格初始化
        const canvas = document.getElementById('detailChartCanvas');
        const container = canvas.parentNode;
        
        container.style.flex = "1";
        container.style.minHeight = "0"; 
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.overflow = "hidden";
        
        if (isMobile) {
            container.style.padding = "0 2px";
        } else {
            container.style.padding = "5px 0 0 0";
        }

        let tableDiv = document.getElementById('detailTableContainer');
        if (!tableDiv) {
            tableDiv = document.createElement('div');
            tableDiv.id = 'detailTableContainer';
            if (isMobile) {
                const tableMaxHeight = 'calc(95vh - 120px)';
                tableDiv.style.cssText = `flex:1; width:100%; max-height: ${tableMaxHeight}; overflow-y:auto; overflow-x:hidden; display:none; background:#181818; color:#ddd; border:1px solid #333; margin-top:6px; -webkit-overflow-scrolling: touch;`;
            } else {
                tableDiv.style.cssText = "flex:1; width:100%; max-height: 35vh; overflow-y:auto; overflow-x:hidden; display:none; background:#181818; color:#ddd; border:1px solid #333; margin-top:8px; -webkit-overflow-scrolling: touch;";
            }
            container.appendChild(tableDiv);
        }

        // 立即更新头部数值显示
        updateHeaderInfo(dataObj);

        if (dataObj.values.length === 0) {
            canvas.style.display = 'none';
            tableDiv.style.display = 'block';
            tableDiv.innerHTML = `<div style="padding:20px; text-align:center; color:#666;">
                暂无 [${state.metric}] 数据<br>
            </div>`;
            return;
        }

        // --- 表格视图逻辑 ---
        if (state.view === 'table') {
            canvas.style.display = 'none';
            tableDiv.style.display = 'block';

            const tableFontSize = isMobile ? '10px' : '12px';
            const cellPadding = isMobile ? '3px 2px' : '5px 6px';
            
            let html = `<table style="width:100%; border-collapse:collapse; font-size:${tableFontSize}; table-layout:fixed;">
                <thead style="background:#2d2d2d; position:sticky; top:0; z-index:1;">
                    <tr>
                        <th style="padding:${cellPadding}; text-align:left; width:${isMobile ? '35%' : 'auto'};">日期</th>
                        <th style="padding:${cellPadding}; text-align:right; width:${isMobile ? '30%' : 'auto'};">${dataObj.yLabel}</th>
                        ${state.metric === '30d_price' ? `<th style="padding:${cellPadding}; text-align:right; width:${isMobile ? '35%' : 'auto'};">涨跌幅</th>` : ''}
                    </tr>
                </thead>
                <tbody>`;
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
        // --- 图表视图逻辑 ---
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
                    datasets: [{ 
                        label: dataObj.yLabel, 
                        data: [], 
                        borderColor: dataObj.lineColor, 
                        backgroundColor: gradient, 
                        borderWidth: 2, 
                        pointRadius: 0, 
                        pointHoverRadius: 4, 
                        fill: true, 
                        tension: 0.1 
                    }] 
                },
                options: { 
                    responsive: true, 
                    maintainAspectRatio: false, 
                    animation: false, 
                    layout: { 
                        padding: { 
                            top: 15, 
                            bottom: isMobile ? 10 : 20,
                            left: isMobile ? 5 : 15,
                            right: 10 
                        } 
                    }, 
                    interaction: { mode: 'index', intersect: false }, 
                    plugins: { 
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    let label = context.dataset.label || '';
                                    if (label) {
                                        label += ': ';
                                    }
                                    if (context.parsed.y !== null) {
                                        label += context.parsed.y.toFixed(2);
                                    }
                                    
                                    if (state.metric === '30d_price' && dataObj.pctChanges) {
                                        const idx = context.dataIndex;
                                        const pct = dataObj.pctChanges[idx];
                                        if (pct !== null && pct !== undefined) {
                                            const sign = pct >= 0 ? '+' : '';
                                            label += ` (${sign}${pct.toFixed(2)}%)`;
                                        }
                                    }
                                    return label;
                                }
                            }
                        }
                    }, 
                    scales: { 
                        x: { 
                            display: false,
                            ticks: {
                                font: {
                                    size: isMobile ? 9 : 11
                                }
                            }
                        }, 
                        y: { 
                            position: 'left', 
                            grid: { color: '#333' }, 
                            ticks: { 
                                color: '#888', 
                                font: {
                                    size: isMobile ? 9 : 11
                                },
                                padding: 5
                            }, 
                            grace: '10%',
                            afterFit: function(scale) {
                                scale.width = isMobile ? 30 : 40;
                            }
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
        const sign = pct >= 0 ? '+' : '';
        return `<td style="padding:${padding}; text-align:right; color:${color}; font-family:monospace; white-space:nowrap;">${sign}${isMobile ? pct.toFixed(1) : pct.toFixed(2)}%</td>`;
    }

    // --- 动画逻辑 ---
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
            const currentSlice = dataObj.values.slice(0, state.progress);
            updateChartData(currentSlice);

            // 【问题1修复】：更新头部信息，传入当前进度索引
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

    // --- 更新头部数字 ---
    function updateHeaderInfo(dataObj, currentIndex = null) {
        const pctEl = document.getElementById('modalPct');
        if (!pctEl || dataObj.values.length === 0) return;
        
        // 确定当前显示的索引
        let displayIndex;
        if (currentIndex !== null && currentIndex >= 0 && currentIndex < dataObj.values.length) {
            // 播放过程中：使用传入的索引
            displayIndex = currentIndex;
        } else if (state.view === 'table') {
            // 表格视图：显示最后一条数据
            displayIndex = dataObj.values.length - 1;
        } else if (state.progress > 0 && state.progress <= dataObj.values.length) {
            // 图表视图（播放暂停）：显示当前进度
            displayIndex = state.progress - 1;
        } else {
            // 默认显示最后一条
            displayIndex = dataObj.values.length - 1;
        }
        
        const val = dataObj.values[displayIndex];
        const currentPct = dataObj.pctChanges ? dataObj.pctChanges[displayIndex] : null;
        
        if (val == null) return;

        let displayText = '';
        let displayColor = '#fff';

        switch(state.metric) {
            case '30d_price':
                if (currentPct !== null && currentPct !== undefined) {
                    const sign = currentPct >= 0 ? '+' : '';
                    displayColor = currentPct >= 0 ? '#EF4444' : '#10B981';
                    displayText = isMobile ? 
                        `${val.toFixed(2)} (${sign}${currentPct.toFixed(1)}%)` : 
                        `${val.toFixed(2)} (${sign}${currentPct.toFixed(2)}%)`;
                } else {
                    displayText = `${val.toFixed(2)}`;
                }
                break;
                
            case '1min':
                if (dataObj.refValue && dataObj.refValue !== 0) {
                    const chg = ((val - dataObj.refValue) / dataObj.refValue * 100);
                    const sign = chg >= 0 ? '+' : '';
                    displayColor = chg >= 0 ? '#EF4444' : '#10B981';
                    displayText = isMobile ? 
                        `${val.toFixed(2)} (${sign}${chg.toFixed(1)}%)` : 
                        `${val.toFixed(2)} (${sign}${chg.toFixed(2)}%)`;
                } else {
                    displayText = `${val.toFixed(2)}`;
                }
                break;
                
            case '30d_pot':
                displayText = isMobile ? 
                    `${val.toFixed(1)}` : 
                    `${val.toFixed(2)}`;
                displayColor = val >= 0 ? '#EF4444' : '#10B981';
                break;
                
            case '30d_super':
                displayText = isMobile ? 
                    `${val.toFixed(1)}%` : 
                    `${val.toFixed(2)}%`;
                displayColor = val >= 0 ? '#EF4444' : '#10B981';
                break;
                
            case '30d_main':
                displayText = isMobile ? 
                    `${val.toFixed(1)}%` : 
                    `${val.toFixed(2)}%`;
                displayColor = val >= 0 ? '#EF4444' : '#10B981';
                break;
                
            default:
                displayText = `${val.toFixed(2)}`;
        }
        
        pctEl.innerText = displayText;
        pctEl.style.color = displayColor;
        
        // 移动端添加 tooltip，长按可查看完整数值
        if (isMobile) {
            pctEl.title = displayText;
            pctEl.style.cursor = 'pointer';
        }
    }

    // 首次渲染
    renderContent();
}
