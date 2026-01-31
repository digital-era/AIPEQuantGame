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

        // 使用 XLSX.utils.sheet_to_json 简化读取，但需要手动处理列名映射以防万一
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
                // 处理 Excel 序列日期
                const dateObj = new Date(Math.round((dateStr - 25569)*86400*1000));
                dateStr = dateObj.toISOString().split('T')[0];
            } else {
                dateStr = String(dateStr || '').trim().split(' ')[0]; // 去掉可能的时间部分
            }

            // 3. 构建数据对象
            const cleanRow = {
                '代码': code,
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

            if (!dataMap[code]) dataMap[code] = [];
            dataMap[code].push(cleanRow);
        });

        // 4. 排序：按日期升序（旧 -> 新），方便图表绘制
        Object.keys(dataMap).forEach(key => {
            dataMap[key].sort((a, b) => a['日期'].localeCompare(b['日期']));
        });

        eeiFlow30DaysData = dataMap;
        console.log(`30天数据加载完成，覆盖 ${Object.keys(dataMap).length} 只股票`);

    } catch (err) {
        console.error("加载 EEIFlow30Days.xlsx 失败:", err);
    }
}

// [修复版] openDetailChart
function openDetailChart(item, color) {
    const rawCode = item.code;
    // 关键修复：强制将代码转为6位字符串（例如 89 -> "000089"），以匹配 Excel 中的 Key
    // const code = String(rawCode).padStart(6, '0');
    const code = item.code;

    console.log(`正在打开图表: 原始代码=${rawCode}, 查找代码=${code}`);

    // 1. 初始化状态
    if (!modalState[code]) {
        modalState[code] = {
            metric: '1min',
            view: 'chart', 
            playing: true, 
            progress: 0 
        };
    }
    const state = modalState[code];

    // 2. 基础 DOM 设置
    const modal = document.getElementById('chartModal');
    const modalContent = document.querySelector('.modal-content');
    modalContent.style.borderColor = color;
    modal.style.display = 'flex';

    // 标题栏设置
    const titleEl = document.getElementById('modalTitle');
    titleEl.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px;">
            <span style="font-size:1.1em; font-weight:bold;">${item.name}</span>
            <span style="font-size:0.9em; color:#aaa;">(${code})</span>
            <select id="metricSelect" style="background:#333; color:#fff; border:1px solid #555; padding:4px 8px; border-radius:4px; font-size:13px; cursor:pointer;">
                <option value="1min" ${state.metric === '1min' ? 'selected' : ''}>1分钟价格</option>
                <option value="30d_price" ${state.metric === '30d_price' ? 'selected' : ''}>30天价格</option>
                <option value="30d_pot" ${state.metric === '30d_pot' ? 'selected' : ''}>30天PotScore</option>
                <option value="30d_super" ${state.metric === '30d_super' ? 'selected' : ''}>30天超大单占比</option>
                <option value="30d_main" ${state.metric === '30d_main' ? 'selected' : ''}>30天主力占比</option>
            </select>
        </div>
    `;

    // 绑定下拉事件
    document.getElementById('metricSelect').onchange = function(e) {
        state.metric = e.target.value;
        state.progress = 0;
        state.playing = true;
        state.view = 'chart';
        openDetailChart(item, color); // 重新调用自身以刷新
    };

    // 确保控制栏存在
    let controlsContainer = document.getElementById('chartControls');
    if (!controlsContainer) {
        controlsContainer = document.createElement('div');
        controlsContainer.id = 'chartControls';
        controlsContainer.style.cssText = "display:flex; justify-content:center; gap:15px; margin-top:15px; padding-top:10px; border-top:1px solid #333;";
        modalContent.appendChild(controlsContainer); 
    }

    // 3. 数据获取逻辑（增加日志）
    function getData() {
        let labels = [];
        let values = [];
        let refValue = 0;
        let yLabel = '';
        let lineColor = color;

        if (state.metric === '1min') {
            // --- 1分钟逻辑 ---
            if (item.history && item.history.length > 0) {
                values = item.history;
                labels = values.map((_, i) => i);
                refValue = item.refPrice;
                // 尝试用涨跌幅反推昨日收盘价
                if (item.officialChangePercent != null && item.currentPrice) {
                    refValue = item.currentPrice / (1 + item.officialChangePercent / 100);
                }
                if (!refValue) refValue = values[0];
                yLabel = '价格';
            }
        } else {
            // --- 30天逻辑 ---
            if (!eeiFlow30DaysData) {
                console.warn("30天数据对象 eeiFlow30DaysData 为空，请检查 loadEEIFlow30DaysData 是否执行");
            } else if (!eeiFlow30DaysData[code]) {
                console.warn(`未找到代码 [${code}] 的30天数据。现有Key示例:`, Object.keys(eeiFlow30DaysData).slice(0,3));
            }

            // 获取数据
            const d30 = eeiFlow30DaysData ? (eeiFlow30DaysData[code] || []) : [];
            
            if (d30.length > 0) {
                // 取最近 30 条
                const recent30 = d30.slice(-30); 
                labels = recent30.map(r => r['日期']);
                
                // 根据你提供的 JSON 字段名进行映射
                switch (state.metric) {
                    case '30d_price':
                        values = recent30.map(r => Number(r['收盘价']));
                        refValue = values[0] || 0;
                        yLabel = '收盘价';
                        lineColor = (values[values.length-1] >= refValue) ? '#EF4444' : '#10B981';
                        break;
                    case '30d_pot':
                        values = recent30.map(r => Number(r['PotScore']));
                        refValue = 0; 
                        yLabel = 'PotScore';
                        lineColor = '#FFD700';
                        break;
                    case '30d_super':
                        values = recent30.map(r => Number(r['超大单净流入-净占比']));
                        refValue = 0;
                        yLabel = '超大单占比(%)';
                        lineColor = '#FF6B6B';
                        break;
                    case '30d_main':
                        values = recent30.map(r => Number(r['主力净流入-净占比']));
                        refValue = 0;
                        yLabel = '主力占比(%)';
                        lineColor = '#4ECDC4';
                        break;
                }
            } else {
                console.log(`代码 [${code}] 的 d30 数组长度为 0`);
            }
        }
        return { labels, values, refValue, yLabel, lineColor };
    }

    // 4. 渲染核心
    function renderContent() {
        const dataObj = getData();
        
        // 清理旧状态
        if (currentChartInstance) {
            currentChartInstance.destroy();
            currentChartInstance = null;
        }
        if (currentPlaybackTimer) {
            clearInterval(currentPlaybackTimer);
            currentPlaybackTimer = null;
        }

        // --- 按钮状态更新 ---
        controlsContainer.innerHTML = '';
        
        // 播放按钮 (仅Chart模式)
        if (state.view === 'chart') {
            const playBtn = document.createElement('button');
            playBtn.style.cssText = "padding:6px 16px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px;";
            
            // 播放完显示重播
            const isFinished = state.progress >= dataObj.values.length && dataObj.values.length > 0;
            
            if (isFinished) {
                 playBtn.innerHTML = "↺ 重播";
                 playBtn.style.background = "#2d5a2d"; // 绿色提示可重播
            } else {
                 playBtn.innerHTML = state.playing ? "❚❚ 暂停" : "▶ 播放";
            }

            playBtn.onclick = () => {
                if (isFinished) {
                    state.progress = 0; // 重置
                    state.playing = true;
                } else {
                    state.playing = !state.playing;
                }
                renderContent();
            };
            controlsContainer.appendChild(playBtn);
        }

        // 表格/图表切换按钮
        const viewBtn = document.createElement('button');
        viewBtn.style.cssText = "padding:6px 16px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px;";
        viewBtn.innerText = state.view === 'chart' ? "📅 切换表格" : "📈 切换图表";
        viewBtn.onclick = () => {
            state.view = state.view === 'chart' ? 'table' : 'chart';
            state.playing = false; // 切换时暂停
            renderContent();
        };
        controlsContainer.appendChild(viewBtn);

        // --- 内容显示区域 ---
        const canvas = document.getElementById('detailChartCanvas');
        const container = canvas.parentNode;
        let tableDiv = document.getElementById('detailTableContainer');
        
        if (!tableDiv) {
            tableDiv = document.createElement('div');
            tableDiv.id = 'detailTableContainer';
            tableDiv.style.cssText = "width:100%; height:320px; overflow-y:auto; display:none; background:#181818; color:#ddd; border:1px solid #333; margin-top:10px;";
            container.appendChild(tableDiv);
        }

        // 没数据时的提示
        if (dataObj.values.length === 0) {
            canvas.style.display = 'none';
            tableDiv.style.display = 'block';
            tableDiv.innerHTML = `<div style="padding:20px; text-align:center; color:#666;">
                暂无 [${state.metric}] 数据<br>
                <small>请确认Excel是否包含代码 ${code}</small>
            </div>`;
            document.getElementById('modalPct').innerText = '--';
            return;
        }

        if (state.view === 'table') {
            // 表格渲染
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
            // 倒序遍历
            for (let i = dataObj.values.length - 1; i >= 0; i--) {
                const val = dataObj.values[i];
                const colorStyle = (state.metric.includes('net') || state.metric.includes('super')) 
                    ? (val >= 0 ? '#ff4444' : '#00cc00') 
                    : '#ddd';
                    
                html += `<tr style="border-bottom:1px solid #333;">
                            <td style="padding:6px 8px; color:#aaa;">${dataObj.labels[i]}</td>
                            <td style="padding:6px 8px; text-align:right; color:${colorStyle}; font-family:monospace;">${Number(val).toFixed(2)}</td>
                         </tr>`;
            }
            html += `</tbody></table>`;
            tableDiv.innerHTML = html;
            
            // 更新顶部大字
            updateHeaderInfo(dataObj.values[dataObj.values.length-1], dataObj.refValue);

        } else {
            // 图表渲染
            tableDiv.style.display = 'none';
            canvas.style.display = 'block';

            const ctx = canvas.getContext('2d');
            const gradient = ctx.createLinearGradient(0, 0, 0, 400);
            gradient.addColorStop(0, dataObj.lineColor + '40'); // 25% opacity
            gradient.addColorStop(1, dataObj.lineColor + '00'); // 0% opacity

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
                    layout: { padding: { top: 20, bottom: 10, left: 0, right: 10 } },
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function(ctx) { return ` ${ctx.parsed.y.toFixed(2)}`; }
                            }
                        }
                    },
                    scales: {
                        x: { display: false }, // 隐藏横坐标文字
                        y: {
                            position: 'left',
                            grid: { color: '#333' },
                            ticks: { color: '#888', font: {size:10} },
                            grace: '10%' // 留白
                        }
                    }
                }
            });

            runAnimation(dataObj);
        }
    }

    // 5. 动画循环
    function runAnimation(dataObj) {
        // 如果未处于播放状态，直接显示到当前进度
        if (!state.playing) {
            updateChartData(dataObj.values.slice(0, state.progress));
            const curVal = dataObj.values[state.progress - 1];
            updateHeaderInfo(curVal, dataObj.refValue);
            return;
        }

        const total = dataObj.values.length;
        // 速度逻辑：数据少(30天)则慢，数据多(1分钟)则快
        const speed = total < 100 ? 100 : 20; 

        currentPlaybackTimer = setInterval(() => {
            if (!state.playing) {
                clearInterval(currentPlaybackTimer);
                renderContent(); // 刷新按钮状态
                return;
            }

            state.progress++;
            
            const currentSlice = dataObj.values.slice(0, state.progress);
            updateChartData(currentSlice);
            
            const lastVal = currentSlice[currentSlice.length - 1];
            updateHeaderInfo(lastVal, dataObj.refValue);

            // 播放结束
            if (state.progress >= total) {
                state.playing = false;
                clearInterval(currentPlaybackTimer);
                renderContent(); // 触发重播按钮显示
            }
        }, speed);
    }

    function updateChartData(data) {
        if (currentChartInstance) {
            currentChartInstance.data.datasets[0].data = data;
            currentChartInstance.update('none');
        }
    }

    function updateHeaderInfo(val, ref) {
        const pctEl = document.getElementById('modalPct');
        if (val == null) {
            pctEl.innerText = '--';
            return;
        }

        // 只有价格相关才显示涨跌幅百分比
        const isPrice = state.metric === '1min' || state.metric === '30d_price';
        
        if (isPrice && ref) {
            const chg = ((val - ref) / ref * 100).toFixed(2);
            pctEl.innerText = `${val.toFixed(2)} (${chg > 0 ? '+' : ''}${chg}%)`;
            pctEl.style.color = val >= ref ? '#EF4444' : '#10B981';
        } else {
            // 资金流或PotScore直接显示数值
            pctEl.innerText = val.toFixed(2);
            // >0 红色, <0 绿色
            pctEl.style.color = val >= 0 ? '#EF4444' : '#10B981';
        }
    }

    // 启动
    renderContent();
}

