'use strict';
try{ require('./lib-systemca.cjs'); }catch(e){}  /* 系统证书库（加速器自签根证书） */
/* ============================================================================
 * notify.cjs —— 从 second-eye（goodprice）移植过来的多渠道路由推送层
 * ----------------------------------------------------------------------------
 * 来源：second-eye 项目的 goodprice/notify/ 目录（Python 原版），结构对照以下模块：
 *   base.py / registry.py / log.py / serverchan.py / wecom_robot.py
 *   feishu.py / gotify.py
 *
 * 移植时补齐了原版 Node 版缺的 7 件事：
 *   ① 渠道扩到 6 个（serverchan / wecom / feishu / gotify / bark / generic）
 *   ② 飞书 HMAC-SHA256 签名（原版无）
 *   ③ 超时 + 重试（5xx/网络错误重试，4xx 不重试，429 退避）
 *   ④ 按渠道字节上限自动分条（企微 2048B、飞书 19000B、Server酱 30000B）
 *   ⑤ 响应体错误码校验（200 但 code!=0 也判失败，不像原版一律"已推送"）
 *   ⑥ 每渠道限流（企微 20 条/分钟，超了排队而不是丢）
 *   ⑦ 发送历史落盘 data/notify-history.jsonl（可按条追溯成功/失败原因）
 *
 * 只依赖 Node 内置模块 + 全局 fetch / AbortSignal（Node 18+）。
 * 便携版 runtime\playwright-driver\node.exe 是 v24.18.0，全部满足。
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- 路径：跟着 monitor.cjs 的约定走 ---------- */
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const HISTF = path.join(DATA, 'notify-history.jsonl');
const STATEF = path.join(DATA, 'notify-state.json');

/* ---------- 日志：优先用 monitor.cjs 注入进来的 log ---------- */
let _log = (...a) => console.log('[notify]', ...a);
function bindLogger(fn) { if (typeof fn === 'function') _log = fn; }
const log = (...a) => { try { _log(...a); } catch (e) { /* 日志永不抛 */ } };

/* ============================================================================
 * 一、渠道定义
 * 每个渠道 = { key, label, enabled(cfg), async send(msg, cfg, opt) => {ok, detail} }
 * msg = { title, content, url }
 * ========================================================================== */

const CHANNELS = {};

/* ---------- 1. log：本地日志（second-eye 的 LogNotifier，永远启用） ---------- */
CHANNELS.log = {
  key: 'log',
  label: '本地日志',
  always: true,
  enabled: () => true,
  maxBytes: 0,
  async send(msg) {
    log('通知[log]: ' + msg.title + '\n' + msg.content + (msg.url ? '\n' + msg.url : ''));
    return { ok: true, detail: '写入 monitor.log' };
  }
};

/* ---------- 2. Server酱（sctapi.ftqq.com/{key}.send） ---------- */
CHANNELS.serverchan = {
  key: 'serverchan',
  label: 'Server酱',
  maxBytes: 30000,
  enabled: (c) => !!(c && c.enabled && c.sendkey),
  async send(msg, c, opt) {
    const url = 'https://sctapi.ftqq.com/' + encodeURIComponent(c.sendkey) + '.send';
    const body = new URLSearchParams();
    body.set('title', msg.title);
    body.set('desp', msg.content + (msg.url ? '\n' + msg.url : ''));
    const r = await httpJson(url, { method: 'POST', body, opt });
    let d;
    try { d = JSON.parse(r.text); } catch (e) { throw new Error('返回非 JSON: ' + r.text.slice(0, 120)); }
    if (Number(d.code) !== 0) throw new Error('Server酱返回错误: ' + JSON.stringify(d).slice(0, 200));
    return { ok: true, detail: 'code=0' };
  }
};

/* ---------- 3. 企业微信群机器人（20 条/分钟硬限） ---------- */
CHANNELS.wecom = {
  key: 'wecom',
  label: '企业微信机器人',
  maxBytes: 2000,              /* 企微 text.content 上限 2048 字节，留点余量 */
  enabled: (c) => !!(c && c.enabled && c.webhook),
  async send(msg, c, opt) {
    const payload = {
      msgtype: 'text',
      text: { content: msg.title + '\n' + msg.content + (msg.url ? '\n' + msg.url : '') }
    };
    const r = await httpJson(c.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      opt
    });
    let d;
    try { d = JSON.parse(r.text); } catch (e) { throw new Error('返回非 JSON: ' + r.text.slice(0, 120)); }
    if (Number(d.errcode) === 0) return { ok: true, detail: 'errcode=0' };
    if (Number(d.errcode) === 93000) throw new Error('企微机器人 webhook 无效或机器人已被移除，请重新添加');
    if (Number(d.errcode) === 93004) throw new Error('企微机器人发送太频繁（20 条/分钟），本条被拒');
    throw new Error('企微返回错误 errcode=' + d.errcode + ' ' + (d.errmsg || ''));
  }
};

