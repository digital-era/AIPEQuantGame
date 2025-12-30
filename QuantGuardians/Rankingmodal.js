		// --- 功能 1: 设置相关 ---
		function openSettings() {
		    document.getElementById('settingsModal').style.display = 'flex';
		    // 同步 checkbox 状态
		    document.getElementById('chkGitProxy').checked = gitproxy;
		}
		
		function toggleProxy(checkbox) {
		    gitproxy = checkbox.checked;
		    console.log("Github Proxy set to:", gitproxy);
		    // 可选：添加提示
		    log(`System Setting: Proxy ${gitproxy ? 'ENABLED' : 'DISABLED'}`, "#fff");
		}
		
		// --- 功能 2: 排序展示相关 ---
		function openRanking() {
		    // 检查是否有历史数据
		    if (!historyData.dates || historyData.dates.length === 0) {
		        alert("System initializing or no data available yet.");
		        return;
		    }
		
		    const modal = document.getElementById('rankingModal');
		    const listEl = document.getElementById('rankingList');
		    listEl.innerHTML = ''; // 清空旧数据
		    modal.style.display = 'flex';
		
		    // 1. 获取最近一天的数据索引
		    const lastIdx = historyData.dates.length - 1;
		    const dateStr = historyData.dates[lastIdx];
		    
		    // 2. 准备参与排序的实体
		    // 定义颜色和图标
		    const entities = [
		        { key: 'suzaku',  name: 'SUZAKU',   icon: '🔥', color: GUARDIAN_COLORS.suzaku },
		        { key: 'sirius',  name: 'SIRIUS',   icon: '🐺', color: GUARDIAN_COLORS.sirius },
				{ key: 'genbu',   name: 'GENBU',    icon: '🐢', color: GUARDIAN_COLORS.genbu },
		        { key: 'kirin',   name: 'KIRIN',    icon: '🦄', color: GUARDIAN_COLORS.kirin },
		        { key: 'user',    name: 'USER',     icon: '👤', color: '#00FFFF' }, // 用户
		        { key: 'guardians',name:'Guardians',     icon: '🛡️', color: '#FFD700' }  // 护卫队总分
		    ];
		
		    // 提取数值并构建数组
		    let rankingData = entities.map(e => {
		        let val = historyData.datasets[e.key] ? historyData.datasets[e.key][lastIdx] : -999;
		        // 处理可能为null的情况
		        if (val === null || val === undefined) val = -999; 
		        return { ...e, value: val };
		    });
		
		    // 3. 获取标普500基准值 (用来判断冠军奖杯条件2)
		    let sp500Val = -999;
		    if (historyData.datasets['sp500'] && historyData.datasets['sp500'].length > lastIdx) {
		        sp500Val = historyData.datasets['sp500'][lastIdx];
		    }
		    // 护卫队整体战绩
		    const guardiansVal = rankingData.find(e => e.key === 'guardians').value;
		
		    // 4. 排序 (从高到低)
		    rankingData.sort((a, b) => b.value - a.value);
		
		    // 5. 渲染 DOM
		    rankingData.forEach((item, index) => {
		        const div = document.createElement('div');
		        div.className = 'rank-item';
		        div.style.animationDelay = `${index * 0.1}s`; // 阶梯动画
		
		        // 计算奖杯逻辑：
		        // 条件1: 排名第一 (index === 0)
		        // 条件2: 护卫队整体(guardiansVal) > 标普500(sp500Val)
		        let trophyHtml = '';
		        if (index === 0 && guardiansVal > sp500Val) {
		            //trophyHtml = `<div class="rank-trophy">🏆</div>`;
					trophyHtml = `<div class="rank-trophy" style="position: absolute; right: 0; top: 0; bottom: 0; display: flex; align-items: center; z-index: 10; font-size: 1.5em; text-shadow: 0 0 5px gold;">🏆</div>`;
		        }
		
		        // 格式化数值
		        const valStr = item.value === -999 ? 'N/A' : item.value.toFixed(2) + '%';
		        // 计算条形图宽度 (简单归一化，最大值占80%，处理负数)
		        // 为了视觉效果，我们假设最大值为 maxVal，最小值为 minVal
		        // 这里简化处理：绝对值映射，正数为彩色，负数为灰色或反向？
		        // 为了生动，我们简单地让最大值的宽度为 100% (相对于 bar-area)，其他的按比例
		        const maxVal = Math.max(...rankingData.map(d => d.value));
		        const minVal = Math.min(0, ...rankingData.map(d => d.value)); // 包含0作为基准
		        const range = maxVal - minVal + 0.001;
		        
		        // 这里的宽度计算逻辑：以 minVal 为 0% 位置
		        let widthPct = 0;
		        if (item.value > -999) {
		             // 简单的视觉优化：如果是正数，长度基于 maxVal；如果是负数，显示一小段
		             // 这里采用更直观的逻辑：所有 Bar 左对齐，长度代表数值大小（相对最大值）
		             // 如果数值是负的，为了不破坏布局，我们给一个最小宽度，并变色
		             widthPct = Math.max(5, (item.value / (maxVal > 0 ? maxVal : 1)) * 90);
		             if (item.value < 0) widthPct = 5; // 负数给个短条
		        }
		
		        // 颜色：正数用定义的颜色，负数用灰色
		        const barColor = item.value >= 0 ? item.color : '#555';
		
		        div.innerHTML = `
		            <div class="rank-info">
		                <span class="rank-name">${item.name}</span>
		                <span class="rank-icon" style="font-size: 1.5em;">${item.icon}</span>
		            </div>
					         
		            <!-- 【关键修改】给父容器加上 position: relative，作为定位基准 -->
		            <div class="rank-bar-area" style="position: relative; flex: 1; margin-left: 10px; height: 30px; display: flex; align-items: center;">
		                
		                <div class="rank-bar" id="bar-${item.key}" style="background:${barColor}; width: 0%; height: 80%; border-radius: 4px; transition: width 1s ease;">
		                    <!-- 数值绝对定位 -->
		                    <span class="rank-val" style="position: absolute; right: 5px; top: 50%; transform: translateY(-50%); color: #fff; font-size: 0.8em; white-space: nowrap; mix-blend-mode: difference;">
		                        ${valStr}
		                    </span>
		                </div>
		                <!-- 奖杯 -->
		                ${trophyHtml}
		            </div>				
		        `;
		        listEl.appendChild(div);
		
		        // 触发宽度动画 (setTimeout 确保 DOM 渲染后触发 transition)
		        setTimeout(() => {
		            const bar = document.getElementById(`bar-${item.key}`);
		            if(bar) bar.style.width = `${widthPct}%`;
		        }, 100 + (index * 100));
		    });
		    
		    // 在底部显示基准信息
		    const infoDiv = document.createElement('div');
		    infoDiv.style.textAlign = 'center';
		    infoDiv.style.marginTop = '20px';
		    infoDiv.style.color = '#666';
		    infoDiv.style.fontSize = '0.8em';
		    infoDiv.innerHTML = `Benchmark S&P 500: <span style="color:#ccc">${sp500Val.toFixed(2)}%</span><br>Date: ${dateStr}`;
		    listEl.appendChild(infoDiv);
		}
