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

// ================= 图表详情函数 =================
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
    
    // 【布局修复】：使用 Flex 列布局，限制最大高度，防止模态框溢出屏幕
    modalContent.style.display = 'flex';
    modalContent.style.flexDirection = 'column';
    modalContent.style.maxHeight = isMobile ? '95vh' : '90vh';
    modal.style.display = 'flex';
    
    // 移动端调整模态框宽度
    if (isMobile) {
        modalContent.style.width = '95vw';
        modalContent.style.margin = 'auto';
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
    }

    // --- 2. 标题栏重构 (含移动端适配) ---
    const titleEl = document.getElementById('modalTitle');
    titleEl.innerHTML = ''; // 清空原有内容

    const headerDiv = document.createElement('div');
    headerDiv.style.cssText = 'display:flex; align-items:center; justify-content:space-between; width:100%;';

    // 2.1 左侧信息 (名称+代码)
    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'display:flex; align-items:center; gap:5px; flex:1; overflow:hidden; white-space:nowrap;';

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'font-size:1.1em; font-weight:bold; text-overflow:ellipsis; overflow:hidden;';
    nameSpan.textContent = item.name;
    infoDiv.appendChild(nameSpan);

    const codeSpan = document.createElement('span');
    // 普通字体，白色，适中的透明度
    codeSpan.style.cssText = 'font-size:0.9em; color:#fff; font-weight:normal; font-family:"Courier New", monospace; opacity:0.9;';
    codeSpan.textContent = `(${code})`;
    infoDiv.appendChild(codeSpan);
    headerDiv.appendChild(infoDiv);

    // 2.2 右侧操作区 (下拉框)
    const actionDiv = document.createElement('div');
    actionDiv.style.cssText = 'display:flex; align-items:center; gap:8px; flex-shrink:0;';

    const select = document.createElement('select');
    select.id = 'metricSelect';
    // 【移动端优化】：使用响应式宽度
    select.style.cssText = 'background:#333; color:#fff; border:1px solid #555; padding:4px 8px; border-radius:4px; font-size:14px; cursor:pointer; max-width: 100%; box-sizing:border-box; width:auto;';

    // 移动端特定样式
    if (isMobile) {
        select.style.fontSize = '12px';
        select.style.padding = '4px 6px';
        select.style.maxWidth = '90%';
    }

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
    actionDiv.appendChild(select);
    
    // 注意：这里不再创建关闭按钮，使用HTML中原有的关闭按钮

    headerDiv.appendChild(actionDiv);
    titleEl.appendChild(headerDiv);

    // 绑定 change 事件
    const handleMetricChange = (e) => {
        const newMetric = e.target.value;
        state.metric = newMetric;
        state.progress = 0;
        state.playing = true;
        state.view = 'chart';
        renderContent();
    };
    select.removeEventListener('change', handleMetricChange);
    select.addEventListener('change', handleMetricChange);

    // 确保控制栏存在
    let controlsContainer = document.getElementById('chartControls');
    if (!controlsContainer) {
        controlsContainer = document.createElement('div');
        controlsContainer.id = 'chartControls';
        controlsContainer.style.cssText = "display:flex; justify-content:center; gap:15px; margin-top:10px; padding-top:10px; border-top:1px solid #333; flex-shrink: 0;";
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

        if (state.metric === '1min') {
            if (item.history && item.history.length > 0) {
                values = item.history;
                labels = values.map((_, i) => i);
                refValue = item.refPrice || values[0];
                if (item.officialChangePercent != null && item.currentPrice) {
                    refValue = item.currentPrice / (1 + item.officialChangePercent / 100);
                }
                yLabel = '价格';
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
                        break;
                    case '30d_pot':
                        values = recent30.map(r => Number(r['PotScore']));
                        yLabel = 'PotScore';
                        lineColor = '#FFD700';
                        break;
                    case '30d_super':
                        values = recent30.map(r => Number(r['超大单净流入-净占比']));
                        yLabel = '超大单占比(%)';
                        lineColor = '#FF6B6B';
                        break;
                    case '30d_main':
                        values = recent30.map(r => Number(r['主力净流入-净占比']));
                        yLabel = '主力占比(%)';
                        lineColor = '#4ECDC4';
                        break;
                }
            }
        }
        return { labels, values, pctChanges, refValue, yLabel, lineColor };
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
            playBtn.style.cssText = "padding:6px 16px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px;";
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
        viewBtn.style.cssText = "padding:6px 16px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px;";
        viewBtn.innerText = state.view === 'chart' ? "📅 切换表格" : "📈 切换图表";
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

        let tableDiv = document.getElementById('detailTableContainer');
        if (!tableDiv) {
            tableDiv = document.createElement('div');
            tableDiv.id = 'detailTableContainer';
            // 【移动端优化】：更好的高度控制和滚动
            const tableMaxHeight = isMobile ? 'calc(80vh - 150px)' : '45vh';
            tableDiv.style.cssText = `flex:1; width:100%; max-height: ${tableMaxHeight}; overflow-y:auto; overflow-x:hidden; display:none; background:#181818; color:#ddd; border:1px solid #333; margin-top:10px; -webkit-overflow-scrolling: touch;`;
            container.appendChild(tableDiv);
        }

        const pctEl = document.getElementById('modalPct');
        if(pctEl) pctEl.innerText = '';

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

            // 移动端表格字体更小
            const tableFontSize = isMobile ? '11px' : '13px';
            const cellPadding = isMobile ? '4px 3px' : '6px 8px';
            
            let html = `<table style="width:100%; border-collapse:collapse; font-size:${tableFontSize};">
                <thead style="background:#2d2d2d; position:sticky; top:0; z-index:1;">
                    <tr>
                        <th style="padding:${cellPadding}; text-align:left;">日期</th>
                        <th style="padding:${cellPadding}; text-align:right;">${dataObj.yLabel}</th>
                        ${state.metric === '30d_price' ? `<th style="padding:${cellPadding}; text-align:right;">涨跌幅</th>` : ''}
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
                    <td style="padding:${cellPadding}; color:#aaa;">${dataObj.labels[i]}</td>
                    <td style="padding:${cellPadding}; text-align:right; color:${colorStyle}; font-family:monospace;">${Number(val).toFixed(2)}</td>
                    ${state.metric === '30d_price' ? renderTablePctCell(dataObj.pctChanges[i], cellPadding) : ''}
                </tr>`;
            }
            html += `</tbody></table>`;
            tableDiv.innerHTML = html;

            const lastIdx = dataObj.values.length - 1;
            updateHeaderInfo(dataObj.values[lastIdx], dataObj.refValue, dataObj.pctChanges ? dataObj.pctChanges[lastIdx] : null);
        } 
        // --- 图表视图逻辑 ---
        else {
            tableDiv.style.display = 'none';
            canvas.style.display = 'block';
            canvas.style.maxHeight = isMobile ? '45vh' : '50vh'; 

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
    function renderTablePctCell(pct, padding) {
        if (pct === null || pct === undefined) return `<td style="padding:${padding};"></td>`;
        const color = pct >= 0 ? '#ff4444' : '#00cc00';
        const sign = pct >= 0 ? '+' : '';
        return `<td style="padding:${padding}; text-align:right; color:${color}; font-family:monospace;">${sign}${pct.toFixed(2)}%</td>`;
    }

    // --- 动画逻辑 ---
    function runAnimation(dataObj) {
        if (!state.playing) {
            updateChartData(dataObj.values.slice(0, state.progress));
            const idx = Math.max(0, state.progress - 1);
            updateHeaderInfo(dataObj.values[idx], dataObj.refValue, dataObj.pctChanges ? dataObj.pctChanges[idx] : null);
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

            const idx = state.progress - 1;
            updateHeaderInfo(currentSlice[idx], dataObj.refValue, dataObj.pctChanges ? dataObj.pctChanges[idx] : null);

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
    function updateHeaderInfo(val, ref, directPct) {
        const pctEl = document.getElementById('modalPct');
        if (!pctEl) return;
        pctEl.innerText = ''; 
        pctEl.style.color = '#fff';

        if (val == null) return;

        if (state.metric === '30d_price') {
            if (directPct !== null && directPct !== undefined) {
                const sign = directPct >= 0 ? '+' : '';
                const color = directPct >= 0 ? '#EF4444' : '#10B981';
                pctEl.innerText = `${val.toFixed(2)} (${sign}${directPct.toFixed(2)}%)`;
                pctEl.style.color = color;
            } else {
                pctEl.innerText = `${val.toFixed(2)}`;
            }
        } 
        else if (state.metric === '1min') {
            if (ref && ref !== 0) {
                const chg = ((val - ref) / ref * 100);
                const sign = chg >= 0 ? '+' : '';
                const color = chg >= 0 ? '#EF4444' : '#10B981';
                pctEl.innerText = `${val.toFixed(2)} (${sign}${chg.toFixed(2)}%)`;
                pctEl.style.color = color;
            } else {
                pctEl.innerText = `${val.toFixed(2)}`;
            }
        }
    }

    // 首次渲染
    renderContent();
}
