'use strict';
/**
 * gas/Code.gs の自動テスト（Node標準のみ）。
 *   node harness/run-tests.js
 * 固定日 2026-09-12 で動かす。サンプルの先月分は 2026-08、今月分は 2026-09。
 */
const assert = require('assert');
const { loadCode } = require('./load-code');

const NOW = new Date('2026-09-12T10:00:00+09:00').getTime();
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message : e)); }
}
function fresh(userEmail) {
  const app = loadCode({ nowMs: NOW, userEmail: userEmail || 'demo-input@example.jp' });
  app.context.apiBootstrap();
  return app;
}
function throwsWith(fn, substr) {
  let msg = '';
  try { fn(); } catch (e) { msg = e.message || String(e); }
  assert.ok(msg.indexOf(substr) >= 0, '期待した文言「' + substr + '」が無い。実際: ' + (msg || '(例外なし)'));
}

console.log('受発注・売上・請求管理 Code.gs テスト');

test('起動でマスタ3種と台帳が作られ、サンプルが入る', () => {
  const app = fresh();
  const b = app.context.apiBootstrap();
  assert.strictEqual(b.clients.length, 5);
  assert.strictEqual(b.items.length, 7);
  assert.strictEqual(b.company['名称'].length > 0, true);
  assert.strictEqual(b.today, '2026-09-12');
  assert.strictEqual(b.user.role, '入力', 'demo-input は入力');
  assert.strictEqual(b.user.name, '事務 田中');
  assert.strictEqual(app.ss.getSheets().length, 11);
});

test('必須未入力は保存できず、理由が全部返る', () => {
  const c = fresh().context;
  throwsWith(() => c.apiSaveQuote({ clientId: '', title: '', lines: [] }), '取引先を選んでください');
  throwsWith(() => c.apiSaveQuote({ clientId: '', title: '', lines: [] }), '件名を入力してください');
  throwsWith(() => c.apiSaveQuote({ clientId: '', title: '', lines: [] }), '明細を1行以上');
  throwsWith(() => c.apiSaveQuote({ clientId: 'C-2026-0001', title: 'x', lines: [{ name: '', qty: 0, price: '', taxRate: 5 }] }), '1行目: 品名が空です');
  throwsWith(() => c.apiSaveQuote({ clientId: 'C-2026-0001', title: 'x', lines: [{ name: 'a', qty: 0, price: 1, taxRate: 10 }] }), '数量は1以上');
  throwsWith(() => c.apiSaveQuote({ clientId: 'C-2026-0001', title: 'x', lines: [{ name: 'a', qty: 1, price: '', taxRate: 10 }] }), '単価を入力');
  throwsWith(() => c.apiSaveQuote({ clientId: 'C-2026-0001', title: 'x', lines: [{ name: 'a', qty: 1, price: 1, taxRate: 5 }] }), '税率は 10 か 8');
  throwsWith(() => c.apiSaveQuote({ clientId: 'C-9999-0000', title: 'x', lines: [{ name: 'a', qty: 1, price: 1, taxRate: 10 }] }), 'マスタにありません');
});

test('見積の保存で採番され、税率ごとに1回丸めた合計になる', () => {
  const c = fresh().context;
  const r = c.apiSaveQuote({ clientId: 'C-2026-0001', title: 'テスト工事', date: '2026-09-12', lines: [
    { itemId: 'M-2026-0001', name: '作業員（技術）', qty: 3, unit: '人日', price: 28000, taxRate: 10 },
    { itemId: '', name: '軽減税率の品', qty: 3, unit: '個', price: 333, taxRate: 8 }
  ] });
  assert.strictEqual(r.quoteNo, 'Q-2026-0004', 'サンプルが Q-0001〜0003 なので次は 0004');
  assert.strictEqual(r.ver, 1);
  // 10%: 84000 → 税8400。8%: 999 → 税 floor(79.92)=79
  assert.deepStrictEqual([r.totals.subtotal, r.totals.tax, r.totals.total], [84999, 8479, 93478]);
  const q = c.apiGetQuote('Q-2026-0004');
  assert.strictEqual(q.lines.length, 2);
  assert.strictEqual(q['有効期限'], '2026-10-12');
  assert.strictEqual(q['状態'], '作成中');
});

