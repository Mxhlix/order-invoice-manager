'use strict';
/**
 * ローカル実行サーバ。gas/Code.gs と gas/Index.html を、Google環境なしでブラウザから動かす。
 *   node harness/server.js [--port 8787] [--user demo-input@example.jp] [--now 2026-09-12]
 * GET  /            … Index.html（include展開＋ google.script.run の代替を注入）
 * POST /rpc         … {fn, args} → Code.gs の api* 関数を呼ぶ
 * GET  /pdf/<name>  … 保存した帳票（HTML）
 * POST /reset       … 台帳を初期状態（サンプル）に戻す
 * GET  /state       … シートの中身（検証用）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadCode, renderIndex } = require('./load-code');

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; }
const PORT = Number(arg('port', 8787));
const USER = arg('user', 'demo-input@example.jp');
const NOW = arg('now', '');
const PDF_DIR = path.join(__dirname, 'out', 'pdf');

let app = null;
function boot() {
  fs.rmSync(PDF_DIR, { recursive: true, force: true });
  const nowMs = NOW ? new Date(NOW + 'T10:00:00+09:00').getTime() : undefined;
  app = loadCode({ userEmail: USER, pdfDir: PDF_DIR, nowMs });
  app.context.apiBootstrap(); // シート作成とサンプル投入
}
boot();

const SHIM = `<script>
window.google = { script: { run: (function(){
  function mk(ok, ng){
    var h = { withSuccessHandler: function(f){ return mk(f, ng); }, withFailureHandler: function(f){ return mk(ok, f); } };
    return new Proxy(h, { get: function(t, p){
      if (p in t) return t[p];
      return function(){
        var args = Array.prototype.slice.call(arguments);
        return fetch('/rpc', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ fn: p, args: args }) })
          .then(function(r){ return r.json(); })
          .then(function(j){ if (j.error) { ng && ng(new Error(j.error)); } else { ok && ok(j.result); } })
          .catch(function(e){ ng && ng(e); });
      };
    }});
  }
  return mk(null, null);
})(), host: { close: function(){} } } };
</script>`;

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    const html = renderIndex().replace('</head>', SHIM + '\n</head>');
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname.startsWith('/pdf/')) {
    const name = decodeURIComponent(url.pathname.slice(5));
    const p = path.join(PDF_DIR, path.basename(name));
    if (!fs.existsSync(p)) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(p), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    const out = {};
    app.ss.getSheets().forEach(s => { out[s.getName()] = s.data; });
    return send(res, 200, JSON.stringify(out, null, 1));
  }
  if (req.method === 'POST' && url.pathname === '/reset') { boot(); return send(res, 200, '{"ok":true}'); }
  if (req.method === 'POST' && url.pathname === '/user') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => { app.state.userEmail = JSON.parse(body || '{}').email || USER; send(res, 200, '{"ok":true}'); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/rpc') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { fn, args } = JSON.parse(body || '{}');
        if (!/^api[A-Z]/.test(String(fn)) || typeof app.context[fn] !== 'function') return send(res, 400, JSON.stringify({ error: '関数 ' + fn + ' は公開されていません' }));
        const result = app.context[fn].apply(null, args || []);
        send(res, 200, JSON.stringify({ result: result === undefined ? null : result }));
      } catch (e) {
        send(res, 200, JSON.stringify({ error: (e && e.message) ? e.message : String(e) }));
      }
    });
    return;
  }
  send(res, 404, 'not found', 'text/plain');
});

server.listen(PORT, () => {
  console.log('order-invoice-manager demo server: http://localhost:' + PORT + '  user=' + USER + (NOW ? ' now=' + NOW : ''));
});
