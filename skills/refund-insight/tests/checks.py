# 数据层黄金回归自检（以欧莱雅样例为 fixture）。
# 用法：REFUND_XLSX=/path/to/欧莱雅抖音6.11-6.17退款数据.xlsx python checks.py
# 断言含欧莱雅特定数值，仅对该样例有效；换客户数据时这些数值断言会失败属预期。
import os
from refund_data_layer import load_and_clean
XLSX = os.environ.get("REFUND_XLSX", "欧莱雅抖音6.11-6.17退款数据.xlsx")

def test_task1():
    df = load_and_clean(XLSX)
    assert len(df) == 32351, f"行数应为 32351，实际 {len(df)}"
    assert set(df["品牌"].unique()) == {"兰蔻", "修丽可", "卡诗"}, df["品牌"].unique()
    # 派生列齐全
    for col in ["退款金额_num","退款间隔_天","原因层级","是否静默","是否未发货退",
                "是否可深挖","可补打标","价格段","情绪极性","订单号_可靠"]:
        assert col in df.columns, f"缺派生列 {col}"
    # 订单号恒不可靠
    assert (~df["订单号_可靠"]).all()
    # 工单编号为字符串且无精度损失（9 位）
    assert df["工单编号"].dtype == object
    # 静默率与已知值吻合（整体 ~78%）
    silent = df["是否静默"].mean()
    assert 0.76 <= silent <= 0.80, f"整体静默率异常 {silent:.3f}"
    # 退款间隔无负值
    assert (df["退款间隔_天"].dropna() >= 0).all()
    print("[Task1] PASS  rows=", len(df), " silent=", round(silent,3))

def test_task2():
    from refund_data_layer import sig_note, show_conclusion
    assert sig_note(100) == ""
    assert sig_note(20) == "样本不足，仅供参考"
    assert sig_note(5) == "样本极少，不下结论"
    assert show_conclusion(10) is True
    assert show_conclusion(9) is False
    print("[Task2] PASS")

def test_task3():
    from refund_data_layer import load_and_clean, dual_layer_crosstab, analyzable_top
    df = load_and_clean(XLSX)
    ct = dual_layer_crosstab(df, "兰蔻")
    assert "不想要了" in ct.index
    assert ct.values.sum() > 0
    top = analyzable_top(df, "兰蔻")
    # 兰蔻可深挖样本约 1201 条
    assert 1100 <= int(top["单数"].sum()) <= 1300, int(top["单数"].sum())
    assert {"单数","占比","退款金额","退款间隔中位数","显著性"} <= set(top.columns)
    print("[Task3] PASS  兰蔻可深挖=", int(top["单数"].sum()))

def test_task4():
    from refund_data_layer import load_and_clean, silent_profile
    df = load_and_clean(XLSX)
    p = silent_profile(df, "兰蔻")
    assert 0.76 <= p["静默退款率"] <= 0.82, p["静默退款率"]
    assert 0 <= p["未发货仅退款占比"] <= 1
    assert p["静默退款金额"] > 0
    assert p["静默退款间隔中位数"] >= 0
    print("[Task4] PASS  兰蔻静默率=", round(p["静默退款率"],3))

def test_task5():
    from refund_data_layer import load_and_clean, explicit_breakdown, case_samples
    df = load_and_clean(XLSX)
    bd = explicit_breakdown(df, "修丽可")
    assert {"单数","退款金额","退款间隔中位数","负面情绪率","显著性"} <= set(bd.columns)
    assert bd["单数"].sum() > 0
    # 取一个存在的实情原因做案例
    label = bd.iloc[0]["实情原因"]
    cases = case_samples(df, "修丽可", label, k=3)
    assert len(cases) >= 1
    assert all("工单编号" in c for c in cases)
    print("[Task5] PASS  修丽可明确诉求=", int(bd['单数'].sum()))

def test_task6():
    from refund_data_layer import load_and_clean, key_metrics, metric_glossary, ORDER_TOTALS
    df = load_and_clean(XLSX)
    m = key_metrics(df, "卡诗")
    assert m["退款单数"] > 0
    assert 0 < m["退款率"] < 1
    g = metric_glossary()
    assert any(x["名称"] == "退款率" for x in g)
    assert all({"名称","分子","分母","取数范围","局限"} <= set(x) for x in g)
    print("[Task6] PASS  卡诗退款率≈", round(m["退款率"],3))

def test_task8():
    from refund_data_layer import (load_and_clean, key_metrics, analyzable_top,
        case_samples, overall_emotion_rate, sample_tiers, le1day_rate, _neg_rate)
    df = load_and_clean(XLSX)
    m = key_metrics(df, "兰蔻")
    assert round(m["退款率"]*100,1) == 36.4, m["退款率"]
    assert round(m["明细覆盖率"]*100,1) == 45.7, m["明细覆盖率"]
    top = analyzable_top(df, "兰蔻")
    assert "负面情绪率" in top.columns
    av = top[top["实情原因"]=="活动降价"].iloc[0]
    assert 73 <= av["负面情绪率"] <= 75, av["负面情绪率"]
    er = overall_emotion_rate(df, "兰蔻")
    assert 9 <= er["负面情绪率"] <= 11, er  # 有情绪为分母≈10%
    st = sample_tiers(df, "兰蔻")
    assert st["全量"]==14443 and st["可分析(进线≥1)"]==3059
    cs = case_samples(df, "兰蔻", "活动降价", 3)
    assert all("分析依据" in c and c["分析依据"] for c in cs)
    assert le1day_rate(df, "兰蔻") > 50
    print("[Task8] PASS  退款率=36.4% 覆盖率=45.7% 活动降价负面率=", av["负面情绪率"])

import os
def test_task7():
    from refund_data_layer import main
    main()
    for f in ["分析就绪明细.csv", "异常行清单.csv", "分析结果.md"]:
        p = os.path.join("output", f)
        assert os.path.exists(p), f"缺产物 {p}"
        assert os.path.getsize(p) > 0
    md = open("output/分析结果.md", encoding="utf-8").read()
    for kw in ["兰蔻", "修丽可", "卡诗", "静默退款", "口径", "工单编号"]:
        assert kw in md, f"分析结果.md 缺内容 {kw}"
    print("[Task7] PASS  产物已生成")

if __name__ == "__main__":
    test_task1()
    test_task2()
    test_task3()
    test_task4()
    test_task5()
    test_task6()
    test_task7()
    test_task8()
