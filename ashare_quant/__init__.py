"""A 股日线回测框架。"""

from .data import load_universe, make_synthetic
from .engine import Backtester, BacktestResult
from .metrics import equity_metrics, summarize
from .rules import FeeModel
from .strategies import STRATEGIES, BuyAndHold, DualMA, MomentumRotation, Strategy

__all__ = [
    "Backtester",
    "BacktestResult",
    "BuyAndHold",
    "DualMA",
    "FeeModel",
    "MomentumRotation",
    "STRATEGIES",
    "Strategy",
    "equity_metrics",
    "load_universe",
    "make_synthetic",
    "summarize",
]
