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
function openDetailChart(item, color) {
    const rawCode = item.code;
    const code = rawCode;
    console.log(`正在打开图表: ${item.name} (${code})`);

    const isMobile = window.innerWidth <= 768;

    // 1. 清理旧元素
    const oldModalCode = document.getElementById('modalCode');
    if (oldModalCode) oldModalCode.remove();

    // 2. 初始化状态
    if (!modalState[code]) {
        modalState[code] = {
            metric: '1min',
            view: 'chart',
            playing: true,
            progress: 0
        };
    }
    const state = modalState[code];

    // 3. 获取模态框 DOM
    const modal = document.getElementById('chartModal');
    const modalContent = document.querySelector('.modal-content');
    modalContent.style.borderColor = color;

    // --- 布局设置 ---
    modalContent.style.display = 'flex';
    modalContent.style.flexDirection = 'column';
    modalContent.style.maxHeight = isMobile ? '95vh' : '90vh';
    modal.style.display = 'flex';

    if (isMobile) {
        modalContent.style.width = '95vw';
        modalContent.style.margin = 'auto';
        modalContent.style.maxWidth = '95vw';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        modalContent.style.overflow = 'hidden';
    }

    // --- 关闭按钮逻辑 ---
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

    // ==========================================
    //   标题栏重构 (核心修复区域)
    // ==========================================
    const titleEl = document.getElementById('modalTitle');
    titleEl.innerHTML = '';

    const headerDiv = document.createElement('div');
    // 启用 flex-wrap 允许移动端换行
    headerDiv.style.cssText = 'display:flex; align-items:center; justify-content:space-between; width:100%; flex-wrap:wrap; gap:5px;';

    // --- 左侧区域：名称 + 代码 + 数值 ---
    const leftContainer = document.createElement('div');
    // flex:1 确保占满左侧剩余空间，把下拉框挤到右边
    leftContainer.style.cssText = 'display:flex; align-items:center; gap:8px; flex:1; min-width:0; margin-right:5px;';

    // 股票名称
    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = isMobile ? 'font-size:1em; font-weight:bold; white-space:nowrap;' : 'font-size:1.1em; font-weight:bold;';
    nameSpan.textContent = item.name;
    leftContainer.appendChild(nameSpan);

    // 股票代码
    const codeSpan = document.createElement('span');
    codeSpan.style.cssText = 'font-size:0.9em; color:#aaa; font-family:"Courier New", monospace;';
    codeSpan.textContent = `(${code})`;
    leftContainer.appendChild(codeSpan);

    // 【关键修复】数值显示区域 (初始化为 --)
    const pctSpan = document.createElement('span');
    pctSpan.id = 'modalPct'; // 确保 ID 存在
    pctSpan.textContent = '--'; // 默认占位
    pctSpan.style.cssText = isMobile 
        ? 'font-weight:bold; font-family:monospace; margin-left:2px; font-size:0.95em;' 
        : 'font-weight:bold; font-family:monospace; margin-left:8px; font-size:1.1em;';
    leftContainer.appendChild(pctSpan);

    headerDiv.appendChild(leftContainer);

    // --- 右侧区域：下拉框 ---
    const actionDiv = document.createElement('div');
    if (isMobile) {
        // 移动端：强制换行(width:100%) 并 靠右对齐(justify-content:flex-end)
        actionDiv.style.cssText = 'display:flex; align-items:center; width:100%; justify-content:flex-end; margin-top:5px; order:2;';
    } else {
        actionDiv.style.cssText = 'display:flex; align-items:center; gap:8px; flex-shrink:0;';
    }

    const select = document.createElement('select');
    select.id = 'metricSelect';
    select.style.cssText = isMobile 
        ? 'background:#333; color:#fff; border:1px solid #555; padding:2px 8px; border-radius:4px; font-size:12px; height:26px;' 
        : 'background:#333; color:#fff; border:1px solid #555; padding:4px 8px; border-radius:4px; font-size:14px; cursor:pointer;';

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
    headerDiv.appendChild(actionDiv);
    titleEl.appendChild(headerDiv);

    // 绑定 change 事件
    const handleMetricChange = (e) => {
        state.metric = e.target.value;
        state.progress = 0;
        state.playing = true;
        state.view = 'chart';
        renderContent();
    };
    select.removeEventListener('change', handleMetricChange);
    select.addEventListener('change', handleMetricChange);

    // --- 控制栏容器 ---
    let controlsContainer = document.getElementById('chartControls');
    if (!controlsContainer) {
        controlsContainer = document.createElement('div');
        controlsContainer.id = 'chartControls';
        controlsContainer.style.cssText = isMobile 
            ? "display:flex; justify-content:center; gap:10px; margin-top:8px; padding-top:8px; border-top:1px solid #333; flex-shrink: 0; flex-wrap:wrap;"
            : "display:flex; justify-content:center; gap:15px; margin-top:10px; padding-top:10px; border-top:1px solid #333; flex-shrink: 0;";
        modalContent.appendChild(controlsContainer);
    }

    // --- 数据获取函数 ---
    function getData() {
        let labels = [], values = [], pctChanges = [];
        let refValue = 0, yLabel = '', lineColor = color;

        if (state.metric === '1min') {
            if (item.history && item.history.length > 0) {
                values = item.history;
                labels = values.map((_, i) => i);
                // 1分钟线的基准价计算
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
                        pctChanges = recent30.map(r => Number(r['涨跌幅']));
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

    // --- 渲染内容主函数 ---
    function renderContent() {
        const dataObj = getData();

        // 清理旧实例
        if (currentChartInstance) { currentChartInstance.destroy(); currentChartInstance = null; }
        if (currentPlaybackTimer) { clearInterval(currentPlaybackTimer); currentPlaybackTimer = null; }

        controlsContainer.innerHTML = '';

        // 1. 播放按钮
        if (state.view === 'chart') {
            const playBtn = document.createElement('button');
            playBtn.style.cssText = isMobile 
                ? "padding:4px 10px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:11px; flex:1; min-width: 70px;"
                : "padding:6px 16px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px;";
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

        // 2. 视图切换按钮
        const viewBtn = document.createElement('button');
        viewBtn.style.cssText = isMobile 
            ? "padding:4px 10px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:11px; flex:1; min-width: 70px;"
            : "padding:6px 16px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px;";
        viewBtn.innerText = state.view === 'chart' ? "📅 表格" : "📈 图表";
        viewBtn.onclick = () => {
            state.view = state.view === 'chart' ? 'table' : 'chart';
            state.playing = false;
            renderContent();
        };
        controlsContainer.appendChild(viewBtn);

        // 3. 容器设置
        const canvas = document.getElementById('detailChartCanvas');
        const container = canvas.parentNode;
        container.style.flex = "1";
        container.style.display = "flex";
        container.style.flexDirection = "column";
        if (isMobile) container.style.padding = "0 2px";

        let tableDiv = document.getElementById('detailTableContainer');
        if (!tableDiv) {
            tableDiv = document.createElement('div');
            tableDiv.id = 'detailTableContainer';
            const tableMaxHeight = isMobile ? 'calc(95vh - 120px)' : '45vh';
            tableDiv.style.cssText = `flex:1; width:100%; max-height:${tableMaxHeight}; overflow-y:auto; display:none; background:#181818; color:#ddd; border:1px solid #333; margin-top:8px; -webkit-overflow-scrolling: touch;`;
            container.appendChild(tableDiv);
        }

        // --- 立即更新头部数值 (防止空白) ---
        // 如果正在播放且进度为0，显示第0个；如果播放完，显示最后一个。
        // 安全起见，如果 values 不为空，先显示当前进度对应的值。
        if (dataObj.values.length > 0) {
            let initialIdx = state.progress;
            if (initialIdx >= dataObj.values.length) initialIdx = dataObj.values.length - 1;
            if (initialIdx < 0) initialIdx = 0;
            
            updateHeaderInfo(
                dataObj.values[initialIdx], 
                dataObj.refValue, 
                dataObj.pctChanges ? dataObj.pctChanges[initialIdx] : null
            );
        } else {
            updateHeaderInfo(null);
        }

        if (dataObj.values.length === 0) {
            canvas.style.display = 'none';
            tableDiv.style.display = 'block';
            tableDiv.innerHTML = `<div style="padding:20px; text-align:center; color:#666;">暂无 [${state.metric}] 数据</div>`;
            return;
        }

        // --- 视图渲染 ---
        if (state.view === 'table') {
            canvas.style.display = 'none';
            tableDiv.style.display = 'block';
            // (表格渲染逻辑省略，保持原有即可，或者如果不显示请告诉我补全)
            // 简单补全表格逻辑：
            const cellPad = isMobile ? '3px 2px' : '6px 8px';
            let html = `<table style="width:100%; border-collapse:collapse; font-size:${isMobile?'10px':'13px'};"><thead><tr><th style="text-align:left;padding:${cellPad}">日期</th><th style="text-align:right;padding:${cellPad}">${dataObj.yLabel}</th>${state.metric==='30d_price'?`<th style="text-align:right;padding:${cellPad}">涨跌幅</th>`:''}</tr></thead><tbody>`;
            for(let i=dataObj.values.length-1; i>=0; i--){
                const v=dataObj.values[i];
                let cStyle='#ddd';
                if(state.metric.includes('pot')||state.metric.includes('super')||state.metric.includes('main')) cStyle = v>=0?'#ff4444':'#00cc00';
                html += `<tr style="border-bottom:1px solid #333;"><td style="padding:${cellPad};color:#aaa;">${dataObj.labels[i]}</td><td style="padding:${cellPad};text-align:right;color:${cStyle};font-family:monospace;">${v.toFixed(2)}</td>${state.metric==='30d_price'?`<td style="padding:${cellPad};text-align:right;color:${dataObj.pctChanges[i]>=0?'#ff4444':'#00cc00'};font-family:monospace;">${dataObj.pctChanges[i]>=0?'+':''}${dataObj.pctChanges[i].toFixed(2)}%</td>`:''}</tr>`;
            }
            html+='</tbody></table>';
            tableDiv.innerHTML = html;
        } else {
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
                        data: [], // 初始为空，由动画填充
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
                    interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { display: false },
                        y: { position: 'left', grid: { color: '#333' }, ticks: { color: '#888' } }
                    }
                }
            });
            runAnimation(dataObj);
        }
    }

    // --- 动画逻辑 ---
    function runAnimation(dataObj) {
        if (!state.playing) {
            updateChartData(dataObj.values.slice(0, state.progress));
            return;
        }
        const total = dataObj.values.length;
        const speed = total < 100 ? 100 : 20;

        currentPlaybackTimer = setInterval(() => {
            if (!state.playing) { clearInterval(currentPlaybackTimer); return; }
            state.progress++;
            const currentSlice = dataObj.values.slice(0, state.progress);
            updateChartData(currentSlice);

            const idx = state.progress - 1;
            if (idx >= 0) {
                updateHeaderInfo(dataObj.values[idx], dataObj.refValue, dataObj.pctChanges ? dataObj.pctChanges[idx] : null);
            }

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

    // --- 头部数值更新 (终极修复版) ---
    function updateHeaderInfo(val, ref, directPct) {
        const pctEl = document.getElementById('modalPct');
        if (!pctEl) return;

        // 如果值为 null/undefined，显示横线
        if (val === null || val === undefined) {
            pctEl.innerText = '--';
            pctEl.style.color = '#888';
            return;
        }

        // 1. 1分钟线逻辑
        if (state.metric === '1min') {
            if (ref && ref !== 0) {
                const chg = ((val - ref) / ref * 100);
                const sign = chg >= 0 ? '+' : '';
                const color = chg >= 0 ? '#EF4444' : '#10B981';
                pctEl.innerText = `${val.toFixed(2)} ${sign}${chg.toFixed(2)}%`;
                pctEl.style.color = color;
            } else {
                pctEl.innerText = val.toFixed(2);
                pctEl.style.color = '#fff';
            }
        } 
        // 2. 30天价格逻辑 (使用 Excel 中的涨跌幅)
        else if (state.metric === '30d_price') {
            if (directPct !== null && directPct !== undefined) {
                const sign = directPct >= 0 ? '+' : '';
                const color = directPct >= 0 ? '#EF4444' : '#10B981';
                pctEl.innerText = `${val.toFixed(2)} ${sign}${directPct.toFixed(2)}%`;
                pctEl.style.color = color;
            } else {
                pctEl.innerText = val.toFixed(2);
                pctEl.style.color = '#fff';
            }
        } 
        // 3. 其他指标逻辑 (Pot, Super, Main)
        else {
            pctEl.innerText = val.toFixed(2);
            // 颜色判断
            if (state.metric.includes('pot')) {
                pctEl.style.color = '#FFD700'; // 金色
            } else {
                // 资金流向，正红负绿
                pctEl.style.color = val >= 0 ? '#EF4444' : '#10B981';
            }
            // 如果是占比，加 %
            if (state.metric.includes('super') || state.metric.includes('main')) {
                pctEl.innerText += '%';
            }
        }
    }

    // 首次渲染
    renderContent();
}
