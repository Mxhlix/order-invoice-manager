/**
 * 受発注・売上・請求管理システム（Google Apps Script Webアプリ）
 *
 * 保存先: このスクリプトが紐付くGoogleスプレッドシート（マスタ3種＋台帳6種）
 * 画面:   Index.html（HtmlService）。台帳シートは画面からだけ触る
 *
 * 台帳
 *   取引先 / 品目 / 自社情報 / 利用者
 *   見積 / 見積明細 / 受注 / 発注 / 売上 / 請求 / 出力履歴
 */

var CONFIG = {
  TIMEZONE: 'Asia/Tokyo',
  PDF_FOLDER: '帳票出力',
  DEMO_MODE: true,          // true のとき、台帳が空なら setupDemoData_() でサンプルを入れる
  QUOTE_VALID_DAYS: 30,
  TAX_RATES: [10, 8]
};

var SHEETS = {
  clients:  { name: '取引先',   headers: ['取引先ID', '名称', '敬称', '郵便番号', '住所', '担当者', '締め日', '支払条件', '請求方式', '備考'] },
  items:    { name: '品目',     headers: ['品目ID', '品名', '規格', '単位', '標準単価', '税率', '備考'] },
  company:  { name: '自社情報', headers: ['項目', '値'] },
  users:    { name: '利用者',   headers: ['メール', '表示名', '権限'] },
  quotes:   { name: '見積',     headers: ['見積番号', '版', '取引先ID', '件名', '見積日', '有効期限', '小計', '消費税', '合計', '状態', '案件番号', '作成者', '作成日時', '備考'] },
  qlines:   { name: '見積明細', headers: ['見積番号', '版', '行', '品目ID', '品名', '規格', '数量', '単位', '単価', '税率', '金額'] },
  orders:   { name: '受注',     headers: ['案件番号', '見積番号', '取引先ID', '件名', '受注日', '納期', '金額(税抜)', '状態', '注文書URL', '登録者', '登録日時', '備考'] },
  pos:      { name: '発注',     headers: ['発注番号', '案件番号', '仕入先ID', '内容', '金額(税抜)', '税率', '発注日', '状態', '登録者', '登録日時'] },
  sales:    { name: '売上',     headers: ['売上ID', '案件番号', '取引先ID', '売上日', '内容', '金額(税抜)', '税率', '請求番号', '登録者', '登録日時'] },
  invoices: { name: '請求',     headers: ['請求番号', '取引先ID', '請求方式', '締め日', '対象期間', '小計', '消費税', '合計', '発行日', '支払期限', 'PDF', '状態', '発行者', '発行日時'] },
  outlog:   { name: '出力履歴', headers: ['日時', '帳票', '番号', '取引先ID', '利用者', 'URL'] }
};

/* ============================================================
 * 画面
 * ============================================================ */

