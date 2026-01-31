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

function openDetailChart(item, color) {
    const code = item.code;
    
    // 1. 初始化或获取该股票的状态
    if (!modalState[code]) {
        modalState[code] = {
            metric: '1min', // 默认指标
            view: 'chart',  // chart 或 table
            playing: true,  // 是否自动播放
            progress: 0     // 记录播放进度
        };
    }
    const state = modalState[code];

    // 2. 准备基础 DOM
    const modal = document.getElementById('chartModal');
    const modalContent = document.querySelector('.modal-content');
    modalContent.style.borderColor = color;
    modal.style.display = 'flex';

    // 2.1 设置标题区域（包含下拉框）
    const titleEl = document.getElementById('modalTitle');
    // 使用 innerHTML 构造下拉框，注意 onchange 事件绑定
    titleEl.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px;">
            <span>${item.name}</span>
            <span style="font-size:0.8em; color:#888;">(${code})</span>
            <select id="metricSelect" style="background:#333; color:#fff; border:1px solid #555; padding:2px 5px; border-radius:4px; font-size:12px;">
                <option value="1min" ${state.metric === '1min' ? 'selected' : ''}>1分钟价格</option>
                <option value="30d_price" ${state.metric === '30d_price' ? 'selected' : ''}>30天价格</option>
                <option value="30d_pot" ${state.metric === '30d_pot' ? 'selected' : ''}>30天PotScore</option>
                <option value="30d_super" ${state.metric === '30d_super' ? 'selected' : ''}>30天超大单占比</option>
                <option value="30d_main" ${state.metric === '30d_main' ? 'selected' : ''}>30天主力占比</option>
            </select>
        </div>
    `;

    // 2.2 绑定下拉框事件
    document.getElementById('metricSelect').onchange = function(e) {
        state.metric = e.target.value;
        state.progress = 0;      // 切换指标重置进度
        state.playing = true;    // 切换指标自动播放
        state.view = 'chart';    // 切换指标默认回图表
        renderContent();         // 重新渲染
    };

    // 2.3 创建控制栏（播放按钮、表格切换）
    // 检查是否已存在控制容器，不存在则创建
    let controlsContainer = document.getElementById('chartControls');
    if (!controlsContainer) {
        controlsContainer = document.createElement('div');
        controlsContainer.id = 'chartControls';
        // 样式：放在模态框底部或顶部，这里放在 Canvas 下方
        controlsContainer.style.cssText = "display:flex; justify-content:center; gap:15px; margin-top:10px; padding:5px;";
        // 插入到 modal-content 内部的最后
        modalContent.appendChild(controlsContainer); 
    }

    // 3. 数据准备逻辑
    function getData() {
        let labels = [];
        let values = [];
        let refValue = 0;
        let yLabel = '';
        let lineColor = color;

        if (state.metric === '1min') {
            // 原有 1分钟逻辑
            if (item.history && item.history.length > 0) {
                values = item.history;
                labels = values.map((_, i) => i); // 简单索引，或转换成时间
                
                // 计算参考价 (RefPrice)
                refValue = item.refPrice;
                if (item.officialChangePercent !== null && item.officialChangePercent !== undefined && item.currentPrice) {
                    refValue = item.currentPrice / (1 + item.officialChangePercent / 100);
                }
                if (!refValue) refValue = values[0];
                
                yLabel = '价格';
                lineColor = color;
            }
        } else {
            // 30天数据逻辑
            const d30 = eeiFlow30DaysData ? (eeiFlow30DaysData[code] || []) : [];
            // 取最近30条
            const recent30 = d30.slice(-30); 
            
            labels = recent30.map(r => r['日期']);
            
            switch (state.metric) {
                case '30d_price':
                    values = recent30.map(r => r['收盘价']);
                    refValue = values[0] || 0;
                    yLabel = '收盘价';
                    // 涨红跌绿 (相对于30天前)
                    lineColor = (values[values.length-1] >= refValue) ? '#EF4444' : '#10B981';
                    break;
                case '30d_pot':
                    values = recent30.map(r => r['PotScore']);
                    refValue = 0; 
                    yLabel = 'PotScore';
                    lineColor = '#FFD700'; // 金色
                    break;
                case '30d_super':
                    values = recent30.map(r => r['超大单净流入-净占比']);
                    refValue = 0;
                    yLabel = '超大单占比(%)';
                    lineColor = '#FF6B6B';
                    break;
                case '30d_main':
                    values = recent30.map(r => r['主力净流入-净占比']);
                    refValue = 0;
                    yLabel = '主力占比(%)';
                    lineColor = '#4ECDC4';
                    break;
            }
        }
        return { labels, values, refValue, yLabel, lineColor };
    }

    // 4. 核心渲染函数 (负责图表/表格/按钮更新)
    function renderContent() {
        const dataObj = getData();
        const canvasContainer = document.getElementById('detailChartCanvas').parentNode;
        
        // 清理旧资源
        if (currentChartInstance) {
            currentChartInstance.destroy();
            currentChartInstance = null;
        }
        if (currentPlaybackTimer) {
            clearInterval(currentPlaybackTimer);
            currentPlaybackTimer = null;
        }

        // --- 渲染控制按钮 ---
        // 动态生成按钮，以便状态更新时文字变化
        controlsContainer.innerHTML = '';
        
        // 按钮1: 播放/暂停/重播 (仅在图表模式下显示)
        if (state.view === 'chart') {
            const playBtn = document.createElement('button');
            playBtn.className = 'ctrl-btn'; // 建议加点 CSS class 样式
            playBtn.style.cssText = "padding:5px 15px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer;";
            
            // 逻辑：如果已经播完，显示“重播”；如果正在播，显示“暂停”；如果暂停中，显示“播放”
            if (state.progress >= dataObj.values.length && dataObj.values.length > 0) {
                 playBtn.innerText = "↺ 重播";
            } else {
                 playBtn.innerText = state.playing ? "❚❚ 暂停" : "▶ 播放";
            }

            playBtn.onclick = () => {
                if (state.progress >= dataObj.values.length) {
                    // 重播逻辑
                    state.progress = 0;
                    state.playing = true;
                } else {
                    // 切换播放/暂停
                    state.playing = !state.playing;
                }
                renderContent(); // 刷新按钮状态和图表动画
            };
            controlsContainer.appendChild(playBtn);
        }

        // 按钮2: 切换图表/表格
        const viewBtn = document.createElement('button');
        viewBtn.style.cssText = "padding:5px 15px; background:#444; color:white; border:none; border-radius:4px; cursor:pointer;";
        viewBtn.innerText = state.view === 'chart' ? "📅 查看表格" : "📈 查看曲线";
        viewBtn.onclick = () => {
            state.view = state.view === 'chart' ? 'table' : 'chart';
            state.playing = false; // 切换视图时暂停
            renderContent();
        };
        controlsContainer.appendChild(viewBtn);


        // --- 视图渲染 ---
        const canvas = document.getElementById('detailChartCanvas');
        const tableContainerId = 'detailTableContainer';
        let tableDiv = document.getElementById(tableContainerId);
        
        // 确保表格容器存在
        if (!tableDiv) {
            tableDiv = document.createElement('div');
            tableDiv.id = tableContainerId;
            tableDiv.style.cssText = "width:100%; height:300px; overflow-y:auto; display:none; background:#111; color:#ddd;";
            canvasContainer.appendChild(tableDiv);
        }

        if (state.view === 'table') {
            // 表格模式
            canvas.style.display = 'none';
            tableDiv.style.display = 'block';
            
            // 生成表格 HTML
            let html = `<table style="width:100%; border-collapse:collapse; text-align:center;">
                        <thead style="background:#222; position:sticky; top:0;">
                            <tr><th style="padding:8px;">日期/时间</th><th style="padding:8px;">${dataObj.yLabel}</th></tr>
                        </thead>
                        <tbody>`;
            // 倒序显示（最新的在上面）
            for (let i = dataObj.values.length - 1; i >= 0; i--) {
                html += `<tr style="border-bottom:1px solid #333;">
                            <td style="padding:6px;">${dataObj.labels[i]}</td>
                            <td style="padding:6px;">${Number(dataObj.values[i]).toFixed(2)}</td>
                         </tr>`;
            }
            html += `</tbody></table>`;
            tableDiv.innerHTML = html;
            
            // 更新顶部百分比显示（显示最新值）
            updateHeaderInfo(dataObj.values[dataObj.values.length - 1], dataObj.refValue);

        } else {
            // 图表模式
            tableDiv.style.display = 'none';
            canvas.style.display = 'block';

            // 处理无数据情况
            if (dataObj.values.length === 0) {
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.font = "14px Arial";
                ctx.fillStyle = "#888";
                ctx.fillText("暂无数据", canvas.width / 2 - 30, canvas.height / 2);
                return;
            }

            const ctx = canvas.getContext('2d');
            
            // 背景渐变
            const gradient = ctx.createLinearGradient(0, 0, 0, 400);
            gradient.addColorStop(0, dataObj.lineColor + '55'); // 透明度
            gradient.addColorStop(1, dataObj.lineColor + '00');

            // 修复1：初始化 Chart
            currentChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: dataObj.labels,
                    datasets: [{
                        label: dataObj.yLabel,
                        data: [], // 初始为空，动画填充
                        borderColor: dataObj.lineColor,
                        backgroundColor: gradient,
                        borderWidth: 2,
                        pointRadius: 0, // 不显示圆点，防止遮挡
                        pointHoverRadius: 4,
                        fill: true,
                        tension: 0.2 // 稍微平滑一点
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false, // 关闭自带动画，使用手动播放
                    layout: {
                        padding: {
                            top: 20,
                            bottom: 10,
                            left: 10,
                            right: 10
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            mode: 'index',
                            intersect: false,
                            callbacks: {
                                label: function(context) {
                                    return ` ${context.parsed.y.toFixed(2)}`;
                                }
                            }
                        }
                    },
                    scales: {
                        x: { 
                            display: false, // 隐藏 X 轴标签以节省空间
                            grid: { display: false }
                        },
                        y: {
                            display: true,
                            position: 'left',
                            grid: { color: '#333' },
                            ticks: { color: '#888', font: { size: 10 } },
                            // 修复2：增加 grace 防止曲线顶天立地
                            grace: '5%' 
                        }
                    }
                }
            });

            // 启动动画循环
            runAnimation(dataObj);
        }
    }

    // 5. 动画控制逻辑
    function runAnimation(dataObj) {
        if (!state.playing) {
            // 如果暂停，直接渲染到当前进度
            updateChartData(dataObj.values.slice(0, state.progress));
            // 更新头部数字
            const currentVal = dataObj.values[state.progress - 1];
            updateHeaderInfo(currentVal, dataObj.refValue);
            return;
        }

        const totalPoints = dataObj.values.length;
        // 修复3：根据数据量调整速度
        // 1分钟数据(240点) -> 快(20ms)
        // 30天数据(30点) -> 慢(150ms)
        const speed = totalPoints > 100 ? 20 : 150;

        currentPlaybackTimer = setInterval(() => {
            if (!state.playing) {
                clearInterval(currentPlaybackTimer);
                return;
            }

            state.progress++;

            // 渲染切片数据
            const currentData = dataObj.values.slice(0, state.progress);
            updateChartData(currentData);
            
            // 更新头部数字
            const lastVal = currentData[currentData.length - 1];
            updateHeaderInfo(lastVal, dataObj.refValue);

            // 播放结束
            if (state.progress >= totalPoints) {
                state.playing = false; // 自动停止
                clearInterval(currentPlaybackTimer);
                // 重新渲染以更新按钮文字为“重播”
                renderContent(); 
            }

        }, speed);
    }

    function updateChartData(newData) {
        if (currentChartInstance) {
            currentChartInstance.data.datasets[0].data = newData;
            currentChartInstance.update('none'); // 'none' 模式最高效
        }
    }

    function updateHeaderInfo(val, ref) {
        const pctEl = document.getElementById('modalPct');
        const codeEl = document.getElementById('modalCode'); // 也可以用这个显示额外信息

        if (val === undefined || val === null) {
            pctEl.innerText = '--';
            return;
        }

        // 如果是价格类指标，计算涨跌幅；如果是得分/比例，直接显示数值
        if (state.metric.includes('price') || state.metric === '1min') {
            if (ref && ref !== 0) {
                const chg = ((val - ref) / ref * 100).toFixed(2);
                pctEl.innerText = `${val.toFixed(2)} (${chg > 0 ? '+' : ''}${chg}%)`;
                pctEl.style.color = val >= ref ? '#EF4444' : '#10B981';
            } else {
                pctEl.innerText = val.toFixed(2);
                pctEl.style.color = '#ddd';
            }
        } else {
            // 其他指标直接显示数值
            pctEl.innerText = val.toFixed(2);
            // 颜色逻辑：>0 红, <0 绿 (适用于净流入)
            pctEl.style.color = val >= 0 ? '#EF4444' : '#10B981';
        }
    }

    // --- 初始化入口 ---
    // 首次打开时，如果不处于播放中且进度为0，默认开始播放
    // 每次打开模态框都重新渲染
    renderContent(); 
}
