'use strict';
/* ============================================================================
 * price-memory.cjs —— 价格记忆 / 降价重推数据层
 * ----------------------------------------------------------------------------
 * 为什么必须有这一层：
 *   你的 monitor.cjs 用 seen{} 只记 itemId + 首次时间，命中后就走
 *   `if(wasSeen) continue`（monitor.cjs:2667-2673）—— 第二次看到同一个商品
 *   直接跳过，**价格根本不会被再读一次**。于是"降价提醒"在 Node 版里
 *   不是没做，是**没有数据可做**。
 *
 *   桌面版 second-eye 靠 listings 表 + price_snapshots 表保存每次价格，
 *   并用 last_notified_satisfaction 做"分数没涨就别重复推"的抑制。
 *   本模块把这两件事搬到 JSON 文件里，字段语义对齐：
 *     first       ↔ price_snapshots 的第一条 price
 *     last        ↔ listings.price
 *     notifiedScore ↔ listings.last_notified_satisfaction
 *
 * 落盘：data/price-memory.json
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const FILE = path.join(DATA, 'price-memory.json');

const MAX_ENTRIES = 30000;      /* 上限，超出按 lastAt 最老淘汰 */
const MAX_SNAPS_PER_ITEM = 12;  /* 每件最多留 12 个价格点，够画趋势又不撑爆 */

let _mem = null;
let _dirty = false;
let _broken = false;
let _log = (...a) => console.log('[price]', ...a);

function bindLogger(fn) { if (typeof fn === 'function') _log = fn; }
const log = (...a) => { try { _log(...a); } catch (e) {} };

function load() {
  if (_mem) return _mem;
  let raw = null;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    /* 文件不存在是正常情况（第一次运行），不报警 */
    _mem = {};
    return _mem;
  }
  try {
    /* 去 BOM：记事本/部分编辑器保存会带 EF BB BF，JSON.parse 会直接抛错。
       以前不处理的话整份价格记忆会被静默清零，降价重推全部失效且无任何提示。 */
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    _mem = JSON.parse(raw);
  } catch (e) {
    _mem = {};
    _broken = true;
    log('⚠ 价格记忆文件损坏，已按空历史继续运行（降价重推暂不生效）: ' + e.message);
    log('   文件: ' + FILE + '（建议删除该文件让它重新积累，或检查是否被手工编辑过）');
  }
  if (!_mem || typeof _mem !== 'object' || Array.isArray(_mem)) _mem = {};
  return _mem;
}

function save(force) {
  if (!_dirty && !force) return;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(load()));
    _dirty = false;
  } catch (e) {
    log('价格记忆落盘失败: ' + e.message);
  }
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 观测一条命中，更新价格记忆。
 * 返回 { isNew, first, last, prev, dropPct, dropAbs, snaps } 或 null（价格无效）
 */
function observe(item, nowTs) {
  if (!item || !item.itemId) return null;
  const price = num(item.price);
  if (price == null || price < 0) return null;
  /* 哨兵价（¥99999999 = 价格面议）不参与降价判断，否则一降价就是暴跌 */
  if (price >= 1000000) return null;

  const m = load();
  const id = String(item.itemId);
  const t = nowTs || Date.now();
  let e = m[id];

  if (!e) {
    e = m[id] = {
      first: price,
      firstAt: t,
      last: price,
      lastAt: t,
      low: price,
      snaps: [{ p: price, t: t }],
      notifiedScore: null,
      notifyCount: 0
    };
    _dirty = true;
    return { isNew: true, first: price, last: price, prev: null, dropPct: 0, dropAbs: 0, snaps: e.snaps.length };
  }

  const prev = num(e.last);
  let changed = false;

  if (prev == null || Math.abs(price - prev) > 0.001) {
    e.snaps.push({ p: price, t: t });
    if (e.snaps.length > MAX_SNAPS_PER_ITEM) e.snaps = e.snaps.slice(-MAX_SNAPS_PER_ITEM);
    e.last = price;
    e.lastAt = t;
    if (price < (num(e.low) == null ? price : e.low)) e.low = price;
    changed = true;
    _dirty = true;
  } else {
    e.lastAt = t;
  }

  const first = num(e.first);
  const dropAbs = (first != null && price < first) ? (first - price) : 0;
  const dropPct = (first != null && first > 0 && price < first) ? (first - price) / first : 0;

  return {
    isNew: false,
    changed: changed,
    first: first,
    last: price,
    prev: prev,
    dropPct: dropPct,
    dropAbs: dropAbs,
    low: num(e.low),
    snaps: e.snaps.length
  };
}

function get(itemId) {
  const m = load();
  return m[String(itemId)] || null;
}

