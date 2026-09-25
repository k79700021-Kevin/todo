"""沪深300 历史成分重建：解析函数与已提交数据文件的一致性。"""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
import build_hs300 as B  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), '..')


def test_old_html_without_tr_end_tags_and_merged_heading():
    # 2012 年前后的公告：省略 </tr>，表格嵌在外层单元格里，标题与正文连在一起，另有其他指数与备选名单
    html = (
        '<table><tr><td>决定于 2012 年 7 月 2 日 调整沪深 300 等指数样本股。部分指数样本调整名单和备选名单见下表。<br>'
        '<div>沪深 300 指数样本股调整名单</div><table><tbody>'
        '<tr><td colspan="2"><div>调出名单</div></td><td colspan="2"><div>调入名单</div></td>'
        '<tr><td>股票代码</td><td>股票名称</td><td>股票代码</td><td>股票名称</td>'
        '<tr><td><div>000027</div></td><td>深圳能源</td><td><div>000046</div></td><td>泛海建设</td>'
        '<tr><td>002244</td><td>滨江集团</td><td>000703</td><td>恒逸石化</td>'
        '</tbody></table><div>中证 100 指数样本股调整名单</div><table>'
        '<tr><td>000825</td><td>太钢不锈</td><td>000869</td><td>张裕Ａ</td></table>'
        '<div>沪深 300 指数备选名单</div><table><tr><td>1</td><td>002236</td><td>大华股份</td></table>'
    )
    outs, ins = B.wide_rows(B.html_rows(html))
    assert outs == ['000027', '002244']
    assert ins == ['000046', '000703']
    assert B.eff_date(html, '2012-06-11') == '2012-07-02'


def test_column_order_follows_header():
    rows = [['沪深300指数样本股调整名单'], ['调入样本', '调出样本'], ['000422', '湖北宜化', '000096', '广聚能源']]
    outs, ins = B.wide_rows(rows)
    assert outs == ['000096'] and ins == ['000422']


def test_long_sheets_pick_only_csi300():
    sheets = {
        '调入': [['指数代码', '指数简称', '证券代码', '证券简称'], ['000300', '沪深300', '002049', '紫光国微'], ['000905', '中证500', '600000', 'x']],
        '调出': [['指数代码', '指数简称', '证券代码', '证券简称'], ['000300', '沪深300', '000709', '河钢股份']],
    }
    assert B.long_sheets(sheets) == (['000709'], ['002049'])


def test_effective_date_phrasings():
    assert B.eff_date('决定于2008年7月第一个交易日调整沪深300指数', '2008-06-04') == '2008-07-01'
    assert B.eff_date('于2026年6月12日收市后生效', '2026-05-29') == '2026-06-13'
    assert B.eff_date('决定于7月3日调整沪深300指数', '2006-06-12') == '2006-07-03'


def test_committed_members_file_has_300_constituents_every_month():
    data = json.load(open(os.path.join(ROOT, 'docs', 'data', 'hs300_members.json'), encoding='utf-8'))
    members = data['members']
    d = datetime.date(2005, 7, 1)
    end = datetime.date.fromisoformat(data['asOf'])
    checked = 0
    while d <= end:
        s = d.isoformat()
        n = sum(1 for ivs in members.values() for f, t in ivs if f <= s and (t is None or s < t))
        assert n == 300, f'{s}: {n}'
        checked += 1
        d = (d.replace(day=1) + datetime.timedelta(days=32)).replace(day=15 if d.day == 1 else 1)
    assert checked > 240
    # 区间不重叠、按时间排序
    for code, ivs in members.items():
        for (f1, t1), (f2, _) in zip(ivs, ivs[1:]):
            assert t1 is not None and t1 <= f2, code
    assert data['delisted']['601299'] == '2015-05-20'
