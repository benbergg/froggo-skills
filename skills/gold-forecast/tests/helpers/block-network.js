'use strict';
// 测试套件的硬约束:零外部流量。本 shim 把任何出网尝试变成显式报错,
// 而不是让它悄悄发出去。
//
// 存在的理由是一次真实事故:一条 CLI 测试跑了完整 runPipeline,
// Step 1a 的 collect-settlement 直接打了 prices.lbma.org.uk,而那条测试的断言是
// `status !== 5` —— 通网断网都成立,所以既没人发现在联网,也没人发现断言是空的。
// 光靠"记得给测试传 --fixture"守不住:漏一次就是一次真实请求,且不会红。
//
// 用法:helpers.runCli 已自动为所有子进程注入;自己 spawn 的测试用
//   NODE_OPTIONS: `--require ${BLOCK_NETWORK}`
// 整套自查:
//   NODE_OPTIONS="--require skills/gold-forecast/tests/helpers/block-network.js" \
//     node --test skills/gold-forecast/tests/run-*-tests.js

const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');

const LOCAL = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);
const boom = (what) => { throw new Error(`[NET-BLOCKED] ${what}`); };

global.fetch = (u) => Promise.reject(new Error(`[NET-BLOCKED] fetch ${typeof u === 'string' ? u : (u && u.url)}`));

for (const mod of [http, https]) {
  mod.request = (...a) => boom(`request ${JSON.stringify(a[0])}`);
  mod.get = (...a) => boom(`get ${JSON.stringify(a[0])}`);
}

// unix socket 与回环放行:node --test 自身以及可能的本地夹具服务器要用
const hostOf = (opt, fallback) => (opt && typeof opt === 'object' ? opt.host : fallback);
const isLocal = (opt) => typeof opt === 'string' || (opt && opt.path);

const origConnect = net.connect;
net.connect = (...a) => {
  if (isLocal(a[0])) return origConnect(...a);
  const host = hostOf(a[0], a[1]);
  if (!host || LOCAL.has(host)) return origConnect(...a);
  return boom(`net.connect ${host}`);
};

net.Socket.prototype.connect = new Proxy(net.Socket.prototype.connect, {
  apply(target, self, a) {
    const host = hostOf(a[0], null);
    if (host && !LOCAL.has(host)) boom(`socket.connect ${host}`);
    return Reflect.apply(target, self, a);
  },
});

// 拦到 DNS 这一层:即使有别的路径绕过上面几个入口,解析域名也过不去
dns.lookup = (h, o, cb) => {
  const done = typeof o === 'function' ? o : cb;
  if (LOCAL.has(h)) return done(null, '127.0.0.1', 4);
  return done(new Error(`[NET-BLOCKED] dns ${h}`));
};
