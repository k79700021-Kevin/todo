"""行情数据：akshare 在线获取（带本地缓存）、本地 CSV、合成数据。

统一格式：以 DatetimeIndex 为索引，列为 open/high/low/close/volume 的日线 DataFrame。
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pandas as pd

from .rules import is_etf, price_limit

REQUIRED_COLUMNS = ["open", "high", "low", "close", "volume"]
AKSHARE_COLUMNS = {
    "日期": "date",
    "开盘": "open",
    "收盘": "close",
    "最高": "high",
    "最低": "low",
    "成交量": "volume",
}


def normalize_bars(df: pd.DataFrame) -> pd.DataFrame:
    df = df.rename(columns=AKSHARE_COLUMNS).rename(columns=str.lower)
    if "date" in df.columns:
        df = df.set_index("date")
    df.index = pd.to_datetime(df.index)
    df.index.name = "date"
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"缺少列: {missing}")
    df = df[REQUIRED_COLUMNS].astype(float)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df.dropna(subset=["open", "close"])


def load_akshare(
    symbol: str,
    start: str,
    end: str,
    adjust: str = "qfq",
    cache_dir: str | Path = "data",
    retries: int = 4,
    retry_wait: float = 2.0,
) -> pd.DataFrame:
    """从东方财富（经 akshare）获取日线。股票与 ETF 自动区分。"""
    cache = Path(cache_dir) / f"{symbol}_{adjust or 'none'}_{start}_{end}.csv"
    if cache.exists():
        return normalize_bars(pd.read_csv(cache))
    try:
        import akshare as ak
    except ImportError as exc:
        raise ImportError("需要 akshare：pip install akshare") from exc

    fetch = ak.fund_etf_hist_em if is_etf(symbol) else ak.stock_zh_a_hist
    # 东方财富接口偶尔直接断开连接（境外网络尤其常见），网络错误时退避重试
    for attempt in range(retries):
        try:
            raw = fetch(
                symbol=symbol,
                period="daily",
                start_date=start.replace("-", ""),
                end_date=end.replace("-", ""),
                adjust=adjust,
            )
            break
        except OSError:
            if attempt == retries - 1:
                raise
            time.sleep(retry_wait * 2**attempt)
    if raw is None or raw.empty:
        raise ValueError(f"{symbol} 在 {start}~{end} 没有数据")
    df = normalize_bars(raw)
    cache.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(cache)
    return df


def load_csv(path: str | Path) -> pd.DataFrame:
    return normalize_bars(pd.read_csv(path))


def make_synthetic(
    symbols: list[str],
    start: str = "2016-01-01",
    end: str = "2024-12-31",
    seed: int = 42,
    suspend_prob: float = 0.003,
) -> dict[str, pd.DataFrame]:
    """生成带趋势切换、涨跌停截断和随机停牌的合成日线，用于演示与测试。"""
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(start, end)
    out = {}
    for sym in symbols:
        n = len(dates)
        regime = np.repeat(rng.normal(0.0004, 0.0012, n // 120 + 1), 120)[:n]
        vol = rng.uniform(0.012, 0.025)
        limits = np.array([price_limit(sym, d) for d in dates])
        rets = np.clip(regime + rng.normal(0, vol, n), -limits, limits)
        close = 10.0 * np.cumprod(1 + rets)
        prev = np.concatenate([[10.0], close[:-1]])
        gap = np.clip(rng.normal(0, vol / 3, n), -limits, limits)
        open_ = prev * (1 + gap)
        high = np.maximum(open_, close) * (1 + rng.uniform(0, vol / 2, n))
        low = np.minimum(open_, close) * (1 - rng.uniform(0, vol / 2, n))
        df = pd.DataFrame(
            {
                "open": open_.round(2),
                "high": high.round(2),
                "low": low.round(2),
                "close": close.round(2),
                "volume": rng.integers(1_000_000, 10_000_000, n).astype(float),
            },
            index=pd.DatetimeIndex(dates, name="date"),
        )
        keep = rng.random(n) >= suspend_prob
        keep[0] = True
        out[sym] = df[keep]
    return out


def load_universe(
    symbols: list[str],
    start: str,
    end: str,
    source: str = "akshare",
    csv_dir: str | Path = "data",
    adjust: str = "qfq",
    seed: int = 42,
) -> dict[str, pd.DataFrame]:
    if source == "synthetic":
        return make_synthetic(symbols, start, end, seed=seed)
    if source == "csv":
        data = {s: load_csv(Path(csv_dir) / f"{s}.csv") for s in symbols}
        return {s: df.loc[start:end] for s, df in data.items()}
    if source == "akshare":
        return {s: load_akshare(s, start, end, adjust, csv_dir) for s in symbols}
    raise ValueError(f"未知数据源: {source}")
