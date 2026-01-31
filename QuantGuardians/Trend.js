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
    
    // 【布局修复】：使用 Flex 列布局，限制最大高度，防止模态框溢出屏幕
    modalContent.style.display = 'flex';
    modalContent.style.flexDirection = 'column';
    modalContent.style.maxHeight = isMobile ? '95vh' : '90vh';
    modal.style.display = 'flex';
    
    // 移动端调整模态框宽度和位置
    if (isMobile) {
        modalContent.style.width = '95vw';
        modalContent.style.margin = 'auto';
        modalContent.style.maxWidth = '95vw'; // 确保不超过屏幕宽度
        // 确保模态框不会超出屏幕
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        modalContent.style.overflow = 'hidden'; // 防止内容溢出
    }

    // 修改原有关闭按钮的点击事件，确保能停止播放
    const originalCloseBtn = modal.querySelector('.close-btn');
    if (originalCloseBtn) {
        // 保存原有的点击事件（如果有的话）
        const originalOnClick = originalCloseBtn.onclick;
        
        // 设置新的点击事件
        originalCloseBtn.onclick = (e) => {
            // 停止播放
            state.playing = false;
            if (currentPlaybackTimer) {
                clearInterval(currentPlaybackTimer);
                currentPlaybackTimer = null;
            }
            
            // 执行原有的关闭函数
            if (typeof originalOnClick === 'function') {
                originalOnClick.call(originalCloseBtn, e);
            } else {
                // 如果没有原有函数，则默认关闭模态框
                modal.style.display = 'none';
            }
            
            // 阻止事件冒泡
            e.stopPropagation();
        };
        
        // 移动端调整关闭按钮样式
        if (isMobile) {
            originalCloseBtn.style.fontSize = '12px';
            originalCloseBtn.style.padding = '4px 8px';
            originalCloseBtn.style.marginLeft = 'auto'; // 靠右对齐
        }
    }

    // --- 2. 标题栏重构 (含移动端适配) ---
    const titleEl = document.getElementById('modalTitle');
    titleEl.innerHTML = ''; // 清空原有内容

    // 【问题2修复】：移动端使用两行布局
    if (isMobile) {
        // 移动端：第一行显示名称、代码和关闭按钮
        const firstRow = document.createElement('div');
        firstRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:8px;';
        
        // 左侧信息
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'display:flex; align-items:center; gap:3px; flex:1; overflow:hidden; white-space:nowrap;';
        
        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'font-size:0.95em; font-weight:bold; text-overflow:ellipsis; overflow:hidden; max-width:50vw;';
        nameSpan.textContent = item.name;
        infoDiv.appendChild(nameSpan);

        const codeSpan = document.createElement('span');
        codeSpan.style.cssText = 'font-size:0.8em; color:#fff; font-weight:normal; font-family:"Courier New", monospace; opacity:0.9;';
        codeSpan.textContent = `(${code})`;
        infoDiv.appendChild(codeSpan);
        firstRow.appendChild(infoDiv);
        
        titleEl.appendChild(firstRow);
        
        // 移动端：第二行显示数值和下拉框
        const secondRow = document.createElement('div');
        secondRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; width:100%; gap:8px;';
        
        // 数值显示区域（左侧）
        const valueDiv = document.createElement('div');
        valueDiv.id = 'modalPct';
        valueDiv.style.cssText = 'font-size:0.95em; font-weight:bold; color:#fff; text-align:left; flex-shrink:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; max-width:50%;';
        secondRow.appendChild(valueDiv);
        
        // 下拉框容器（右侧）
        const selectWrapper = document.createElement('div');
        selectWrapper.style.cssText = 'display:flex; align-items:center; justify-content:flex-end; flex-shrink:0; max-width:50%;';
        
        const select = document.createElement('select');
        select.id = 'metricSelect';
        select.style.cssText = 'background:#333; color:#fff; border:1px solid #555; padding:4px 6px; border-radius:4px; font-size:11px; cursor:pointer; width:100%; max-width:150px; box-sizing:border-box;';
        selectWrapper.appendChild(select);
        secondRow.appendChild(selectWrapper);
        
        titleEl.appendChild(secondRow);
        
        // 为移动端添加选项
        const optionsList = [
            { value: '1min',      label: '1分价格' },
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
        infoDiv.style.cssText = 'display:flex; align-items:center; gap:5px; flex:1; overflow:hidden; white-space:nowrap;';
        
        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'font-size:1.1em; font-weight:bold; text-overflow:ellipsis; overflow:hidden;';
        nameSpan.textContent = item.name;
        infoDiv.appendChild(nameSpan);

        const codeSpan = document.createElement('span');
        codeSpan.style.cssText = 'font-size:0.9em; color:#fff; font-weight:normal; font-family:"Courier New", monospace; opacity:0.9;';
        codeSpan.textContent = `(${code})`;
        infoDiv.appendChild(codeSpan);
        headerDiv.appendChild(infoDiv);
        
        // 中间数值显示
        const valueDiv = document.createElement('div');
        valueDiv.id = 'modalPct';
        valueDiv.style.cssText = 'font-size:1.1em; font-weight:bold; color:#fff; text-align:center; flex-shrink:0; padding:0 10px;';
        headerDiv.appendChild(valueDiv);
        
        // 右侧下拉框
        const actionDiv = document.createElement('div');
        actionDiv.style.cssText = 'display:flex; align-items:center; gap:8px; flex-shrink:0;';
        
        const select = document.createElement('select');
        select.id = 'metricSelect';
        select.style.cssText = 'background:#333; color:#fff; border:1px solid #555; padding:4px 8px; border-radius:4px; font-size:14px; cursor:pointer; width:auto;';
        actionDiv.appendChild(select);
        
        const optionsList = [
            { value: '1min',      label: '1分价格' },
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
            controlsContainer.style.cssText = "display:flex; justify-content:center; gap:10px; margin-top:8px; padding-top:8px; border-top:1px solid #333; flex-shrink: 0; flex-wrap:wrap;";
        } else {
            controlsContainer.style.cssText = "display:flex; justify-content:center; gap:15px; margin-top:10px; padding-top:10px; border-top:1px solid #333; flex-shrink: 0;";
        }
        modalContent.appendChild(controlsContainer);
    }

    // --- 3. 数据获取 ---
    function getData() {
        let labels = [];
        let values = [];
        let pctChanges = []; // 存储涨跌幅
        let refValue = 0;
        let yLabel = '';
        let lineColor = color;
        let currentValue = 0; // 当前数值

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
                        pctChanges = recent30.map(r => Number(r['涨跌幅'])); // 获取 Excel 中的涨跌幅
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
                playBtn.style.cssText = "padding:4px 10px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:11px; flex:1; min-width: 70px;";
            } else {
                playBtn.style.cssText = "padding:6px 16px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px;";
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
            viewBtn.style.cssText = "padding:4px 10px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:11px; flex:1; min-width: 70px;";
        } else {
            viewBtn.style.cssText = "padding:6px 16px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px;";
        }
        viewBtn.innerText = state.view === 'chart' ? "📅 表格" : "📈 图表";
        viewBtn.onclick = () => {
            state.view = state.view === 'chart' ? 'table' : 'chart';
            state.playing = false;
            renderContent();
        };
        controlsContainer.appendChild(viewBtn);

        // 4.3 容器与表格初始化
        const canvas = document.getElementById('detailChartCanvas');
        const container = canvas.parentNode;
        
        // 【布局修复】：Flex布局容器
        container.style.flex = "1";
        container.style.minHeight = "0"; 
        container.style.display = "flex";
        container.style.flexDirection = "column";
        
        // 移动端容器内边距调整
        if (isMobile) {
            container.style.padding = "0 2px";
        }

        let tableDiv = document.getElementById('detailTableContainer');
        if (!tableDiv) {
            tableDiv = document.createElement('div');
            tableDiv.id = 'detailTableContainer';
            // 【重要修复】：移动端表格下边界问题
            if (isMobile) {
                // 计算可用高度：模态框高度 - 标题高度 - 控制栏高度 - 内边距
                const tableMaxHeight = 'calc(95vh - 120px)';
                tableDiv.style.cssText = `flex:1; width:100%; max-height: ${tableMaxHeight}; overflow-y:auto; overflow-x:hidden; display:none; background:#181818; color:#ddd; border:1px solid #333; margin-top:8px; -webkit-overflow-scrolling: touch;`;
            } else {
                tableDiv.style.cssText = "flex:1; width:100%; max-height: 45vh; overflow-y:auto; overflow-x:hidden; display:none; background:#181818; color:#ddd; border:1px solid #333; margin-top:10px; -webkit-overflow-scrolling: touch;";
            }
            container.appendChild(tableDiv);
        }

        // 【问题1修复】：立即更新头部数值显示
        updateHeaderInfo(dataObj);

        if (dataObj.values.length === 0) {
            canvas.style.display = 'none';
            tableDiv.style.display = 'block';
            tableDiv.innerHTML = `<div style="padding:20px; text-align:center; color:#666;">
                暂无 [${state.metric}] 数据<br>
                <small>请确认代码 ${code} 是否存在于 Excel 中</small>
            </div>`;
            return;
        }

        // --- 表格视图逻辑 ---
        if (state.view === 'table') {
            canvas.style.display = 'none';
            tableDiv.style.display = 'block';

            // 移动端表格字体更小，压缩布局
            const tableFontSize = isMobile ? '10px' : '13px';
            const cellPadding = isMobile ? '3px 2px' : '6px 8px';
            
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
                
                // 表格内的颜色逻辑
                if (state.metric === '30d_price') {
                   // 价格本身如果是红绿显示需要参照昨日，这里简化处理，主要看涨跌幅列
                } else if (state.metric.includes('super') || state.metric.includes('main') || state.metric.includes('pot')) {
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
            canvas.style.maxHeight = isMobile ? 'calc(95vh - 150px)' : '50vh'; 

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
                    layout: { padding: { top: 20, bottom: 10, left: 0, right: 10 } }, 
                    interaction: { mode: 'index', intersect: false }, 
                    plugins: { 
                        legend: { display: false },
                        // 【新功能实现】：自定义 Tooltip，显示30天价格的涨跌幅
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
                                    
                                    // 检查是否为 30天价格，且有涨跌幅数据
                                    if (state.metric === '30d_price' && dataObj.pctChanges) {
                                        const idx = context.dataIndex; // 获取当前鼠标所在的索引
                                        const pct = dataObj.pctChanges[idx]; // 获取对应的涨跌幅
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
                        x: { display: false }, 
                        y: { position: 'left', grid: { color: '#333' }, ticks: { color: '#888', font: {size:10} }, grace: '10%' } 
                    } 
                }
            });

            runAnimation(dataObj);
        }
    }

    // 辅助函数：渲染表格中的涨跌幅单元格
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
            const idx = Math.max(0, state.progress - 1);
            // 更新头部信息
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

            // 更新头部信息
            updateHeaderInfo(dataObj);

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

    // --- 【问题1修复】：更新头部数字 ---
    function updateHeaderInfo(dataObj) {
        const pctEl = document.getElementById('modalPct');
        if (!pctEl || dataObj.values.length === 0) return;
        
        const val = dataObj.currentValue;
        const lastIdx = dataObj.values.length - 1;
        const currentPct = dataObj.pctChanges ? dataObj.pctChanges[lastIdx] : null;
        
        // 移动端调整字体大小
        if (isMobile) {
            pctEl.style.fontSize = '0.95em';
        }

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
                    `Pot: ${val.toFixed(1)}` : 
                    `PotScore: ${val.toFixed(2)}`;
                displayColor = val >= 0 ? '#EF4444' : '#10B981';
                break;
                
            case '30d_super':
                displayText = isMobile ? 
                    `超大单: ${val.toFixed(1)}%` : 
                    `超大单: ${val.toFixed(2)}%`;
                displayColor = val >= 0 ? '#EF4444' : '#10B981';
                break;
                
            case '30d_main':
                displayText = isMobile ? 
                    `主力: ${val.toFixed(1)}%` : 
                    `主力: ${val.toFixed(2)}%`;
                displayColor = val >= 0 ? '#EF4444' : '#10B981';
                break;
                
            default:
                displayText = `${val.toFixed(2)}`;
        }
        
        pctEl.innerText = displayText;
        pctEl.style.color = displayColor;
    }

    // 首次渲染
    renderContent();
}
