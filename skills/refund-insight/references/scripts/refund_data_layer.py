# 抖音退款数据层重组脚本（班牛 refund-insight skill）
# 产物 A：清洗 + 派生字段后的分析就绪明细
# 用法：python refund_data_layer.py <退款明细.xlsx> [汇总.json] [输出目录]
import os
import re
import sys
import json
import numpy as np
import pandas as pd

# 默认输入（欧莱雅样例）；可由命令行参数或环境变量 REFUND_XLSX 覆盖
XLSX_DEFAULT = os.environ.get("REFUND_XLSX", "欧莱雅抖音6.11-6.17退款数据.xlsx")
OUT_DIR = "output"

# 低信息（无理由）平台原因；空值另行判定
LOW_INFO_REASONS = {"不想要了", "7天无理由退款", "多拍/错拍/不想要", "暂时不需要这个商品"}

# 店铺关键词→品牌短名 的精确映射（可选）。留空则用 _brand 的自动推断。
# 新客户若自动推断不准，在此登记，如 {"兰蔻": "兰蔻"}。
BRAND_CONFIG = {}

# 店铺 → 品牌 归一：先查精确映射，否则自动推断
# 自动推断：去平台前缀【…】、去"官方旗舰店/专卖店/专营店"后缀、去尾部英文
def _brand(shop) -> str:
    if shop is None or (isinstance(shop, float) and pd.isna(shop)):
        return "未知"
    s = str(shop)
    for kw, name in BRAND_CONFIG.items():
        if kw in s:
            return name
    s = re.sub(r"^【.*?】", "", s)
    s = re.sub(r"(官方)?(旗舰店|专卖店|专营店)$", "", s)
    s = re.sub(r"[A-Za-z\s\-·]+$", "", s).strip()
    return s or "未知"

# 情绪极性：🔴/🟡 负面，🟢/⚪ 中性，空缺失
def _emotion_polarity(v) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)) or str(v).strip() == "":
        return "缺失"
    s = str(v)
    if "🔴" in s or "🟡" in s:
        return "负面"
    if "🟢" in s or "⚪" in s:
        return "中性"
    return "中性"

def load_and_clean(xlsx_path: str = XLSX_DEFAULT) -> pd.DataFrame:
    # 工单编号读为字符串保精度；订单号/售后单号已是 float，无法恢复
    df = pd.read_excel(xlsx_path, sheet_name="Sheet1",
                       dtype={"工单编号(不可修改)": str})
    df = df.rename(columns={"工单编号(不可修改)": "工单编号"})
    df["工单编号"] = df["工单编号"].astype(str).str.replace(r"\.0$", "", regex=True)

    df["品牌"] = df["店铺"].map(_brand)

    # 退款金额数值化
    df["退款金额_num"] = pd.to_numeric(df["退款金额"], errors="coerce")

    # 时间解析 + 退款间隔（天）；负值置 NaN
    申请 = pd.to_datetime(df["申请时间"], errors="coerce")
    下单 = pd.to_datetime(df["下单时间"], errors="coerce")
    iv = (申请 - 下单).dt.total_seconds() / 86400.0
    iv[iv < 0] = np.nan
    df["退款间隔_天"] = iv
    df["_申请dt"] = 申请
    df["_下单dt"] = 下单

    # 进线次数规整
    jx = pd.to_numeric(df["进线次数"], errors="coerce").fillna(0)
    df["进线次数_num"] = jx

    # 原因层级
    平台 = df["售后原因(平台)"]
    低信息 = 平台.isna() | 平台.isin(LOW_INFO_REASONS)
    df["原因层级"] = np.where(低信息, "低信息", "明确诉求")

    # 派生标记
    df["是否静默"] = jx == 0
    df["是否未发货退"] = df["售后类型"] == "未发货仅退款"
    有原因 = df["售后原因(标签名称)"].notna() & (df["售后原因(标签名称)"] != "非售后场景")
    df["是否可深挖"] = (jx >= 1) & 有原因
    df["可补打标"] = (jx >= 1) & (~有原因) & 低信息

    # 价格段：按全体退款金额分位切档
    q = df["退款金额_num"].quantile([0.25, 0.5, 0.75]).values
    def _band(x):
        if pd.isna(x):
            return "未知"
        if x <= q[0]:
            return f"≤P25(≤{q[0]:.0f})"
        if x <= q[1]:
            return f"P25-P50({q[0]:.0f}-{q[1]:.0f})"
        if x <= q[2]:
            return f"P50-P75({q[1]:.0f}-{q[2]:.0f})"
        return f">P75(>{q[2]:.0f})"
    df["价格段"] = df["退款金额_num"].map(_band)

    df["情绪极性"] = df["买家情绪"].map(_emotion_polarity)
    df["订单号_可靠"] = False
    return df

