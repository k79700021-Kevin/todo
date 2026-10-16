# 行情镜像（自动生成，请勿手工修改）

由 `.github/workflows/market-data.yml` 每个交易日收盘后生成，只保留最新一个提交。

- `manifest.json`：更新时间、数据截至日、每只标的的区间与行数、失败清单
- `stocks/<代码>.json`：`bars` 不复权日线（腾讯）、`ca` 分红送转明细、`fin` 财务主要指标、`shares` 股本变动（东方财富）

读取方法见主分支的 `docs/mirror.js`（网页）与 `ashare_quant/data.py` 的 `load_mirror`（Python）。
