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
    console.log(`正在打开图表: 原始代码=${rawCode}, 查找代码=${code}`);

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

    // 基础 DOM 设置
    const modal = document.getElementById('chartModal');
    const modalContent = document.querySelector('.modal-content');
    modalContent.style.borderColor = color;
    modal.style.display = 'flex';

    // 标题栏
    const titleEl = document.getElementById('modalTitle');
    titleEl.innerHTML = '';
    const headerDiv = document.createElement('div');
    headerDiv.style.cssText = 'display:flex; align-items:center; gap:10px;';

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'font-size:1.1em; font-weight:bold;';
    nameSpan.textContent = item.name;
    headerDiv.appendChild(nameSpan);

    const codeSpan = document.createElement('span');
    // 【修改点1】：字体颜色改为白色 (#fff)，去除灰色，样式更清晰
    codeSpan.style.cssText = 'font-size:0.9em; color:#fff; font-weight:normal;';
    codeSpan.textContent = `(${code})`;
    headerDiv.appendChild(codeSpan);

    const select = document.createElement('select');
    select.id = 'metricSelect';
    select.style.cssText = 'background:#333; color:#fff; border:1px solid #555; padding:4px 8px; border-radius:4px; font-size:13px; cursor:pointer;';

    const optionsList = [
        { value: '1min',      label: '1分钟价格'     },
        { value: '30d_price', label: '30天价格'      },
        { value: '30d_pot',   label: '30天PotScore'  },
        { value: '30d_super', label: '30天超大单占比'},
        { value: '30d_main',  label: '30天主力占比'  }
    ];

    optionsList.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.value === state.metric) option.selected = true;
        select.appendChild(option);
    });

    headerDiv.appendChild(select);
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
        controlsContainer.style.cssText = "display:flex; justify-content:center; gap:15px; margin-top:15px; padding-top:10px; border-top:1px solid #333;";
        modalContent.appendChild(controlsContainer);
    }

    // --- 数据获取 ---
    function getData() {
        let labels = [];
        let values = [];
        let pctChanges = []; // 【修改点2】：新增数组，用于存储30天数据的原始涨跌幅
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
                        // 提取 Excel 中的涨跌幅，不进行计算
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

    // --- 渲染内容 ---
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

        const viewBtn = document.createElement('button');
        viewBtn.style.cssText = "padding:6px 16px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px;";
        viewBtn.innerText = state.view === 'chart' ? "📅 切换表格" : "📈 切换图表";
        viewBtn.onclick = () => {
            state.view = state.view === 'chart' ? 'table' : 'chart';
            state.playing = false;
            renderContent();
        };
        controlsContainer.appendChild(viewBtn);

        const canvas = document.getElementById('detailChartCanvas');
        const container = canvas.parentNode;
        let tableDiv = document.getElementById('detailTableContainer');
        if (!tableDiv) {
            tableDiv = document.createElement('div');
            tableDiv.id = 'detailTableContainer';
            tableDiv.style.cssText = "width:100%; height:320px; overflow-y:auto; display:none; background:#181818; color:#ddd; border:1px solid #333; margin-top:10px;";
            container.appendChild(tableDiv);
        }

        // 每次渲染前先清空头部信息，防止残留
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

        if (state.view === 'table') {
            canvas.style.display = 'none';
            tableDiv.style.display = 'block';

            let html = `<table style="width:100%; border-collapse:collapse; font-size:13px;">
                <thead style="background:#2d2d2d; position:sticky; top:0; z-index:1;">
                    <tr>
                        <th style="padding:8px; text-align:left;">日期</th>
                        <th style="padding:8px; text-align:right;">${dataObj.yLabel}</th>
                    </tr>
                </thead>
                <tbody>`;
            for (let i = dataObj.values.length - 1; i >= 0; i--) {
                const val = dataObj.values[i];
                const colorStyle = (state.metric.includes('super') || state.metric.includes('main') || state.metric.includes('pot'))
                    ? (val >= 0 ? '#ff4444' : '#00cc00')
                    : '#ddd';
                html += `<tr style="border-bottom:1px solid #333;">
                    <td style="padding:6px 8px; color:#aaa;">${dataObj.labels[i]}</td>
                    <td style="padding:6px 8px; text-align:right; color:${colorStyle}; font-family:monospace;">${Number(val).toFixed(2)}</td>
                </tr>`;
            }
            html += `</tbody></table>`;
            tableDiv.innerHTML = html;

            // 表格模式显示最后一条数据
            const lastIdx = dataObj.values.length - 1;
            const lastPct = dataObj.pctChanges ? dataObj.pctChanges[lastIdx] : null;
            updateHeaderInfo(dataObj.values[lastIdx], dataObj.refValue, lastPct);

        } else {
            tableDiv.style.display = 'none';
            canvas.style.display = 'block';

            const ctx = canvas.getContext('2d');
            const gradient = ctx.createLinearGradient(0, 0, 0, 400);
            gradient.addColorStop(0, dataObj.lineColor + '40');
            gradient.addColorStop(1, dataObj.lineColor + '00');

            currentChartInstance = new Chart(ctx, {
                type: 'line',
                data: { labels: dataObj.labels, datasets: [{ label: dataObj.yLabel, data: [], borderColor: dataObj.lineColor, backgroundColor: gradient, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: true, tension: 0.1 }] },
                options: { responsive: true, maintainAspectRatio: false, animation: false, layout: { padding: { top: 20, bottom: 10, left: 0, right: 10 } }, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { position: 'left', grid: { color: '#333' }, ticks: { color: '#888', font: {size:10} }, grace: '10%' } } }
            });

            runAnimation(dataObj);
        }
    }

    // --- 动画逻辑 ---
    function runAnimation(dataObj) {
        if (!state.playing) {
            updateChartData(dataObj.values.slice(0, state.progress));
            
            // 静态展示时，获取当前进度对应的数据
            const idx = Math.max(0, state.progress - 1);
            const curVal = dataObj.values[idx];
            const curPct = dataObj.pctChanges ? dataObj.pctChanges[idx] : null;
            
            updateHeaderInfo(curVal, dataObj.refValue, curPct);
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

            // 获取当前动画帧对应的数据
            const idx = state.progress - 1;
            const lastVal = currentSlice[idx];
            const lastPct = dataObj.pctChanges ? dataObj.pctChanges[idx] : null;
            
            updateHeaderInfo(lastVal, dataObj.refValue, lastPct);

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

    // --- 【关键函数】更新头部数字 ---
    // val: 当前数值
    // ref: 参考值 (用于1min)
    // directPct: 直接从Excel读取的涨跌幅 (用于30d_price)
    function updateHeaderInfo(val, ref, directPct) {
        const pctEl = document.getElementById('modalPct');
        if (!pctEl) return;

        // 【修改点3】：默认为空字符串，彻底解决 "(--)" 显示问题
        pctEl.innerText = ''; 
        pctEl.style.color = '#fff';

        if (val == null) return;

        // 情况1：30天价格 - 使用 Excel 里的原始涨跌幅，不计算
        if (state.metric === '30d_price') {
            if (directPct !== null && directPct !== undefined) {
                const sign = directPct >= 0 ? '+' : '';
                const color = directPct >= 0 ? '#EF4444' : '#10B981';
                pctEl.innerText = `${val.toFixed(2)} (${sign}${directPct.toFixed(2)}%)`;
                pctEl.style.color = color;
            } else {
                // 如果没有涨跌幅数据，只显示价格，不显示空括号
                pctEl.innerText = `${val.toFixed(2)}`;
            }
        } 
        // 情况2：1分钟价格 - 需要计算
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
        // 情况3：其他指标 (PotScore, 资金流等) -> 保持为空，不显示任何内容
    }

    // 首次渲染
    renderContent();
}