# 产物 F：样本量显著性标注
def sig_note(n: int) -> str:
    if n >= 30:
        return ""
    if n >= 10:
        return "样本不足，仅供参考"
    return "样本极少，不下结论"

def show_conclusion(n: int) -> bool:
    return n >= 10

# 售后原因(一级标签) 作为 AI 实情列；空归并为"(无)"
def _ai_l1(df: pd.DataFrame) -> pd.Series:
    return df["售后原因(一级标签)"].fillna("(无)")

# 产物 B1：声明原因 × AI 实情 交叉表
def dual_layer_crosstab(df: pd.DataFrame, brand: str) -> pd.DataFrame:
    sub = df[df["品牌"] == brand].copy()
    sub["平台原因"] = sub["售后原因(平台)"].fillna("(空)")
    sub["AI一级"] = _ai_l1(sub)
    ct = pd.crosstab(sub["平台原因"], sub["AI一级"], margins=True, margins_name="合计")
    return ct.sort_values("合计", ascending=False)

# 产物 B2：可分析样本 AI 实情 Top 榜
def analyzable_top(df: pd.DataFrame, brand: str) -> pd.DataFrame:
    sub = df[(df["品牌"] == brand) & df["是否可深挖"]].copy()
    total = len(sub)
    g = sub.groupby("售后原因(标签名称)").agg(
        单数=("工单编号", "size"),
        退款金额=("退款金额_num", "sum"),
        退款间隔中位数=("退款间隔_天", "median"),
    ).reset_index().rename(columns={"售后原因(标签名称)": "实情原因"})
    g["占比"] = (g["单数"] / total * 100).round(1) if total else 0.0
    g["显著性"] = g["单数"].map(sig_note)
    g = g.sort_values("单数", ascending=False)
    # 新增负面情绪率列（以有情绪记录为分母，剔除缺失稀释）
    g["负面情绪率"] = g["实情原因"].map(
        lambda r: round(_neg_rate(sub[sub["售后原因(标签名称)"] == r]), 1))
    return g[["实情原因", "单数", "占比", "退款金额", "退款间隔中位数", "负面情绪率", "显著性"]]

# 产物 C：静默退款画像
def silent_profile(df: pd.DataFrame, brand: str) -> dict:
    sub = df[df["品牌"] == brand]
    n = len(sub)
    silent = sub[sub["是否静默"]]
    le24 = sub["退款间隔_天"].dropna()
    多拍 = (sub["售后原因(平台)"] == "多拍/错拍/不想要").sum()
    return {
        "退款单数": int(n),
        "静默退款率": silent.shape[0] / n if n else 0.0,
        "未发货仅退款占比": sub["是否未发货退"].mean() if n else 0.0,
        "静默退款金额": float(silent["退款金额_num"].sum()),
        "静默退款间隔中位数": float(silent["退款间隔_天"].median(skipna=True)) if len(silent) else 0.0,
        "le24h占比": float((le24 <= 1).mean()) if len(le24) else 0.0,
        "多拍错拍占比": 多拍 / n if n else 0.0,
        "价格段分布": silent["价格段"].value_counts().to_dict(),
    }

# 产物 D：明确诉求型深挖
def explicit_breakdown(df: pd.DataFrame, brand: str) -> pd.DataFrame:
    sub = df[(df["品牌"] == brand) & (df["原因层级"] == "明确诉求")].copy()
    g = sub.groupby("售后原因(标签名称)").agg(
        单数=("工单编号", "size"),
        退款金额=("退款金额_num", "sum"),
        退款间隔中位数=("退款间隔_天", "median"),
    ).reset_index().rename(columns={"售后原因(标签名称)": "实情原因"})
    # 负面情绪率改用有情绪记录为分母，剔除缺失稀释
    g["负面情绪率"] = g["实情原因"].map(
        lambda r: round(_neg_rate(sub[sub["售后原因(标签名称)"] == r]), 1))
    g["显著性"] = g["单数"].map(sig_note)
    return g.sort_values("单数", ascending=False)