function doGet() {
  ensureSheets_();
  var t = HtmlService.createTemplateFromFile('Index');
  return t.evaluate()
    .setTitle('受発注・売上・請求管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** 画面の初期表示に必要なものを1回で返す */
function apiBootstrap() {
  ensureSheets_();
  var user = currentUser_();
  return {
    user: user,
    company: readCompany_(),
    clients: readClients_(),
    items: readItems_(),
    today: fmtDate_(new Date())
  };
}

/* ============================================================
 * 一覧
 * ============================================================ */

/** 案件一覧: 見積から請求までの進み具合を1行で返す */
function apiListProjects() {
  var quotes = readRows_(SHEETS.quotes);
  var orders = readRows_(SHEETS.orders);
  var sales = readRows_(SHEETS.sales);
  var invoices = readRows_(SHEETS.invoices);
  var clients = indexBy_(readClients_(), 'id');

  var orderByQuote = {};
  orders.forEach(function (o) { if (o['見積番号']) orderByQuote[o['見積番号']] = o; });
  var salesByOrder = {};
  sales.forEach(function (s) { (salesByOrder[s['案件番号']] = salesByOrder[s['案件番号']] || []).push(s); });
  var invoiceByNo = indexBy_(invoices, '請求番号');

  var rows = [];
  // 見積から始まった案件
  latestQuotes_(quotes).forEach(function (q) {
    var o = orderByQuote[q['見積番号']];
    rows.push(projectRow_(q, o, o ? (salesByOrder[o['案件番号']] || []) : [], invoiceByNo, clients));
  });
  // 見積無しの直接受注
  orders.filter(function (o) { return !o['見積番号']; }).forEach(function (o) {
    rows.push(projectRow_(null, o, salesByOrder[o['案件番号']] || [], invoiceByNo, clients));
  });
  rows.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return rows;
}

function projectRow_(q, o, sales, invoiceByNo, clients) {
  var clientId = o ? o['取引先ID'] : q['取引先ID'];
  var c = clients[clientId] || {};
  var stage = '見積作成中';
  if (q && q['状態'] === '提出済') stage = '見積提出済';
  if (q && q['状態'] === '失注') stage = '失注';
  if (o) stage = '受注';
  if (o && sales.length) stage = '納品・売上計上';
  var invNos = sales.map(function (s) { return s['請求番号']; }).filter(String);
  if (o && sales.length && invNos.length === sales.length) stage = '請求済';
  var lastInv = invNos.length ? invoiceByNo[invNos[invNos.length - 1]] : null;
  return {
    quoteNo: q ? q['見積番号'] : '',
    quoteVer: q ? q['版'] : '',
    orderNo: o ? o['案件番号'] : '',
    clientId: clientId,
    clientName: c.name || clientId,
    title: o ? o['件名'] : q['件名'],
    amount: o ? Number(o['金額(税抜)']) : Number(q['小計']),
    date: o ? o['受注日'] : q['見積日'],
    due: o ? o['納期'] : q['有効期限'],
    stage: stage,
    invoiceNo: lastInv ? lastInv['請求番号'] : (invNos[0] || ''),
    unbilled: sales.filter(function (s) { return !s['請求番号']; }).length
  };
}

/** 月別・取引先別の売上集計（税抜） */
function apiSalesSummary() {
  var sales = readRows_(SHEETS.sales);
  var clients = indexBy_(readClients_(), 'id');
  var byMonth = {};
  var byClient = {};
  sales.forEach(function (s) {
    var m = String(s['売上日']).slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + Number(s['金額(税抜)']);
    byClient[s['取引先ID']] = (byClient[s['取引先ID']] || 0) + Number(s['金額(税抜)']);
  });
  return {
    months: Object.keys(byMonth).sort().map(function (m) { return { month: m, amount: byMonth[m] }; }),
    clients: Object.keys(byClient).map(function (id) {
      return { clientId: id, clientName: (clients[id] || {}).name || id, amount: byClient[id] };
    }).sort(function (a, b) { return b.amount - a.amount; }),
    unbilled: sales.filter(function (s) { return !s['請求番号']; }).length
  };
}

/* ============================================================
 * 見積
 * ============================================================ */

function apiListQuotes() {
  var clients = indexBy_(readClients_(), 'id');
  return latestQuotes_(readRows_(SHEETS.quotes)).map(function (q) {
    q.clientName = (clients[q['取引先ID']] || {}).name || q['取引先ID'];
    return q;
  }).sort(function (a, b) { return String(b['作成日時']).localeCompare(String(a['作成日時'])); });
}

function apiGetQuote(quoteNo, ver) {
  var q = readRows_(SHEETS.quotes).filter(function (r) {
    return r['見積番号'] === quoteNo && (!ver || Number(r['版']) === Number(ver));
  }).sort(function (a, b) { return Number(b['版']) - Number(a['版']); })[0];
  if (!q) throw new Error('見積 ' + quoteNo + ' が見つかりません');
  q.lines = readRows_(SHEETS.qlines).filter(function (l) {
    return l['見積番号'] === q['見積番号'] && Number(l['版']) === Number(q['版']);
  }).sort(function (a, b) { return Number(a['行']) - Number(b['行']); });
  return q;
}

/**
 * 見積の保存。quoteNo が空なら新規採番、あれば改訂版（版+1）を作る。
 * payload: { quoteNo, clientId, title, date, note, lines:[{itemId,name,spec,qty,unit,price,taxRate}], force }
 * 戻り: { quoteNo, ver, totals } または { warning:{...} }（重複の可能性。force=true で保存）
 */
function apiSaveQuote(payload) {
  requireRole_('入力');
  var errors = validateQuote_(payload);
  if (errors.length) throw new Error(errors.join('\n'));

  var dup = findDuplicateQuote_(payload);
  if (dup && !payload.force) {
    return { warning: { kind: 'duplicate', message: '同じ取引先・同じ件名の見積が同じ日に登録されています（' + dup['見積番号'] + ' 版' + dup['版'] + '）。改訂なら「改訂版として保存」を、別件なら「別件として保存」を選んでください。', existing: dup['見積番号'] } };
  }

  var totals = computeTotals_(payload.lines);
  var user = currentUser_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var quoteNo = payload.quoteNo;
    var ver = 1;
    if (quoteNo) {
      var prev = readRows_(SHEETS.quotes).filter(function (r) { return r['見積番号'] === quoteNo; });
      if (!prev.length) throw new Error('見積 ' + quoteNo + ' が見つかりません');
      if (prev.some(function (r) { return r['状態'] === '受注'; })) throw new Error('受注済みの見積は改訂できません。受注の変更として登録してください');
      ver = Math.max.apply(null, prev.map(function (r) { return Number(r['版']); })) + 1;
    } else {
      quoteNo = nextNumber_(SHEETS.quotes, '見積番号', 'Q');
    }
    var date = payload.date || fmtDate_(new Date());
    var valid = addDays_(date, CONFIG.QUOTE_VALID_DAYS);
    appendRow_(SHEETS.quotes, {
      '見積番号': quoteNo, '版': ver, '取引先ID': payload.clientId, '件名': payload.title,
      '見積日': date, '有効期限': valid, '小計': totals.subtotal, '消費税': totals.tax, '合計': totals.total,
      '状態': '作成中', '案件番号': '', '作成者': user.name, '作成日時': fmtDateTime_(new Date()), '備考': payload.note || ''
    });
    payload.lines.forEach(function (l, i) {
      appendRow_(SHEETS.qlines, {
        '見積番号': quoteNo, '版': ver, '行': i + 1, '品目ID': l.itemId || '', '品名': l.name, '規格': l.spec || '',
        '数量': Number(l.qty), '単位': l.unit || '', '単価': Number(l.price), '税率': Number(l.taxRate), '金額': Math.round(Number(l.qty) * Number(l.price))
      });
    });
    return { quoteNo: quoteNo, ver: ver, totals: totals };
  } finally {
    lock.releaseLock();
  }
}

function validateQuote_(p) {
  var errors = [];
  if (!p || !p.clientId) errors.push('取引先を選んでください');
  if (!p || !String(p.title || '').trim()) errors.push('件名を入力してください');
  if (!p || !p.lines || !p.lines.length) errors.push('明細を1行以上入力してください');
  (p && p.lines || []).forEach(function (l, i) {
    var n = i + 1;
    if (!String(l.name || '').trim()) errors.push(n + '行目: 品名が空です');
    if (!(Number(l.qty) > 0)) errors.push(n + '行目: 数量は1以上を入力してください');
    if (!(Number(l.price) >= 0) || l.price === '' || l.price === null || l.price === undefined) errors.push(n + '行目: 単価を入力してください');
    if (CONFIG.TAX_RATES.indexOf(Number(l.taxRate)) < 0) errors.push(n + '行目: 税率は 10 か 8 を選んでください');
  });
  if (p && p.clientId) {
    var ok = readClients_().some(function (c) { return c.id === p.clientId; });
    if (!ok) errors.push('取引先 ' + p.clientId + ' はマスタにありません');
  }
  return errors;
}

function findDuplicateQuote_(p) {
  var date = p.date || fmtDate_(new Date());
  var hit = latestQuotes_(readRows_(SHEETS.quotes)).filter(function (q) {
    return q['取引先ID'] === p.clientId && String(q['件名']).trim() === String(p.title).trim() &&
      String(q['見積日']) === date && q['見積番号'] !== p.quoteNo;
  });
  return hit[0] || null;
}

function apiSetQuoteStatus(quoteNo, status) {
  requireRole_('入力');
  if (['作成中', '提出済', '失注'].indexOf(status) < 0) throw new Error('状態 ' + status + ' は指定できません');
  var updated = 0;
  readRows_(SHEETS.quotes).forEach(function (q) {
    if (q['見積番号'] === quoteNo && q['状態'] !== '受注') { updateRow_(SHEETS.quotes, q.__row, { '状態': status }); updated++; }
  });
  if (!updated) throw new Error('見積 ' + quoteNo + ' が見つかりません（受注済みは変更できません）');
  return { quoteNo: quoteNo, status: status };
}

/** 見積書PDF */
function apiQuotePdf(quoteNo, ver) {
  var q = apiGetQuote(quoteNo, ver);
  var c = clientById_(q['取引先ID']);
  var html = buildQuoteHtml_(q, c, readCompany_());
  var file = savePdf_('見積書_' + q['見積番号'] + '_v' + q['版'] + '_' + safeName_(c.name) + '.pdf', html);
  if (q['状態'] === '作成中') apiSetQuoteStatus(quoteNo, '提出済');
  logOutput_('見積書', q['見積番号'] + ' 版' + q['版'], c.id, file.url);
  return { url: file.url, name: file.name, html: html, quoteNo: q['見積番号'], ver: q['版'] };
}

/* ============================================================
 * 受注
 * ============================================================ */

/** 見積から受注を確定する */
function apiConfirmOrder(quoteNo, payload) {
  requireRole_('入力');
  payload = payload || {};
  var q = apiGetQuote(quoteNo);
  if (q['状態'] === '受注') throw new Error('見積 ' + quoteNo + ' は既に受注済みです（案件 ' + q['案件番号'] + '）');
  if (q['状態'] === '失注') throw new Error('失注にした見積は受注できません。状態を戻してください');
  var user = currentUser_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var orderNo = nextNumber_(SHEETS.orders, '案件番号', 'J');
    appendRow_(SHEETS.orders, {
      '案件番号': orderNo, '見積番号': q['見積番号'], '取引先ID': q['取引先ID'], '件名': q['件名'],
      '受注日': payload.orderDate || fmtDate_(new Date()), '納期': payload.due || '', '金額(税抜)': Number(q['小計']),
      '状態': '受注', '注文書URL': payload.poUrl || '', '登録者': user.name, '登録日時': fmtDateTime_(new Date()), '備考': payload.note || ''
    });
    // 同じ見積番号の全版を受注に
    readRows_(SHEETS.quotes).forEach(function (r) {
      if (r['見積番号'] === q['見積番号']) updateRow_(SHEETS.quotes, r.__row, { '状態': Number(r['版']) === Number(q['版']) ? '受注' : '旧版', '案件番号': orderNo });
    });
    return { orderNo: orderNo, quoteNo: q['見積番号'], amount: Number(q['小計']) };
  } finally {
    lock.releaseLock();
  }
}

