"""重建沪深300 历史成分（时点股票池），输出 docs/data/hs300_members.json。

数据来源全部是中证指数有限公司官网：
  1. 2005-07-01 生效的样本股名单（公告 86）作为起点；
  2. 历次定期调整公告（正文表格、正文链接的 xls/xlsx、附件 pdf/xlsx，自动解析）；
  3. 临时调整（大市值新股快速进入、吸收合并退市等），格式不一，逐条核对后记录在 tools/hs300_adhoc.json；
  4. 当前成分表（000300cons.xls）用于最终校验。
按生效日期顺序推演，要求每一步后恰好 300 只、调出的都在指数内、调入的都不在，且推演结果与当前成分表完全一致，否则报错退出。
出现新的临时调整时，校验会失败并指出差异，把它补进 hs300_adhoc.json 即可。

用法：python tools/build_hs300.py [--cache 目录]
依赖：pip install openpyxl xlrd pdfplumber
"""
import argparse, datetime, html, json, os, re, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = 'https://www.csindex.com.cn/csindex-home'
CONS = 'https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/cons/000300cons.xls'
BASE_ID = '86'          # 2005-07-01 起生效的样本股名单
BASE_EXTRA = {'000550', '600033', '600660'}  # 公告页面只列出 297 只；这三只后来被定期调整调出（或至今在内），且新浪历史成分显示自 2005-04-08 起为成分
SKIP_IDS = {'87'}       # 2005-07-01 的调整已体现在起点名单中
CODE = re.compile(r'^\s*(\d{6})(?:\.(?:SH|SZ|BJ))?\s*$')


_last = [0.0]


def get(url, raw=False, tries=5):
    """请求间隔至少 0.6 秒；中证官网频繁请求会返回 403，退避后重试。"""
    for a in range(tries):
        wait = 0.6 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(urllib.parse.quote(url, safe=':/?=&%()'), headers={'User-Agent': 'Mozilla/5.0'})
            b = urllib.request.urlopen(req, timeout=60).read()
            return b if raw else json.loads(b)
        except Exception as e:  # noqa: BLE001 网络错误重试
            if a == tries - 1:
                raise RuntimeError(f'{url}：{e}') from e
            print('重试', url[:90], e, file=sys.stderr)
            time.sleep(10 * 2 ** a if '403' in str(e) else 2 * (a + 1))


class Cache:
    def __init__(self, d):
        self.d = d
        os.makedirs(d, exist_ok=True)

    def json(self, key, url):
        fn = os.path.join(self.d, key + '.json')
        if not os.path.exists(fn):
            data = json.dumps(get(url), ensure_ascii=False).encode()
            with open(fn, 'wb') as f:
                f.write(data)
        return json.load(open(fn, encoding='utf-8'))

    def file(self, key, url):
        fn = os.path.join(self.d, key)
        if not os.path.exists(fn):
            data = get(url, raw=True)
            with open(fn, 'wb') as f:
                f.write(data)
        return fn


def norm(s):
    return re.sub(r'[\s　\xa0]+', '', str(s if s is not None else ''))


EXCLUDE = r'沪深300(价值|成长|行业|相对|风格|主题|精明|优选|等权|红利|低波|地产|金融|能源|材料|工业|可选|消费|医药|信息|电信|公用|非银|银行|有色|高贝|动量|ESG|质量|周期)'


def is_target_heading(t):
    t = norm(t)
    return ('沪深300' in t and any(k in t for k in ('调整名单', '调样名单', '样本股名单', '样本调整'))
            and not re.search(EXCLUDE, t) and '备选' not in t)


def is_other_heading(t):
    t = norm(t)
    return '名单' in t and ('指数' in t or '备选' in t) and len(t) < 60 and not is_target_heading(t)