function setNotifiedScore(itemId, score) {
  const m = load();
  const id = String(itemId);
  if (!m[id]) return;
  m[id].notifiedScore = (score == null ? null : Number(score));
  m[id].notifyCount = (m[id].notifyCount || 0) + 1;
  m[id].notifiedAt = Date.now();
  _dirty = true;
}

function getNotifiedScore(itemId) {
  const e = get(itemId);
  return e ? (e.notifiedScore == null ? null : Number(e.notifiedScore)) : null;
}

/* 淘汰：条目超上限时保留最近活跃的 */
function prune() {
  const m = load();
  const ids = Object.keys(m);
  if (ids.length <= MAX_ENTRIES) return 0;
  ids.sort((a, b) => (num(m[a].lastAt) || 0) - (num(m[b].lastAt) || 0));
  const drop = ids.slice(0, ids.length - MAX_ENTRIES);
  drop.forEach((k) => delete m[k]);
  _dirty = true;
  log('价格记忆淘汰 ' + drop.length + ' 条，剩余 ' + Object.keys(m).length + ' 条');
  return drop.length;
}

/* ============================================================================
 * 综合分（satisfaction / 0-100）
 * ----------------------------------------------------------------------------
 * 桌面版公式（goodprice/services/satisfaction.py）：
 *   视觉关：需求 50 + 性价比 30 + 卖家 20（视觉开时 需求40/品相30/性价比20/卖家10）
 * 但 Node 版**没有品相分、没有性价比分、没有需求匹配 LLM**，三样都填 0 会让
 * 所有商品分数一样、抑制逻辑完全失效。所以这里用 Node 版真实拿得到的三个
 * 维度做代理分，语义仍是"这件货值不值得打扰我"，只是权重换成了可得数据：
 *   价格分 50  —— 相对任务 maxPrice/minPrice 的位置（越便宜越高）
 *   卖家分 30  —— 好评率（sellerRate）× 有成交记录加成
 *   新鲜分 20  —— ageMinutes 相对 freshMaxAgeHours
 * 三者都算不出来时给 50（中性），不会因为缺数据就一律不推。
 * ========================================================================== */

function priceScore(price, task) {
  const p = num(price);
  if (p == null || p <= 0) return 0.5;
  const maxP = num(task && task.maxPrice);
  const minP = num(task && task.minPrice);
  let lo = (minP != null && minP > 0) ? minP : null;
  let hi = (maxP != null && maxP > 0) ? maxP : null;
  if (hi == null && lo == null) return 0.5;             /* 没设价格区间 → 中性 */
  if (hi == null) hi = lo * 3;                          /* 只有下限：用 3 倍当上界 */
  if (lo == null) lo = Math.max(1, hi * 0.1);           /* 只有上限：用 1/10 当下界 */
  if (hi <= lo) return p <= hi ? 0.8 : 0.2;
  const s = (hi - p) / (hi - lo);
  return Math.max(0, Math.min(1, s));
}

function rateScore(item) {
  if (!item) return 0.5;
  const raw = String(item.sellerRate || '').replace('%', '').trim();
  const r = Number(raw);
  if (!isFinite(r) || raw === '') return 0.5;
  const base = Math.max(0, Math.min(1, r / 100));
  /* 有成交记录的卖家略加分（0.05 上限），避免新号刷好评直接满分 */
  const deals = num(item.sellerDeals) || 0;
  const boost = deals >= 50 ? 0.05 : (deals >= 10 ? 0.02 : 0);
  return Math.max(0, Math.min(1, base + boost));
}

function freshScore(item, freshMaxAgeHours) {
  const age = num(item && item.ageMinutes);
  const h = num(freshMaxAgeHours);
  if (age == null) return 0.5;
  if (h == null || h <= 0) h = 24;
  const s = 1 - (age / (h * 60));
  return Math.max(0, Math.min(1, s));
}

function satisfaction(item, task, opts) {
  const o = opts || {};
  const ps = priceScore(item && item.price, task);
  const rs = rateScore(item);
  const fs2 = freshScore(item, o.freshMaxAgeHours);
  const score = 50 * ps + 30 * rs + 20 * fs2;
  /* 降价加成：对齐 second-eye 的 _drop_bonus（≥20%→2分，≥8%→1分，单位是10分制的一半） */
  const drop = num(o.dropPct) || 0;
  const bonus = drop >= 0.20 ? 10 : (drop >= 0.08 ? 5 : 0);
  return Math.max(0, Math.min(100, score + bonus));
}

/* 已记录的商品数（面板显示"价格记忆 N 条"用） */
function count() {
  try { return Object.keys(load()).length; } catch (e) { return 0; }
}

module.exports = {
  bindLogger,
  observe,
  get,
  count,
  isBroken: () => _broken,
  setNotifiedScore,
  getNotifiedScore,
  prune,
  save,
  satisfaction,
  priceScore,
  rateScore,
  freshScore,
  paths: { ROOT, DATA, FILE }
};
