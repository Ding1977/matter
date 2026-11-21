#!/usr/bin/env python3
"""价位清单生成器（ISS-661 一键标注的数据源）。

用途：把持仓参数（成本/止损/止盈/关键结构位）算成 Trader 图表可直接吃的
`PriceLine[]` 清单，输出 JSON 与一份可直接粘进控制台的片段。

为什么不做成「图表里点按钮自动读文件」：
  前端读本地文件需要 File System Access 或后端接口，两者都比「生成一份 JSON
  + 一行 console 调用」重；本单的目标是让标注**能落图**，不是建一套配置系统。
  等老板确认要「每日自动重画」再升级到接口层（见 ISS-661 待定项）。

用法：
    python3 scripts/gen-price-lines.py            # 输出到 stdout
    python3 scripts/gen-price-lines.py --json     # 只输出 JSON
    python3 scripts/gen-price-lines.py --period 60m

数据来源：行情服务 127.0.0.1:8100/kline（与投研分析同一口径）。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request

API = "http://127.0.0.1:8100/kline"

# 持仓定义（与 docs/research/PORTFOLIO-LEDGER.md 保持一致）。
# 止损/止盈按 60m 周期口径算，见 docs/research/KLINE-ANNOTATION-ANSWERS.md。
POSITIONS = [
    {
        "symbol": "000973",
        "name": "佛塑科技",
        "cost": 10.385,
        # 60m 结构位
        "support": [("10.40", "S1 10-26低"), ("10.16", "S2 10-22低"), ("9.75", "前低")],
        "resistance": [("10.88", "10-26高"), ("11.03", "密集下沿"),
                       ("11.31", "密集上沿"), ("11.44", "60m近20高"), ("12.19", "顶部放量")],
        # 止损用 60m 2×ATR（本文件运行时按实时 ATR 复核）
        "stop_atr_mult": 2.0,
    },
    {
        "symbol": "002493",
        "name": "荣盛石化",
        "cost": 11.520,
        "support": [("11.48", "S1 10-26低"), ("11.33", "S2 10-15低"),
                    ("11.15", "S3 10-22低"), ("10.99", "前低")],
        "resistance": [("11.79", "10-26高"), ("11.87", "10-19高"),
                       ("12.01", "放量阴线顶"), ("12.37", "10-14高")],
        "stop_atr_mult": 2.0,
    },
]


def fetch(code: str, period: str, limit: int = 800) -> list[dict]:
    url = f"{API}?code={code}&period={period}&limit={limit}"
    with urllib.request.urlopen(url, timeout=25) as r:
        return json.load(r)["data"]


def atr(ks: list[dict], n: int = 14) -> float:
    trs = []
    for i in range(1, len(ks)):
        h, l, pc = ks[i]["high"], ks[i]["low"], ks[i - 1]["close"]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return sum(trs[-n:]) / n


def build_lines(pos: dict, period: str) -> dict:
    ks = fetch(pos["symbol"], period)
    last = ks[-1]["close"]
    a = atr(ks)
    stop = round(last - pos["stop_atr_mult"] * a, 2)

    lines = [
        {"price": round(pos["cost"], 3), "label": f"成本 {pos['cost']}",
         "role": "cost", "dashed": True},
        {"price": stop, "label": f"止损 {pos['stop_atr_mult']}×ATR",
         "role": "stop", "width": 2},
    ]
    for v, lab in pos["support"]:
        lines.append({"price": float(v), "label": lab, "role": "support"})
    for v, lab in pos["resistance"]:
        lines.append({"price": float(v), "label": lab, "role": "resistance"})
    lines.append({"price": last, "label": f"现价 {last}", "role": "neutral", "width": 2})

    # 去重（同价位只留一条，保留优先角色）
    seen, uniq = {}, []
    for ln in sorted(lines, key=lambda x: -x["price"]):
        k = round(ln["price"], 3)
        if k in seen:
            continue
        seen[k] = True
        uniq.append(ln)

    return {"symbol": pos["symbol"], "name": pos["name"],
            "period": period, "price": last, "atr": round(a, 4),
            "lines": uniq}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--period", default="60m", help="周期：15m / 60m / daily")
    ap.add_argument("--json", action="store_true", help="只输出 JSON")
    ap.add_argument("--symbol", help="只生成该标的")
    args = ap.parse_args()

    out = []
    for pos in POSITIONS:
        if args.symbol and pos["symbol"] != args.symbol:
            continue
        try:
            out.append(build_lines(pos, args.period))
        except Exception as e:  # 服务不可达时明确报错，不静默产出空清单
            print(f"[error] {pos['symbol']} 取数失败: {e}", file=sys.stderr)
            return 2

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    for blk in out:
        print(f"── {blk['name']} {blk['symbol']} ({blk['period']}) "
              f"现价 {blk['price']}  ATR {blk['atr']} ──")
        for ln in blk["lines"]:
            print(f"   {ln['price']:>8.3f}  {ln['role']:<11}{ln.get('label','')}")
        print()

    print("粘贴到浏览器控制台（需在 Trader 面板打开对应标的/周期）：")
    print("  localStorage.setItem('trand-pricelines', JSON.stringify(...))  ")
    print("  —— 或直接把下列 JSON 交给父组件 priceLines prop")
    print(json.dumps([{b["symbol"]: b["lines"]} for b in out], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