/** 見積無しの直接受注（電話・口頭の注文） */
function apiDirectOrder(payload) {
  requireRole_('入力');
  var errors = [];
  if (!payload.clientId) errors.push('取引先を選んでください');
  if (!String(payload.title || '').trim()) errors.push('件名を入力してください');
  if (!(Number(payload.amount) >= 0) || payload.amount === '' || payload.amount == null) errors.push('金額(税抜)を入力してください');
  if (errors.length) throw new Error(errors.join('\n'));
  var user = currentUser_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var orderNo = nextNumber_(SHEETS.orders, '案件番号', 'J');
    appendRow_(SHEETS.orders, {
      '案件番号': orderNo, '見積番号': '', '取引先ID': payload.clientId, '件名': payload.title,
      '受注日': payload.orderDate || fmtDate_(new Date()), '納期': payload.due || '', '金額(税抜)': Number(payload.amount),
      '状態': '受注', '注文書URL': payload.poUrl || '', '登録者': user.name, '登録日時': fmtDateTime_(new Date()), '備考': payload.note || ''
    });
    return { orderNo: orderNo };
  } finally {
    lock.releaseLock();
  }
}

function apiListOrders() {
  var clients = indexBy_(readClients_(), 'id');
  var sales = readRows_(SHEETS.sales);
  return readRows_(SHEETS.orders).map(function (o) {
    o.clientName = (clients[o['取引先ID']] || {}).name || o['取引先ID'];
    var s = sales.filter(function (x) { return x['案件番号'] === o['案件番号']; });
    o.salesCount = s.length;
    o.salesAmount = s.reduce(function (a, x) { return a + Number(x['金額(税抜)']); }, 0);
    o.unbilled = s.filter(function (x) { return !x['請求番号']; }).length;
    return o;
  }).sort(function (a, b) { return String(b['登録日時']).localeCompare(String(a['登録日時'])); });
}

/* ============================================================
 * 発注
 * ============================================================ */

function apiAddPurchase(payload) {
  requireRole_('入力');
  var errors = [];
  if (!payload.orderNo) errors.push('案件を選んでください');
  if (!payload.supplierId) errors.push('仕入先を選んでください');
  if (!String(payload.detail || '').trim()) errors.push('内容を入力してください');
  if (!(Number(payload.amount) >= 0) || payload.amount === '' || payload.amount == null) errors.push('金額(税抜)を入力してください');
  if (errors.length) throw new Error(errors.join('\n'));
  var order = readRows_(SHEETS.orders).filter(function (o) { return o['案件番号'] === payload.orderNo; })[0];
  if (!order) throw new Error('案件 ' + payload.orderNo + ' が見つかりません');
  var user = currentUser_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var poNo = nextNumber_(SHEETS.pos, '発注番号', 'P');
    appendRow_(SHEETS.pos, {
      '発注番号': poNo, '案件番号': payload.orderNo, '仕入先ID': payload.supplierId, '内容': payload.detail,
      '金額(税抜)': Number(payload.amount), '税率': Number(payload.taxRate || 10), '発注日': payload.date || fmtDate_(new Date()),
      '状態': '発注済', '登録者': user.name, '登録日時': fmtDateTime_(new Date())
    });
    return { poNo: poNo };
  } finally {
    lock.releaseLock();
  }
}

/** 注文書PDF */
function apiPurchasePdf(poNo) {
  var po = readRows_(SHEETS.pos).filter(function (p) { return p['発注番号'] === poNo; })[0];
  if (!po) throw new Error('発注 ' + poNo + ' が見つかりません');
  var order = readRows_(SHEETS.orders).filter(function (o) { return o['案件番号'] === po['案件番号']; })[0] || {};
  var sup = clientById_(po['仕入先ID']);
  var html = buildPurchaseOrderHtml_(po, order, sup, readCompany_());
  var file = savePdf_('注文書_' + poNo + '_' + safeName_(sup.name) + '.pdf', html);
  logOutput_('注文書', poNo, sup.id, file.url);
  return { url: file.url, name: file.name, html: html, poNo: poNo };
}

function apiListPurchases(orderNo) {
  var clients = indexBy_(readClients_(), 'id');
  return readRows_(SHEETS.pos).filter(function (p) { return !orderNo || p['案件番号'] === orderNo; }).map(function (p) {
    p.supplierName = (clients[p['仕入先ID']] || {}).name || p['仕入先ID'];
    return p;
  });
}

/* ============================================================
 * 売上（納品）
 * ============================================================ */

/**
 * 納品を登録して売上を計上する。
 * payload: { orderNo, date, detail, amount(税抜), taxRate, full } full=true なら受注金額から未計上残額を計上
 */
function apiRecordSales(payload) {
  requireRole_('入力');
  var order = readRows_(SHEETS.orders).filter(function (o) { return o['案件番号'] === payload.orderNo; })[0];
  if (!order) throw new Error('案件 ' + payload.orderNo + ' が見つかりません');
  var existing = readRows_(SHEETS.sales).filter(function (s) { return s['案件番号'] === payload.orderNo; });
  var booked = existing.reduce(function (a, s) { return a + Number(s['金額(税抜)']); }, 0);
  var remain = Number(order['金額(税抜)']) - booked;
  var amount = payload.full ? remain : Number(payload.amount);
  var errors = [];
  if (!(amount > 0)) errors.push(payload.full ? 'この案件は全額計上済みです' : '金額(税抜)は1以上を入力してください');
  if (!payload.full && amount > remain) errors.push('金額が未計上の残額 ' + yen_(remain) + ' 円を超えています');
  if (errors.length) throw new Error(errors.join('\n'));
  var taxRate = Number(payload.taxRate || 10);
  var user = currentUser_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var salesId = nextNumber_(SHEETS.sales, '売上ID', 'S');
    appendRow_(SHEETS.sales, {
      '売上ID': salesId, '案件番号': payload.orderNo, '取引先ID': order['取引先ID'], '売上日': payload.date || fmtDate_(new Date()),
      '内容': payload.detail || order['件名'], '金額(税抜)': amount, '税率': taxRate, '請求番号': '',
      '登録者': user.name, '登録日時': fmtDateTime_(new Date())
    });
    var newBooked = booked + amount;
    updateRow_(SHEETS.orders, order.__row, { '状態': newBooked >= Number(order['金額(税抜)']) ? '納品済' : '一部納品' });
    return { salesId: salesId, amount: amount, remain: Number(order['金額(税抜)']) - newBooked };
  } finally {
    lock.releaseLock();
  }
}

function apiListSales(onlyUnbilled) {
  var clients = indexBy_(readClients_(), 'id');
  return readRows_(SHEETS.sales).filter(function (s) { return !onlyUnbilled || !s['請求番号']; }).map(function (s) {
    s.clientName = (clients[s['取引先ID']] || {}).name || s['取引先ID'];
    return s;
  }).sort(function (a, b) { return String(b['売上日']).localeCompare(String(a['売上日'])); });
}

/* ============================================================
 * 締めと請求
 * ============================================================ */

/**
 * 締め処理の対象を出す（発行はしない）。
 * cutoff: 'yyyy-MM-dd'。締め請求の取引先は「締め日≦cutoff かつ 未請求」の売上を締め日ごとにまとめる。
 * 随時請求の取引先は案件ごとにまとめる。
 * 戻り: { groups:[{clientId, clientName, mode, cutoff, period, orderNo, lines:[...], subtotal, tax, total}], skipped:[...] }
 */
