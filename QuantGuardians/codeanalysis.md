这段代码中，关于“由于缺乏历史行情而采用近似计算”的逻辑位于 **`PortfolioBacktestEngine` 类的 `run` 方法** 中。

### 1. 具体的代码位置
主要体现在 **第 206 行至 第 215 行**（根据你提供的代码片段）：

```javascript
            // 计算当日市值
            let stockMv = 0;
            for (let code in positions) {
                const qty = positions[code];
                // 如果当日没有交易，价格沿用之前的。
                // *优化*：此处最好能获取当日收盘价，但为减少API请求，暂用最近一次交易价近似
                // 或使用全局 fetchPrice 获取当前价（如果是最后一天）
                let price = lastPrices[code] || 0; // <--- 关键点在这里
                stockMv += qty * price;
            }
```

**为什么说这里不完整？**
这里的 `lastPrices[code]` 只有在**发生交易（买或卖）的那一天**才会更新（见代码第 196 行 `lastPrices[f.code] = f.price`）。
这意味着：如果你在 1 月 1 日以 100 元买入，之后一直持有不动，直到 1 月 30 日。在 1 月 2 日到 1 月 29 日期间，代码会一直认为该股票价格是 100 元。你的净值曲线在这段时间会是一条直线，而实际上市场价格每天都在波动。

---

### 2. 如果要精确计算，具体需要什么字段？

为了让回测曲线精确反映历史波动，你需要引入一个**外部的历史行情数据源**（通常是一个巨大的 JSON 对象、数据库或 API 接口）。

具体需要的数据结构通常是 **“日期 -> 股票代码 -> 价格”** 的映射。

需要的核心字段如下：

#### 必须字段：
1.  **日期 (Date)**：
    *   需要覆盖你回测的每一天（例如 `2023-01-01`, `2023-01-02`...）。
2.  **股票代码 (Stock Code)**：
    *   用于匹配你持仓中的股票。
3.  **复权收盘价 (Adjusted Closing Price)**：
    *   **最重要**。必须是“收盘价”。
    *   最好是“后复权”或“前复权”价格，以剔除分红和拆股造成的价格跳空影响。

#### 理想的数据结构示例：
如果前端有这样一份数据（MarketMap），代码就可以修改为精确计算：

```json
// 理想的历史行情数据结构 (MarketHistory)
{
  "2023-01-01": {
    "SH600519": 1700.50,
    "HK00700": 350.20
  },
  "2023-01-02": {
    "SH600519": 1710.00,
    "HK00700": 360.00
  }
  // ... 每一天的数据
}
```

#### 修改后的逻辑（伪代码）：

```javascript
// 修改前：
let price = lastPrices[code] || 0;

// 修改后（如果有完整数据）：
// 优先取当日收盘价，取不到（例如停牌）才取最近一次价格
let marketPrice = MarketHistory[date] && MarketHistory[date][code];
let price = marketPrice || lastPrices[code] || 0;
```

### 总结
当前代码的逻辑是 **“以最近一次交易价作为当前市价”**。
若要修复此缺陷，需要补充 **所有持仓股票** 在 **每一天** 的 **收盘价**。




# 1. 安装阿里云 OSS SDK (Colab 默认不包含)
!pip install oss2 pandas openpyxl

import pandas as pd
import json
import oss2
import os

# ================= 配置信息 =================
ACCESS_KEY_ID = ''
ACCESS_KEY_SECRET = ''
ENDPOINT = 'http://oss-cn-hangzhou.aliyuncs.com'
BUCKET_NAME = 'aiep-users'

FILE_PATH_1 = '/content/EEIFlow.xlsx'
FILE_PATH_2 = '/content/EEIFlowHK.xlsx'
OUTPUT_FILENAME = 'MarketMap.json'