/* ---------- 4. 飞书自定义机器人（HMAC-SHA256 签名 + 19000 字节硬截断） ---------- */
CHANNELS.feishu = {
  key: 'feishu',
  label: '飞书机器人',
  maxBytes: 19000,             /* 飞书请求体上限 20KB，原版按 UTF-8 字节裁到 19000 */
  enabled: (c) => !!(c && c.enabled && c.webhook),
  async send(msg, c, opt) {
    const payload = {
      msg_type: 'text',
      content: { text: msg.title + '\n' + msg.content + (msg.url ? '\n' + msg.url : '') }
    };
    if (c.secret) {
      /* second-eye/feishu.py 原样：key = "{timestamp}\n{secret}"，待签名内容为空串 */
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sign = crypto.createHmac('sha256', timestamp + '\n' + c.secret).update('').digest('base64');
      payload.timestamp = timestamp;
      payload.sign = sign;
    }
    const r = await httpJson(c.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      opt
    });
    let d;
    try { d = JSON.parse(r.text); } catch (e) { throw new Error('返回非 JSON: ' + r.text.slice(0, 120)); }
    const code = d.code !== undefined ? d.code : (d.StatusCode !== undefined ? d.StatusCode : -1);
    if (Number(code) !== 0) throw new Error('飞书返回错误 code=' + code + ' ' + (d.msg || ''));
    return { ok: true, detail: 'code=0' };
  }
};

/* ---------- 5. Gotify（X-Gotify-Key 头，priority 0-10） ---------- */
CHANNELS.gotify = {
  key: 'gotify',
  label: 'Gotify',
  maxBytes: 30000,
  enabled: (c) => !!(c && c.enabled && c.url && c.token),
  async send(msg, c, opt) {
    const base = String(c.url).replace(/\/+$/, '');
    const endpoint = /\/message$/.test(base) ? base : base + '/message';
    const payload = {
      title: msg.title,
      message: msg.content + (msg.url ? '\n' + msg.url : ''),
      priority: Math.max(0, Math.min(10, Number(c.priority === undefined ? 5 : c.priority) || 0))
    };
    const r = await httpJson(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Gotify-Key': c.token },
      body: JSON.stringify(payload),
      opt
    });
    if (r.status >= 400) throw new Error('Gotify 返回 ' + r.status + ' ' + r.text.slice(0, 120));
    return { ok: true, detail: 'HTTP ' + r.status };
  }
};

/* ---------- 6. Bark（iOS）----------
 * 【必读】原实现只有 GET /{key}/{title}/{body} 一种方式，正文全塞在路径里。
 * 实测 api.day.app 的 nginx 对请求行有硬上限：完整 URL 超过约 4000 字节直接回
 *   414 Request-URI Too Large
 * 而中文经 encodeURIComponent 后每个字膨胀到 9 字节（%E6%9F%8F…），
 * 一条命中约 230 字节正文 → 编码后约 660 字节 URL。也就是说：
 *   1 条能发、2 条能发、5 条约 2.9KB 还能发、**8 条就 4.5KB 直接 414**。
 * 后果很隐蔽：maxBytes 当时是 0（=不分条），所以只要命中超过 6 条，
 * Bark 渠道就整条失败，用户看到的是"Bark 推送失败: HTTP 414"而不知道为什么。
 *
 * 修法：改用 Bark v2 的官方 POST 接口 {服务器}/push，正文放 JSON body。
 * 实测该接口请求体上限约 8000 字节（8155 通过、8255 回 413），比 URL 宽松得多，
 * 且正文不再受 URL 编码膨胀影响。老的自建 bark 服务若没有 /push（404/405），
 * 自动回落到原来的 GET 形式，不至于因为换提交方式反而发不出去。
 */
const BARK_GROUP = '闲鱼扫货';

/* 解析用户填的 Bark 地址：
 *   https://api.day.app/AbCdEf123            → {pushUrl:'https://api.day.app/push', key:'AbCdEf123'}
 *   https://bark.example.com/bark/AbCdEf123  → {pushUrl:'https://bark.example.com/bark/push', key:'AbCdEf123'}
 * 取「最后一段路径」当 DeviceKey，前面的都当作自建服务的路径前缀。
 * 没有路径段（用户只填了域名）返回 null —— 这种情况根本不知道该推给哪台设备。
 */
function parseBarkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return null; }
  const segs = u.pathname.split('/').filter(Boolean);
  if (!segs.length) return null;
  const key = decodeURIComponent(segs[segs.length - 1]);
  if (!key) return null;
  const prefix = segs.slice(0, -1).join('/');
  /* pushUrl 直接基于字符串拼，不重新走 URL 对象 —— 这样自建服务的子路径、端口、
     http 协议都能原样保留，不会被规范化的意外改动坑到。 */
  const pushUrl = u.origin + (prefix ? '/' + prefix : '') + '/push';
  return { key, pushUrl, origin: u.origin };
}

