"""生成网页版内置的示例行情 docs/sample-data.js（合成数据，非真实历史）。"""

import json
from pathlib import Path

from ashare_quant.data import make_synthetic

SYMBOLS = ["510300", "510500", "159915", "518880", "511260"]
OUT = Path(__file__).resolve().parents[1] / "docs" / "sample-data.js"


def main() -> None:
    data = make_synthetic(SYMBOLS, "2016-01-01", "2024-12-31", seed=42)
    payload = {
        s: {
            "dates": [d.strftime("%Y-%m-%d") for d in df.index],
            "open": df["open"].round(2).tolist(),
            "close": df["close"].round(2).tolist(),
        }
        for s, df in data.items()
    }
    body = json.dumps(payload, separators=(",", ":"))
    OUT.write_text(
        "// 由 tools/make_web_sample.py 生成：程序合成的模拟行情，仅供演示，不是真实历史数据\n"
        f"window.AQ_SAMPLE = {body};\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
