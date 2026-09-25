"""沪深300 历史成分股的行业分类（东方财富 2016 行业，含已退市公司），输出 docs/data/hs300_industry.json。

注意：这是当前（或退市时）的分类，不是时点数据；上市公司很少跨一级行业变动，行业中性化与归因按此近似。
用法：python tools/build_industry.py
"""
import datetime, json, os, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    codes = sorted(json.load(open(os.path.join(ROOT, 'docs', 'data', 'hs300_members.json'), encoding='utf-8'))['members'])
    full = {}
    for i in range(0, len(codes), 100):
        chunk = codes[i:i + 100]
        f = '(SECURITY_CODE in (' + ','.join(f'"{c}"' for c in chunk) + '))'
        u = ('https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_BASIC_ORGINFO'
             '&columns=SECURITY_CODE,EM2016&pageSize=200&filter=' + urllib.parse.quote(f))
        for r in json.load(urllib.request.urlopen(u, timeout=30))['result']['data']:
            if r['EM2016']:
                full[r['SECURITY_CODE']] = r['EM2016']
    missing = [c for c in codes if c not in full]
    if missing:
        raise SystemExit(f'缺少行业分类：{missing}')
    out = {
        'source': '东方财富 2016 行业分类（RPT_F10_BASIC_ORGINFO.EM2016），当前或退市时的分类，非时点数据',
        'asOf': datetime.date.today().isoformat(),
        'level1': {c: v.split('-')[0] for c, v in sorted(full.items())},
        'full': dict(sorted(full.items())),
    }
    path = os.path.join(ROOT, 'docs', 'data', 'hs300_industry.json')
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(full)} 只，{len(set(out["level1"].values()))} 个一级行业，写入 {path}')


if __name__ == '__main__':
    main()