function apiClosingPreview(cutoff) {
  if (!cutoff) throw new Error('締め日を指定してください');
  var today = fmtDate_(new Date());
  if (String(cutoff) > today) throw new Error('締め日に今日（' + today + '）より後の日付は指定できません。まだ終わっていない期間は締められません');
  var clients = indexBy_(readClients_(), 'id');
  var sales = readRows_(SHEETS.sales).filter(function (s) { return !s['請求番号'] && String(s['売上日']) <= cutoff; });
  var groups = {};
  var skipped = [];
  sales.forEach(function (s) {
    var c = clients[s['取引先ID']];
    if (!c) { skipped.push({ salesId: s['売上ID'], reason: '取引先 ' + s['取引先ID'] + ' がマスタに無い' }); return; }
    var key, closing, period;
    if (c.billing === '随時') {
      key = c.id + '|' + s['案件番号'];
      closing = cutoff;
      period = s['案件番号'];
    } else {
      closing = closingDateFor_(String(s['売上日']), c.closingDay);
      if (closing > cutoff) { skipped.push({ salesId: s['売上ID'], reason: c.name + ' の締め日 ' + closing + ' はまだ来ていない' }); return; }
      key = c.id + '|' + closing;
      period = periodLabel_(closing, c.closingDay);
    }
    if (!groups[key]) groups[key] = { clientId: c.id, clientName: c.name, mode: c.billing || '締め', cutoff: closing, period: period, orderNo: c.billing === '随時' ? s['案件番号'] : '', lines: [] };
    groups[key].lines.push({ salesId: s['売上ID'], date: s['売上日'], orderNo: s['案件番号'], detail: s['内容'], amount: Number(s['金額(税抜)']), taxRate: Number(s['税率']) });
  });
  var out = Object.keys(groups).map(function (k) {
    var g = groups[k];
    var t = computeTotals_(g.lines.map(function (l) { return { qty: 1, price: l.amount, taxRate: l.taxRate }; }));
    g.subtotal = t.subtotal; g.tax = t.tax; g.total = t.total; g.byRate = t.byRate;
    return g;
  }).sort(function (a, b) { return String(a.clientId).localeCompare(String(b.clientId)); });
  return { cutoff: cutoff, groups: out, skipped: skipped, count: out.length };
}

/** 締め処理を確定して請求書を発行する。groupKeys を省くと全グループ */
function apiIssueInvoices(cutoff, groupKeys) {
  requireRole_('入力');
  var preview = apiClosingPreview(cutoff);
  var targets = preview.groups.filter(function (g) {
    return !groupKeys || groupKeys.indexOf(g.clientId + '|' + (g.orderNo || g.cutoff)) >= 0;
  });
  if (!targets.length) return { issued: [], count: 0, message: '請求対象はありません' };
  var user = currentUser_();
  var company = readCompany_();
  var issued = [];
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 発行直前にもう一度未請求を確認する（他の利用者が先に発行した分を除く）
    var fresh = indexBy_(readRows_(SHEETS.sales), '売上ID');
    targets.forEach(function (g) {
      var lines = g.lines.filter(function (l) { return fresh[l.salesId] && !fresh[l.salesId]['請求番号']; });
      if (!lines.length) return;
      var t = computeTotals_(lines.map(function (l) { return { qty: 1, price: l.amount, taxRate: l.taxRate }; }));
      var c = clientById_(g.clientId);
      var invNo = nextNumber_(SHEETS.invoices, '請求番号', 'I');
      var issueDate = fmtDate_(new Date());
      var due = paymentDue_(g.cutoff, c.terms);
      var html = buildInvoiceHtml_({ invNo: invNo, issueDate: issueDate, due: due, period: g.period, lines: lines, totals: t, mode: g.mode }, c, company);
      var file = savePdf_('請求書_' + invNo + '_' + safeName_(c.name) + '.pdf', html);
      appendRow_(SHEETS.invoices, {
        '請求番号': invNo, '取引先ID': c.id, '請求方式': g.mode, '締め日': g.cutoff, '対象期間': g.period,
        '小計': t.subtotal, '消費税': t.tax, '合計': t.total, '発行日': issueDate, '支払期限': due, 'PDF': file.url,
        '状態': '発行済', '発行者': user.name, '発行日時': fmtDateTime_(new Date())
      });
      lines.forEach(function (l) { updateRow_(SHEETS.sales, fresh[l.salesId].__row, { '請求番号': invNo }); });
      // 案件の状態
      var orderNos = {};
      lines.forEach(function (l) { orderNos[l.orderNo] = true; });
      var allSales = readRows_(SHEETS.sales);
      readRows_(SHEETS.orders).forEach(function (o) {
        if (!orderNos[o['案件番号']]) return;
        var s = allSales.filter(function (x) { return x['案件番号'] === o['案件番号']; });
        if (s.length && s.every(function (x) { return x['請求番号']; }) && o['状態'] === '納品済') updateRow_(SHEETS.orders, o.__row, { '状態': '請求済' });
      });
      logOutput_('請求書', invNo, c.id, file.url);
      issued.push({ invNo: invNo, clientId: c.id, clientName: c.name, total: t.total, url: file.url, name: file.name, html: html, lines: lines.length });
    });
  } finally {
    lock.releaseLock();
  }
  return { issued: issued, count: issued.length, message: issued.length ? issued.length + ' 件の請求書を発行しました' : '請求対象はありません' };
}

function apiListInvoices() {
  var clients = indexBy_(readClients_(), 'id');
  return readRows_(SHEETS.invoices).map(function (i) {
    i.clientName = (clients[i['取引先ID']] || {}).name || i['取引先ID'];
    return i;
  }).sort(function (a, b) { return String(b['発行日時']).localeCompare(String(a['発行日時'])); });
}

/** 発行済み請求書のPDFを再表示する（再発行ではない。出力履歴に残す） */
function apiInvoicePdf(invNo) {
  var inv = readRows_(SHEETS.invoices).filter(function (i) { return i['請求番号'] === invNo; })[0];
  if (!inv) throw new Error('請求書 ' + invNo + ' が見つかりません');
  var c = clientById_(inv['取引先ID']);
  var lines = readRows_(SHEETS.sales).filter(function (s) { return s['請求番号'] === invNo; }).map(function (s) {
    return { salesId: s['売上ID'], date: s['売上日'], orderNo: s['案件番号'], detail: s['内容'], amount: Number(s['金額(税抜)']), taxRate: Number(s['税率']) };
  });
  var t = computeTotals_(lines.map(function (l) { return { qty: 1, price: l.amount, taxRate: l.taxRate }; }));
  var html = buildInvoiceHtml_({ invNo: invNo, issueDate: inv['発行日'], due: inv['支払期限'], period: inv['対象期間'], lines: lines, totals: t, mode: inv['請求方式'] }, c, readCompany_());
  logOutput_('請求書(再表示)', invNo, c.id, inv['PDF']);
  return { url: inv['PDF'], html: html, invNo: invNo };
}

/** 売上日と締め日（'末' か 1〜28 の数字）から、その売上が属する締め日を返す */
function closingDateFor_(saleDate, closingDay) {
  var y = Number(saleDate.slice(0, 4)), m = Number(saleDate.slice(5, 7)), d = Number(saleDate.slice(8, 10));
  if (!closingDay || closingDay === '末' || closingDay === '月末') {
    return fmtDate_(new Date(y, m, 0));
  }
  var cd = Number(closingDay);
  if (d <= cd) return fmtDate_(new Date(y, m - 1, cd));
  return fmtDate_(new Date(y, m, cd));
}

