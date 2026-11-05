/**
 * 闲鱼扫货监控 · 守护进程（崩溃/被系统杀掉后自动拉起 + 推手机告警）
 *
 * 作用：每 CHECK_MS 探一次面板端口；若监控已死（端口无响应）就自动重新拉起 monitor.cjs。
 * 适用场景：笔记本 Modern Standby 唤醒后监控进程被系统终止、或 monitor 自身崩溃退出。
 *
 * 用法：
 *   直接用便携 node 跑：  runtime\playwright-driver\node.exe guard.cjs
 *   或双击：              1-启动监控-守护.cmd
 *
 * 停止：关掉这个守护窗口即可（它不会去杀 monitor；要停监控请用面板的「停止」或 3-重新登录并恢复.cmd）
 *
 * ============================================================================
 * 【2026-10-29 新增：监控死掉时推手机】
 * 背景：monitor.cjs 里那套告警（登录失效/限流/任务失败，见 checkAlerts）只在
 *       监控进程【还活着】的时候才跑得起来。进程被系统杀掉、崩掉、栈溢出退出，
 *       它根本没机会执行 —— 手机端只会表现为"安静"，跟"没货"完全区分不出来。
 *       实测 2026/10/29 01:52 到 15:11 有 799 分钟大空档（8 次系统睡眠），
 *       期间一条推送都没有，用户完全不知道。
 * 做法：在这个守护进程里判断"监控是不是没了"，由它发消息（它是独立进程，
 *       monitor 死了它照样活着）。
 *   · 意外退出（崩溃 / 被系统杀掉 / 睡眠唤醒后没了）→ 推「监控已停止运行」
 *   · 反复拉起失败（连续 N 次探不通）              → 推「监控反复启动失败」
 *   · 恢复运行（之前报过）                         → 推「监控已恢复」
 *   · 用户自己点【停止监控】/【立即重新登录】/关窗口 → 不推（他知道自己干了什么）
 *     区分靠 monitor 退出前留下的 data\monitor-exit.json，只在 3 分钟内有效。
 *   · 同类告警 30 分钟内不重复推；恢复消息只对"报过警的那次故障"发。
 * ============================================================================
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');

/* 时间参数：正常用默认值；测试/调试可用环境变量临时改小（不影响生产） */
function envNum(name, dflt) {
  const v = Number(process.env[name]);
  return (isFinite(v) && v > 0) ? v : dflt;
}
const CHECK_MS = envNum('GUARD_CHECK_MS', 60000);   // 探活间隔
const BOOT_WAIT_MS = envNum('GUARD_BOOT_WAIT_MS', 45000); // 拉起后给 monitor 的启动时间
const COOLDOWN_MS = envNum('GUARD_COOLDOWN_MS', 30000);   // 两次拉起之间的最小间隔
const ALERT_COOLDOWN_MS = envNum('GUARD_ALERT_COOLDOWN_MS', 30 * 60 * 1000); // 同类告警最短间隔
const DELIBERATE_MS = envNum('GUARD_DELIBERATE_MS', 180 * 1000);  // 退出标记有效期
const START_FAIL_ALERT_TRIES = envNum('GUARD_FAIL_TRIES', 3);     // 连续探不通几次才报"启动失败"
const STATE_SAVE_MS = 10 * 60 * 1000;               // 正常运行时状态文件最长 10 分钟写一次
/* 用户自己点了【停止监控】/【立即重新登录】之后，守护不要立刻又把它拉起来 ——
   那等于把用户停掉的程序强行启动一遍（旧版就是这样，日志里能看到「正在拉起」紧跟「退出 code=0」）。
   尊重期内在沉默：不拉起、不报警。过了尊重期还是不活（多半是关机/忘了），才恢复拉起。 */
const RESPECT_MS = envNum('GUARD_RESPECT_MS', 10 * 60 * 1000);