CHANNELS.bark = {
  key: 'bark',
  label: 'Bark (iOS)',
  /* 正文原始字节上限 3000。JSON.stringify 后中文原样保留、只多转义引号换行，
     大约膨胀 1.05 倍，加上 device_key/标题固定开销不到 3.3KB —— 稳在 8KB 以内。 */
  maxBytes: 3000,
  enabled: (c) => !!(c && c.enabled && c.url),
  async send(msg, c, opt) {
    /* 【点击跳转 2026-10-29】以前只把链接当纯文本塞在正文末尾，用户在 iPhone 上点它
       会被 Bark 交给 SFSafariViewController 打开 —— 而 SFSafariViewController **永不触发
       Universal Link**，所以既不会拉起闲鱼 App，又因为 h5 页是 PHA 容器页而白屏。
       Bark 官方支持顶层 `url` 字段：点【通知本体】时由系统打开，走的是真 Safari，
       Universal Link 才会把 com.taobao.fleamarket 拉起来（h5.m.goofish.com 的
       apple-app-site-association 声明了 paths:["*"]，任意路径都能唤端 —— 已实测可访问）。
       正文里的链接保持原样不动：一是没装 App 的人仍能复制，二是老版本 Bark 忽略 url 字段时
       还有文本链接可用。 */
    const jump = msg.jump ? mobileUrl(msg.jump) : (msg.url ? mobileUrl(msg.url) : '');
    const body = msg.content + ((jump && msg.content.indexOf(jump) < 0) ? '\n' + jump : '');
    const parsed = parseBarkUrl(c.url);
    if (!parsed) {
      throw new Error('Bark 地址里没找到 DeviceKey（应形如 https://api.day.app/你的DeviceKey）');
    }

    /* 首选：POST {服务器}/push —— 正文放 body，不受 URL 长度限制 */
    try {
      const payload = {
        device_key: parsed.key,
        title: msg.title,
        body,
        group: BARK_GROUP,
        isArchive: 1,
        level: 'active'
      };
      /* 顶层 url：点通知跳这里（关键字段，缺了就只能点正文里的纯文本链接） */
      if (jump) payload.url = jump;
      const r = await httpText(parsed.pushUrl, {
        method: 'POST',
        /* connection: close 是刻意的：监控每轮间隔 4~5.5 分钟，keep-alive 空连接会被
           api.day.app 单方面 RST，下一轮第一发必然 ECONNRESET（已连续 3 轮复现）。
           关掉复用后每次都新建 socket，实测单次 128~170ms，代价可以忽略，
           但彻底消灭了"每轮第一条必失败"的问题。 */
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify(payload),
        opt
      });
      const d = parseJson(r.text);
      if (d && d.code !== undefined && Number(d.code) !== 200) {
        throw new Error('Bark 返回 code=' + d.code + ' ' + (d.message || ''));
      }
      return { ok: true, detail: 'HTTP ' + r.status + ' · POST /push' };
    } catch (e) {
      /* 只有"这个服务器没有 /push 接口"才回落；设备密钥错、正文过大等问题回落也没用，
         回落反而会把真实原因（比如 413）掩盖成 404，所以这里必须精确匹配。 */
      const m = String(e && e.message || e);
      if (!/^HTTP (404|405|501)\b/.test(m)) throw e;
      log('[bark] 该服务器不支持 POST /push（' + m + '），回落为 GET 老接口');
    }

    /* 回落：GET /{key}/{title}/{body}，兼容老版本自建 bark */
    const base = String(c.url).replace(/\/+$/, '');
    const url = base + '/' + encodeURIComponent(msg.title) + '/' + encodeURIComponent(body);
    const r = await httpText(url, { method: 'GET', opt });
    if (r.status >= 400) throw new Error('Bark 返回 ' + r.status + ' ' + r.text.slice(0, 120));
    const d = parseJson(r.text);
    if (d && d.code !== undefined && Number(d.code) !== 200) {
      throw new Error('Bark 返回 code=' + d.code + ' ' + (d.message || ''));
    }
    return { ok: true, detail: 'HTTP ' + r.status + ' · GET（回落）' };
  }
};

/* ---------- 7. generic（钉钉 / 飞书 / Slack / 裸 text，原版 webhook 的升级版） ---------- */
CHANNELS.generic = {
  key: 'generic',
  label: '自定义 Webhook',
  maxBytes: 2000,
  enabled: (c) => !!(c && c.enabled && c.url),
  async send(msg, c, opt) {
    const text = msg.title + '\n' + msg.content + (msg.url ? '\n' + msg.url : '');
    let payload;
    const type = String(c.type || 'wecom').toLowerCase();
    if (type === 'wecom' || type === 'dingtalk') payload = { msgtype: 'text', text: { content: text } };
    else if (type === 'feishu') payload = { msg_type: 'text', content: { text } };
    else if (type === 'slack') payload = { text };
    else payload = { text };
    const r = await httpJson(c.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      opt
    });
    if (r.status >= 400) throw new Error('Webhook 返回 ' + r.status + ' ' + r.text.slice(0, 120));
    let d = null;
    try { d = JSON.parse(r.text); } catch (e) { /* 裸 text 接口不返回 JSON，正常 */ }
    if (d) {
      if (Number(d.errcode) > 0) throw new Error('Webhook 错误 errcode=' + d.errcode + ' ' + (d.errmsg || ''));
      if (d.code !== undefined && Number(d.code) !== 0) throw new Error('Webhook 错误 code=' + d.code);
    }
    return { ok: true, detail: 'HTTP ' + r.status };
  }
};

const CHANNEL_KEYS = Object.keys(CHANNELS);

/* ============================================================================
 * 二、HTTP 基础设施：超时 / 重试 / 错误分类
 * ========================================================================== */

/* 【修 BUG-RESET 2026-10-29】每轮第一发必失败的真实原因：
   监控每轮间隔 4~5.5 分钟（intervalSeconds 240 + jitterSeconds 90），而 Node 内置 fetch
   （undici）与 api.day.app 之间那条 keep-alive 空连接会被对方单方面 RST。下一次请求复用到
   这条已死的 socket，立刻抛 fetch failed (ECONNRESET)。日志里的 ms=6136 正是 3 次尝试
   （每次几十毫秒就失败）+ 2s、4s 两次退避之和 —— 三次全打在同一个死连接上，纯重试救不回来。
   修法（三层，任一层生效即可，互不冲突）：
     ① 第 2 次起强制 connection: close，逼 undici 换新 socket，不再复用死连接；
     ② 退避加 0~250ms 抖动，避免和对方的限流窗口对齐；
     ③ 渠道层在推送前打一次轻量热身请求（见 barkWarm），把这条死连接的账提前认掉。 */
