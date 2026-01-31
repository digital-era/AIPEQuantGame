// ================= 新增：全局变量 =================
let eeiFlow30DaysData = null;  // { code → [ {日期, 收盘价, 涨跌幅, PotScore, 超大单净流入-净占比, ...} ] }
// 在全局增加当前选择的指标（每个股票独立记忆）
const selectedSparkMetrics = {}; // code → '1min_price' | '30d_price' | '30d_pot' | '30d_super' | '30d_main'

// 全局变量：记录每只股票在大图中最后选择的指标（避免每次打开都重置）
const modalSelectedMetric = {}; // code → '1min_price' | '30d_price' | '30d_pot' | '30d_super' | '30d_main'

// 记录播放状态（每个股票独立，避免多窗口干扰）
const modalPlaybackState = {}; // code → { playing: boolean, timer: null|number }

// 记录显示模式（图表或表格）
const modalDisplayMode = {}; // code → 'chart' | 'table'

// ================= 新增：读取 30 天 EEI 资金流数据 =================
async function loadEEIFlow30DaysData() {
    if (eeiFlow30DaysData !== null) return; // 已加载过则跳过

    const filename = 'month/EEIFlow30Days.xlsx';
    const url = getResourceUrl(filename);

    try {
        log("正在加载 30 天资金流向数据 (EEIFlow30Days.xlsx)...", "#88f");

        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const arrayBuffer = await res.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];

        // 读取表头，找到列索引（更健壮）
        const headers = {};
        const range = XLSX.utils.decode_range(sheet['!ref']);
        for (let c = range.s.c; c <= range.e.c; ++c) {
            const cell = sheet[XLSX.utils.encode_cell({ r: 0, c })];
            if (cell && cell.t !== 'z') {
                const val = (cell.w || cell.v || '').trim();
                if (val) headers[val] = c;
            }
        }

        const requiredFields = [
            '代码', 'PotScore', '日期', '收盘价', '涨跌幅',
            '超大单净流入-净占比', '主力净流入-净占比',
            '大单净流入-净占比', '中单净流入-净占比', '小单净流入-净占比', '总净流入占比'
        ];

        // 检查必要字段是否存在
        for (let f of requiredFields) {
            if (!(f in headers)) {
                console.warn(`缺少必要字段：${f}`);
            }
        }

        const dataMap = {};

        for (let r = 1; r <= range.e.r; ++r) {
            const row = {};
            for (let f of requiredFields) {
                const col = headers[f];
                if (col === undefined) continue;
                const cell = sheet[XLSX.utils.encode_cell({ r, c: col })];
                let val = cell ? (cell.w !== undefined ? cell.w : cell.v) : null;

                // 特殊处理
                if (f === '代码') {
                    // 保留前导零，强制转字符串
                    val = val == null ? '' : String(val).padStart(6, '0');
                } else if (['收盘价', '涨跌幅', 'PotScore', '超大单净流入-净占比',
                            '主力净流入-净占比', '大单净流入-净占比',
                            '中单净流入-净占比', '小单净流入-净占比', '总净流入占比'].includes(f)) {
                    // 尝试转数字，失败则保持原样
                    const num = Number(val);
                    val = isNaN(num) ? val : num;
                } else if (f === '日期') {
                    // 强制字符串格式 yyyy-mm-dd
                    if (val instanceof Date) {
                        val = val.toISOString().split('T')[0];
                    } else {
                        val = String(val || '').trim();
                    }
                }

                row[f] = val;
            }

            const code = row['代码'];
            if (!code || code.length !== 6) continue;

            if (!dataMap[code]) dataMap[code] = [];
            dataMap[code].push(row);
        }

        // 按日期排序（新 → 旧）
        Object.values(dataMap).forEach(arr => {
            arr.sort((a, b) => b['日期'].localeCompare(a['日期']));
        });

        eeiFlow30DaysData = dataMap;
        log(`30 天资金流向数据加载完成，覆盖 ${Object.keys(dataMap).length} 只股票`, "#0f0");

    } catch (err) {
        console.error("加载 EEIFlow30Days 失败", err);
        log("加载 30 天资金流向数据失败：" + err.message, "orange");
        eeiFlow30DaysData = {};
    }
}

// Supporting functions (add these below the main function)
function createModalControls() {
    let container = document.getElementById('modalControls');
    if (!container) {
        container = document.createElement('div');
        container.id = 'modalControls';
        container.style.cssText = 'position:absolute; bottom:15px; right:20px; display:flex; gap:12px;';
        document.querySelector('.modal-content').appendChild(container);
    }
    return container;
}

function renderModalChart(ctx, labels, data, base, lineColor, yTitle) {
    detailChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: yTitle,
                data: data,
                borderColor: lineColor,
                backgroundColor: lineColor + '22',
                tension: 0.2,
                pointRadius: 0,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    title: { display: true, text: yTitle },
                    grid: { color: '#222' }
                },
                x: { grid: { display: false } }
            }
        }
    });
}

function renderModalTable(labels, data, title) {
    const container = document.getElementById('detailChartCanvas').parentElement;
    container.innerHTML = ''; // Clear existing canvas

    const table = document.createElement('table');
    table.style.cssText = 'width:100%; height:100%; font-size:13px; color:#ddd; background:#111; border-collapse:collapse;';
    table.innerHTML = `
        <thead style="background:#1e1e1e;">
            <tr><th>日期</th><th>${title}</th></tr>
        </thead>
        <tbody>
            ${labels.map((label, i) => `
                <tr style="border-bottom:1px solid #333;">
                    <td style="padding:6px 10px;">${label}</td>
                    <td style="padding:6px 10px; text-align:right;">${Number(data[i]).toFixed(2)}</td>
                </tr>
            `).join('')}
        </tbody>
    `;
    container.appendChild(table);
}

function animateModalChart(code, labels, data, base, lineColor) {
    const playback = modalPlaybackState[code];
    if (!playback.playing) return;

    const canvas = document.getElementById('detailChartCanvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    let step = 0;
    const min = Math.min(...data, base);
    const max = Math.max(...data, base);
    const range = max - min || 1;

    playback.timer = setInterval(() => {
        step++;
        if (step > data.length + 5) {
            clearInterval(playback.timer);
            playback.timer = null;
            playback.playing = false;
            return;
        }

        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 3;
        ctx.beginPath();

        for (let i = 0; i < Math.min(step, data.length); i++) {
            const x = (i / (data.length - 1)) * w;
            const y = h - ((data[i] - min) / range) * h;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Optional: Draw baseline if applicable
    }, 60);
}