const STATEF = path.join(DATA, 'guard-state.json');
const EXITMARKF = path.join(DATA, 'monitor-exit.json');
/* 【2026-10-29 新增】自己的 pid 落盘。
   托盘要判断「本目录的守护在不在跑」，不能靠命令行里搜 guard.cjs ——
   1-启动监控-守护.cmd 传进去的是相对路径，命令行里看不到绝对路径，
   于是同一个目录的多个副本（备份包解压出来的那份）会互相认错，
   点「停止监控」会把别人的守护杀掉。pid 文件是唯一不会认错的办法。 */
const PIDF = path.join(DATA, 'guard.pid');
/* 【2026-10-29 新增】「用户手动启动」标记。
   托盘点【停止监控】会先让 monitor 体面退出、再关掉守护；紧接着点【启动监控】时，
   守护一起来就探不到 monitor，按老逻辑会立刻推一条「监控已停止运行」——
   明明就是用户自己刚停的，这条告警是纯噪音。
   托盘在 spawn 守护之前写这个标记，守护读到就当作冷启动（只拉起、不报警）。 */
const MANUALF = path.join(DATA, 'manual-start.json');

/* 【2026-10-29 修】日志轮转阈值原来没定义。
   下面 log() 里写的是 `if (fs.statSync(f).size > GUARD_LOG_MAX)`，
   但 GUARD_LOG_MAX 从来没声明过 —— 每次写日志 statSync 之后立刻抛
   ReferenceError，被同一个 try 的空 catch 吞掉，结果是
   「日志照写、轮转永不发生」。守护是长期进程，这等于 guard.log 会无限长。 */
const GUARD_LOG_MAX = 2 * 1024 * 1024;