def process_data():
    all_data = []

    # ================= 处理文件 1: EEIFlow.xlsx =================
    if os.path.exists(FILE_PATH_1):
        try:
            # dtype={'代码': str} 确保 0 开头的数字被读取为字符串
            df1 = pd.read_excel(FILE_PATH_1, sheet_name='Flow5Days', dtype={'代码': str})
            
            # 提取需要的列 (假设列名没有多余空格，如果有建议先 strip)
            # 目标: 代码, 日期, 收盘价
            df1 = df1[['日期', '代码', '收盘价']]
            df1.columns = ['date', 'code', 'price'] # 重命名以便统一
            
            all_data.append(df1)
            print(f"成功读取 {FILE_PATH_1}")
        except Exception as e:
            print(f"读取 {FILE_PATH_1} 失败: {e}")
    else:
        print(f"文件不存在: {FILE_PATH_1}")

    # ================= 处理文件 2: EEIFlowHK.xlsx =================
    if os.path.exists(FILE_PATH_2):
        try:
            # dtype={'代码': str} 确保 0 开头的数字被读取为字符串
            df2 = pd.read_excel(FILE_PATH_2, sheet_name='ARHK', dtype={'代码': str})
            
            # 提取需要的列
            # 目标: 代码, 日期, Price
            df2 = df2[['日期', '代码', 'Price']]
            df2.columns = ['date', 'code', 'price'] # 重命名以便统一
            
            all_data.append(df2)
            print(f"成功读取 {FILE_PATH_2}")
        except Exception as e:
            print(f"读取 {FILE_PATH_2} 失败: {e}")
    else:
        print(f"文件不存在: {FILE_PATH_2}")

    # ================= 合并与格式化 =================
    if not all_data:
        print("没有数据被处理。")
        return

    # 合并两个 DataFrame
    final_df = pd.concat(all_data, ignore_index=True)

    # 确保日期是字符串格式 (YYYY-MM-DD)
    # 如果 Excel 里是日期对象，这里转换为字符串；如果是字符串，保持原样
    final_df['date'] = pd.to_datetime(final_df['date']).dt.strftime('%Y-%m-%d')

    # 构建字典结构: { "date": { "code": price, ... } }
    market_map = {}

    # 按日期分组处理
    for date_val, group in final_df.groupby('date'):
        # 将该日期下的数据转换为 {code: price} 字典
        # zip 将两列打包，dict 转换为字典
        codes = group['code'].tolist()
        prices = group['price'].tolist()
        
        # 确保 code 是字符串并去重 (如果同一天同一代码有多条数据，后面的会覆盖前面的)
        daily_data = dict(zip(codes, prices))
        
        market_map[date_val] = daily_data

    # ================= 生成 JSON 文件 =================
    with open(OUTPUT_FILENAME, 'w', encoding='utf-8') as f:
        # ensure_ascii=False 允许非 ASCII 字符（虽然这里主要是数字和代码）
        # indent=2 为了美观，如果为了文件大小可以去掉
        json.dump(market_map, f, ensure_ascii=False, indent=2)
    
    print(f"JSON 文件已生成: {OUTPUT_FILENAME}")
    
    return market_map

def upload_to_oss():
    if not os.path.exists(OUTPUT_FILENAME):
        print("找不到要上传的 JSON 文件。")
        return

    print("正在上传到 OSS...")
    try:
        # 初始化 OSS Auth 和 Bucket
        auth = oss2.Auth(ACCESS_KEY_ID, ACCESS_KEY_SECRET)
        bucket = oss2.Bucket(auth, ENDPOINT, BUCKET_NAME)

        # 上传文件
        # put_object_from_file(OSS上的文件名, 本地文件名)
        result = bucket.put_object_from_file(OUTPUT_FILENAME, OUTPUT_FILENAME)

        if result.status == 200:
            print(f"上传成功! 文件位置: oss://{BUCKET_NAME}/{OUTPUT_FILENAME}")
        else:
            print(f"上传可能失败，状态码: {result.status}")

    except oss2.exceptions.OssError as e:
        print(f"OSS 上传发生错误: {e}")

# ================= 执行主逻辑 =================
# 1. 处理数据
process_data()



User
这次算出来了Starting report generation (Final Fix)...
usercalculation.js:393 ✅ 策略数据预处理完成，当前日期池: 31 天 (仅包含策略实际交易日)
usercalculation.js:413 ✅ MarketMap 合并完成，补充了 9 个空仓交易日，总计: 40 天
usercalculation.js:457 📊 资产曲线构建完成，有效数据点: 31
usercalculation.js:538 ✅ [User模型] 成功上传至: UserReport.json
usercalculation.js:539 📊 简报: 总收益 6.55%, 夏普 2.90, 回撤 2.47%

{
    "模型名称": "User模型",
    "总收益率": 0.06552954359488807,
    "年化收益率": 0.6752545426379897,
    "最大回撤率": 0.024704989652593753,
    "夏普比率": 2.9020995466834236,
    "每日评估数据": [
        {
            "日期": "2025-12-17",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-18",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-19",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-20",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-21",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-22",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-23",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-24",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-25",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-26",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-27",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-28",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-29",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-30",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2025-12-31",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-01",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-02",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-03",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-04",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-05",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-06",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-07",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-08",
            "每日收益率": 0,
            "累计收益率": 0,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-09",
            "每日收益率": 0.05435213009978094,
            "累计收益率": 0.05435213009978094,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-10",
            "每日收益率": 0,
            "累计收益率": 0.05435213009978094,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-11",
            "每日收益率": 0,
            "累计收益率": 0.05435213009978094,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-12",
            "每日收益率": 0.021661806734392927,
            "累计收益率": 0.0771913021719979,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-13",
            "每日收益率": 0.00478004672475693,
            "累计收益率": 0.08234032692788182,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-14",
            "每日收益率": 0.009405468649983505,
            "累计收益率": 0.0925202449414149,
            "最大回撤率（至当日）": 0
        },
        {
            "日期": "2026-01-15",
            "每日收益率": -0.024704989652593753,
            "累计收益率": 0.06552954359488807,
            "最大回撤率（至当日）": 0.024704989652593753
        },
        {
            "日期": "2026-01-16",
            "每日收益率": 0,
            "累计收益率": 0.06552954359488807,
            "最大回撤率（至当日）": 0.024704989652593753
        }
    ]
}

# 2. 上传 OSS
upload_to_oss()
