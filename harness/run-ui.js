'use strict';
/**
 * 画面の通し検証をまとめて動かす。
 *   node harness/run-ui.js
 * ローカルサーバを日付固定（2026-09-12）で起動し、ui-smoke.js を実行して、終わったらサーバを止める。
 * 日付を固定するのは、サンプルデータと採番（Q-2026-0004 など）が今日の日付で変わるため。
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.UI_PORT || '8799';
const BASE = 'http://localhost:' + PORT;

const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', PORT, '--now', '2026-09-12'], { stdio: ['ignore', 'pipe', 'inherit'] });

function stop(code) { server.kill(); process.exit(code); }

let started = false;
server.stdout.on('data', (buf) => {
  process.stdout.write(buf);
  if (started || !String(buf).includes('demo server')) return;
  started = true;
  const smoke = spawn(process.execPath, [path.join(__dirname, 'ui-smoke.js'), BASE], { stdio: 'inherit' });
  smoke.on('exit', (code) => stop(code === null ? 1 : code));
});
server.on('exit', (code) => { if (!started) { console.error('server exited before start: ' + code); process.exit(1); } });
setTimeout(() => { console.error('ui test timed out'); stop(1); }, 120000).unref();
