# ashare-quant：A 股日线回测框架

一个**贴近 A 股真实交易规则**的轻量级事件驱动回测框架，附带可复现的策略、绩效分析和防过拟合的参数样本外检验。

> 本项目仅用于量化研究与学习，不构成投资建议。回测收益不代表未来表现。

## 特性

| 模块 | 说明 |
|---|---|
| 交易规则 | 100 股一手、T+1、停牌不可交易、开盘涨停不可买/跌停不可卖（主板 10%，创业板 2020-08-24 起 20%，科创板 20%，北交所 30%），未成交订单次日自动重试 |
| 交易成本 | 佣金（含最低 5 元）、过户费、印花税（按日期：2023-08-28 前 0.1%，之后 0.05%）、ETF 免印花税；可配置滑点 |
| 无未来函数 | t 日收盘出信号 → t+1 日开盘成交；有单测验证"篡改未来数据不影响历史净值" |
| 数据 | [akshare](https://github.com/akfamily/akshare) 获取股票/ETF 日线（自动识别、本地缓存），或本地 CSV，或合成数据 |
| 策略 | 买入持有（基准）、双均线趋势、ETF 动量轮动（含绝对动量过滤） |
| 绩效 | 年化收益、波动率、夏普、索提诺、最大回撤及持续天数、卡玛比率、手续费、年化换手率 |
| 参数优化 | 网格搜索，按样本内指标选参，同时输出样本外表现，识别过拟合 |
| 报告 | 净值/回撤图（PNG）、指标对比（Markdown）、净值与成交明细（CSV） |

## 快速开始

```bash
pip install -r requirements.txt

# ETF 动量轮动：沪深300、中证500、创业板、黄金、国债
python -m ashare_quant backtest --strategy momentum \
    --symbols 510300,510500,159915,518880,511260 \
    --start 2015-01-01 --end 2024-12-31 \
    --param lookback=60 --param top_n=2 --param rebalance=20

# 个股双均线
python -m ashare_quant backtest --strategy dual_ma --symbols 600519 --param fast=20 --param slow=60

# 参数网格搜索：2021 年前为样本内，之后为样本外
python -m ashare_quant optimize --strategy dual_ma --symbols 600519 \
    --grid fast=5,10,20 --grid slow=30,60,120 --split 2021-01-01

# 无网络时用合成数据体验
python -m ashare_quant backtest --strategy momentum --symbols 510300,510500,159915 --source synthetic
```

报告输出在 `output/`：`summary.md`、`report.png`、`equity.csv`、`trades.csv`。

常用参数：`--cash` 初始资金、`--commission` 佣金率、`--min-commission` 最低佣金、`--slippage` 滑点、`--band` 调仓容差、`--adjust qfq|hfq|""` 复权方式、`--source akshare|csv|synthetic`、`--data-dir` 缓存/CSV 目录（CSV 命名为 `<代码>.csv`，需含 `date,open,high,low,close,volume` 列）。

## 网页版（手机可用）

`docs/` 是纯前端的网页版：同样的交易规则和策略，用 JavaScript 实现，在浏览器里本地计算，不需要服务器。`tests/test_web_parity.py` 会在同一份数据上比对网页版与 Python 版的逐日净值和成交，保证两边结果一致。

- 数据来源：内置示例（程序合成的模拟行情）、上传 CSV（可直接用 Python 版缓存在 `data/` 的文件）、在线从东方财富获取
- 部署到 GitHub Pages：仓库 Settings → Pages → Build and deployment 选 **Deploy from a branch**，分支 `main`、目录 `/docs`，保存后访问 `https://<用户名>.github.io/<仓库名>/`
- iPhone：用 Safari 打开上面的地址，点分享 → **添加到主屏幕**，之后像 App 一样打开
- 重新生成示例数据：`python tools/make_web_sample.py`

## 编写自己的策略

策略只需把收盘价矩阵映射为目标权重矩阵：

```python
import numpy as np
import pandas as pd
from ashare_quant import Backtester, Strategy, load_universe, summarize

class LowVol(Strategy):
    """每月持有过去 60 日波动率最低的 2 个标的。"""
    name = "low_vol"

    def generate(self, close: pd.DataFrame) -> pd.DataFrame:
        vol = close.pct_change().rolling(60).std()
        out = pd.DataFrame(np.nan, index=close.index, columns=close.columns)
        for i in range(60, len(close), 20):
            pick = vol.iloc[i].nsmallest(2).index
            out.iloc[i] = 0.0
            out.iloc[i, out.columns.get_indexer(pick)] = 0.5
        return out

data = load_universe(["510300", "510500", "518880", "511260"], "2016-01-01", "2024-12-31")
result = Backtester(data).run(LowVol())
print(summarize(result))
```

约定：某行只要有非 NaN 值即为当日收盘后的完整目标仓位（NaN 视为 0），全 NaN 行表示不调仓；权重非负且和不超过 1。只使用 `rolling`、`shift` 等向后看的计算。

## 项目结构

```
ashare_quant/
  rules.py       交易规则：涨跌停、手数、费用
  data.py        数据获取与标准化
  engine.py      回测引擎
  strategies.py  策略
  metrics.py     绩效指标
  optimize.py    网格搜索 + 样本外检验
  report.py      报告输出
  cli.py         命令行
docs/            网页版（engine.js 为 JS 版引擎）
tools/           示例数据生成脚本
tests/           单元测试（pytest，含网页版一致性测试）
```

## 已知局限

- 仅日线、仅做多，按开盘价成交，不模拟盘中撮合与成交量约束
- 使用前复权价格：金额近似正确，但早期价格与真实成交价不同，手数取整会有偏差
- 未处理 ST 股 5% 涨跌幅、新股上市初期无涨跌幅限制、退市
- 股票池为固定列表，若用当下成分股回测历史会有幸存者偏差

## 测试

```bash
pip install pytest
python -m pytest -q
```