# 汇总口径（退款率分子/分母）。默认欧莱雅样例，可由 load_summary() 用 JSON 覆盖。
# JSON 形如 {"兰蔻": {"orders": 86929, "refund_orders": 31638}, ...}
ORDER_TOTALS = {"兰蔻": 86929, "修丽可": 45953, "卡诗": 60672}
ACTUAL_REFUND_TOTALS = {"兰蔻": 31638, "修丽可": 23039, "卡诗": 22556}

def load_summary(path: str) -> None:
    # 从汇总 JSON 覆盖订单总数与平台售后单数（退款率口径）
    global ORDER_TOTALS, ACTUAL_REFUND_TOTALS
    d = json.load(open(path, encoding="utf-8"))
    ORDER_TOTALS = {k: v["orders"] for k, v in d.items()}
    ACTUAL_REFUND_TOTALS = {k: v["refund_orders"] for k, v in d.items()}

# 产物 E：关键指标
def key_metrics(df: pd.DataFrame, brand: str) -> dict:
    sub = df[df["品牌"] == brand]
    n = len(sub)
    可分析 = sub["是否可深挖"].sum()
    return {
        "退款单数": int(n),
        "退款率": ACTUAL_REFUND_TOTALS[brand] / ORDER_TOTALS[brand] if brand in ORDER_TOTALS else float("nan"),
        "明细覆盖率": n / ACTUAL_REFUND_TOTALS[brand] if brand in ACTUAL_REFUND_TOTALS else float("nan"),
        "静默退款率": sub["是否静默"].mean() if n else 0.0,
        "可分析率": 可分析 / n if n else 0.0,
        "明确诉求占比": (sub["原因层级"] == "明确诉求").mean() if n else 0.0,
    }

# 口径附件：每条比例的分子/分母说明
def metric_glossary() -> list:
    return [
        {"名称": "退款率", "分子": "汇总售后单数(平台口径)", "分母": "订单总数",
         "取数范围": "汇总md", "局限": "明细仅覆盖平台售后单约 34%~46%（兰蔻45.7%）"},
        {"名称": "明细覆盖率", "分子": "明细退款记录数", "分母": "汇总售后单数",
         "取数范围": "明细÷汇总", "局限": "明细疑似仅含班牛工单系统纳管/AI处理的退款单"},
        {"名称": "静默退款率", "分子": "进线次数=0 单数", "分母": "该品牌退款单数",
         "取数范围": "明细全量", "局限": "无"},
        {"名称": "可分析率", "分子": "进线≥1 且 AI标签≠非售后场景", "分母": "该品牌退款单数",
         "取数范围": "明细全量", "局限": "无"},
        {"名称": "各原因占比", "分子": "该实情原因单数", "分母": "可分析样本(非全样本)",
         "取数范围": "是否可深挖=True", "局限": "符合 prompt 第57行：以可分析为总体"},
        {"名称": "负面情绪率", "分子": "情绪极性=负面 单数", "分母": "有情绪记录数（剔除缺失）",
         "取数范围": "分组内", "局限": "情绪字段约48.9%缺失，以有情绪记录为分母避免稀释"},
    ]

# 典型案例：用工单编号锚定（订单号不可靠），加"分析依据"字段，按情绪烈度排序
def case_samples(df: pd.DataFrame, brand: str, label: str, k: int = 3) -> list:
    sub = df[(df["品牌"] == brand) & (df["售后原因(标签名称)"] == label)].copy()
    def 烈度(v):
        s = str(v)
        if "🔴" in s: return 3
        if "🟡" in s: return 2
        if "🟢" in s or "⚪" in s: return 1
        return 0
    无效原声 = sub["买家原声"].isin([None, "无有效原声", "无"]) | sub["买家原声"].isna()
    sub = sub.assign(_烈度=sub["买家情绪"].map(烈度), _有效原声=(~无效原声).astype(int))
    sub = sub.sort_values(["_有效原声", "_烈度", "进线次数_num"], ascending=False)
    cols = ["工单编号", "商品名称", "商品SKU", "买家情绪", "买家原声", "分析依据"]
    return [{c: (None if pd.isna(r[c]) else r[c]) for c in cols} for _, r in sub.head(k).iterrows()]

def _neg_rate(sub) -> float:
    # 负面情绪率 = 负面 / 有情绪记录（剔除"缺失"，避免被 48.9% 缺失稀释）
    emo = (sub["情绪极性"] != "缺失").sum()
    return (sub["情绪极性"] == "负面").sum() / emo * 100 if emo else 0.0