def wide_rows(rows, force=False):
    """宽表：同一行左右两组（代码, 名称）。列顺序按表头判断（通常左调出右调入，也有反过来的）。
    只取"沪深300 …调整名单"标题下的表格；force=True 时不要求标题。"""
    outs, ins, active, left_is_out = [], [], force, True
    for r in rows:
        cells = [norm(c) for c in r]
        if not any(CODE.match(c) for c in cells):
            head = ''.join(cells)
            pin = min([head.find(k) for k in ('调入', '新进', '纳入') if k in head] or [-1])
            pout = min([head.find(k) for k in ('调出', '剔除', '删除') if k in head] or [-1])
            if pin >= 0 and pout >= 0 and len(head) < 40:
                left_is_out = pout < pin
                continue
            last = re.split(r'[。：:]', head.rstrip('。：: '))[-1] if '。' in head else head  # 标题常与正文连在一起
            if is_target_heading(last):
                active = True
            elif is_other_heading(last):
                active = False
            continue
        if not active:
            continue
        codes = [(i, CODE.match(c).group(1)) for i, c in enumerate(cells) if CODE.match(c)]
        left, right = (outs, ins) if left_is_out else (ins, outs)
        if len(codes) == 2:
            left.append(codes[0][1]); right.append(codes[1][1])
        elif len(codes) == 1:
            (left if codes[0][0] < len(cells) / 2 else right).append(codes[0][1])
    return outs, ins


def html_rows(content):
    t = re.sub(r'(?is)<(script|style).*?</\1>', '', content or '')
    t = re.sub(r'(?i)<tr\b[^>]*>|</table>|<table[^>]*>', '\x01', t)   # 不少老公告省略 </tr>
    t = re.sub(r'(?i)</t[dh]>', '\x02', t)
    t = html.unescape(re.sub(r'<[^>]+>', ' ', t))
    rows = []
    for chunk in t.split('\x01'):
        cells = chunk.split('\x02')
        if cells and not norm(cells[-1]):
            cells = cells[:-1]
        if any(norm(c) for c in cells):
            rows.append(cells)
    return rows


def long_sheets(sheets):
    """长表：按"调入""调出"分 sheet，每行带指数代码。"""
    outs, ins = [], []
    for name, rows in sheets.items():
        kind = 'in' if '调入' in name else 'out' if '调出' in name else None
        if not kind or not rows:
            continue
        head = [norm(c) for c in rows[0]]
        if '指数代码' not in head:
            continue
        ic = head.index('指数代码')
        cc = next((i for i, h in enumerate(head) if h in ('证券代码', '股票代码', '成份券代码', '样本代码')), None)
        if cc is None:
            continue
        for r in rows[1:]:
            if len(r) > max(ic, cc) and norm(r[ic]).zfill(6) == '000300':
                m = CODE.match(norm(r[cc]).split('.')[0].zfill(6))
                if m:
                    (ins if kind == 'in' else outs).append(m.group(1))
    return outs, ins


def read_file(fn):
    ext = os.path.splitext(fn)[1].lower()
    if ext == '.xlsx':
        import openpyxl
        wb = openpyxl.load_workbook(fn, read_only=True, data_only=True)
        return {ws.title: [list(r) for r in ws.iter_rows(values_only=True)] for ws in wb.worksheets}
    if ext == '.xls':
        import xlrd
        b = xlrd.open_workbook(fn)
        return {sh.name: [sh.row_values(i) for i in range(sh.nrows)] for sh in b.sheets()}
    if ext == '.pdf':
        import pdfplumber
        rows = []
        with pdfplumber.open(fn) as p:
            for pg in p.pages:
                trows = [r for t in pg.extract_tables() for r in t]
                ti = 0
                for line in (pg.extract_text() or '').split('\n'):
                    if re.search(r'\d{6}', line):
                        while ti < len(trows) and not any(CODE.match(norm(c)) for c in trows[ti] if c):
                            ti += 1
                        if ti < len(trows):
                            rows.append(trows[ti]); ti += 1
                    else:
                        rows.append([line])
        return {'pdf': rows}
    raise ValueError(ext)


