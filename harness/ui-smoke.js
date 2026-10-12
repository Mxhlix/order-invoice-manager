'use strict';
/**
 * 画面の通し検証（Playwright・headless）。サーバを起動してから実行する。
 *   node harness/ui-smoke.js [http://localhost:8787]
 * 見積→保存（空欄で止まる→入力して保存）→見積書PDF→受注確定→納品・売上→締め処理→請求書発行→再実行0件 を
 * 実際に操作し、各場面を harness/out/shots/ に保存する。文言は画面から読んで assert する。
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const BASE = process.argv[2] || 'http://localhost:8787';
const SHOTS = path.join(__dirname, 'out', 'shots');

(async () => {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  let n = 0;
  const shot = async (page, name) => { n++; await page.screenshot({ path: path.join(SHOTS, String(n).padStart(2, '0') + '-' + name + '.png') }); };

  // 状態を初期化
  await fetch(BASE + '/reset', { method: 'POST' });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1220, height: 686 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE + '/');
  await page.waitForSelector('#tblProjects tbody tr');
  await shot(page, 'projects');
  assert.strictEqual(await page.textContent('#companyName'), 'ミライ設備工業株式会社（サンプル）');
  assert.strictEqual(await page.textContent('#userName'), '事務 田中');
  const today = await page.textContent('#todayLabel');

  // 見積: 空欄で保存 → 止まる
  await page.click('#btnNewQuote');
  await page.waitForSelector('#view-quotes:not(.hidden)');
  await page.click('#btnQuoteSave');
  await page.waitForSelector('#qAlert:not(.hidden)');
  const alert1 = await page.textContent('#qAlert');
  assert.ok(alert1.includes('取引先を選んでください') && alert1.includes('件名を入力してください') && alert1.includes('明細を1行以上'), alert1);
  assert.ok(await page.$('#qClient.bad'), '取引先欄が赤くなる');
  await shot(page, 'quote-blank-blocked');

  // 入力
  await page.selectOption('#qClient', 'C-2026-0004');
  await page.fill('#qTitle', '事務所 空調設備 定期点検（秋季）');
  const rows = await page.$$('#tblLines tbody tr');
  await rows[0].$eval('.l-item', (s) => { s.value = 'M-2026-0005'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await rows[0].$eval('.l-qty', (i) => { i.value = '2'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await rows[1].$eval('.l-item', (s) => { s.value = 'M-2026-0006'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => document.getElementById('tTotal').textContent !== '0');
  assert.strictEqual(await page.textContent('#tSub'), '82,000');
  assert.strictEqual(await page.textContent('#tTax'), '8,200');
  assert.strictEqual(await page.textContent('#tTotal'), '90,200');
  await shot(page, 'quote-filled');

  await page.click('#btnQuoteSave');
  await page.waitForSelector('#qAlert.ok');
  const alert2 = await page.textContent('#qAlert');
  assert.ok(alert2.includes('Q-2026-0004') && alert2.includes('90,200'), alert2);
  assert.ok(await page.$('#qClient:not(.bad)'), '赤が消える');
  await shot(page, 'quote-saved');

  // 見積書PDF
  await page.click('#btnQuotePdf');
  await page.waitForSelector('#docFrame');
  await page.waitForTimeout(600);
  const quoteHtml = await page.$eval('#docFrame', f => f.srcdoc);
  assert.ok(quoteHtml.includes('御見積書') && quoteHtml.includes('Q-2026-0004') && quoteHtml.includes('有限会社アオキ電機'));
  await shot(page, 'quote-pdf');
  await page.click('#docClose');

  // 重複: 同じ内容で新規保存 → 警告
  await page.click('#btnQuoteCancel');
  await page.selectOption('#qClient', 'C-2026-0004');
  await page.fill('#qTitle', '事務所 空調設備 定期点検（秋季）');
  const rows2 = await page.$$('#tblLines tbody tr');
  await rows2[0].$eval('.l-item', (s) => { s.value = 'M-2026-0005'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('#btnQuoteSave');
  await page.waitForSelector('#wForce');
  const warn = await page.textContent('#modalBox p');
  assert.ok(warn.includes('同じ取引先・同じ件名') && warn.includes('Q-2026-0004'), warn);
  await shot(page, 'quote-duplicate-warning');
  await page.click('#wCancel');

  // 受注確定（一覧から）
  const orderBtn = await page.$('#tblQuotes tbody tr:has-text("Q-2026-0004") [data-act=order]');
  assert.ok(orderBtn, '一覧に受注ボタン');
  await orderBtn.click();
  await page.waitForSelector('#oOk');
  await page.fill('#oDue', '2026-09-25');
  await shot(page, 'order-confirm-dialog');
  await page.click('#oOk');
  await page.waitForSelector('#qAlert.ok');
  await page.waitForFunction(() => document.querySelector('#tblQuotes tbody')?.textContent.includes('J-2026-0004'));
  await shot(page, 'order-confirmed');

  // 納品・売上
  await page.click('.nav-item[data-view=orders]');
  await page.waitForSelector('#view-orders:not(.hidden)');
  await page.waitForFunction(() => document.querySelectorAll('#sOrder option').length > 1);
  await page.selectOption('#sOrder', 'J-2026-0004');
  await page.fill('#sDate', '2026-09-12');
  await page.click('#btnSales');
  await page.waitForSelector('#sAlert.ok');
  const sAlert = await page.textContent('#sAlert');
  assert.ok(sAlert.includes('82,000') && sAlert.includes('全額計上済み'), sAlert);
  await shot(page, 'sales-recorded');

  // 発注と注文書PDF
  await page.selectOption('#pOrder', 'J-2026-0004');
  await page.selectOption('#pSupplier', 'C-2026-0005');
  await page.fill('#pDetail', '点検用 交換フィルター 2式');
  await page.fill('#pAmount', '9000');
  await page.click('#btnPurchase');
  await page.waitForSelector('#pAlert.ok');
  const pAlert = await page.textContent('#pAlert');
  assert.ok(pAlert.includes('P-2026-0003'), pAlert);
  await page.click('#tblPurchases tbody tr:first-child [data-po]');
  await page.waitForSelector('#docFrame');
  await page.waitForTimeout(600);
  const poHtml = await page.$eval('#docFrame', f => f.srcdoc);
  assert.ok(poHtml.includes('注文書') && poHtml.includes('P-2026-0003') && poHtml.includes('関東部材センター') && poHtml.includes('9,900'), 'PO html');
  await shot(page, 'purchase-order-pdf');
  await page.click('#docClose');

  // 締め処理（締め日は今日。月末締めの新しい売上は対象外として理由が出る）
  await page.click('.nav-item[data-view=closing]');
  await page.waitForSelector('#view-closing:not(.hidden)');
  assert.strictEqual(await page.inputValue('#cCutoff'), today, '締め日の既定は今日');
  await page.click('#btnClosingPreview');
  await page.waitForSelector('#tblClosing:not(.hidden) tbody tr');
  const cMsg = await page.textContent('#cMsg');
  assert.ok(cMsg.includes('請求対象 2 件'), cMsg);
  const closingRows = await page.$$eval('#tblClosing tbody tr', trs => trs.map(t => t.textContent));
  assert.ok(closingRows.some(r => r.includes('タカギ建設') && r.includes('随時請求')));
  assert.ok(closingRows.some(r => r.includes('ハルカ工業') && r.includes('07-21 〜') && r.includes('70,400')));
  const skipped = await page.textContent('#cSkipped');
  assert.ok(skipped.includes('アオキ電機') && skipped.includes('まだ来ていない'), skipped);
  await shot(page, 'closing-preview');

  // 発行
  await page.click('#btnIssue');
  await page.waitForSelector('#docFrame');
  await page.waitForTimeout(600);
  const invHtml = await page.$eval('#docFrame', f => f.srcdoc);
  assert.ok(invHtml.includes('請求書') && invHtml.includes('登録番号') && invHtml.includes('お支払期限'));
  await shot(page, 'invoice-pdf');
  await page.click('#docClose');
  const issuedRows = await page.$$eval('#cIssued .row', rs => rs.map(r => r.textContent));
  assert.strictEqual(issuedRows.length, 2, JSON.stringify(issuedRows));
  await shot(page, 'invoices-issued');

  // 再実行 → 0件
  await page.click('#btnClosingPreview');
  await page.waitForFunction(() => document.getElementById('cMsg').textContent.includes('請求対象 0 件'));
  const empty = await page.textContent('#tblClosing tbody');
  assert.ok(empty.includes('請求対象はありません'), empty);
  assert.ok((await page.textContent('#cSkipped')).includes('アオキ電機'), '月末締めの分は対象外のまま残る');
  await shot(page, 'closing-empty');

  // 案件一覧で請求済みに
  await page.click('.nav-item[data-view=projects]');
  await page.waitForFunction(() => document.querySelector('#tblProjects tbody')?.textContent.includes('J-2026-0004'));
  const projText = await page.textContent('#tblProjects tbody');
  assert.ok(projText.includes('J-2026-0004'));
  const kpiUnbilled = await page.$$eval('#kpis .kpi', k => k[1].textContent);
  assert.ok(kpiUnbilled.includes('1'), kpiUnbilled);
  // マスタ: 利用者一覧
  await page.click('.nav-item[data-view=masters]');
  await page.waitForFunction(() => document.querySelectorAll('#tblUsers tbody tr').length === 3);
  await shot(page, 'masters-users');
  await shot(page, 'projects-after');

  await browser.close();
  assert.deepStrictEqual(errors, [], 'ブラウザのエラー: ' + errors.join(' | '));
  console.log('ui-smoke: ok (' + n + ' shots in ' + SHOTS + ')');
})().catch(e => { console.error('ui-smoke: FAIL', e && e.stack || e); process.exit(1); });
