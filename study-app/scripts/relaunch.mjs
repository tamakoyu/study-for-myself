#!/usr/bin/env node
/**
 * relaunch.mjs —— 「一键重启」的看门人
 *
 * 为什么不能自己重启自己：重启的请求是**老进程**在处理，它得先退出把端口让出来，
 * 新的进程才能 bind 上去。所以流程是：
 *
 *   老进程 spawn 这个看门人（detached，脱离老进程）
 *     → 老进程退出
 *     → 看门人**轮询端口**，等它空出来
 *     → 再把 server.mjs 拉起来（--no-open，别再弹一个浏览器窗口）
 *
 * 新进程的输出追加到 `study-app/.server.log`（不在终端里了，日志得有地方看）。
 *
 * 用法：node scripts/relaunch.mjs <server.mjs 的路径> <端口> [其它参数…]
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [serverPath, portArg, ...rest] = process.argv.slice(2);
if (!serverPath) {
  console.error('用法：node scripts/relaunch.mjs <server.mjs> <端口> [参数…]');
  process.exit(1);
}
const port = Number(portArg) || 4173;
const appDir = path.dirname(path.resolve(serverPath));
// 跑测试时把它指到测试目录，别往真 study-app/ 里写日志
const LOG = process.env.RELAUNCH_LOG || path.join(appDir, '.server.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口还占着吗？（连不上 = 空出来了） */
function portBusy() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (busy) => {
      sock.destroy();
      resolve(busy);
    };
    sock.setTimeout(1200, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const t0 = Date.now();
while (await portBusy()) {
  // 最多等 20 秒：等不到也照样拉起来，让新服务自己报「端口被占用」，比在这儿干等强
  if (Date.now() - t0 > 20000) break;
  await sleep(250);
}

let out = 'ignore';
try {
  out = fs.openSync(LOG, 'a');
} catch {
  /* 开不了日志文件就让它自生自灭（服务照样能起来） */
}
const child = spawn(process.execPath, [path.resolve(serverPath), '--no-open', '--port', String(port), ...rest], {
  cwd: appDir,
  env: process.env,
  detached: true,
  stdio: out === 'ignore' ? 'ignore' : ['ignore', out, out],
});
child.unref();
if (out !== 'ignore') {
  try {
    fs.closeSync(out);
  } catch {
    /* 已经关了就算了 */
  }
}