def parse_file(fn):
    sheets = read_file(fn)
    o, i = long_sheets(sheets)
    if o or i:
        return o, i
    outs, ins = [], []
    for rows in sheets.values():
        a, b = wide_rows(rows)
        outs += a; ins += b
    return outs, ins


def eff_date(text, publish):
    """生效日（当天起为成分）：'于X年X月第一个交易日' → 当月 1 日；'X日收市后生效' → 次日；'于X日调整/生效' → 当日。"""
    t = norm(text)
    m = re.search(r'于(\d{4})年(\d{1,2})月第一个交易日', t)
    if m:
        return f'{int(m[1]):04d}-{int(m[2]):02d}-01'
    m = re.search(r'(\d{4})年(\d{1,2})月(\d{1,2})日(?:收市|收盘)后生效', t)
    if m:
        return (datetime.date(int(m[1]), int(m[2]), int(m[3])) + datetime.timedelta(days=1)).isoformat()
    m = (re.search(r'于(\d{4})年(\d{1,2})月(\d{1,2})日(?:起)?(?:正式)?(?:调整|生效|实施)', t)
         or re.search(r'(\d{4})年(\d{1,2})月(\d{1,2})日(?:起)?(?:正式)?生效', t))
    if m:
        return datetime.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    m = re.search(r'于(\d{1,2})月(\d{1,2})日(?:起)?(?:调整|生效)', t)
    if m:
        return datetime.date(int(publish[:4]), int(m[1]), int(m[2])).isoformat()
    return None