test('同じ取引先・件名・日付は重複の警告で止まり、force で別件として保存できる', () => {
  const c = fresh().context;
  const p = { clientId: 'C-2026-0002', title: '同じ件名', date: '2026-09-12', lines: [{ name: 'a', qty: 1, price: 1000, taxRate: 10 }] };
  const r1 = c.apiSaveQuote(p);
  assert.ok(r1.quoteNo);
  const r2 = c.apiSaveQuote(p);
  assert.ok(r2.warning && r2.warning.kind === 'duplicate', '2回目は警告');
  assert.strictEqual(r2.warning.existing, r1.quoteNo);
  const r3 = c.apiSaveQuote(Object.assign({}, p, { force: true }));
  assert.notStrictEqual(r3.quoteNo, r1.quoteNo);
});

test('保存済み見積を quoteNo 付きで保存すると改訂版（版+1）になり、一覧は最新版だけ', () => {
  const c = fresh().context;
  const r1 = c.apiSaveQuote({ clientId: 'C-2026-0001', title: '改訂テスト', date: '2026-09-12', lines: [{ name: 'a', qty: 1, price: 1000, taxRate: 10 }] });
  const r2 = c.apiSaveQuote({ quoteNo: r1.quoteNo, clientId: 'C-2026-0001', title: '改訂テスト', date: '2026-09-12', lines: [{ name: 'a', qty: 2, price: 1000, taxRate: 10 }], force: true });
  assert.strictEqual(r2.quoteNo, r1.quoteNo);
  assert.strictEqual(r2.ver, 2);
  const list = c.apiListQuotes().filter(q => q['見積番号'] === r1.quoteNo);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(Number(list[0]['版']), 2);
  assert.strictEqual(Number(list[0]['小計']), 2000);
});

test('受注確定で案件番号が付き、見積は受注になり、二重確定はできない', () => {
  const c = fresh().context;
  const r = c.apiSaveQuote({ clientId: 'C-2026-0001', title: '受注テスト', date: '2026-09-12', lines: [{ name: 'a', qty: 2, price: 50000, taxRate: 10 }] });
  const o = c.apiConfirmOrder(r.quoteNo, { orderDate: '2026-09-12', due: '2026-09-30' });
  assert.strictEqual(o.orderNo, 'J-2026-0004', 'サンプルが J-0001〜0003 なので次は 0004');
  assert.strictEqual(o.amount, 100000);
  assert.strictEqual(c.apiGetQuote(r.quoteNo)['状態'], '受注');
  throwsWith(() => c.apiConfirmOrder(r.quoteNo), '既に受注済み');
  throwsWith(() => c.apiSaveQuote({ quoteNo: r.quoteNo, clientId: 'C-2026-0001', title: '受注テスト', date: '2026-09-12', lines: [{ name: 'a', qty: 1, price: 1, taxRate: 10 }], force: true }), '受注済みの見積は改訂できません');
  const orders = c.apiListOrders();
  assert.ok(orders.some(x => x['案件番号'] === 'J-2026-0004' && x['見積番号'] === r.quoteNo));
});

test('見積なしの直接受注が登録できる', () => {
  const c = fresh().context;
  throwsWith(() => c.apiDirectOrder({ clientId: '', title: '', amount: '' }), '取引先を選んでください');
  const o = c.apiDirectOrder({ clientId: 'C-2026-0002', title: '電話注文', amount: 30000 });
  assert.strictEqual(o.orderNo, 'J-2026-0004');
  const rows = c.apiListProjects();
  assert.ok(rows.some(p => p.orderNo === 'J-2026-0004' && p.quoteNo === '' && p.stage === '受注'));
});