const NET_ERR_RE = /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|other side closed|fetch failed|terminated|请求超时/i;

function isNetErr(m) { return NET_ERR_RE.test(String(m == null ? '' : m)); }

async function httpText(url, opts) {
  const o = opts || {};
  const opt = o.opt || {};
  const timeoutMs = Number(opt.timeoutMs || 15000);
  const attempts = Math.max(1, Number(opt.retry || 3));
  const delay = Math.max(0, Number(opt.retryDelayMs === undefined ? 2000 : opt.retryDelayMs));
  let lastErr = null;

  for (let i = 1; i <= attempts; i++) {
    let res;
    /* 重试一律强制关连接：第 1 次正常复用（快），失败后每次都要新 socket */
    let headers = o.headers;
    if (i > 1) {
      headers = Object.assign({}, o.headers || {});
      if (!headers.connection && !headers.Connection) headers.connection = 'close';
    }
    try {
      res = await fetch(url, {
        method: o.method || 'GET',
        headers,
        body: o.body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      /* 网络层错误（DNS / 拒连 / 超时 / 死连接）→ 重试 */
      lastErr = new Error(errText(e));
      if (i < attempts) await sleep(delay * i + Math.floor(Math.random() * 250));
      continue;
    }
    const text = await res.text().catch(() => '');
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error('HTTP ' + res.status + ' ' + text.slice(0, 160));
      if (i < attempts) await sleep(delay * i + Math.floor(Math.random() * 250));
      continue;
    }
    if (res.status >= 400) {
      /* 4xx（除 429）是配置错，重试没意义 */
      throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 200));
    }
    return { status: res.status, text };
  }
  throw lastErr || new Error('未知网络错误');
}

async function httpJson(url, opts) { return httpText(url, opts); }

/* 宽松解析响应体：解析不出来就返回 null，由调用方决定"没有 code 字段"算不算成功。
   与上面各渠道里的 try/catch 写法等价，抽出来是因为 Bark 的 POST 与 GET 两条路径都要用。 */
function parseJson(text) {
  try { return JSON.parse(String(text || '')); } catch (e) { return null; }
}

function errText(e) {
  if (!e) return '未知错误';
  if (e.name === 'TimeoutError' || /aborted|timeout/i.test(String(e.message))) return '请求超时';
  const c = e.cause && (e.cause.code || e.cause.message);
  return (e.message || String(e)) + (c ? ' (' + c + ')' : '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================================
 * 三、按字节上限分条 —— 原版 Node 是"拼一条长文本"，企微/飞书必挂
 * ========================================================================== */

function byteLen(s) { return Buffer.byteLength(String(s), 'utf8'); }

function splitByBytes(text, limit) {
  const s = String(text == null ? '' : text);
  if (!limit || limit <= 0 || byteLen(s) <= limit) return [s];
  const out = [];
  let cur = '';
  for (const line of s.split('\n')) {
    const cand = cur ? cur + '\n' + line : line;
    if (byteLen(cand) <= limit) { cur = cand; continue; }
    if (cur) { out.push(cur); cur = ''; }
    /* 单行本身就超限 → 硬切 */
    if (byteLen(line) <= limit) { cur = line; continue; }
    let buf = '';
    for (const ch of line) {
      if (byteLen(buf + ch) > limit) { out.push(buf); buf = ''; }
      buf += ch;
    }
    cur = buf;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/* ============================================================================
 * 四、限流：每渠道一个滑动窗口（企微 20 条/分钟，超了等，不丢）
 * ========================================================================== */

const _sentAt = {};   /* channelKey -> [ts, ts, ...] */
const RL_WINDOW_MS = 60 * 1000;
const RL_LIMIT = { wecom: 20, serverchan: 30, feishu: 30, gotify: 60, bark: 60, generic: 20, log: 10000 };

async function rateLimitGate(key) {
  const limit = RL_LIMIT[key] || 30;
  const arr = _sentAt[key] || (_sentAt[key] = []);
  const nowTs = Date.now();
  while (arr.length && nowTs - arr[0] > RL_WINDOW_MS) arr.shift();
  if (arr.length < limit) return;
  const waitMs = RL_WINDOW_MS - (nowTs - arr[0]) + 50;
  if (waitMs > 0) {
    log('[' + key + '] 触发限流 ' + limit + ' 条/分钟，等 ' + Math.ceil(waitMs / 1000) + 's');
    await sleep(waitMs);
  }
  const t2 = Date.now();
  while (arr.length && t2 - arr[0] > RL_WINDOW_MS) arr.shift();
  if (arr.length >= limit) { arr.length = 0; }   /* 极端兜底：清空窗口，宁可多发包也不卡死 */
}

function markSent(key) {
  (_sentAt[key] || (_sentAt[key] = [])).push(Date.now());
}

/* ============================================================================
 * 五、发送历史（data/notify-history.jsonl，一行一条，可追溯）
 * ========================================================================== */

function appendHistory(rec) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(HISTF, JSON.stringify(rec) + '\n');
    /* 简单轮转：超过 5MB 留最后 5000 行 */
    try {
      const st = fs.statSync(HISTF);
      if (st.size > 5 * 1024 * 1024) {
        const lines = fs.readFileSync(HISTF, 'utf8').trim().split('\n');
        fs.writeFileSync(HISTF, lines.slice(-5000).join('\n') + '\n');
      }
    } catch (e) { /* 轮转失败不影响主流程 */ }
  } catch (e) { /* 历史写失败绝不影响推送 */ }
}

/* ============================================================================
 * 六、状态持久化（data/notify-state.json）
 *    notified: { itemId: { at, satisfaction, price } }  ← 重复通知抑制的依据
 * ========================================================================== */

let _state = null;
function loadState() {
  if (_state) return _state;
  try { _state = JSON.parse(fs.readFileSync(STATEF, 'utf8')); } catch (e) { _state = {}; }
  if (!_state || typeof _state !== 'object') _state = {};
  if (!_state.notified || typeof _state.notified !== 'object') _state.notified = {};
  if (!_state.stats || typeof _state.stats !== 'object') _state.stats = { sent: 0, failed: 0 };
  return _state;
}
function saveState() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(STATEF, JSON.stringify(loadState(), null, 0));
  } catch (e) { log('状态落盘失败: ' + e.message); }
}
/* 只保留最近 20000 条，防止无限增长 */
function pruneState() {
  const s = loadState();
  const ids = Object.keys(s.notified);
  if (ids.length <= 20000) return;
  ids.sort((a, b) => (s.notified[a].at || 0) - (s.notified[b].at || 0));
  const drop = ids.slice(0, ids.length - 20000);
  drop.forEach((k) => delete s.notified[k]);
}