function log(s) {
  const t = new Date();
  const p = n => String(n).padStart(2, '0');
  const ts = `${t.getFullYear()}/${p(t.getMonth() + 1)}/${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  const line = `[${ts}] ${s}`;
  try { console.log(line); } catch (e) {}
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const f = path.join(DATA, 'guard.log');
    fs.appendFileSync(f, line.replace(/\r?\n/g, ' ') + '\r\n');
    /* 轮转：守护是长期在跑的进程，guard.log 不轮转会一直长。
       超过 2 MB 就把旧的留一份 .1，新文件重开。 */
    try {
      if (fs.statSync(f).size > GUARD_LOG_MAX) {
        const old = f + '.1';
        try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch (e2) {}
        fs.renameSync(f, old);
      }
    } catch (e2) {}
  } catch (e) {}
}

function readJSON(f, d) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return d; }
}
function writeJSON(f, v) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(v));
    return true;
  } catch (e) { return false; }
}

/* ---------- 告警推送（复用 notify.cjs，只在真出事时发） ---------- */
let notifyLayer = null;
try {
  notifyLayer = require('./notify.cjs');
  notifyLayer.bindLogger(log);
} catch (e) {
  notifyLayer = null;
  log('告警模块加载失败（不影响守护本身）: ' + (e && e.message));
}

async function sendAlert(title, body) {
  if (!notifyLayer) return false;
  try {
    /* 每次都重新读 config.json：用户在面板里改了推送渠道/开关，不用重启守护就能生效 */
    const c = readJSON(path.join(ROOT, 'config.json'), {}) || {};
    const ncfg = notifyLayer.normalizeConfig(c.notify || {});
    if (ncfg.enabled === false) return false;
    const on = notifyLayer.buildEnabled(ncfg).filter(t => t.def.key !== 'log');
    if (!on.length) return false;
    const msg = { title: '闲鱼扫货 告警：' + title, content: body, url: '', jump: '' };
    /* __test=true：告警不计入面板「累计成功 N 次」的商品推送统计 */
    ncfg.__test = true;
    const rs = await notifyLayer.send(msg, ncfg);
    const anyOk = rs.some(r => r.channel !== 'log' && r.ok);
    log((anyOk ? '📣 已推送告警：' : '⚠ 告警推送失败：') + title);
    return anyOk;
  } catch (e) {
    log('告警推送异常: ' + (e && e.message));
    return false;
  }
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (s < 60) return s + ' 秒';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), r = m % 60;
  return h + ' 小时' + (r ? ' ' + r + ' 分钟' : '');
}
function fmtTime(ms) {
  const t = new Date(Number(ms || 0));
  if (!isFinite(t.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${t.getFullYear()}/${p(t.getMonth() + 1)}/${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/* ---------- 退出标记：monitor 主动停止时自己写的，用来区分"用户停的"和"死掉的" ---------- */
function exitMark() {
  try {
    const o = readJSON(EXITMARKF, null);
    return (o && typeof o === 'object') ? o : null;
  } catch (e) { return null; }
}
function clearExitMark() { try { fs.unlinkSync(EXITMARKF); } catch (e) {} }

const cfg = readJSON(path.join(ROOT, 'config.json'), {});
const PORT = Number(cfg.port) || 59288;

let nodeExe = path.join(ROOT, 'runtime', 'playwright-driver', 'node.exe');
if (!fs.existsSync(nodeExe)) {
  try {
    const rt = (fs.readFileSync(path.join(ROOT, 'runtime.txt'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '').trim();
    if (rt) {
      const c = path.join(rt, 'playwright-driver', 'node.exe');
      if (fs.existsSync(c)) nodeExe = c;
    }
  } catch (e) {}
}
if (!fs.existsSync(nodeExe)) nodeExe = process.execPath;

let browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (!browsers) {
  const b = path.join(path.dirname(nodeExe), '..', 'playwright-browsers');
  if (fs.existsSync(b)) browsers = path.resolve(b);
}

let child = null;
let lastStart = 0;
let lastExit = null;      /* {code,signal,at} —— 监控上次退出时拿到的信息，写进告警正文 */

/* 守护自己的状态（落盘，守护重启也不会把"正在报的这次故障"忘掉）
   { outage:是否处于故障中, since:故障开始前最后一次探通的时间, tries:本轮已拉起几次,
     alerted:这次故障是否已经报过, lastAlertAt:上次告警时间, lastAliveAt:最近一次探通 }
   说明：lastAliveAt 在内存里每轮都更新，但只在故障切换时和每 10 分钟才落盘，
        避免每分钟都写一次文件。 */
let gstate = readJSON(STATEF, {}) || {};
if (typeof gstate !== 'object' || !gstate) gstate = {};
gstate.outage = !!gstate.outage;
gstate.since = Number(gstate.since || 0) || 0;
gstate.tries = Number(gstate.tries || 0) || 0;
gstate.alerted = !!gstate.alerted;
gstate.failAlerted = !!gstate.failAlerted;
gstate.cold = !!gstate.cold;
gstate.lastAlertAt = Number(gstate.lastAlertAt || 0) || 0;
gstate.lastAliveAt = Number(gstate.lastAliveAt || 0) || 0;
let lastRespectLogAt = 0;
let sawAlive = false;     /* 本次守护运行期间是否至少探通过一次（冷启动判断用） */
let lastSaveAt = 0;
function gsave(force) {
  const now = Date.now();
  if (!force && now - lastSaveAt < STATE_SAVE_MS) return;
  lastSaveAt = now;
  writeJSON(STATEF, gstate);
}

function alive() {
  return new Promise(res => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/__scan/hits.json', timeout: 5000 }, r => {
      r.resume();
      res(r.statusCode === 200);
    });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}

function startMonitor() {
  const now = Date.now();
  if (now - lastStart < COOLDOWN_MS) return false;
  lastStart = now;
  const env = Object.assign({}, process.env, {
    SCAN_KEEP_ALIVE: '1'
  });
  if (browsers) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  log(`监控已停止响应，正在拉起：${path.basename(nodeExe)} monitor.cjs`);
  try {
    child = spawn(nodeExe, ['monitor.cjs'], {
      cwd: ROOT, env, stdio: 'ignore', detached: true, windowsHide: true
    });
    child.on('exit', (code, signal) => {
      lastExit = { code: code, signal: signal || '', at: Date.now() };
      log(`monitor 退出 code=${code}${signal ? (' signal=' + signal) : ''}`);
      child = null;
    });
    child.on('error', (e) => {
      lastExit = { code: 'spawn-error', signal: '', at: Date.now() };
      log(`monitor 启动失败: ${e.message}`);
      child = null;
    });
    child.unref();
    return true;
  } catch (e) {
    lastExit = { code: 'spawn-throw', signal: '', at: Date.now() };
    log(`拉起异常: ${e.message}`);
    return false;
  }
}

process.on('uncaughtException', e => log('守护异常: ' + (e && e.message)));
process.on('unhandledRejection', e => log('守护异步异常: ' + (e && e.message)));
process.on('SIGINT', () => { log('守护已停止（monitor 不受影响，仍在运行）'); clearPid(); process.exit(0); });
process.on('SIGTERM', () => { clearPid(); process.exit(0); });
process.on('exit', () => { clearPid(); });

/* pid 文件：写在 data\guard.pid，退出时删掉。
   托盘靠它判断「本目录的守护在不在跑」以及「要停哪个进程」。 */
function writePid() {
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(PIDF, String(process.pid)); } catch (e) {}
}
function clearPid() {
  try {
    const v = Number(fs.readFileSync(PIDF, 'utf8').trim());
    /* 只有内容还是自己才删 —— 防止新一轮守护已经写好新 pid 又被旧进程删掉 */
    if (v === process.pid) fs.unlinkSync(PIDF);
  } catch (e) {}
}

(async function main() {
  writePid();
  log(`=== 监控守护启动 === 端口 ${PORT}，每 ${CHECK_MS / 1000}s 探一次（PID ${process.pid}）`);
  log(`node: ${nodeExe}`);
  if (browsers) log(`browsers: ${browsers}`);
  if (!notifyLayer) log('⚠ 告警功能不可用（notify.cjs 没加载成功），自动拉起仍然正常');

  for (;;) {
    const ok = await alive();

    if (ok) {
      /* ---- 监控活着 ---- */
      sawAlive = true;
      if (gstate.outage) {
        const gapMs = gstate.since ? (Date.now() - gstate.since) : 0;
        const wasAlerted = gstate.alerted;
        gstate.outage = false;
        gstate.tries = 0;
        gstate.alerted = false;
        gstate.failAlerted = false;
        gstate.cold = false;
        gstate.lastAliveAt = Date.now();
        gstate.since = 0;
        gsave(true);
        if (wasAlerted) {
          await sendAlert('监控已恢复',
            '监控已经重新跑起来了。\n'
            + '中断时长：约 ' + fmtDur(gapMs) + '\n'
            + '中断期间新上架的货不会补推（已经登记过就不再当新命中），但后面的新货照常推。\n'
            + '如果反复出现，检查一下是不是电脑自动睡眠了。');
        } else {
          log('监控已恢复运行（这次没报过警，不推恢复消息）');
        }
      } else {
        gstate.lastAliveAt = Date.now();
        gsave(false);
      }
      await new Promise(r => setTimeout(r, CHECK_MS));
      continue;
    }

    /* ---- 监控没响应 ---- */
    const mk = exitMark();
    const mkAt = mk ? Number(mk.at || 0) : 0;
    const mkFresh = mkAt > 0 && (Date.now() - mkAt) < DELIBERATE_MS;
    const deliberate = !!(mkFresh && mk && ['stop', 'relogin', 'window', 'parent'].indexOf(String(mk.reason)) >= 0);
    if (mkAt > 0 && !mkFresh) clearExitMark();     /* 老标记留着没用，清掉免得下次误判 */

    /* 用户主动停的：尊重期内不拉起、不报警（否则等于把用户关掉的程序强行开回来） */
    const respect = deliberate && (Date.now() - mkAt) < RESPECT_MS;
    if (respect) {
      if (!gstate.outage) {
        gstate.outage = true;
        gstate.since = Number(gstate.lastAliveAt || 0) || Date.now();
        gstate.tries = 0;
        gstate.alerted = false;     /* 主动停的不算"要报的故障"：没报过警，恢复时也不推恢复消息 */
        gstate.failAlerted = false;
        gstate.cold = false;
        gsave(true);
      }
      if (lastRespectLogAt !== mkAt) {
        lastRespectLogAt = mkAt;
        log(`监控已按指令停止（reason=${mk.reason}），${Math.round(RESPECT_MS / 60000)} 分钟内不再自动拉起、不推告警`);
      }
      await new Promise(r => setTimeout(r, CHECK_MS));
      continue;
    }

    /* 冷启动判断：只有"它本来在跑、现在没了"才值得报「停止运行」。
       如果守护刚启动、监控压根没启动过（历史里没有探通记录、也没观察到退出），
       那是用户只开了守护而没开监控 —— 直接拉起就好，别拿一条告警吓人。
       注意：冷启动之后如果一直拉不起来，「反复启动失败」那条照样会发。 */
    const hadHistory = (Number(gstate.lastAliveAt || 0) > 0) || !!lastExit || sawAlive;

    /* 托盘手动点【启动监控】：用户明确要求现在就跑，不需要「已停止运行」这条噪音。 */
    let manual = false;
    try {
      const m = readJSON(MANUALF, null);
      const mAt = m ? Number(m.at || 0) : 0;
      if (mAt > 0 && (Date.now() - mAt) < DELIBERATE_MS) manual = true;
      if (mAt > 0) { try { fs.unlinkSync(MANUALF); } catch (e) {} }
    } catch (e) {}

    if (!gstate.outage) {
      gstate.outage = true;
      gstate.since = Number(gstate.lastAliveAt || 0) || Date.now();
      gstate.tries = 0;
      gstate.alerted = false;
      gstate.failAlerted = false;
      gstate.cold = (!hadHistory) || manual;   /* 冷启动 / 用户手点启动 ⇒ 只拉起，不报「已停止运行」 */
      gsave(true);
      if (manual && hadHistory) {
        log('托盘手动启动：先把监控拉起来，不报「已停止运行」（用户知道自己刚点过）');
      } else if (gstate.cold) {
        log('守护启动时监控还没在跑（冷启动），先拉起，不报「已停止运行」');
      } else {
        const gapMs = Date.now() - (gstate.since || Date.now());
        const why = lastExit
          ? ('上次退出：code=' + lastExit.code + (lastExit.signal ? (' signal=' + lastExit.signal) : ''))
          : '没有拿到退出码（被系统强制结束 / 睡眠唤醒 / 断电，或进程被外部杀掉）';
        const sent = await sendAlert('监控已停止运行',
          '监控进程不在了（' + why + '）。\n'
          + '最后一次正常：' + (fmtTime(gstate.since) || '未知') + '\n'
          + '失去响应：约 ' + fmtDur(gapMs) + '\n'
          + '守护正在自动重新拉起，拉起来之后会再发一条「已恢复」。\n'
          + '这段时间里新上架的货不会被推送。');
        if (sent) { gstate.alerted = true; gstate.lastAlertAt = Date.now(); }
        gsave(true);
      }
    }

    const spawned = startMonitor();
    if (spawned) {
      gstate.tries = Number(gstate.tries || 0) + 1;
      gsave(true);
    }
    /* 连续拉起若干次还是探不通 → 报一次「启动失败」；同一轮故障只报一次，不反复刷 */
    if (!gstate.failAlerted && gstate.tries >= START_FAIL_ALERT_TRIES) {
      const sent = await sendAlert('监控反复启动失败',
        '已经连续 ' + gstate.tries + ' 次尝试拉起监控，都没能探通。\n'
        + (lastExit ? ('上次退出：code=' + lastExit.code + '\n') : '')
        + '常见原因：\n'
        + '· 登录态失效，需要重新扫码\n'
        + '· 界面端口被别的程序占用（同时开了两个监控）\n'
        + '· 浏览器配置目录被锁（上次的浏览器进程没退干净）\n'
        + '处理：运行【0-首次扫码登录.cmd】重新登录；关掉多余的监控窗口只留一个；'
        + '都不行就重启电脑后运行【1-启动监控-无窗口.vbs】。');
      if (sent) { gstate.failAlerted = true; gstate.alerted = true; gstate.lastAlertAt = Date.now(); }
      gsave(true);
    }

    await new Promise(r => setTimeout(r, BOOT_WAIT_MS));
  }
})();