test('売上計上: 全額は残額を計上し、超過は止まり、全額後の再計上は止まる', () => {
  const c = fresh().context;
  const r = c.apiSaveQuote({ clientId: 'C-2026-0001', title: '売上テスト', date: '2026-09-12', lines: [{ name: 'a', qty: 1, price: 100000, taxRate: 10 }] });
  const o = c.apiConfirmOrder(r.quoteNo);
  throwsWith(() => c.apiRecordSales({ orderNo: o.orderNo, amount: 150000, full: false }), '未計上の残額');
  const s1 = c.apiRecordSales({ orderNo: o.orderNo, amount: 40000, full: false, date: '2026-09-12' });
  assert.strictEqual(s1.remain, 60000);
  const s2 = c.apiRecordSales({ orderNo: o.orderNo, full: true, date: '2026-09-12' });
  assert.strictEqual(s2.amount, 60000);
  assert.strictEqual(s2.remain, 0);
  throwsWith(() => c.apiRecordSales({ orderNo: o.orderNo, full: true }), '全額計上済み');
  const order = c.apiListOrders().filter(x => x['案件番号'] === o.orderNo)[0];
  assert.strictEqual(order['状態'], '納品済');
});

test('締め日の計算: 月末締めと20日締め', () => {
  const c = fresh().context;
  assert.strictEqual(c.closingDateFor_('2026-09-05', '末'), '2026-09-30');
  assert.strictEqual(c.closingDateFor_('2026-09-05', '20'), '2026-09-20');
  assert.strictEqual(c.closingDateFor_('2026-09-25', '20'), '2026-10-20');
  assert.strictEqual(c.closingDateFor_('2026-02-10', '末'), '2026-02-28');
  assert.strictEqual(c.periodLabel_('2026-09-30', '末'), '2026-09 分');
  assert.strictEqual(c.periodLabel_('2026-09-20', '20'), '2026-08-21 〜 2026-09-20');
});

test('支払期限: 翌月末・翌々月末・翌月20日・日数', () => {
  const c = fresh().context;
  assert.strictEqual(c.paymentDue_('2026-09-30', '翌月末'), '2026-10-31');
  assert.strictEqual(c.paymentDue_('2026-09-30', '翌々月末'), '2026-11-30');
  assert.strictEqual(c.paymentDue_('2026-09-30', '翌月20日'), '2026-10-20');
  assert.strictEqual(c.paymentDue_('2026-09-30', '30'), '2026-10-30');
});

test('締め処理の対象: 締め日≦今日のものだけ、随時請求は案件ごと、まだ来ていない締め日は理由つきで対象外', () => {
  const c = fresh().context;
  // サンプル: S-0002 C-0003(随時) 2026-09-05 / S-0003 C-0002(20日締め) 2026-08-18 → 締め日 2026-08-20
  throwsWith(() => c.apiClosingPreview('2026-09-30'), '今日（2026-09-12）より後の日付は指定できません');
  const p1 = c.apiClosingPreview('2026-08-19');
  assert.strictEqual(p1.groups.length, 0, '8/19 時点では 8/20 締めはまだ。随時の売上は 9/5 なので範囲外');
  assert.strictEqual(p1.skipped.length, 1);
  assert.ok(p1.skipped[0].reason.indexOf('2026-08-20') >= 0, '20日締めの理由に締め日が出る');
  const p2 = c.apiClosingPreview('2026-09-12');
  assert.strictEqual(p2.groups.length, 2);
  assert.strictEqual(p2.skipped.length, 0);
  const g2 = p2.groups.filter(g => g.clientId === 'C-2026-0002')[0];
  assert.strictEqual(g2.mode, '締め');
  assert.strictEqual(g2.period, '2026-07-21 〜 2026-08-20');
  assert.deepStrictEqual([g2.subtotal, g2.tax, g2.total], [64000, 6400, 70400]);
  const g3 = p2.groups.filter(g => g.clientId === 'C-2026-0003')[0];
  assert.strictEqual(g3.mode, '随時');
  assert.strictEqual(g3.orderNo, 'J-2026-0002');
  // 今日の月末締めの売上を足すと、対象外として理由が出る
  const r = c.apiSaveQuote({ clientId: 'C-2026-0001', title: '9月の作業', date: '2026-09-12', lines: [{ name: '作業', qty: 1, price: 100000, taxRate: 10 }] });
  const o = c.apiConfirmOrder(r.quoteNo);
  c.apiRecordSales({ orderNo: o.orderNo, full: true, date: '2026-09-12' });
  const p3 = c.apiClosingPreview('2026-09-12');
  assert.strictEqual(p3.groups.length, 2);
  assert.strictEqual(p3.skipped.length, 1);
  assert.ok(p3.skipped[0].reason.indexOf('2026-09-30') >= 0 && p3.skipped[0].reason.indexOf('まだ来ていない') >= 0, p3.skipped[0].reason);
});