/* ============================================================================
 * 七、配置归一化 —— 兼容你现有 config.json 里的老 notify 块
 *   老格式：{ enabled, bark, webhook, webhookType }
 *   新格式：{ enabled, timeoutMs, retry, bark:{...}, wecom:{...}, ... }
 * ========================================================================== */

function normalizeConfig(raw) {
  const n = (raw && typeof raw === 'object') ? raw : {};
  const c = {
    enabled: n.enabled !== false,
    timeoutMs: Math.max(3000, Math.min(120000, Number(n.timeoutMs) || 15000)),
    retry: Math.max(1, Math.min(6, Number(n.retry) || 3)),
    retryDelayMs: Math.max(0, Math.min(60000, Number(n.retryDelayMs === undefined ? 2000 : n.retryDelayMs))),
    maxItemsPerMessage: Math.max(1, Math.min(50, Number(n.maxItemsPerMessage) || 15)),
    priceDropNotify: n.priceDropNotify !== false,
    priceDropPct: Math.max(0.005, Math.min(0.9, Number(n.priceDropPct) || 0.03)),
    onlyIncreaseRenotify: n.onlyIncreaseRenotify !== false,
    channels: {}
  };

  /* 逐渠道：新格式对象优先，老格式字符串兜底 —— 用户不改配置也能用 */
  const ch = n.channels && typeof n.channels === 'object' ? n.channels : n;

  c.channels.serverchan = {
    enabled: !!(ch.serverchan && ch.serverchan.enabled),
    sendkey: (ch.serverchan && ch.serverchan.sendkey) || ''
  };
  c.channels.wecom = {
    enabled: !!(ch.wecom && ch.wecom.enabled),
    webhook: (ch.wecom && ch.wecom.webhook) || ''
  };
  c.channels.feishu = {
    enabled: !!(ch.feishu && ch.feishu.enabled),
    webhook: (ch.feishu && ch.feishu.webhook) || '',
    secret: (ch.feishu && ch.feishu.secret) || ''
  };
  c.channels.gotify = {
    enabled: !!(ch.gotify && ch.gotify.enabled),
    url: (ch.gotify && ch.gotify.url) || '',
    token: (ch.gotify && ch.gotify.token) || '',
    priority: (ch.gotify && ch.gotify.priority !== undefined) ? ch.gotify.priority : 5
  };
  c.channels.bark = {
    enabled: !!(ch.bark && ch.bark.enabled),
    url: (ch.bark && ch.bark.url) || (typeof ch.bark === 'string' ? ch.bark : '') || ''
  };
  c.channels.generic = {
    enabled: !!(ch.generic && ch.generic.enabled),
    url: (ch.generic && ch.generic.url) || '',
    type: (ch.generic && ch.generic.type) || 'wecom'
  };

  /* 老格式兼容：顶层 bark 字符串 / webhook 字符串 直接映射过来 */
  if (!c.channels.bark.url && typeof n.bark === 'string' && n.bark) {
    c.channels.bark = { enabled: true, url: n.bark };
  }
  if (!c.channels.generic.url && typeof n.webhook === 'string' && n.webhook) {
    c.channels.generic = { enabled: true, url: n.webhook, type: n.webhookType || 'wecom' };
  }

  /* 顶层旧键当开关（老配置只写 bark:"..." 没写 enabled 子键，等价于启用） */
  if (typeof n.bark === 'string' && n.bark) c.channels.bark.enabled = true;
  if (typeof n.webhook === 'string' && n.webhook) c.channels.generic.enabled = true;

  /* 只要有 enabled:false 且没配任何渠道 → 全关 */
  if (n.enabled === false) {
    Object.keys(c.channels).forEach((k) => { c.channels[k].enabled = false; });
  }
  /* 自检标记透传：monitor.cjs 的 /__scan/notifytest 会设 __test=true，
     让 sendOne 不把测试消息计进"累计成功/失败"。放在 normalizeConfig 里显式透传，
     否则调用方在外面设会被这里的白名单对象直接吃掉（静默失效）。 */
  if (n.__test) c.__test = true;
  return c;
}

/* ============================================================================
 * 八、装配启用的渠道（对齐 second-eye 的 build_enabled_notifiers）
 * ========================================================================== */