def overall_emotion_rate(df: pd.DataFrame, brand: str) -> dict:
    """全量情绪分布（以有情绪记录为分母）"""
    sub = df[df["品牌"] == brand]
    return {
        "负面情绪率": round(_neg_rate(sub), 1),               # 有情绪为分母
        "有情绪记录数": int((sub["情绪极性"] != "缺失").sum()),
        "情绪缺失率": round((sub["情绪极性"] == "缺失").mean() * 100, 1),
    }


def sample_tiers(df: pd.DataFrame, brand: str) -> dict:
    # 三级样本：全量 > 可分析(有进线) > 可归因(有进线且定位原因)
    sub = df[df["品牌"] == brand]
    return {
        "全量": int(len(sub)),
        "可分析(进线≥1)": int((sub["进线次数_num"] >= 1).sum()),
        "可归因(进线≥1且定位原因)": int(sub["是否可深挖"].sum()),
    }


def daily_trend(df: pd.DataFrame, brand: str) -> dict:
    """按申请日期统计退款单数趋势"""
    sub = df[df["品牌"] == brand].copy()
    sub["日期"] = sub["_申请dt"].dt.strftime("%Y-%m-%d")
    return sub.groupby("日期").size().to_dict()


def le1day_rate(df: pd.DataFrame, brand: str) -> float:
    """下单≤1天退款占比（%）"""
    iv = df[df["品牌"] == brand]["退款间隔_天"].dropna()
    return round((iv <= 1).mean() * 100, 1) if len(iv) else 0.0


def emotion_by_refundtype(df: pd.DataFrame, brand: str) -> dict:
    """按售后类型×情绪极性交叉分布（剔除缺失）"""
    sub = df[(df["品牌"] == brand) & (df["情绪极性"] != "缺失")]
    return pd.crosstab(sub["售后类型"], sub["情绪极性"]).to_dict()


# 默认品牌顺序（欧莱雅样例）；render 时优先用数据里实际出现的品牌
BRANDS = ["兰蔻", "修丽可", "卡诗"]

def _brands_in(df: pd.DataFrame) -> list:
    # 数据里实际出现的品牌，按退款单数降序；保证新客户也能自适应
    order = df["品牌"].value_counts().index.tolist()
    return [b for b in order if b != "未知"] or BRANDS

def _df_to_md(df: pd.DataFrame) -> str:
    return df.to_markdown(index=False, floatfmt=".1f")