function periodLabel_(closing, closingDay) {
  if (!closingDay || closingDay === '末' || closingDay === '月末') return closing.slice(0, 7) + ' 分';
  var y = Number(closing.slice(0, 4)), m = Number(closing.slice(5, 7)), cd = Number(closingDay);
  var start = new Date(y, m - 2, cd + 1);
  return fmtDate_(start) + ' 〜 ' + closing;
}

/** 支払期限。支払条件は '翌月末' / '翌々月末' / '翌月20日' / '当月末' / 数字（日数） */
function paymentDue_(closing, terms) {
  var y = Number(closing.slice(0, 4)), m = Number(closing.slice(5, 7));
  terms = String(terms || '翌月末');
  if (terms === '翌月末') return fmtDate_(new Date(y, m + 1, 0));
  if (terms === '翌々月末') return fmtDate_(new Date(y, m + 2, 0));
  if (terms === '当月末') return fmtDate_(new Date(y, m, 0));
  var md = terms.match(/^翌月(\d{1,2})日$/);
  if (md) return fmtDate_(new Date(y, m, Number(md[1])));
  if (/^\d+$/.test(terms)) return addDays_(closing, Number(terms));
  return fmtDate_(new Date(y, m + 1, 0));
}

/* ============================================================
 * 金額
 * ============================================================ */

/** 明細 [{qty, price, taxRate}] → 税率ごとに1回丸め（適格請求書の端数処理） */
function computeTotals_(lines) {
  var byRate = {};
  lines.forEach(function (l) {
    var amt = Math.round(Number(l.qty) * Number(l.price));
    var r = Number(l.taxRate);
    byRate[r] = (byRate[r] || 0) + amt;
  });
  var subtotal = 0, tax = 0;
  var rates = Object.keys(byRate).map(Number).sort(function (a, b) { return b - a; }).map(function (r) {
    var t = Math.floor(byRate[r] * r / 100);
    subtotal += byRate[r]; tax += t;
    return { rate: r, base: byRate[r], tax: t };
  });
  return { subtotal: subtotal, tax: tax, total: subtotal + tax, byRate: rates };
}

/* ============================================================
 * 帳票HTML
 * ============================================================ */

function docCss_() {
  return '<style>' +
    '@page{size:A4;margin:16mm 14mm}' +
    'body{font-family:"Noto Sans JP","Yu Gothic","Hiragino Sans",sans-serif;color:#1a1a1a;font-size:11pt;margin:0;padding:24px 28px;}' +
    '.doc{width:680px;margin:0 auto;}' +
    'h1{font-size:22pt;letter-spacing:.35em;text-align:center;margin:0 0 18px;font-weight:700}' +
    '.meta{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}' +
    '.to{font-size:13pt;font-weight:700;border-bottom:1.5px solid #1a1a1a;padding-bottom:4px;min-width:280px}' +
    '.to small{display:block;font-size:9.5pt;font-weight:400;color:#444;margin-top:4px}' +
    '.from{text-align:left;font-size:9.5pt;line-height:1.55;position:relative;padding-right:56px}' +
    '.from b{font-size:11pt}' +
    '.seal{position:absolute;right:0;top:14px;width:46px;height:46px;border:2px solid #c0392b;border-radius:50%;color:#c0392b;' +
    'display:flex;align-items:center;justify-content:center;font-size:12pt;font-weight:700;letter-spacing:.05em;opacity:.85;transform:rotate(-8deg)}' +
    '.seal.s3{font-size:9.5pt;letter-spacing:0}' +
    '.nums{font-size:9.5pt;color:#333;margin-bottom:10px;display:flex;gap:22px}' +
    '.total{display:flex;align-items:baseline;gap:18px;border-bottom:2px solid #1a1a1a;padding:6px 4px;margin:8px 0 14px}' +
    '.total .l{font-size:11pt;font-weight:700}.total .v{font-size:19pt;font-weight:700;margin-left:auto}' +
    'table{width:100%;border-collapse:collapse;font-size:10pt}' +
    'th,td{border:1px solid #999;padding:6px 8px}th{background:#f0f0f0;font-weight:700;text-align:center}' +
    'td.n{text-align:right;font-variant-numeric:tabular-nums}td.c{text-align:center}' +
    '.sum{width:300px;margin:10px 0 0 auto}.sum td{border:none;padding:3px 8px}.sum td.n{font-weight:600}' +
    '.sum tr.g td{border-top:1.5px solid #1a1a1a;font-weight:700}' +
    '.note{margin-top:16px;font-size:9.5pt;color:#333;line-height:1.6}' +
    '.note b{display:block;font-weight:700;margin-bottom:2px}' +
    '</style>';
}

function companyBlock_(co) {
  return '<div class="from"><b>' + esc_(co['名称']) + '</b><br>' +
    esc_(co['郵便番号'] ? '〒' + co['郵便番号'] + ' ' : '') + esc_(co['住所']) + '<br>' +
    'TEL ' + esc_(co['電話']) + (co['メール'] ? '　' + esc_(co['メール']) : '') + '<br>' +
    '登録番号 ' + esc_(co['登録番号']) + (co['担当者'] ? '<br>担当 ' + esc_(co['担当者']) : '') +
    '<div class="seal' + (String(co['印'] || '').length > 2 ? ' s3' : '') + '">' + esc_(String(co['印'] || co['名称']).slice(0, 3)) + '</div></div>';
}

function buildQuoteHtml_(q, c, co) {
  var rows = q.lines.map(function (l) {
    return '<tr><td>' + esc_(l['品名']) + (l['規格'] ? ' <span style="color:#555">' + esc_(l['規格']) + '</span>' : '') + '</td>' +
      '<td class="n">' + yen_(l['数量']) + '</td><td class="c">' + esc_(l['単位']) + '</td>' +
      '<td class="n">' + yen_(l['単価']) + '</td><td class="c">' + l['税率'] + '%</td><td class="n">' + yen_(l['金額']) + '</td></tr>';
  }).join('');
  var t = computeTotals_(q.lines.map(function (l) { return { qty: l['数量'], price: l['単価'], taxRate: l['税率'] }; }));
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8">' + docCss_() + '</head><body><div class="doc">' +
    '<h1>御見積書</h1>' +
    '<div class="nums"><span>見積番号 ' + esc_(q['見積番号']) + (Number(q['版']) > 1 ? '（改訂 ' + q['版'] + '）' : '') + '</span><span>見積日 ' + esc_(q['見積日']) + '</span><span>有効期限 ' + esc_(q['有効期限']) + '</span></div>' +
    '<div class="meta"><div class="to">' + esc_(c.name) + ' ' + esc_(c.honorific || '御中') + '<small>' + esc_(c.address || '') + (c.contact ? '　' + esc_(c.contact) + ' 様' : '') + '</small></div>' + companyBlock_(co) + '</div>' +
    '<div class="nums"><span>件名 ' + esc_(q['件名']) + '</span></div>' +
    '<div class="total"><span class="l">御見積金額（税込）</span><span class="v">' + yen_(t.total) + ' 円</span></div>' +
    '<table><thead><tr><th>品名</th><th>数量</th><th>単位</th><th>単価</th><th>税率</th><th>金額</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    sumTable_(t) +
    '<div class="note"><b>備考</b>' + esc_(q['備考'] || '上記金額は税抜の小計に消費税を加えたものです。') + '</div>' +
    '</div></body></html>';
}