function buildEnabled(cfg) {
  const out = [];
  for (const key of CHANNEL_KEYS) {
    const def = CHANNELS[key];
    const c = cfg.channels[key];
    if (def.always) { out.push({ def, c }); continue; }
    if (!c) continue;
    if (!c.enabled) continue;
    try { if (def.enabled(c)) out.push({ def, c }); } catch (e) { /* 配置残缺就跳过 */ }
  }
  return out;
}

/* ============================================================================
 * 九、文案渲染（对齐 second-eye crawl_service._notify 的行结构）
 * ========================================================================== */

/* 【标题截断】旧实现 slice(0,60) 是硬切，不看标点，实测切出半句（"拍照清晰 系"）。
   现在按标点找最近的断点：优先在 60 字以内最后一个 、，。；/·| 处断开，找不到就硬切，
   被截断时补"…"，读者一眼能看出这是节选而不是标题本身就不完整。 */
const TITLE_MAX = 80;
const TITLE_BREAKS = ['。', '；', '，', '、', ' ', '/', '|', '·', ',', '.'];
function clipTitle(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const m = max || TITLE_MAX;
  if (t.length <= m) return t;
  /* 在 [m*0.6, m] 区间内从后往前找最后一个标点，找不到再硬切 */
  const floor = Math.floor(m * 0.6);
  for (let i = m; i >= floor; i--) {
    if (TITLE_BREAKS.indexOf(t.charAt(i)) >= 0) {
      const cut = t.slice(0, i).trim();
      if (cut) return cut + '…';
    }
  }
  return t.slice(0, m).trim() + '…';
}

/* 【商品简介】把卖家描述压成一行：去掉换行/多余空白、滤掉纯表情与"想要"之类的噪声，
   截到 max 字。描述本来就常带换行和连续空格，直接用会让一条消息占掉十几行。 */
const DESC_MAX = 140;
function clipDesc(s, max) {
  let t = String(s == null ? '' : s).replace(/\r/g, '\n');
  t = t.split('\n').map(function (x) { return x.replace(/\s+/g, ' ').trim(); })
    .filter(function (x) { return x && x !== '想要' }).join(' / ');
  if (!t) return '';
  const m = max || DESC_MAX;
  return t.length <= m ? t : (t.slice(0, m).replace(/[，、。；\s]+$/, '') + '…');
}

/* 【手机版链接 2026-10-29】把 www.goofish.com 的商品链接换成 h5.m.goofish.com。
   为什么要换：只有 h5.m.goofish.com 声明了 App 关联（实测两份文件都可访问）
     · /.well-known/apple-app-site-association → com.taobao.fleamarket，paths:["*"]  （iOS Universal Link）
     · /.well-known/assetlinks.json → com.taobao.idlefish，handle_all_urls            （Android App Links）
   而 www.goofish.com 这两个文件都是 404 —— 所以点 PC 链接只会在浏览器里开网页，
   不会拉起闲鱼 App。换成 h5 域后，手机上点通知里的链接会直接进 App 商品页；
   没装 App 则原地打开手机版详情页（排版正常），比 PC 页好。
   只改推送渲染，不动 hits.json 里的原始 url，也不影响面板列表里的链接。 */
function mobileUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  /* www.goofish.com/item?id=xxx  →  h5.m.goofish.com/item?id=xxx
     不带 www 的写法也一并归一 */
  let m = s.match(/^https?:\/\/(?:www\.)?goofish\.com\/item\?(.*)$/i);
  if (m) return 'https://h5.m.goofish.com/item?' + m[1];
  /* 已经是 h5 域：原样返回（幂等，重复调用不会叠加前缀） */
  if (/^https?:\/\/h5\.m\.goofish\.com\//i.test(s)) return s;
  /* 旧版长链 2.taobao.com/item.htm?id=xxx → 归一成 h5 商品页 */
  m = s.match(/^https?:\/\/(?:2|sale)\.taobao\.com\/item\.htm\?(.*)$/i);
  if (m) {
    const id = (m[1].match(/(?:^|&)id=(\d+)/) || [])[1];
    if (id) return 'https://h5.m.goofish.com/item?id=' + id;
  }
  return s;
}

function renderItem(h, extra, showBest) {
  const lines = [];
  /* 标题行：价格 + 标题（按标点断句，不再硬切半句） */
  lines.push(h.priceText + '  ' + clipTitle(h.title));
  /* 商品简介：卖家描述（来自 desc-cache.json / 详情页 idle.pc.detail 的 itemDO.desc）。
     旧实现完全没有这一行，用户收到的就是"价格+地区+链接"，看不出成色和配件 —— 这是
     "推这个没什么用"的直接原因。没有描述时整行省略，不显示"简介：无"这种废话。
     描述由 monitor.cjs 的 notify() 放进 __extra.desc；同时兼容直接挂在 hits 上的 desc 字段。 */
  const descSrc = (extra && extra.desc != null) ? extra.desc : (h.desc != null ? h.desc : h.__desc);
  const desc = clipDesc(descSrc);
  if (desc) lines.push('简介：' + desc);
  if (h.area) lines.push('地区：' + h.area);
  if (h.publishAt) lines.push('发布：' + h.publishAt);
  if (h.seller) {
    const rate = h.sellerRate ? (' 好评率 ' + h.sellerRate) : '';
    lines.push('卖家：' + h.seller + rate);
  }
  if (extra) {
    if (extra.dropPct) lines.push('较首见降价 ' + (extra.dropPct * 100).toFixed(0) + '%');
    if (extra.prevPriceText) lines.push('价格更新重推：' + extra.prevPriceText + ' → ' + h.priceText);
    if (extra.satisfaction != null) lines.push('综合分：' + Number(extra.satisfaction).toFixed(0));
    /* 只有本批超过 1 件时「本批最优」才有意义。maxItemsPerMessage=1 时每条消息只有
       一件货，它自己就是「最优」，这行纯属噪音（实测 77% 的推送都属于这种情况）。 */
    if (extra.best && showBest) lines.push('本批最优');
  }
  /* 链接统一换成手机版域（能直接拉起闲鱼 App），见上方 mobileUrl 注释 */
  if (h.url) lines.push(mobileUrl(h.url));
  return lines.join('\n');
}