def regular_events(cache, skip=()):
    """定期调整：搜索标题含"沪深300"的公告，解析正文或附件中的沪深300 调整名单。"""
    items, p = [], 1
    q = urllib.parse.quote('沪深300')
    while True:
        d = cache.json(f'search_{p}', f'{API}/search/search-content?lang=cn&searchInput={q}&pageNum={p}&pageSize=50&sortField=date&dateRange=all&contentType=announcement')
        items += d['data']
        if not d['data'] or len(items) >= d['total']:
            break
        p += 1
    events = []
    for x in items:
        title = re.sub('<[^>]+>', '', x['headline'])
        if '调整' not in title or re.search(r'规则|精明|优选|风格|行业|主题|价值|红利|ESG|等权重月度|答记者问|空间', title):
            continue
        aid = str(x['id'])
        if aid in SKIP_IDS or aid in skip:
            continue
        d = cache.json(f'ann_{aid}', f'{API}/announcement/queryAnnouncementById?id={aid}')['data']
        if not d:
            continue
        rows = html_rows(d['content'])
        outs, ins = wide_rows(rows)
        if not outs and not ins and not re.search(r'中证|上证|深证|香港', title.replace('沪深300', '')):
            outs, ins = wide_rows(rows, force=True)  # 只涉及沪深300 的公告常常没有分表标题
        files = [e['fileUrl'] for e in d.get('enclosureList') or []]
        files += [u for u in re.findall(r'href="([^"]+)"', d['content'] or '') if re.search(r'\.(xlsx?|pdf)$', u, re.I)]
        for k, u in enumerate(files):
            if u.startswith('/'):
                u = 'https://www.csindex.com.cn' + u
            fn = cache.file(f'att_{aid}_{k}{os.path.splitext(u)[1].lower()}', u)
            try:
                o, i = parse_file(fn)
            except Exception as e:  # noqa: BLE001 个别附件损坏时跳过，由最终校验兜底
                print('附件解析失败', aid, u, e, file=sys.stderr)
                continue
            if o or i:
                outs, ins = o, i
                break
        if not outs and not ins:
            continue
        text = title + re.sub(r'<[^>]+>', '', d['content'] or '')
        m = re.search(r'沪深300(?:指数)?(?:更换|调整)(\d+)只', norm(text))
        outs, ins = sorted(set(outs)), sorted(set(ins))
        if m and (len(outs) != int(m[1]) or len(ins) != int(m[1])):
            raise SystemExit(f'公告 {aid}（{d["publishDate"]}）写明更换 {m[1]} 只，解析出调出 {len(outs)}、调入 {len(ins)}')
        if len(outs) != len(ins):
            continue  # 只有单边的多为临时调整，按 hs300_adhoc.json 处理
        eff = eff_date(text, d['publishDate'])
        if not eff:
            raise SystemExit(f'公告 {aid}（{d["publishDate"]}）解析不到生效日期')
        events.append({'id': aid, 'eff': eff, 'out': outs, 'in': ins, 'kind': 'regular'})
    return events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(ROOT, '.cache', 'csindex'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'docs', 'data', 'hs300_members.json'))
    args = ap.parse_args()
    cache = Cache(args.cache)

    base = cache.json(f'ann_{BASE_ID}', f'{API}/announcement/queryAnnouncementById?id={BASE_ID}')['data']
    start = set(re.findall(r'(?<![\d.])(\d{6})(?![\d])', re.sub('<[^>]+>', ' ', base['content']))) | BASE_EXTRA
    if len(start) != 300:
        raise SystemExit(f'起点名单 {len(start)} 只，应为 300')
    adhoc = json.load(open(os.path.join(ROOT, 'tools', 'hs300_adhoc.json'), encoding='utf-8'))
    manual = {e['id'].rstrip('b') for e in adhoc}
    # 人工核对过的临时调整优先；自动解析里同一公告的结果丢弃（多指数混排的正文表格容易误读）
    events = [dict(e, kind='adhoc') for e in adhoc if e['eff']] + regular_events(cache, manual)
    events.sort(key=lambda e: (e['eff'], e['kind'] == 'regular'))

    # 推演并校验
    S = set(start)
    iv = {c: [['2005-07-01', None]] for c in sorted(start)}
    for e in events:
        bad_out = [c for c in e['out'] if c not in S]
        bad_in = [c for c in e['in'] if c in S]
        S -= set(e['out']); S |= set(e['in'])
        if bad_out or bad_in or len(S) != 300:
            raise SystemExit(f'{e["eff"]} 公告 {e["id"]}：调出的不在指数内 {bad_out}，调入的已在指数内 {bad_in}，调整后 {len(S)} 只')
        for c in e['out']:
            iv[c][-1][1] = e['eff']
        for c in e['in']:
            iv.setdefault(c, []).append([e['eff'], None])

    fn = cache.file('000300cons.xls', CONS)
    import xlrd
    sh = xlrd.open_workbook(fn).sheets()[0]
    head = [str(h) for h in sh.row_values(0)]
    ci = next(i for i, h in enumerate(head) if '成份券代码' in h or '成分券代码' in h)
    as_of = str(sh.row_values(1)[0])
    cur = {str(sh.row_values(i)[ci]).split('.')[0].zfill(6) for i in range(1, sh.nrows)}
    if cur != S:
        raise SystemExit(f'推演结果与当前成分表（{as_of}）不一致：多出 {sorted(S - cur)}，缺少 {sorted(cur - S)}。'
                         '通常是有新的临时调整，请补充 tools/hs300_adhoc.json')

    delisted = {}
    for e in adhoc:
        if e.get('delist') and e['eff']:
            for c in e['out']:
                delisted[c] = e['eff']
    out = {
        'index': '000300',
        'name': '沪深300',
        'asOf': f'{as_of[:4]}-{as_of[4:6]}-{as_of[6:8]}',
        'source': '中证指数有限公司历次样本调整公告，经逐步推演校验（每步 300 只，结果与当前成分表一致）',
        'note': '区间 [纳入日, 剔除日)：纳入日当天起为成分，剔除日当天起不再是成分；null 表示至今仍在',
        'events': len(events),
        'pending': [{'id': e['id'], 'out': e['out'], 'in': e['in'], 'note': e['note']} for e in adhoc if not e['eff']],
        'delisted': delisted,
        'members': {c: iv[c] for c in sorted(iv)},
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(events)} 次调整，{len(iv)} 只股票曾为成分，当前 {len(S)} 只（{out["asOf"]}），写入 {args.out}')


if __name__ == '__main__':
    main()