function buildInvoiceHtml_(d, c, co) {
  var rows = d.lines.map(function (l) {
    return '<tr><td class="c">' + esc_(l.date) + '</td><td>' + esc_(l.detail) + (l.orderNo ? ' <span style="color:#555">(' + esc_(l.orderNo) + ')</span>' : '') + '</td>' +
      '<td class="c">' + l.taxRate + '%</td><td class="n">' + yen_(l.amount) + '</td></tr>';
  }).join('');
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8">' + docCss_() + '</head><body><div class="doc">' +
    '<h1>請求書</h1>' +
    '<div class="nums"><span>請求番号 ' + esc_(d.invNo) + '</span><span>発行日 ' + esc_(d.issueDate) + '</span><span>対象 ' + esc_(d.period) + '</span></div>' +
    '<div class="meta"><div class="to">' + esc_(c.name) + ' ' + esc_(c.honorific || '御中') + '<small>' + esc_(c.address || '') + (c.contact ? '　' + esc_(c.contact) + ' 様' : '') + '</small></div>' + companyBlock_(co) + '</div>' +
    '<div class="total"><span class="l">御請求金額（税込）</span><span style="font-size:9.5pt;color:#333">お支払期限 ' + esc_(d.due) + '</span><span class="v">' + yen_(d.totals.total) + ' 円</span></div>' +
    '<table><thead><tr><th>日付</th><th>内容</th><th>税率</th><th>金額（税抜）</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    sumTable_(d.totals) +
    '<div class="note"><b>お振込先</b>' + esc_(co['振込先'] || '') + '<br>振込手数料は貴社にてご負担ください。</div>' +
    '</div></body></html>';
}

function buildPurchaseOrderHtml_(po, order, sup, co) {
  var t = computeTotals_([{ qty: 1, price: po['金額(税抜)'], taxRate: po['税率'] }]);
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8">' + docCss_() + '</head><body><div class="doc">' +
    '<h1>注文書</h1>' +
    '<div class="nums"><span>発注番号 ' + esc_(po['発注番号']) + '</span><span>発注日 ' + esc_(po['発注日']) + '</span><span>当社案件 ' + esc_(po['案件番号']) + (order['件名'] ? '（' + esc_(order['件名']) + '）' : '') + '</span></div>' +
    '<div class="meta"><div class="to">' + esc_(sup.name) + ' ' + esc_(sup.honorific || '御中') + '<small>' + esc_(sup.address || '') + (sup.contact ? '　' + esc_(sup.contact) + ' 様' : '') + '</small></div>' + companyBlock_(co) + '</div>' +
    '<div class="nums"><span>下記のとおり注文いたします。</span></div>' +
    '<div class="total"><span class="l">注文金額（税込）</span>' + (order['納期'] ? '<span style="font-size:9.5pt;color:#333">納入希望日 ' + esc_(order['納期']) + '</span>' : '') + '<span class="v">' + yen_(t.total) + ' 円</span></div>' +
    '<table><thead><tr><th>内容</th><th>税率</th><th>金額（税抜）</th></tr></thead><tbody>' +
    '<tr><td>' + esc_(po['内容']) + '</td><td class="c">' + po['税率'] + '%</td><td class="n">' + yen_(po['金額(税抜)']) + '</td></tr></tbody></table>' +
    sumTable_(t) +
    '<div class="note"><b>備考</b>納品先・納入日はご相談のうえ確定します。</div>' +
    '</div></body></html>';
}

function sumTable_(t) {
  var rows = t.byRate.map(function (r) {
    return '<tr><td>' + r.rate + '%対象（税抜）</td><td class="n">' + yen_(r.base) + ' 円</td></tr>' +
      '<tr><td>消費税（' + r.rate + '%）</td><td class="n">' + yen_(r.tax) + ' 円</td></tr>';
  }).join('');
  return '<table class="sum"><tbody>' + rows + '<tr class="g"><td>合計（税込）</td><td class="n">' + yen_(t.total) + ' 円</td></tr></tbody></table>';
}

/* ============================================================
 * 保存・履歴
 * ============================================================ */

function savePdf_(fileName, html) {
  var folder = getOrCreateFolder_(CONFIG.PDF_FOLDER);
  var blob = Utilities.newBlob(html, 'text/html', fileName).getAs('application/pdf').setName(fileName);
  var file = folder.createFile(blob);
  return { url: file.getUrl(), name: fileName };
}

function logOutput_(kind, no, clientId, url) {
  appendRow_(SHEETS.outlog, { '日時': fmtDateTime_(new Date()), '帳票': kind, '番号': no, '取引先ID': clientId, '利用者': currentUser_().name, 'URL': url });
}

function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/* ============================================================
 * 利用者・権限
 * ============================================================ */

function currentUser_() {
  var email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) { email = ''; }
  var users = readRows_(SHEETS.users);
  var hit = users.filter(function (u) { return String(u['メール']).toLowerCase() === String(email).toLowerCase(); })[0];
  if (hit) return { email: email, name: hit['表示名'] || email, role: hit['権限'] || '閲覧' };
  if (!users.length) return { email: email, name: email || '利用者', role: '入力' }; // 利用者シートが空なら全員入力可
  return { email: email, name: email || '未登録', role: '閲覧' };
}

function requireRole_(role) {
  var u = currentUser_();
  if (role === '入力' && u.role !== '入力' && u.role !== '管理') throw new Error('この操作には入力権限が必要です（現在: ' + u.role + '）');
}

/* ============================================================
 * マスタ
 * ============================================================ */

function apiListUsers() {
  return readRows_(SHEETS.users).map(function (u) { return { email: u['メール'], name: u['表示名'], role: u['権限'] }; });
}

/** 利用者の追加・変更。権限は 管理 / 入力 / 閲覧。管理権限の人だけが変えられる（利用者が空の間は誰でも） */
function apiSaveUser(u) {
  var me = currentUser_();
  var users = readRows_(SHEETS.users);
  if (users.length && me.role !== '管理') throw new Error('利用者の変更は管理権限の人だけができます（現在: ' + me.role + '）');
  if (!String(u.email || '').trim()) throw new Error('メールアドレスを入力してください');
  if (['管理', '入力', '閲覧'].indexOf(u.role) < 0) throw new Error('権限は 管理 / 入力 / 閲覧 のどれかを選んでください');
  var row = { 'メール': String(u.email).trim().toLowerCase(), '表示名': u.name || u.email, '権限': u.role };
  var existing = users.filter(function (r) { return String(r['メール']).toLowerCase() === row['メール']; })[0];
  if (existing) updateRow_(SHEETS.users, existing.__row, row); else appendRow_(SHEETS.users, row);
  return { email: row['メール'] };
}

function readClients_() {
  return readRows_(SHEETS.clients).map(function (r) {
    return { id: r['取引先ID'], name: r['名称'], honorific: r['敬称'] || '御中', zip: r['郵便番号'], address: r['住所'], contact: r['担当者'],
      closingDay: String(r['締め日'] || '末'), terms: r['支払条件'] || '翌月末', billing: r['請求方式'] || '締め', note: r['備考'] };
  });
}

function clientById_(id) {
  var c = readClients_().filter(function (x) { return x.id === id; })[0];
  if (!c) throw new Error('取引先 ' + id + ' がマスタにありません');
  return c;
}