def render_report(df: pd.DataFrame) -> str:
    rng = "—"
    if "_申请dt" in df.columns and df["_申请dt"].notna().any():
        rng = f"{df['_申请dt'].min().date()}~{df['_申请dt'].max().date()}"
    L = ["# 抖音退款数据层分析结果", "",
         f"明细行数：{len(df)}　数据区间：{rng}", ""]

    # 集团关键指标
    L.append("## 集团关键指标")
    rows = []
    for b in _brands_in(df):
        m = key_metrics(df, b)
        rows.append({"品牌": b, "退款单数": m["退款单数"],
                     "退款率%": round(m["退款率"]*100, 1),
                     "明细覆盖率%": round(m["明细覆盖率"]*100, 1),
                     "静默退款率%": round(m["静默退款率"]*100, 1),
                     "可分析率%": round(m["可分析率"]*100, 1),
                     "明确诉求占比%": round(m["明确诉求占比"]*100, 1)})
    L.append(_df_to_md(pd.DataFrame(rows)))
    L.append("")

    for b in _brands_in(df):
        L.append(f"## {b}")
        # 三级样本概览
        st = sample_tiers(df, b)
        er = overall_emotion_rate(df, b)
        lr = le1day_rate(df, b)
        L.append(f"- 三级样本：全量 {st['全量']} / 可分析 {st['可分析(进线≥1)']} / 可归因 {st['可归因(进线≥1且定位原因)']}")
        L.append(f"- 全量负面情绪率(有情绪为分母)：{er['负面情绪率']}%（有情绪记录 {er['有情绪记录数']}，情绪缺失率 {er['情绪缺失率']}%）")
        L.append(f"- 下单≤1天退款占比：{lr}%")
        L.append("")
        # C 静默画像
        p = silent_profile(df, b)
        L.append(f"### 静默退款画像")
        L.append(f"- 退款单数：{p['退款单数']}")
        L.append(f"- 静默退款率：{p['静默退款率']*100:.1f}%")
        L.append(f"- 未发货仅退款占比：{p['未发货仅退款占比']*100:.1f}%")
        L.append(f"- 静默退款涉及金额：{p['静默退款金额']:,.0f} 元")
        L.append(f"- 静默退款间隔中位数：{p['静默退款间隔中位数']:.1f} 天")
        L.append(f"- 下单24h内退款占比：{p['le24h占比']*100:.1f}%")
        L.append(f"- 多拍/错拍占比：{p['多拍错拍占比']*100:.1f}%")
        L.append("")
        # 每日退款趋势（供折线/柱图）
        dt = daily_trend(df, b)
        L.append("### 每日退款趋势")
        L.append(_df_to_md(pd.DataFrame({"日期": list(dt.keys()), "退款单数": list(dt.values())})))
        L.append("")
        # 各退款类型情绪分布（供堆叠条）
        ebr = emotion_by_refundtype(df, b)
        if ebr:
            erows = []
            types = sorted({t for col in ebr.values() for t in col})
            for t in types:
                row = {"售后类型": t}
                for pol, col in ebr.items():
                    row[pol] = int(col.get(t, 0))
                erows.append(row)
            L.append("### 各退款类型情绪分布（剔除缺失）")
            L.append(_df_to_md(pd.DataFrame(erows)))
            L.append("")
        # B2 可分析实情 Top
        L.append("### 可分析样本：聊天实情原因 Top（分母=可分析样本）")
        L.append(_df_to_md(analyzable_top(df, b)))
        L.append("")
        # D 明确诉求
        L.append("### 明确诉求型退款深挖")
        bd = explicit_breakdown(df, b)
        L.append(_df_to_md(bd))
        L.append("")
        # D 案例（取明确诉求 Top1，跳过"非售后场景"，且可下结论的）
        real = bd[bd["实情原因"] != "非售后场景"]
        if len(real) and show_conclusion(int(real.iloc[0]["单数"])):
            label = real.iloc[0]["实情原因"]
            L.append(f"#### 典型案例（{label}，工单编号锚定）")
            for c in case_samples(df, b, label, 3):
                声 = (c["买家原声"] or "")[:80]
                依 = (c["分析依据"] or "")[:120]
                L.append(f"- **工单 {c['工单编号']}**｜{c['商品名称']}｜SKU {c['商品SKU']}｜情绪 {c['买家情绪']}")
                L.append(f"  - 原声：{声}")
                L.append(f"  - 分析依据：{依}")
            L.append("")
        # B1 交叉表
        L.append("### 双层归因：顾客声明原因 × 聊天实情（单数）")
        L.append(_df_to_md(dual_layer_crosstab(df, b).reset_index()))
        L.append("")

    # E 口径附件
    L.append("## 附件：指标口径说明（分子/分母）")
    L.append(_df_to_md(pd.DataFrame(metric_glossary())))
    L.append("")
    L.append("## 数据层局限声明")
    L.append("- 订单号/售后单号 float 精度损坏，不可回溯核实；核实锚点用工单编号。")
    L.append("- 明细仅覆盖汇总售后单的一部分（见各品牌「明细覆盖率」），退款率以汇总口径为准。")
    L.append("- 买家昵称加密，无法做用户级关联。")
    L.append("- 大部分退款为零进线静默，无聊天可逐条归因，以结构化画像替代。")
    return "\n".join(L)

def main(xlsx_path: str = XLSX_DEFAULT, summary_path: str = None, out_dir: str = OUT_DIR):
    if summary_path:
        load_summary(summary_path)
    os.makedirs(out_dir, exist_ok=True)
    df = load_and_clean(xlsx_path)
    # 产物 A
    drop = [c for c in ["_申请dt", "_下单dt"] if c in df.columns]
    df.drop(columns=drop).to_csv(os.path.join(out_dir, "分析就绪明细.csv"),
                                 index=False, encoding="utf-8-sig")
    # 异常行
    bad = df[df["退款间隔_天"].isna() | df["退款金额_num"].isna()]
    bad.drop(columns=drop).to_csv(os.path.join(out_dir, "异常行清单.csv"),
                                  index=False, encoding="utf-8-sig")
    # 产物 B–F
    with open(os.path.join(out_dir, "分析结果.md"), "w", encoding="utf-8") as f:
        f.write(render_report(df))

if __name__ == "__main__":
    a = sys.argv[1:]
    xp = a[0] if len(a) > 0 else XLSX_DEFAULT
    sp = a[1] if len(a) > 1 else None
    od = a[2] if len(a) > 2 else OUT_DIR
    main(xp, sp, od)
