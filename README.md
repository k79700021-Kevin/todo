# ashare-quant：A 股日线回测框架

一个**贴近 A 股真实交易规则**的轻量级事件驱动回测框架，附带可复现的策略、绩效分析和防过拟合的参数样本外检验。

> 本项目仅用于量化研究与学习，不构成投资建议。回测收益不代表未来表现。

## 特性

| 模块 | 说明 |
|---|---|
| 交易规则 | 100 股一手、T+1、停牌不可交易、开盘涨停不可买/跌停不可卖（主板 10%，创业板 2020-08-24 起 20%，科创板 20%，北交所 30%），未成交订单次日自动重试 |
| 交易成本 | 佣金（含最低 5 元）、过户费、印花税（按日期：2023-08-28 前 0.1%，之后 0.05%）、ETF 免印花税；可配置滑点 |
| 无未来函数 | t 日收盘出信号 → t+1 日开盘成交；有单测验证"篡改未来数据不影响历史净值" |
| 数据 | 直接请求东方财富日线接口（与网页版同一接口，本地缓存，网络错误自动重试），可选 [akshare](https://github.com/akfamily/akshare)（`pip install akshare`），或本地 CSV、合成数据 |
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

常用参数：`--cash` 初始资金、`--commission` 佣金率、`--min-commission` 最低佣金、`--slippage` 滑点、`--band` 调仓容差、`--adjust qfq|hfq|""` 复权方式、`--source eastmoney|akshare|csv|synthetic`、`--data-dir` 缓存/CSV 目录（CSV 命名为 `<代码>.csv`，需含 `date,open,high,low,close,volume` 列）。

## 网页版（手机可用）

`docs/` 是纯前端的研究工具，全部计算在浏览器本地完成，不需要服务器，手机上也能用。

**回测**
- 回测区间：起止日期与"近 1/3/5/10 年、全部"快捷设置，回测、优化、因子研究共用
- 最终留出期：设定起始日后，这一天及以后的数据对所有功能不可见；解锁需确认并记录次数，用于策略定型后的最后一次检验
- 规则组合：16 条指标规则——均线交叉、EMA 交叉、价格与均线、均线斜率、MACD、DMI/ADX 趋势强度、CCI 突破、RSI、威廉 %R、KDJ、布林带回归、唐奇安通道突破、动量 ROC、放量上涨、OBV 能量潮、波动率过滤；每条规则可设为"入场和出场 / 只用于入场 / 只用于出场"，入场"全部满足/任一满足"，出场"任一触发/全部触发"
- 风控与持仓（按实际成交闭环：成本价取实际成交价含费用，持有天数与冷却期从实际成交日算起，涨停没买进不算持仓）：止损、止盈、ATR 移动止损、最多持有几只（信号多于仓位时按近 20 日涨幅择优）、最短持有天数、最长持有天数（时间止损）、平仓后冷却天数；仓位可按 1/N 固定、持仓等分或波动率倒数分配
- 多因子选股：多个因子在标的之间排名打分、按权重合成，每期买入前 N 只，可加大盘趋势过滤；因子库含动量、反转、均线偏离、RSI、MACD、布林 %B、KDJ、波动率、ATR、量比，以及距 250 日新高、20 日最大单日涨幅（彩票效应）、Amihud 非流动性
- 另有 ETF 动量轮动与买入持有
- 评价：收益/风险指标；相对等权基准的 α、β、信息比率、跟踪误差；暴露归因（对市场、动量、低波动三个股票池内风格因子回归，Newey–West t 值，给出剔除暴露后的 α）；按笔统计的胜率、盈亏比、利润因子、平均持有天数；月度收益表
- 最新信号：每只标的当前持仓、各规则的多空状态、下一交易日开盘要做的操作

**参数优化**（后台线程运行，页面不卡）
- 网格或随机搜索，规则参数、风控与持仓参数、因子权重与选股参数都可以纳入；目标可选夏普、索提诺、卡玛、年化收益，可设训练集最少成交笔数
- 训练 / 验证 / 测试三段划分：训练集给参数排序，验证集在训练排名前 10%（至少 5 组）中选出最终参数，测试集锁定，点"揭晓"后才显示选定参数的测试结果，并记录同一测试集被查看的次数
- 滚动前推（walk-forward）：只在训练+验证段内进行，每个窗口只用之前的数据选参，由同一个账户连续交易（换参数时的调仓按真实规则成交并计费用），给出费用、换手与按笔统计
- 通缩夏普比率（Bailey & López de Prado）：试验次数取本机在同一份数据上累计记录的回测配置数与优化组合数（试验登记），给出训练集第一名"真实夏普 > 0"的概率；在别处做过的尝试无法计入，仍偏乐观
- 参数热力图：训练集或验证集，区分稳定的参数区域和孤立的过拟合尖峰

**时序与因子**
- 收益序列：偏度、超额峰度、自相关（含绝对收益的波动聚集）、Lo–MacKinlay 方差比检验
- 16 个因子的时序 IC 与截面 IC：非重叠抽样，95% 置信区间用按日期的块自助法（所有标的同时重抽，重复或高度相关的标的不会虚增显著性），前后半段对比，并提示多重检验下的偶然显著数
- 可交易的分组组合（≥10 只分 5 组，6~9 只分 3 组）：每期按因子排序、等权持有到下一期，扣换手成本，给出各组与多空的年化、夏普、换手和前后半段表现

指标口径与通达信一致（EMA 首值为种子，RSI/KDJ 用 SMA(X,N,1) 平滑，MACD 柱 = 2×(DIF−DEA)）。测试覆盖：`tests/test_web_indicators.py` 逐点对照 pandas 独立实现；`tests/test_web_parity.py` 比对网页版与 Python 版引擎的逐日净值；`tests/web/research.test.js` 覆盖策略状态机、优化、前推与统计函数。

- 数据来源：内置示例（程序合成的模拟行情）、上传 CSV（可直接用 Python 版缓存在 `data/` 的文件）、在线从东方财富获取（一次取 2005 年至今全历史，等比前复权，个别代码失败会跳过；预设大类资产 ETF、行业 ETF、大盘蓝筹股票池）；上传与获取的数据保存在本机浏览器
- 在线地址：<https://k79700021-kevin.github.io/todo/>（GitHub Pages 从 `main` 分支根目录发布，根目录的 `index.html` 跳转到 `docs/`）
- 真实数据检查：`.github/workflows/data-smoke.yml` 在 GitHub 服务器上用真实行情验证网页版与 Python 版的东方财富数据源（两边逐日核对），顺带报告 akshare 是否可用，并在真实数据上跑一遍回测、优化与因子分析，结果见该工作流的运行摘要；每周一自动运行
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
docs/            网页版（indicators / engine / rules / research / worker）
tools/           示例数据生成脚本
tests/           单元测试（pytest，含网页版一致性测试）
```

## 已知局限

- 仅日线、仅做多，按开盘价成交，不模拟盘中撮合与成交量约束
- 使用前复权价格：金额近似正确，但早期价格与真实成交价不同，手数取整会有偏差
- 未处理 ST 股 5% 涨跌幅、新股上市初期无涨跌幅限制、退市
- 股票池为固定列表，若用当下成分股回测历史会有幸存者偏差；没有历史成分股、退市股、公司行为明细与财务数据的时点信息，个股层面的结论要打折扣（ETF 轮动受影响较小）
- 暴露归因只覆盖股票池内的市场、动量、低波动三个风格，没有行业、市值、价值等因子
- 理想化预览（`generate`）按信号当天收盘价假设成交，只用于检查信号逻辑；回测一律按实际成交闭环计算

## 测试

```bash
pip install pytest
python -m pytest -q
```