function readItems_() {
  return readRows_(SHEETS.items).map(function (r) {
    return { id: r['品目ID'], name: r['品名'], spec: r['規格'], unit: r['単位'], price: Number(r['標準単価']), taxRate: Number(r['税率'] || 10) };
  });
}

function readCompany_() {
  var o = {};
  readRows_(SHEETS.company).forEach(function (r) { o[r['項目']] = r['値']; });
  return o;
}

function apiSaveClient(c) {
  requireRole_('入力');
  if (!String(c.name || '').trim()) throw new Error('名称を入力してください');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var id = c.id || nextNumber_(SHEETS.clients, '取引先ID', 'C');
    var row = { '取引先ID': id, '名称': c.name, '敬称': c.honorific || '御中', '郵便番号': c.zip || '', '住所': c.address || '', '担当者': c.contact || '',
      '締め日': c.closingDay || '末', '支払条件': c.terms || '翌月末', '請求方式': c.billing || '締め', '備考': c.note || '' };
    var existing = readRows_(SHEETS.clients).filter(function (r) { return r['取引先ID'] === id; })[0];
    if (existing) updateRow_(SHEETS.clients, existing.__row, row); else appendRow_(SHEETS.clients, row);
    return { id: id };
  } finally { lock.releaseLock(); }
}

function apiSaveItem(it) {
  requireRole_('入力');
  if (!String(it.name || '').trim()) throw new Error('品名を入力してください');
  if (!(Number(it.price) >= 0)) throw new Error('標準単価を入力してください');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var id = it.id || nextNumber_(SHEETS.items, '品目ID', 'M');
    var row = { '品目ID': id, '品名': it.name, '規格': it.spec || '', '単位': it.unit || '', '標準単価': Number(it.price), '税率': Number(it.taxRate || 10), '備考': it.note || '' };
    var existing = readRows_(SHEETS.items).filter(function (r) { return r['品目ID'] === id; })[0];
    if (existing) updateRow_(SHEETS.items, existing.__row, row); else appendRow_(SHEETS.items, row);
    return { id: id };
  } finally { lock.releaseLock(); }
}

/* ============================================================
 * シート入出力
 * ============================================================ */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function ensureSheets_() {
  var ss = ss_();
  var created = false;
  Object.keys(SHEETS).forEach(function (k) {
    var def = SHEETS[k];
    var sh = ss.getSheetByName(def.name);
    if (!sh) {
      sh = ss.insertSheet(def.name);
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
      created = true;
    }
  });
  if (CONFIG.DEMO_MODE && readRows_(SHEETS.clients).length === 0) setupDemoData_();
  return created;
}

/** シート全行をヘッダ名→値のオブジェクトで返す。__row に行番号（1始まり）を持つ */
function readRows_(def) {
  var sh = ss_().getSheetByName(def.name);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(1, 1, last, def.headers.length).getValues();
  var headers = values[0];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.every(function (v) { return v === '' || v === null; })) continue;
    var o = { __row: i + 1 };
    headers.forEach(function (h, j) { o[h] = normalize_(row[j]); });
    out.push(o);
  }
  return out;
}

function normalize_(v) {
  if (v instanceof Date) return fmtDate_(v);
  return v;
}