test('請求書の発行: 対象分だけ発行、売上に請求番号が付き、再実行は0件、発行済みは再表示できる', () => {
  const app = fresh();
  const c = app.context;
  const r = c.apiSaveQuote({ clientId: 'C-2026-0001', title: '9月の作業', date: '2026-09-12', lines: [{ name: '作業', qty: 1, price: 100000, taxRate: 10 }] });
  const o = c.apiConfirmOrder(r.quoteNo);
  c.apiRecordSales({ orderNo: o.orderNo, full: true, date: '2026-09-12' });
  throwsWith(() => c.apiIssueInvoices('2026-10-31'), '今日（2026-09-12）より後');
  const res = c.apiIssueInvoices('2026-09-12');
  assert.strictEqual(res.count, 2, 'C-0002(20日締め・8/20分) と C-0003(随時) の2件。C-0001(月末) はまだ');
  const nos = Array.from(res.issued, i => i.invNo).sort();
  assert.deepStrictEqual(nos, ['I-2026-0002', 'I-2026-0003'], 'サンプル I-0001 の続きで採番');
  assert.ok(res.issued.every(i => /^\/pdf\//.test(i.url)), 'PDFの保存先が返る');
  assert.ok(res.issued.every(i => i.html.indexOf('請求書') >= 0 && i.html.indexOf('登録番号') >= 0));
  const unbilled = c.apiListSales(true);
  assert.strictEqual(unbilled.length, 1, '月末締めの1件だけ未請求で残る');
  const again = c.apiIssueInvoices('2026-09-12');
  assert.strictEqual(again.count, 0);
  assert.strictEqual(again.message, '請求対象はありません');
  const inv = c.apiListInvoices();
  assert.strictEqual(inv.length, 3);
  const shown = c.apiInvoicePdf('I-2026-0002');
  assert.ok(shown.html.indexOf('I-2026-0002') >= 0);
  // 発行した案件は請求済み、月末締めの案件はまだ売上計上のまま
  const order3 = c.apiListOrders().filter(x => x['案件番号'] === 'J-2026-0003')[0];
  assert.strictEqual(order3['状態'], '請求済');
  const proj = c.apiListProjects().filter(p => p.orderNo === o.orderNo)[0];
  assert.strictEqual(proj.stage, '納品・売上計上');
  assert.strictEqual(proj.unbilled, 1);
  // 出力履歴
  assert.strictEqual(app.ss.getSheetByName('出力履歴').rows().length, 3, '請求書2件＋再表示1件');
});

test('注文書PDF: 発注を登録して注文書を出せる', () => {
  const app = fresh();
  const c = app.context;
  const p = c.apiAddPurchase({ orderNo: 'J-2026-0002', supplierId: 'C-2026-0005', detail: '制御盤 取付金具', amount: 12000 });
  const pdf = c.apiPurchasePdf(p.poNo);
  assert.ok(pdf.html.indexOf('注文書') >= 0 && pdf.html.indexOf(p.poNo) >= 0 && pdf.html.indexOf('関東部材センター') >= 0 && pdf.html.indexOf('13,200') >= 0, '税込 13,200');
  throwsWith(() => c.apiPurchasePdf('P-9999-0000'), '見つかりません');
  assert.strictEqual(app.ss.getSheetByName('出力履歴').rows().length, 1);
});

test('利用者と権限: サンプルは管理1・入力1・閲覧1。変更できるのは管理だけ', () => {
  const app = fresh('demo-admin@example.jp');
  const c = app.context;
  assert.strictEqual(c.apiListUsers().length, 3);
  assert.strictEqual(c.apiBootstrap().user.role, '管理');
  c.apiSaveUser({ email: 'new@example.jp', name: '新人', role: '閲覧' });
  assert.strictEqual(c.apiListUsers().length, 4);
  throwsWith(() => c.apiSaveUser({ email: 'x@example.jp', role: '神' }), '権限は 管理 / 入力 / 閲覧');
  const app2 = fresh('demo-input@example.jp');
  throwsWith(() => app2.context.apiSaveUser({ email: 'y@example.jp', role: '入力' }), '管理権限の人だけ');
  // 管理は入力操作もできる
  const r = c.apiSaveQuote({ clientId: 'C-2026-0001', title: '管理者の見積', date: '2026-09-12', lines: [{ name: 'a', qty: 1, price: 1, taxRate: 10 }] });
  assert.ok(r.quoteNo);
});

test('見積書PDFを出すと状態が提出済になり、出力履歴に残る', () => {
  const app = fresh();
  const c = app.context;
  const r = c.apiSaveQuote({ clientId: 'C-2026-0004', title: 'PDFテスト', date: '2026-09-12', lines: [{ name: 'a', qty: 1, price: 1000, taxRate: 10 }] });
  const pdf = c.apiQuotePdf(r.quoteNo, r.ver);
  assert.ok(pdf.html.indexOf('御見積書') >= 0 && pdf.html.indexOf(r.quoteNo) >= 0);
  assert.strictEqual(c.apiGetQuote(r.quoteNo)['状態'], '提出済');
  assert.strictEqual(app.ss.getSheetByName('出力履歴').rows().length, 1);
});

test('閲覧権限の利用者は入力操作が止まる', () => {
  const app = fresh('demo-view@example.jp');
  const c = app.context;
  assert.strictEqual(c.apiBootstrap().user.role, '閲覧');
  throwsWith(() => c.apiSaveQuote({ clientId: 'C-2026-0001', title: 'x', lines: [{ name: 'a', qty: 1, price: 1, taxRate: 10 }] }), '入力権限が必要');
  throwsWith(() => c.apiIssueInvoices('2026-09-30'), '入力権限が必要');
  assert.ok(c.apiListProjects().length > 0, '閲覧はできる');
});

test('発注の登録と案件別の一覧', () => {
  const c = fresh().context;
  throwsWith(() => c.apiAddPurchase({ orderNo: 'J-2026-0001', supplierId: '', detail: '', amount: '' }), '仕入先を選んでください');
  const p = c.apiAddPurchase({ orderNo: 'J-2026-0001', supplierId: 'C-2026-0005', detail: '追加部材', amount: 5000 });
  assert.strictEqual(p.poNo, 'P-2026-0003');
  assert.strictEqual(c.apiListPurchases('J-2026-0001').length, 2);
});

test('売上集計: 月別と取引先別、未請求件数', () => {
  const c = fresh().context;
  const s = c.apiSalesSummary();
  assert.strictEqual(s.months.filter(m => m.month === '2026-08')[0].amount, 216000 + 64000);
  assert.strictEqual(s.months.filter(m => m.month === '2026-09')[0].amount, 184000);
  assert.strictEqual(s.unbilled, 2);
  assert.strictEqual(s.clients[0].amount >= s.clients[s.clients.length - 1].amount, true);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
