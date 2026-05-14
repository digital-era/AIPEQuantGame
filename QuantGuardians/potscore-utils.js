/**
 * 将 30 日 EEI 数据的最后一日的 PotScore 绑定到所有标的对象上
 * @param {Object} potScoreMap - 格式: { "600519": 0.85, "000001": -0.12, ... }
 */
function attachPotScores() {
    if (!eeiFlow30DaysData) return;
    
    Object.keys(gameState.guardians).forEach(key => {
        const g = gameState.guardians[key];
        [g.strategy, g.portfolio, g.adhocObservations].forEach(list => {
            if (!Array.isArray(list)) return;
            list.forEach(item => attachSinglePotScore(item));
        });
    });
}

/**
 * 为单个 item 更新 PotScore 和资金条件
 * @param {Object} item - 标的对象
 */
function attachSinglePotScore(item) {
    if (!eeiFlow30DaysData || !item || !item.code) return;
    
    // 重置默认值
    item.lastPotScore = 0;
    item.isSuperFlowPositive = false;
    item.isBigFlowPositive = false;
    
    const code = String(item.code).trim();
    const history = eeiFlow30DaysData[code];
    
    if (Array.isArray(history) && history.length >= 3) {
        const last3Days = history.slice(-3);
        
        const superFlowPositive = last3Days.every(day => {
            const val = Number(day['超大单净流入-净占比']);
            return !isNaN(val) && val > 0;
        });
        
        const bigFlowPositive = last3Days.every(day => {
            const val = Number(day['大单净流入-净占比']);
            return !isNaN(val) && val > 0;
        });
        
        if (superFlowPositive && bigFlowPositive) {
            const lastDay = history[history.length - 1];
            const potScore = Number(lastDay["PotScore"]);
            item.lastPotScore = !isNaN(potScore) ? potScore : 0;
            item.isSuperFlowPositive = true;
            item.isBigFlowPositive = true;
        }
    }
}