function appendRow_(def, obj) {
  var sh = ss_().getSheetByName(def.name);
  sh.appendRow(def.headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
}

function updateRow_(def, rowIndex, patch) {
  var sh = ss_().getSheetByName(def.name);
  var range = sh.getRange(rowIndex, 1, 1, def.headers.length);
  var vals = range.getValues()[0];
  def.headers.forEach(function (h, j) { if (patch[h] !== undefined) vals[j] = patch[h]; });
  range.setValues([vals]);
}

/** 採番: 接頭辞-西暦-4桁連番（年ごとに1から） */
function nextNumber_(def, column, prefix) {
  var year = fmtDate_(new Date()).slice(0, 4);
  var head = prefix + '-' + year + '-';
  var max = 0;
  readRows_(def).forEach(function (r) {
    var v = String(r[column] || '');
    if (v.indexOf(head) === 0) { var n = Number(v.slice(head.length)); if (n > max) max = n; }
  });
  return head + ('0000' + (max + 1)).slice(-4);
}

function indexBy_(arr, key) {
  var o = {};
  arr.forEach(function (x) { o[x[key]] = x; });
  return o;
}

/** 見積の最新版だけ */
function latestQuotes_(quotes) {
  var byNo = {};
  quotes.forEach(function (q) {
    if (!byNo[q['見積番号']] || Number(q['版']) > Number(byNo[q['見積番号']]['版'])) byNo[q['見積番号']] = q;
  });
  return Object.keys(byNo).map(function (k) { return byNo[k]; });
}

/* ============================================================
 * 書式
 * ============================================================ */

function fmtDate_(d) { return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd'); }
function fmtDateTime_(d) { return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); }
function addDays_(ymd, n) {
  var d = new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)) + n);
  return fmtDate_(d);
}
function yen_(n) { return Math.round(Number(n)).toLocaleString('ja-JP'); }
function esc_(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}
function safeName_(s) { return String(s || '').replace(/[\\\/:*?"<>|]/g, '_'); }

/* ============================================================
 * サンプルデータ（デモ用。実在の会社・人物とは無関係）
 * ============================================================ */

function setupDemoData_() {
  var today = fmtDate_(new Date());
  var y = today.slice(0, 4), m = today.slice(5, 7);
  var prevM = m === '01' ? (String(Number(y) - 1) + '-12') : (y + '-' + ('0' + (Number(m) - 1)).slice(-2));
  var thisM = y + '-' + m;

  [
    ['項目', '値'],
    ['名称', 'ミライ設備工業株式会社（サンプル）'], ['郵便番号', '000-0000'], ['住所', '東京都○○区○○ 1-2-3'], ['電話', '03-0000-0000'],
    ['メール', 'info@example.jp'], ['登録番号', 'T0000000000000'], ['担当者', ''], ['印', 'ミライ'],
    ['振込先', '○○銀行 ○○支店 普通 0000000 ミライセツビコウギョウ（カ']
  ].forEach(function (r, i) { if (i) appendRow_(SHEETS.company, { '項目': r[0], '値': r[1] }); });

  [
    ['C-2026-0001', 'ミナト商事株式会社', '御中', '000-0001', '東京都○○区港町 4-5-6', '佐々木', '末', '翌月末', '締め', ''],
    ['C-2026-0002', '株式会社ハルカ工業', '御中', '000-0002', '神奈川県○○市春日 7-8', '中村', '20', '翌月末', '締め', ''],
    ['C-2026-0003', 'タカギ建設株式会社', '御中', '000-0003', '千葉県○○市高木 9', '高木', '末', '翌々月末', '随時', '案件ごとに請求'],
    ['C-2026-0004', '有限会社アオキ電機', '御中', '000-0004', '埼玉県○○市青木 10-11', '青木', '末', '翌月末', '締め', ''],
    ['C-2026-0005', '関東部材センター株式会社', '御中', '000-0005', '東京都○○区部材 12', '小林', '末', '翌月末', '締め', '仕入先']
  ].forEach(function (r) {
    appendRow_(SHEETS.clients, { '取引先ID': r[0], '名称': r[1], '敬称': r[2], '郵便番号': r[3], '住所': r[4], '担当者': r[5], '締め日': r[6], '支払条件': r[7], '請求方式': r[8], '備考': r[9] });
  });

  [
    ['M-2026-0001', '作業員（技術）', '1人日', '人日', 28000, 10],
    ['M-2026-0002', '作業員（補助）', '1人日', '人日', 18000, 10],
    ['M-2026-0003', '配管部材セット', '標準', '式', 46000, 10],
    ['M-2026-0004', '制御盤 小型', 'BOX-S', '台', 128000, 10],
    ['M-2026-0005', '定期点検', '1回', '回', 35000, 10],
    ['M-2026-0006', '運搬費', '都内', '式', 12000, 10],
    ['M-2026-0007', '現場消耗品', '一式', '式', 8000, 10]
  ].forEach(function (r) {
    appendRow_(SHEETS.items, { '品目ID': r[0], '品名': r[1], '規格': r[2], '単位': r[3], '標準単価': r[4], '税率': r[5], '備考': '' });
  });

  // 利用者: 管理1・入力1・閲覧1（実運用では最初に管理者を1人登録して使う）
  [['demo-admin@example.jp', '代表 鈴木', '管理'], ['demo-input@example.jp', '事務 田中', '入力'], ['demo-view@example.jp', '営業 山田', '閲覧']].forEach(function (r) {
    appendRow_(SHEETS.users, { 'メール': r[0], '表示名': r[1], '権限': r[2] });
  });
  // 見積: 過去分3件（受注済2・提出済1）
  var q1 = seedQuote_('Q-2026-0001', 'C-2026-0001', '倉庫内 配管更新工事', prevM + '-03', [
    ['M-2026-0001', '作業員（技術）', '1人日', 4, '人日', 28000, 10], ['M-2026-0003', '配管部材セット', '標準', 2, '式', 46000, 10], ['M-2026-0006', '運搬費', '都内', 1, '式', 12000, 10]
  ], '受注', 'J-2026-0001');
  var q2 = seedQuote_('Q-2026-0002', 'C-2026-0003', '事務所 制御盤交換', prevM + '-10', [
    ['M-2026-0004', '制御盤 小型', 'BOX-S', 1, '台', 128000, 10], ['M-2026-0001', '作業員（技術）', '1人日', 2, '人日', 28000, 10]
  ], '受注', 'J-2026-0002');
  seedQuote_('Q-2026-0003', 'C-2026-0004', '空調設備 定期点検（年間）', thisM + '-02', [
    ['M-2026-0005', '定期点検', '1回', 4, '回', 35000, 10]
  ], '提出済', '');

  appendRow_(SHEETS.orders, { '案件番号': 'J-2026-0001', '見積番号': 'Q-2026-0001', '取引先ID': 'C-2026-0001', '件名': '倉庫内 配管更新工事', '受注日': prevM + '-08', '納期': prevM + '-25', '金額(税抜)': q1.subtotal, '状態': '納品済', '注文書URL': '', '登録者': 'サンプル', '登録日時': prevM + '-08 10:00:00', '備考': '' });
  appendRow_(SHEETS.orders, { '案件番号': 'J-2026-0002', '見積番号': 'Q-2026-0002', '取引先ID': 'C-2026-0003', '件名': '事務所 制御盤交換', '受注日': prevM + '-15', '納期': thisM + '-05', '金額(税抜)': q2.subtotal, '状態': '納品済', '注文書URL': '', '登録者': 'サンプル', '登録日時': prevM + '-15 11:00:00', '備考': '' });
  appendRow_(SHEETS.orders, { '案件番号': 'J-2026-0003', '見積番号': '', '取引先ID': 'C-2026-0002', '件名': '排水ポンプ 緊急修理（電話注文）', '受注日': prevM + '-18', '納期': prevM + '-18', '金額(税抜)': 64000, '状態': '納品済', '注文書URL': '', '登録者': 'サンプル', '登録日時': prevM + '-18 09:30:00', '備考': '口頭注文' });

  appendRow_(SHEETS.pos, { '発注番号': 'P-2026-0001', '案件番号': 'J-2026-0001', '仕入先ID': 'C-2026-0005', '内容': '配管部材セット 2式', '金額(税抜)': 62000, '税率': 10, '発注日': prevM + '-09', '状態': '納入済', '登録者': 'サンプル', '登録日時': prevM + '-09 13:00:00' });
  appendRow_(SHEETS.pos, { '発注番号': 'P-2026-0002', '案件番号': 'J-2026-0002', '仕入先ID': 'C-2026-0005', '内容': '制御盤 小型 1台', '金額(税抜)': 89000, '税率': 10, '発注日': prevM + '-16', '状態': '納入済', '登録者': 'サンプル', '登録日時': prevM + '-16 13:00:00' });

  // 売上: 先月分は請求済み（I-2026-0001）、今月分は未請求
  appendRow_(SHEETS.sales, { '売上ID': 'S-2026-0001', '案件番号': 'J-2026-0001', '取引先ID': 'C-2026-0001', '売上日': prevM + '-25', '内容': '倉庫内 配管更新工事', '金額(税抜)': q1.subtotal, '税率': 10, '請求番号': 'I-2026-0001', '登録者': 'サンプル', '登録日時': prevM + '-25 17:00:00' });
  appendRow_(SHEETS.sales, { '売上ID': 'S-2026-0002', '案件番号': 'J-2026-0002', '取引先ID': 'C-2026-0003', '売上日': thisM + '-05', '内容': '事務所 制御盤交換', '金額(税抜)': q2.subtotal, '税率': 10, '請求番号': '', '登録者': 'サンプル', '登録日時': thisM + '-05 16:00:00' });
  appendRow_(SHEETS.sales, { '売上ID': 'S-2026-0003', '案件番号': 'J-2026-0003', '取引先ID': 'C-2026-0002', '売上日': prevM + '-18', '内容': '排水ポンプ 緊急修理', '金額(税抜)': 64000, '税率': 10, '請求番号': '', '登録者': 'サンプル', '登録日時': prevM + '-18 15:00:00' });

  var t1 = computeTotals_([{ qty: 1, price: q1.subtotal, taxRate: 10 }]);
  var prevEnd = closingDateFor_(prevM + '-25', '末');
  appendRow_(SHEETS.invoices, { '請求番号': 'I-2026-0001', '取引先ID': 'C-2026-0001', '請求方式': '締め', '締め日': prevEnd, '対象期間': prevM + ' 分', '小計': t1.subtotal, '消費税': t1.tax, '合計': t1.total, '発行日': addDays_(prevEnd, 1), '支払期限': paymentDue_(prevEnd, '翌月末'), 'PDF': '', '状態': '発行済', '発行者': 'サンプル', '発行日時': addDays_(prevEnd, 1) + ' 09:00:00' });
}

function seedQuote_(no, clientId, title, date, lines, status, orderNo) {
  var ls = lines.map(function (l) { return { qty: l[3], price: l[5], taxRate: l[6] }; });
  var t = computeTotals_(ls);
  appendRow_(SHEETS.quotes, { '見積番号': no, '版': 1, '取引先ID': clientId, '件名': title, '見積日': date, '有効期限': addDays_(date, CONFIG.QUOTE_VALID_DAYS),
    '小計': t.subtotal, '消費税': t.tax, '合計': t.total, '状態': status, '案件番号': orderNo, '作成者': 'サンプル', '作成日時': date + ' 09:00:00', '備考': '' });
  lines.forEach(function (l, i) {
    appendRow_(SHEETS.qlines, { '見積番号': no, '版': 1, '行': i + 1, '品目ID': l[0], '品名': l[1], '規格': l[2], '数量': l[3], '単位': l[4], '単価': l[5], '税率': l[6], '金額': Math.round(l[3] * l[5]) });
  });
  return t;
}