/* 【汇总精简渲染 2026-11-03】重启积压"汇总成一条"时专用。
   为什么要单独一套：实测完整渲染 8 条 = 5094 字节，超过 Bark 的 3000 字节上限，
   会被自动切成 2 片 —— 手机照样连响两次，"汇总成 1 次"就落空了。
   汇总的目的是"手机只响一次、快速扫一眼有哪些货"，细节可以点进面板看，
   所以这里只留「价格 + 标题（截短）+ 地区与发布时间 + 链接」四要素，
   去掉简介/卖家/好评率/综合分。8 条实测 ≈ 1400 字节，稳稳一条发完。 */
const COMPACT_TITLE_MAX = 24;
function renderItemCompact(h) {
  const lines = [];
  lines.push(h.priceText + '  ' + clipTitle(h.title, COMPACT_TITLE_MAX));
  const meta = [];
  if (h.area) meta.push(h.area);
  if (h.publishAt) meta.push(h.publishAt);
  if (meta.length) lines.push(meta.join(' · '));
  if (h.url) lines.push(mobileUrl(h.url));
  return lines.join('\n');
}

function buildMessage(items, opts) {
  const o = opts || {};
  const list = items || [];
  const head = o.head || ('闲鱼扫货 命中 ' + list.length + ' 条');
  const parts = list.map((x) => (o.compact
    ? renderItemCompact(x)
    : renderItem(x, x.__extra || null, list.length > 1)));
  const content = parts.join('\n\n');
  /* jump：点【通知本体】时跳转的地址（Bark 顶层 url 字段用）。
     单独一个字段，不复用 url —— generic / serverchan 等渠道会把 msg.url 再追加到正文末尾，
     复用会导致同一串链接在正文里出现两遍。 */
  return { title: head, content, url: '', jump: o.jump ? mobileUrl(o.jump) : '' };
}

/* ============================================================================
 * 十、主入口：send —— 一条消息发给所有启用渠道，每渠道独立成败
 * ========================================================================== */

async function send(msg, cfg) {
  const c = cfg || normalizeConfig({});
  const targets = buildEnabled(c);
  const results = [];
  for (const t of targets) {
    results.push(await sendOne(t.def, t.c, msg, c));
  }
  return results;
}

async function sendOne(def, chanCfg, msg, cfg) {
  const chunks = splitByBytes(msg.content, def.maxBytes);
  const multi = chunks.length > 1;
  const startedAt = Date.now();
  let okCount = 0;
  const errs = [];

  for (let i = 0; i < chunks.length; i++) {
    const sub = {
      title: multi ? (msg.title + ' (' + (i + 1) + '/' + chunks.length + ')') : msg.title,
      content: chunks[i],
      url: msg.url,
      /* 分片时跳转地址只给第 1 片：点第 2、3 条通知跳到本批最优那件，
         比跳到"随便某件"更好用，也避免用户误以为每条都是同一个商品。 */
      jump: i === 0 ? (msg.jump || '') : ''
    };
    try {
      await rateLimitGate(def.key);
      const r = await def.send(sub, chanCfg, cfg);
      markSent(def.key);
      okCount++;
      appendHistory({
        at: new Date().toISOString(),
        channel: def.key,
        part: i + 1,
        parts: chunks.length,
        ok: true,
        detail: r && r.detail,
        title: sub.title,
        bytes: byteLen(sub.content),
        ms: Date.now() - startedAt
      });
    } catch (e) {
      const m = String(e && e.message || e);
      errs.push(m);
      appendHistory({
        at: new Date().toISOString(),
        channel: def.key,
        part: i + 1,
        parts: chunks.length,
        ok: false,
        detail: m.slice(0, 300),
        title: sub.title,
        bytes: byteLen(sub.content),
        ms: Date.now() - startedAt
      });
      /* 【修 BUG-CASCADE 2026-10-29】以前这里是"第一条失败就 break"，
         理由是"配置错/地址错，后面不用再试，避免刷屏"。问题是 ECONNRESET 这种瞬时网络错误
         也被当成配置错 —— 一次 71 条的推送分成 3~4 片，第 1 片撞上死连接，剩下 2~3 片直接不发，
         20 条消息就此消失（日志：推送阶段完成：待推 71 条 → 成功 51 / 失败 20）。
         现在只对"确定性错误"（4xx / 密钥错 / 地址错 / 正文过大）才停手；
         网络层错误继续发下一片，且下一片自然走 httpText 的 connection: close 新连接。 */
      const fatal = !isNetErr(m);
      if (fatal && i === 0 && chunks.length > 1) { errs.push('（后续 ' + (chunks.length - 1) + ' 条未发送）'); break; }
    }
    if (multi && i < chunks.length - 1) await sleep(300);
  }

  if (errs.length) {
    log('[' + def.key + '] 推送失败: ' + errs[0]);
    /* 计数口径：一次 sendOne = 一个渠道的一次投递尝试，成功记 sent、失败记 failed。
       两处排除：
       · log 渠道 always:true 永不失败，计进去会让"累计成功"永远虚高；
       · cfg.__test 为真的自检消息不计入，否则用户点两次"测试"面板就显示
         "累计成功 2 次"，会误以为真实推送早就通了。 */
    if (!def.always && !(cfg && cfg.__test)) bumpStats(false);
    return { channel: def.key, ok: false, sent: okCount, failed: chunks.length - okCount, errors: errs };
  }
  log('[' + def.key + '] 已推送' + (multi ? '（分 ' + chunks.length + ' 条）' : ''));
  if (!def.always && !(cfg && cfg.__test)) bumpStats(true);
  return { channel: def.key, ok: true, sent: okCount, failed: 0, errors: [] };
}

