#!/usr/bin/env python3
"""思考档位对齐工具：把「我们自己维护的常用模型档位档案」写进状态库（2026-09-20 · ISS-650 / ISS-651）。

老板口径（2026-09-20）：**以 models.dev 为基线，只维护我们自己常用的几个模型参数**；
其余模型继续参考 models.dev、不动。

落点（★ ISS-692 S5-3 起只有一处）：`<home>/forge-model.db` 的 `model_catalog.reasoning_json`。
  · S5-1 起 enabled 权威与模型规格的生效载体都是库，settings.yaml 是库的投影产物（P1）
    —— 本脚本**不再直写 settings.yaml**（原落点①已删，连同全部 YAML 叶子行手术函数）。
  · 档位进入 settings 的时机 = 该套餐下一次投影（任意勾选 / 更新列表 / 或显式调
    `POST /forge-plans/models/project`，幂等）。跑完本脚本想立即生效就 curl 一下它。

安全约束：
  · 只处理档案表内的模型 id，其他模型一字不动；
  · `reasoning_json` 解析不出非空对象 ⇒ 视为"无档位块"→ 跳过（--allow-insert 可放开）；
  · 新值 = {档位: 档位}（与 DSH 选择器口径同构）；值相同 ⇒ 不动（幂等，可反复跑）。

用法：
  python3 scripts/align-model-efforts.py --dry-run                  # 只报差异（默认）
  python3 scripts/align-model-efforts.py --apply                    # 落库 A 引擎（~/.dsh）
  python3 scripts/align-model-efforts.py --apply --home ~/.dsh-b    # 落库 B 引擎
"""
import argparse
import os

# ─── 自有档案：canonical 模型 id（小写、去 vendor 前缀）→ 我们认可的思考档位 ───
# 口径：模型官方文档（2026-09-20 核对）+ provider 实测校准。
#   DeepSeek V4 / V4.1 Flash  官方 low|high|max，默认 high
#   Qwen3.8 Max / Flash       官方 low|medium|xhigh，默认 xhigh
#   GLM-5.3 / Flash / FlashX  官方 low|high|max，默认 max，**不能关思考**
# 需要纳入更多模型时在此加一行即可（其余模型不在此表 = 继续参考 models.dev）。
OFFICIAL_EFFORTS = {
    "deepseek-v4-flash": ["low", "high", "max"],
    "deepseek-v4.1-flash": ["low", "high", "max"],
    "qwen3.8-max": ["low", "medium", "xhigh"],
    "qwen3.8-flash": ["low", "medium", "xhigh"],
    "glm-5.3": ["low", "high", "max"],
    "glm-5.3-flash": ["low", "high", "max"],
    "glm-5.3-flashx": ["low", "high", "max"],
}

# 已实测的 provider 差异（仅记录，供复核；本表不参与写入逻辑）：
#   commandcode       接受 low|medium|high|xhigh|max，拒绝 minimal/none/ultra
#   apiqik(dimleap)   不校验档位值（任意值均 200）
#   sensenova         deepseek-v4-flash 只认 low|medium|high|xhigh（**拒绝 max**），当前账号 429


def canonical(model_id):
    """vendor/ 前缀去掉、小写，作为档案表键（与 provider 无关，故一处定义处处生效）。"""
    return str(model_id).split("/")[-1].strip().lower()


def run_db(home, apply, allow_insert):
    """落点②：状态库 `model_catalog.reasoning_json`（ISS-688 S3 起目录的生效载体）。

    语义与文件版**逐条对齐**（同一条档案表、同样"没档位块就不臆造"、已对齐则跳过），
    只是载体从 YAML 叶子行换成了库里的 JSON 列：
      · 只处理 canonical(model) 命中 OFFICIAL_EFFORTS 的行；
      · `reasoning_json` 解析不出**非空对象** ⇒ 视为"无档位块"→ 跳过（除非 --allow-insert）；
      · 新值 = {档位: 档位}（与 YAML 版的 `lv: lv` 同构）；
      · 值相同 ⇒ 不动（幂等，可反复跑）。
    """
    db = os.path.join(home, "forge-model.db")
    if not os.path.exists(db):
        print(f"· 跳过（不存在）: {db}")
        return 0
    import json
    import sqlite3
    conn = sqlite3.connect(db)
    try:
        rows = conn.execute(
            "SELECT provider, model, reasoning_json FROM model_catalog"
        ).fetchall()
        edits, skipped = [], []
        for provider, model, rj in rows:
            levels = OFFICIAL_EFFORTS.get(canonical(model))
            if not levels:
                continue  # 不在档案表 → 继续参考 models.dev，不动
            cur = None
            if rj:
                try:
                    cur = json.loads(rj)
                except Exception:
                    cur = None
            if not isinstance(cur, dict) or not cur:
                if not allow_insert:
                    skipped.append(f"{provider}/{model}（无档位块，未臆造）")
                    continue
                cur = {}
            new = {lv: lv for lv in levels}
            if cur == new:
                continue  # 已对齐
            edits.append((provider, model, json.dumps(new, ensure_ascii=False, separators=(",", ":"))))
        print(f"· {db}：{len(edits)} 处待改")
        for provider, model, _ in edits:
            print(f"   - {provider}/{model}")
        if skipped:
            print(f"   （跳过 {len(skipped)} 条）")
            for s in skipped:
                print("     ·", s)
        if not edits or not apply:
            return len(edits)
        conn.executemany(
            "UPDATE model_catalog SET reasoning_json=? WHERE provider=? AND model=?",
            [(new, p, m) for p, m, new in edits],
        )
        conn.commit()
        print(f"   已写入库（{len(edits)} 行）")
        return len(edits)
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正落盘（默认只预览）")
    ap.add_argument("--dry-run", action="store_true", help="只预览（默认行为）")
    ap.add_argument("--home", default="~/.dsh", help="DSH_HOME（默认 ~/.dsh；B 引擎 ~/.dsh-b）")
    ap.add_argument("--allow-insert", action="store_true", help="给无档位块的条目新增档位（默认不动）")
    args = ap.parse_args()
    home = os.path.expanduser(args.home)
    print(f"home = {home}  模式 = {'APPLY' if args.apply else 'DRY-RUN'}")
    n = run_db(home, args.apply, args.allow_insert)
    print(f"合计 {n} 处待改")


if __name__ == "__main__":
    main()