/* ============================================================================
 * 十一、单渠道测试（对齐 second-eye 的 POST /settings/test-notification/{ch}）
 * ========================================================================== */

async function testChannel(channelKey, rawCfg) {
  const cfg = normalizeConfig(rawCfg);
  const def = CHANNELS[channelKey];
  if (!def) return { ok: false, msg: '未知通知渠道: ' + channelKey };
  const chanCfg = cfg.channels[channelKey];
  if (!def.always && !(chanCfg && def.enabled(chanCfg))) {
    return { ok: false, msg: '该通知渠道尚未配置' };
  }
  const msg = {
    title: '闲鱼扫货 测试推送',
    content: '这是一条测试消息，时间：' + new Date().toLocaleString('zh-CN'),
    url: ''
  };
  try {
    const r = await def.send(msg, chanCfg, cfg);
    return { ok: true, msg: (def.label || channelKey) + ' 推送成功' + (r && r.detail ? '（' + r.detail + '）' : '') };
  } catch (e) {
    return { ok: false, msg: (def.label || channelKey) + ' 推送失败: ' + String(e && e.message || e).slice(0, 200) };
  }
}

/* ============================================================================
 * 十二、重复通知抑制（对齐 second-eye 的 last_notified_satisfaction）
 * ----------------------------------------------------------------------------
 * 单一事实来源：价格记忆（price-memory.cjs）里的 notifiedScore。
 * 本文件的 _state.notified 只作降级兜底 —— 若宿主没注入价格记忆模块，
 * 就退回本文件自己的 JSON，行为不变。
 * ========================================================================== */

let _priceMemory = null;
function bindPriceMemory(pm) { if (pm && typeof pm.getNotifiedScore === 'function') _priceMemory = pm; }

function markNotified(itemId, satisfaction, price) {
  if (_priceMemory) { try { _priceMemory.setNotifiedScore(itemId, satisfaction); } catch (e) {} return; }
  const s = loadState();
  s.notified[String(itemId)] = { at: Date.now(), satisfaction: satisfaction, price: price };
  pruneState();
  saveState();
}

function lastNotified(itemId) {
  if (_priceMemory) {
    try {
      const e = _priceMemory.get(itemId);
      if (!e) return null;
      if (e.notifiedScore == null) return null;
      return { at: e.notifiedAt || e.lastAt || 0, satisfaction: e.notifiedScore, price: e.last };
    } catch (e) { /* 落到兜底 */ }
  }
  const s = loadState();
  return s.notified[String(itemId)] || null;
}

/**
 * 是否该推送这条。
 * 规则（移植自 crawl_service._run_impl 通知阶段）：
 *   · 从未推过 → 推
 *   · 降过价（isRenotify）且 onlyIncreaseRenotify → 仅当综合分比上次高才推
 *   · 其他情况 → 不推
 */
function shouldNotify(item, satisfaction, cfg) {
  const last = lastNotified(item.itemId);
  if (!last) return { yes: true, reason: '首次命中' };
  if (!item.__isRenotify) return { yes: false, reason: '已推过且无价格变化' };
  if (cfg && cfg.onlyIncreaseRenotify === false) return { yes: true, reason: '降价重推（不比较分数）' };
  const prev = last.satisfaction;
  if (prev == null) return { yes: true, reason: '降价重推（无历史分数）' };
  if (satisfaction > prev + 1e-9) {
    return { yes: true, reason: '降价重推（综合分 ' + Number(prev).toFixed(0) + ' → ' + Number(satisfaction).toFixed(0) + '）' };
  }
  return { yes: false, reason: '降价但综合分未提升（' + Number(prev).toFixed(0) + ' → ' + Number(satisfaction).toFixed(0) + '）' };
}

function bumpStats(ok) {
  const s = loadState();
  if (ok) s.stats.sent = (s.stats.sent || 0) + 1;
  else s.stats.failed = (s.stats.failed || 0) + 1;
  saveState();
}

function getStats() {
  const s = loadState();
  return { sent: s.stats.sent || 0, failed: s.stats.failed || 0, tracked: Object.keys(s.notified).length };
}

module.exports = {
  CHANNELS,
  CHANNEL_KEYS,
  bindLogger,
  bindPriceMemory,
  normalizeConfig,
  buildEnabled,
  buildMessage,
  renderItem,
  mobileUrl,
  clipTitle,
  clipDesc,
  send,
  sendOne,
  testChannel,
  markNotified,
  lastNotified,
  shouldNotify,
  bumpStats,
  getStats,
  splitByBytes,
  byteLen,
  isNetErr,
  loadState,
  saveState,
  paths: { ROOT, DATA, HISTF, STATEF }
};
