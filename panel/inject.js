/* 闲鱼扫货监控 - 面板脚本
   两种运行方式，同一份脚本：
     ① 注入模式：由 monitor.cjs 塞进宿主页面（Ydisks闲鱼助手），在左侧导航长出【扫货监控】按钮
     ② 独立模式：panel\index.html 引入本脚本时先设 window.__SCAN_STANDALONE=true，
        此时不去找宿主侧边栏，直接把全屏面板渲染出来（不依赖任何外部 CSS 框架）
   两模式共用全部业务逻辑，区别只在 start() 的最后一步。 */
(function () {
  if (window.__scanPanelLoaded) return;
  window.__scanPanelLoaded = true;

  /* 独立模式：没有宿主页面，面板必须自启；且"关闭"按钮没有意义（关了就是白屏） */
  var STANDALONE = !!window.__SCAN_STANDALONE;

  var NAV_LABEL = '扫货监控';
  var PANEL_ID = '__scan_panel';
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-[19px] w-[19px]"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>';
  var catalog = null, conf = null, tab = 'list', unreadOnly = true;
  /* 【cpvFilters 动态筛选 2026-11-04】官方筛选项缓存：{关键词小写: [{pid,pname,values:[{vid,label}]}]} */
  var cpvTree = {};
  /* 【筛选项缓存 2026-11-04】服务端 filterTreeCache 的快照。
     面板刷新后 cpvTree 会清空，以前就靠它渲染 —— 结果界面显示「还没取到」，
     而配置里其实还存着 cpvFilters，一点保存就被清空。现在启动时先问服务端要快照。 */
  var cpvCacheLoaded = false;
  function loadCpvCache(cb) {
    if (cpvCacheLoaded) { cb && cb(); return; }
    fetch('/__scan/filtercache?t=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var trees = (d && d.trees) || {};
        Object.keys(trees).forEach(function (k) {
          if (!cpvTree[k] || !cpvTree[k].length) cpvTree[k] = trees[k];
        });
        cpvCacheLoaded = true;
        cb && cb();
      })
      .catch(function () { cpvCacheLoaded = true; cb && cb(); });
  }
  function fetchCpvTree(kw, cb, opt) {
    var key = String(kw || '').toLowerCase();
    if (!key) { cb && cb(); return; }
    if (cpvTree[key]) { cb && cb(); return; }
    fetch('/__scan/filtertree?keyword=' + encodeURIComponent(kw))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && Array.isArray(d.groups) && d.groups.length) {
          cpvTree[key] = d.groups;
        } else if (d && d.msg && !(opt && opt.silent)) {
          /* 【C 修复 2026-11-04】以前这里把后端的 msg 直接丢掉 ——
             待命时点「拉取筛选项」，后端明明回了「请先点开始监控」，
             界面却毫无反应，跟坏了一样。 */
          toast(d.msg);
        }
        cb && cb();
      })
      .catch(function (e) {
        if (!(opt && opt.silent)) toast('拉取筛选项失败：' + ((e && e.message) || '网络异常'));
        cb && cb();
      });
  }
  /* 列表显示范围：'unread' 只看没看过的 / 'recent' 最近看过的（可恢复未读） / 'all' 全部 / 'day1' 最近24小时 */
  var scopeMode = 'all';
  /* 【时间档位】按商品发布时间筛窗口，单位小时；0 = 全部不筛。
     以前是一个「最近24小时」布尔开关，只有开/关两档：用户想只看 1~3 小时内刚上架的新货，
     只能开 24 小时然后自己往下翻，翻着翻着就翻到一天前，感觉"命中里混着老货"。
     现在换成 1 / 3 / 6 / 12 / 24 / 全部 六档，默认 24（与改之前完全一致，不改变现有观感）。
     选择记在 localStorage，刷新页面不会跳回默认。 */
  var TW_KEY = '__scan_timewin';
  var timeWin = 24;
  try {
    var __twSaved = parseInt(window.localStorage.getItem(TW_KEY), 10);
    if (isFinite(__twSaved) && __twSaved >= 0) timeWin = __twSaved;
  } catch (e) { }
  var TW_OPTS = [1, 3, 6, 12, 24, 0];
  var twLabelOf = function (h) { return h === 0 ? '全部' : (h + '小时'); };
  /* 时间钟状态：当前时间 / 上次跳变 / 距下次刷新 */
  var clockState = { last: null, next: null, rate: 0, hold: false, holdMin: 0 };

  var getAside = function () { return document.querySelector('aside.fixed'); };
  var getNav = function () { return document.querySelector('nav[aria-label="主导航"]'); };
  var isCollapsed = function () { var a = getAside(); return !!(a && a.className.indexOf('w-16') !== -1); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  /* 折叠块（按钮点开才显示内容）：gid 唯一标识，title 是按钮文字，body 是展开内容 HTML。
     供 taskForm 与 renderFilter（全局卡片）共用，wireGroups 统一接线。 */
  var grpWrap = function (gid, title, body, open) {
    return '<div class="grp' + (open ? ' open' : '') + '" data-grp="' + gid + '">'
      + '<div class="grp-h" data-grp-tog><span class="grp-chev">▶</span><span class="grp-t">' + esc(title) + '</span></div>'
      + '<div class="grp-b">' + body + '</div></div>';
  };
  var fmt = function (iso) { try { return new Date(iso).toLocaleString('zh-CN'); } catch (e) { return iso || ''; } };
  var agoText = function (x) {
    /* 【修】旧版只看 x.ageMinutes —— 那是"采集那一刻"算出来的分钟数，
       采集后就不再更新，面板开着一小时还写"11分钟前发布"（实测过）。
       现在优先用发布时间现算；拿不到才退回 ageMinutes（老记录兜底）。 */
    var m = null;
    var ms = (typeof publishMsOf === 'function') ? publishMsOf(x) : 0;
    if (ms > 0) { m = Math.round((Date.now() - ms) / 60000); if (m < 0) m = 0; }
    else if (x.ageMinutes != null) m = x.ageMinutes;
    if (m == null) return '未知';
    if (m < 1) return '刚刚发布';
    if (m < 60) return m + '分钟前发布';
    if (m < 1440) return Math.floor(m / 60) + '小时前发布';
    return Math.floor(m / 1440) + '天前发布';
  };
  /* 闲鱼 publishAt 形如 "2026/10/16 12:15:20"，兼容 "2026-10-16 12:15:20" / ISO，解析失败返回 NaN
     【修】不能只用 Date.parse(s.replace(/\//g,'-').replace(' ','T'))：
       V8 对"月/日不补零"的 "2026-10-8T12:35:08" 返回 NaN。
       老数据里这种格式真实存在（toLocaleString('zh-CN') 不补零），
       一旦 NaN：24 小时过滤会把这批货整条丢掉、「新」标记不显示、时间显示"未知"。
       这里手工拆年月日时分秒重建 Date，任何补零/不补零的写法都能吃。 */
  var parsePublishAt = function (s) {
    if (s == null || s === '') return NaN;
    if (typeof s === 'number') return isFinite(s) ? s : NaN;
    var str = String(s).trim();
    /* 带 Z / ±HH:MM 时区偏移的必须走 Date.parse（手工构造只能按本地时区解释，会整体偏 8 小时） */
    if (/(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(str)) {
      var tz = Date.parse(str);
      if (isFinite(tz)) return tz;
    }
    var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/.exec(str);
    if (m) {
      var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
      var t0 = d.getTime();
      if (isFinite(t0) && d.getDate() === Number(m[3])) return t0;
      /* 2/30、13/45 这类越界日期：不兜底，直接判无效 */
      if (Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31) return NaN;
    }
    var t = Date.parse(str);
    return t;
  };
  /* 一条命中的发布时间毫秒数（拿不到返回 0）：优先接口原始毫秒，再退回字符串 */
  var publishMsOf = function (x) {
    if (!x) return 0;
    var a = Number(x.publishTime || 0);
    if (isFinite(a) && a > 0) return a;
    var b = Number(x.publishTimeAdjusted || 0);
    if (isFinite(b) && b > 0) return b;
    var c = parsePublishAt(x.publishAt);
    return isFinite(c) && c > 0 ? c : 0;
  };
  /* 分钟数 → 人话（用于新鲜度体检） */
  var minsText = function (m) {
    if (m == null) return '未知';
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    if (m < 1440) return Math.floor(m / 60) + ' 小时前';
    return Math.floor(m / 1440) + ' 天前';
  };
  /* 秒数 → mm:ss（倒计时用） */
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  var cdText = function (sec) {
    if (sec == null || isNaN(sec)) return '待定';
    if (sec <= 0) return '正在刷新…';
    var m = Math.floor(sec / 60), s = sec % 60;
    return pad2(m) + ':' + pad2(s);
  };
  var clockText = function (d) {
    return d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) : '--:--:--';
  };
  var hmsText = function (iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return { full: '—', hm: '—' };
    var d = new Date(t);
    return { full: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()), hm: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) };
  };
  /* 每秒刷新时间钟：当前时间 · 上次刷新 · 距下次 mm:ss */
  function tickClock() {
    var el = document.getElementById('__scan_clock');
    if (!el) return;
    var now = new Date(), s = clockState;
    var done = s.last ? fmtDur(now - s.last) : '—';
    var left = s.next ? Math.round((s.next - now) / 1000) : null;
    var over = (s.next && now > s.next) ? Math.abs(Math.round((now - s.next) / 1000)) : 0;
    if (s.hold) {
      el.innerHTML = '⏸ <b style="color:#007aff">待命中</b> · 当前 <b style="color:#1d1d1f">' + clockText(now) + '</b>'
        + ' <span style="color:#c7c7cc">|</span> 本次启动<b style="color:#007aff">没有发出任何搜索请求</b>'
        + (s.holdMin ? ' <span style="color:#8e8e93">（已待命 ' + s.holdMin + ' 分钟）</span>' : '')
        + ' <span style="color:#c7c7cc">|</span> 点右上角「▶ 开始监控」继续';
      return;
    }
    el.innerHTML = '当前 <b style="color:#1d1d1f">' + clockText(now) + '</b>'
      + ' <span style="color:#c7c7cc">|</span> 上次刷新 <b style="color:#1d1d1f">' + (s.last ? clockText(s.last) : '—') + '</b>'
      + ' <span style="color:#8e8e93">（' + done + '前）</span>'
      + ' <span style="color:#c7c7cc">|</span> ' + (s.next
        ? (over > 0
          ? '<span style="color:#007aff">本轮到点，正在取数…（已 ' + cdText(over) + '）</span>'
          : '距下次刷新 <b style="color:#007aff">' + cdText(left) + '</b> <span style="color:#8e8e93">（' + hmsText(s.next.toISOString()).hm + '）</span>')
        : '距下次刷新 <b style="color:#8e8e93">待定</b>');
  }
  function startClock() {
    tickClock();
    if (!window.__scan_clock_tm) window.__scan_clock_tm = setInterval(function () {
      if (!document.getElementById(PANEL_ID)) { clearInterval(window.__scan_clock_tm); window.__scan_clock_tm = null; return; }
      tickClock();
    }, 1000);
  }
  /* 毫秒差 → "12秒 / 3分20秒 / 1小时2分" */
  function fmtDur(ms) {
    if (ms == null || isNaN(ms)) return '—';
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
  }

  /* ---- 地区工具（三级：省 → 市 → 区县） ---- */
  var findProv = function (name) {
    var groups = (catalog && catalog.regionGroups) || [];
    for (var i = 0; i < groups.length; i++) {
      var lst = groups[i].list || [];
      for (var j = 0; j < lst.length; j++) if (lst[j].p === name) return lst[j];
    }
    return null;
  };
  var citiesOf = function (prov) {
    var p = findProv(prov);
    var out = [];
    ((p && p.c) || []).forEach(function (x) {
      if (typeof x === 'string') out.push({ n: x, a: [] });
      else out.push({ n: x.n, a: x.a || [] });
    });
    return out;
  };
  var areasOf = function (prov, city) {
    var cs = citiesOf(prov);
    for (var i = 0; i < cs.length; i++) if (cs[i].n === city) return cs[i].a || [];
    return [];
  };
  var cityOpts = function (prov, cur) {
    var cs = citiesOf(prov);
    var out = '<option value="">全省' + (prov ? '（' + esc(prov) + '）' : '') + '</option>';
    cs.forEach(function (c) {
      out += '<option value="' + esc(c.n) + '"' + (c.n === cur ? ' selected' : '') + '>' + esc(c.n) + '</option>';
    });
    return out;
  };
  var areaOpts = function (prov, city, cur) {
    var as = areasOf(prov, city);
    var head = city ? ('全' + esc(city)) : '全市';
    var out = '<option value="">' + head + '</option>';
    as.forEach(function (a) {
      out += '<option value="' + esc(a) + '"' + (a === cur ? ' selected' : '') + '>' + esc(a) + '</option>';
    });
    return out;
  };

  var CSS = ''
  + '#__scan_panel .holdbar{display:none;margin-top:10px;padding:11px 14px;border-radius:10px;background:rgba(0,122,255,.08);border:1px solid rgba(0,122,255,.28);color:#1d1d1f;font-size:13px;line-height:1.65}'
  + '#__scan_panel .holdbar b{color:#007aff}'
  + '#__scan_panel .holdbar .hb-btn{display:inline-block;margin-left:10px;background:#007aff;color:#fff;border:0;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer}'
  + '#__scan_panel .holdbar .hb-btn:hover{background:#0066d6}'
  + '#__scan_panel .holdbar .hb-btn.on{background:#ff9500}'
  + '#__scan_panel .btn.holdon{color:#007aff;border-color:rgba(0,122,255,.45);font-weight:600}'
    + '#__scan_panel{--ink:#1d1d1f;--ink2:#3a3a3c;--muted:#8e8e93;--muted2:#6e6e73;--line:rgba(60,60,67,.12);--line2:rgba(60,60,67,.18);--bg:#f2f2f7;--card:#fff;--fill:rgba(118,118,128,.10);--blue:#007aff;--red:#ff3b30;--green:#34c759;--orange:#ff9500;--r-lg:16px;--r-md:10px;--r-sm:6px;--ease:cubic-bezier(.4,0,.2,1)}'
    + '#__scan_panel{position:fixed;inset:0;z-index:60;background:var(--bg);overflow:auto;padding:26px 30px;font-family:inherit;display:none;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}'
    + '#__scan_panel .wrap{max-width:1080px;margin:0 auto}'
    + '#__scan_panel h2{font-size:22px;font-weight:600;color:var(--ink);margin:0;flex:none;white-space:nowrap;letter-spacing:-.2px}'
    + '#__scan_panel h2 .brand{font-size:11px;font-weight:500;color:var(--muted);margin-left:10px;letter-spacing:0;vertical-align:baseline;cursor:pointer;white-space:nowrap}'
    + '#__scan_panel h2 .brand:hover{color:var(--blue)}'
    + '#__scan_panel .about-mask{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;padding:20px;-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}'
    + '#__scan_panel .about{background:var(--card);border-radius:var(--r-lg);padding:24px 26px;max-width:460px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.22);font-size:13px;color:var(--ink2);line-height:1.7;box-sizing:border-box}'
    + '#__scan_panel .about h3{font-size:17px;font-weight:600;color:var(--ink);margin:0 0 3px;letter-spacing:-.2px}'
    + '#__scan_panel .about .ver{font-size:12px;color:var(--muted);font-weight:500;margin-bottom:12px}'
    + '#__scan_panel .about .arow{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line)}'
    + '#__scan_panel .about .ak{width:56px;flex:none;color:var(--muted);font-size:12px}'
    + '#__scan_panel .about .av{flex:1;color:var(--ink);word-break:break-word}'
    + '#__scan_panel .about .note{margin-top:4px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted2)}'
    + '#__scan_panel .btn{border:1px solid var(--line2);background:var(--card);border-radius:var(--r-md);padding:8px 14px;font-size:13px;font-weight:500;color:var(--ink2);cursor:pointer;flex:none;white-space:nowrap;transition:background .18s var(--ease),color .18s var(--ease),border-color .18s var(--ease)}'
    + '#__scan_panel .btn:hover{background:#f7f7fa}'
    + '#__scan_panel .btn:active{background:#ececf1}'
    + '#__scan_panel .btn.p{background:var(--blue);color:#fff;border-color:var(--blue)}'
    + '#__scan_panel .btn.p:hover{background:#0a6fe0}'
    + '#__scan_panel .btn.g{background:var(--blue);color:#fff;border-color:var(--blue)}'
    + '#__scan_panel .btn.on{background:var(--green);color:#fff;border-color:var(--green)}'
    + '#__scan_panel .moremenu{position:relative}'
    + '#__scan_panel .moremenu-pop{display:none;position:absolute;right:0;top:calc(100% + 6px);z-index:40;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.16);padding:6px;min-width:156px;flex-direction:column;gap:4px}'
    + '#__scan_panel .moremenu.open .moremenu-pop{display:flex}'
    + '#__scan_panel .moremenu-pop .btn{width:100%;text-align:left;border:0;background:transparent;padding:7px 10px;border-radius:6px}'
    + '#__scan_panel .moremenu-pop .btn:hover{background:#f7f7fa}'
    + '#__scan_panel .twgrp{display:inline-flex;border:0;border-radius:var(--r-md);overflow:hidden;background:var(--fill);flex:none;padding:2px;gap:2px}'
    + '#__scan_panel .twgrp .tw{border:0;border-right:0;background:transparent;padding:6px 11px;font-size:13px;font-weight:500;color:var(--muted2);cursor:pointer;white-space:nowrap;border-radius:6px;transition:background .18s var(--ease),color .18s var(--ease),box-shadow .18s var(--ease)}'
    + '#__scan_panel .twgrp .tw:last-child{border-right:0}'
    + '#__scan_panel .twgrp .tw:hover{color:var(--ink)}'
    + '#__scan_panel .twgrp .tw.on{background:var(--card);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.10)}'
    + '#__scan_panel .tabs{display:inline-flex;gap:2px;margin:16px 0 12px;background:var(--fill);border-radius:var(--r-md);padding:2px}'
    + '#__scan_panel .tab{padding:6px 16px;border-radius:6px;font-size:13px;font-weight:500;color:var(--muted2);cursor:pointer;background:transparent;border:0;transition:background .18s var(--ease),color .18s var(--ease),box-shadow .18s var(--ease)}'
    + '#__scan_panel .tab:hover{color:var(--ink)}'
    + '#__scan_panel .tab.on{background:var(--card);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.10)}'
    + '#__scan_panel .card{background:var(--card);border-radius:0;padding:14px 16px;margin:0;display:flex;gap:14px;border-bottom:1px solid var(--line);box-shadow:none;transition:background .18s var(--ease)}'
    + '#__scan_panel .card:hover{background:#fafafa}'
    + '#__scan_panel .card:first-child{border-top-left-radius:var(--r-lg);border-top-right-radius:var(--r-lg)}'
    + '#__scan_panel .card:last-child{border-bottom-left-radius:var(--r-lg);border-bottom-right-radius:var(--r-lg);border-bottom:0}'
    + '#__scan_panel .card img{width:92px;height:92px;object-fit:cover;border-radius:var(--r-md);background:#f2f2f7;flex:none}'
    + '#__scan_panel .t{font-size:15px;font-weight:500;color:var(--ink);line-height:1.45;margin-bottom:6px;letter-spacing:-.1px}'
    + '#__scan_panel .p{color:var(--red);font-weight:600;font-size:17px;letter-spacing:-.2px}'
    + '#__scan_panel .m{color:var(--muted);font-size:12px;margin-top:6px}'
    + '#__scan_panel .new{background:var(--red);color:#fff;font-size:11px;font-weight:500;padding:1px 6px;border-radius:var(--r-sm);margin-left:6px}'
    + '#__scan_panel .seen{background:var(--muted);color:#fff;font-size:11px;font-weight:500;padding:1px 6px;border-radius:var(--r-sm);margin-left:6px}'
    + '#__scan_panel .card.read{opacity:.55}'
    + '#__scan_panel .fr{background:var(--card);border-radius:var(--r-lg);padding:16px;margin-bottom:12px;box-shadow:none}'
    + '#__scan_panel .lb{display:block;font-size:12px;font-weight:500;color:var(--muted2);margin-bottom:6px}'
    + '#__scan_panel input[type=text],#__scan_panel input[type=number],#__scan_panel select{width:100%;border:1px solid var(--line2);border-radius:var(--r-md);padding:9px 12px;font-size:13px;color:var(--ink);background:var(--card);box-sizing:border-box;transition:border-color .18s var(--ease),box-shadow .18s var(--ease)}'
    + '#__scan_panel input[type=text]:focus,#__scan_panel input[type=number]:focus,#__scan_panel select:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,122,255,.16)}'
    + '#__scan_panel .row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}'
    + '#__scan_panel .row2{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:12px}'
    + '#__scan_panel .chips{display:flex;flex-wrap:wrap;gap:8px}'
    + '#__scan_panel .chip{border:1px solid var(--line2);background:var(--card);border-radius:999px;padding:7px 14px;font-size:12px;font-weight:500;color:var(--ink2);cursor:pointer;user-select:none;transition:background .18s var(--ease),color .18s var(--ease),border-color .18s var(--ease)}'
    + '#__scan_panel .chip:hover{border-color:rgba(60,60,67,.3)}'
    + '#__scan_panel .chip.on{background:var(--blue);color:#fff;border-color:var(--blue);font-weight:600}'
    + '#__scan_panel .msel{position:relative}'
    + '#__scan_panel .msel-btn{width:100%;border:1px solid var(--line2);border-radius:var(--r-md);padding:9px 12px;font-size:13px;color:var(--ink);background:var(--card);box-sizing:border-box;cursor:pointer;text-align:left;display:flex;align-items:center;gap:8px;min-height:38px}'
    + '#__scan_panel .msel-btn:hover{border-color:rgba(60,60,67,.3)}'
    + '#__scan_panel .msel-btn .ms-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '#__scan_panel .msel-btn .ms-txt.ph{color:var(--muted)}'
    + '#__scan_panel .msel-btn .ms-arw{color:var(--muted);font-size:11px;flex:none}'
    + '#__scan_panel .msel-pop{display:none;position:absolute;z-index:20;top:calc(100% + 4px);left:0;right:0;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.16);padding:8px;max-height:290px;overflow:auto;pointer-events:auto}'
    + '#__scan_panel .msel.open .msel-pop{display:block}'
    + '#__scan_panel .msel-pop .mp-bar{display:flex;gap:14px;font-size:12px;color:var(--blue);margin-bottom:6px;padding:2px 4px 6px;border-bottom:1px solid var(--line)}'
    + '#__scan_panel .msel-pop .mp-bar span{cursor:pointer;user-select:none;font-weight:500}'
    + '#__scan_panel .msel-pop .mp-bar span:hover{text-decoration:underline}'
    + '#__scan_panel .msel-pop .mp-i{display:flex;align-items:center;gap:9px;font-size:13px;padding:7px 8px;border-radius:6px;cursor:pointer;color:var(--ink2)}'
    + '#__scan_panel .msel-pop .mp-i:hover{background:#f7f7fa}'
    + '#__scan_panel .msel-pop .mp-i input{width:15px;height:15px;accent-color:var(--blue);cursor:pointer;flex:none}'
    + '#__scan_panel .msel-pop .mp-i.on{color:var(--ink);font-weight:600}'
    + '#__scan_panel .msel-pop .mp-c{color:var(--orange);font-weight:500;font-size:11px;flex:none;margin-left:auto}'
    + '#__scan_panel .bwbox{border:1px solid var(--line2);border-radius:var(--r-md);padding:8px;background:var(--card);min-height:44px}'
    + '#__scan_panel .bwlist{display:flex;flex-wrap:wrap;gap:6px}'
    + '#__scan_panel .bwlist:not(:empty){margin-bottom:7px}'
    + '#__scan_panel .bwt{border:1px solid var(--line);background:var(--fill);border-radius:999px;padding:3px 9px;font-size:12px;color:var(--ink2);display:inline-flex;gap:6px;align-items:center}'
    + '#__scan_panel .bwt.zero{opacity:.55}'
    + '#__scan_panel .bwt .x{color:var(--muted);cursor:pointer;font-weight:500;font-size:13px;line-height:1}'
    + '#__scan_panel .bwt .x:hover{color:var(--red)}'
    + '#__scan_panel .bwt .h{font-size:11px;color:var(--blue);background:rgba(0,122,255,.10);border-radius:var(--r-sm);padding:0 4px;font-weight:600}'
    + '#__scan_panel .bwin{border:none;outline:none;font-size:12px;width:100%;padding:3px 2px;color:var(--ink2)}'
    + '#__scan_panel .bwbar{display:flex;gap:12px;font-size:11px;color:var(--blue);margin-top:6px}'
    + '#__scan_panel .bwbar span{cursor:pointer;user-select:none}'
    + '#__scan_panel .bwbar span.dim{color:var(--muted);cursor:default}'
    + '#__scan_panel .bwimp{display:none;margin-top:7px}'
    + '#__scan_panel .bwimp textarea{width:100%;height:62px;font-size:12px;border:1px solid var(--line2);border-radius:6px;padding:6px;box-sizing:border-box;outline:none;font-family:inherit}'
    + '#__scan_panel .hd{display:flex;align-items:center;gap:10px;margin-bottom:12px}'
    + '#__scan_panel .hd .n{font-size:15px;font-weight:600;color:var(--ink);letter-spacing:-.1px}'
    + '#__scan_panel .hd .hdsel{flex:0 0 auto;width:auto;font-size:12px;color:var(--ink2);border:1px solid var(--line2);border-radius:var(--r-sm);padding:3px 8px;background:var(--fill);cursor:pointer;outline:none;font-weight:500}'
    + '#__scan_panel .hd .hdsel:hover{border-color:rgba(60,60,67,.3);background:#ececf1}'
    + '#__scan_panel .hd .hdsel:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,122,255,.16)}'
    + '#__scan_panel .del{margin-left:auto;color:var(--red);font-size:12px;font-weight:500;cursor:pointer;border:0;background:none}'
    + '#__scan_panel .tn{font-size:12px;color:var(--muted);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px}'
    + '#__scan_panel .grp{margin-bottom:10px;background:transparent;border:0}'
    + '#__scan_panel .grp-h{display:inline-flex;align-items:center;gap:8px;padding:9px 16px;border:1px solid var(--line2);border-radius:999px;background:var(--fill);cursor:pointer;user-select:none;font-size:13px;font-weight:600;color:var(--ink);transition:background .18s var(--ease),border-color .18s var(--ease)}'
    + '#__scan_panel .grp-h:hover{background:#ececf1;border-color:rgba(60,60,67,.3)}'
    + '#__scan_panel .grp.open .grp-h{background:#e8e8ed}'
    + '#__scan_panel .grp-chev{font-size:11px;color:var(--muted);flex:none;transition:transform .18s var(--ease);line-height:1}'
    + '#__scan_panel .grp.open .grp-chev{transform:rotate(90deg)}'
    + '#__scan_panel .grp-t{font-size:13px;font-weight:600;color:var(--ink);flex:none}'
    + '#__scan_panel .grp-s{display:none}'
    + '#__scan_panel .grp-b{display:none;margin-top:10px;padding:14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--card)}'
    + '#__scan_panel .grp.open .grp-b{display:block}'
    + '#__scan_panel .savebar{position:sticky;bottom:0;z-index:40;margin-top:14px;padding:10px 0;background:linear-gradient(180deg,rgba(245,245,247,0),rgba(245,245,247,.94) 22%,rgba(245,245,247,1) 55%);display:flex;justify-content:flex-end}'
    + '#__scan_panel .secbar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}'
    + '#__scan_panel .sectab{flex:1 1 auto;padding:10px 14px;border:1px solid var(--line2);border-radius:12px;background:var(--card);cursor:pointer;user-select:none;font-size:14px;font-weight:600;color:var(--muted2);text-align:center;transition:background .18s var(--ease),color .18s var(--ease),border-color .18s var(--ease)}'
    + '#__scan_panel .sectab:hover{background:#ececf1}'
    + '#__scan_panel .sectab.on{background:var(--ink);border-color:var(--ink);color:#fff}'
    + '#__scan_panel .secpane{display:none}'
    + '#__scan_panel .secpane.on{display:block}'
    + '#__scan_panel b,#__scan_panel strong,#__scan_panel em{font-weight:600}'
    + '#__scan_panel .tip{font-size:12px;color:var(--muted);line-height:1.7}'
    + '#__scan_panel .toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:rgba(29,29,31,.92);color:#fff;padding:11px 22px;border-radius:10px;font-size:13px;font-weight:500;z-index:99;display:none;-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);box-shadow:0 8px 30px rgba(0,0,0,.20)}'
    + '#__scan_panel .loginbar{display:none;background:var(--card);border:1px solid rgba(255,59,48,.35);border-radius:var(--r-lg);padding:16px 18px;margin-bottom:14px;box-shadow:none}'
    + '#__scan_panel .loginbar .lb-h{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:600;color:var(--red);margin-bottom:6px;letter-spacing:-.1px}'
    + '#__scan_panel .loginbar .lb-d{font-size:13px;color:var(--ink2);line-height:1.7}'
    + '#__scan_panel .loginbar .lb-f{display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap}'
    + '#__scan_panel .loginbar .lb-btn{background:var(--red);color:#fff;border:0;border-radius:var(--r-md);padding:11px 20px;font-size:15px;font-weight:600;cursor:pointer;transition:background .18s var(--ease)}'
    + '#__scan_panel .loginbar .lb-btn:hover{background:#e0342a}'
    + '#__scan_panel .loginbar .lb-btn:disabled{background:#f5a9a4;cursor:default}'
    + '#__scan_panel .loginbar .lb-btn2{background:var(--fill);color:var(--ink2);border:0;border-radius:var(--r-md);padding:10px 16px;font-size:13px;font-weight:500;cursor:pointer;transition:background .18s var(--ease)}'
    + '#__scan_panel .loginbar .lb-btn2:hover{background:#ececf1}'
    + '#__scan_panel .loginbar .lb-alt{font-size:12px;color:var(--muted2);line-height:1.7}'
    + '#__scan_panel .loginbar .lb-alt code{background:var(--fill);border:0;border-radius:var(--r-sm);padding:1px 6px;font-size:12px;color:var(--ink2)}'
    + '#__scan_panel .loginbar .spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:__scan_spin .7s linear infinite;vertical-align:-2px;margin-right:7px}'
    + '#__scan_panel .remotebar{display:none;background:var(--card);border:1px solid rgba(255,59,48,.35);border-radius:var(--r-lg);padding:16px 18px;margin-bottom:14px;box-shadow:none}'
    + '#__scan_panel .remotebar.bad{border-color:rgba(255,59,48,.5)}'
    + '#__scan_panel .remotebar .rb-h{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:600;color:var(--red);margin-bottom:6px;letter-spacing:-.1px}'
    + '#__scan_panel .remotebar .rb-d{font-size:13px;color:var(--ink2);line-height:1.7;white-space:pre-wrap}'
    + '#__scan_panel .qmbox{display:none;margin-top:14px;background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px;flex-direction:row;gap:16px;align-items:flex-start}'
    + '#__scan_panel .qmbox.on{display:flex}'
    + '#__scan_panel .qmbox .qr-frame{flex:none;width:168px;height:168px;border:1px solid var(--line);border-radius:var(--r-md);background:#f7f7fa;display:flex;align-items:center;justify-content:center;overflow:hidden}'
    /* 【2026-11-05】原来带 image-rendering:pixelated —— 那是给「小图放大」用的，
       放大时保硬边。现在服务端给的是 444×444 大图、显示框只有 160px，属「大图缩小」，
       pixelated 会让模块宽度抖动、边缘断裂，反而更难扫。改成默认平滑缩放。 */
    + '#__scan_panel .qmbox .qr-frame img{width:160px;height:160px;display:block}'
    + '#__scan_panel .qmbox .qr-tip{flex:1;min-width:0;font-size:13px;color:var(--ink2);line-height:1.8}'
    + '#__scan_panel .qmbox .qr-tip b{color:var(--ink);font-weight:600}'
    + '#__scan_panel .qmbox .qr-st{font-size:12px;color:var(--muted2);margin-top:6px}'
    + '#__scan_panel .qmbox .qr-err{font-size:12px;color:var(--red);margin-top:6px;line-height:1.7}'
    + '#__scan_panel .qmbox .qr-acts{margin-top:9px;display:flex;gap:9px;flex-wrap:wrap}'
    + '#__scan_panel .qmbox .qr-s{background:var(--card);color:var(--ink2);border:1px solid var(--line2);border-radius:var(--r-sm);padding:6px 12px;font-size:12px;font-weight:500;cursor:pointer;transition:background .18s var(--ease)}'
    + '#__scan_panel .qmbox .qr-s:hover{background:#f7f7fa}'
    + '#__scan_panel .lgn{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:500;border-radius:999px;padding:5px 12px;border:1px solid var(--line2);background:var(--card);color:var(--muted2);white-space:nowrap;transition:background .18s var(--ease),border-color .18s var(--ease),color .18s var(--ease)}'
    + '#__scan_panel .lgn.ok{background:rgba(52,199,89,.10);border-color:rgba(52,199,89,.28);color:#1d7a34}'
    + '#__scan_panel .lgn.warn{background:rgba(255,149,0,.10);border-color:rgba(255,149,0,.28);color:#a05f00}'
    + '#__scan_panel .lgn.bad{background:rgba(255,59,48,.10);border-color:rgba(255,59,48,.28);color:#c3241b}'
    + '#__scan_panel .lgn .dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}'
    + '#__scan_panel .lgn .sep{opacity:.32;margin:0 1px;font-weight:400}'
    + '#__scan_panel .lgn .u{font-variant-numeric:tabular-nums}'
    + '#__scan_panel .lgn-btn{background:var(--card);color:var(--ink2);border:1px solid var(--line2);border-radius:999px;padding:5px 14px;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .18s var(--ease),color .18s var(--ease),border-color .18s var(--ease)}'
    + '#__scan_panel .lgn-btn:hover{background:#f7f7fa}'
    + '#__scan_panel .lgn-btn.bad{background:var(--red);color:#fff;border-color:var(--red)}'
    + '#__scan_panel .lgn-btn.bad:hover{background:#e0342a}'
    + '@keyframes __scan_spin{to{transform:rotate(360deg)}}'
    + '#__scan_panel .sellerbar{background:var(--card);border:1px solid rgba(255,149,0,.32);border-radius:var(--r-lg);padding:0;margin-bottom:12px;overflow:hidden}'
    + '#__scan_panel .sellerbar.sbm{background:var(--card);border-color:var(--line2)}'
    + '#__scan_panel .sellerbar .sb-h{font-size:15px;font-weight:600;color:var(--ink);margin-bottom:4px;letter-spacing:-.1px}'
    + '#__scan_panel .sellerbar.sbm .sb-h{color:var(--ink)}'
    + '#__scan_panel .sellerbar .sb-s{font-size:12px;color:var(--muted2);margin-bottom:10px}'
    + '#__scan_panel .sellerbar.sbm .sb-s{color:var(--muted2)}'
    + '#__scan_panel .sellerbar .sb-list{max-height:210px;overflow:auto;display:flex;flex-direction:column;gap:2px;background:#f7f7fa;border:1px solid var(--line);border-radius:var(--r-md);padding:8px}'
    + '#__scan_panel .sellerbar .sb-item{display:flex;align-items:center;gap:8px;font-size:13px;padding:5px 6px;border-radius:6px;cursor:pointer}'
    + '#__scan_panel .sellerbar .sb-item:hover{background:var(--fill)}'
    + '#__scan_panel .sellerbar .sb-item input{width:15px;height:15px;accent-color:var(--orange);cursor:pointer;flex:none}'
    + '#__scan_panel .sellerbar .sb-nm{font-weight:500;color:var(--ink);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '#__scan_panel .sellerbar .sb-ct{color:var(--orange);font-weight:600;flex:none}'
    + '#__scan_panel .sellerbar .sb-rt{color:var(--red);font-weight:500;flex:none}'
    + '#__scan_panel .sellerbar .sb-dl{color:var(--muted);flex:none}'
    + '#__scan_panel .sellerbar .sb-why{color:var(--blue);font-weight:500;flex:none;font-size:11px;background:rgba(0,122,255,.10);border:0;border-radius:var(--r-sm);padding:1px 6px}'
    + '#__scan_panel .sellerbar .sb-act{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}'
    + '#__scan_panel .sellerbar .sb-btn{background:var(--card);color:var(--ink2);border:1px solid var(--line2);border-radius:var(--r-sm);padding:8px 15px;font-size:12px;font-weight:500;cursor:pointer;transition:background .18s var(--ease)}'
    + '#__scan_panel .sellerbar .sb-btn:hover{background:#f7f7fa}'
    + '#__scan_panel .sellerbar .sb-btn.sb-ok{background:var(--orange);color:#fff;border-color:var(--orange)}'
    + '#__scan_panel .sellerbar .sb-btn.sb-ok:hover{background:#e58600}'
    + '#__scan_panel .sellerbar .sb-btn:disabled{background:var(--fill);color:var(--muted);cursor:default}'
    + '#__scan_panel .sellerbar .sb-blocked{font-size:12px;color:var(--muted2);margin-left:auto}'
    /* ===== 折叠头：收起时整条只有这一行（约 46px），点一下展开完整清单 ===== */
    + '#__scan_panel .sellerbar .sb-head{display:flex;align-items:center;gap:10px;padding:11px 16px;cursor:pointer;user-select:none;transition:background .18s var(--ease)}'
    + '#__scan_panel .sellerbar .sb-head:hover{background:#fafafa}'
    + '#__scan_panel .sellerbar .sb-head.flat{cursor:default}'
    + '#__scan_panel .sellerbar .sb-head.flat:hover{background:transparent}'
    + '#__scan_panel .sellerbar .sb-h-ico{font-size:14px;flex:none;line-height:1}'
    + '#__scan_panel .sellerbar .sb-h-txt{font-size:13px;font-weight:500;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '#__scan_panel .sellerbar .sb-h-txt b{font-weight:600}'
    + '#__scan_panel .sellerbar .sb-new{flex:none;font-size:11px;font-weight:500;color:#fff;background:var(--orange);border-radius:var(--r-sm);padding:1px 6px}'
    + '#__scan_panel .sellerbar .sb-chev{flex:none;margin-left:auto;padding-left:8px;color:var(--muted);font-size:11px;line-height:1}'
    + '#__scan_panel .sellerbar .sb-body{display:none;padding:0 16px 14px}'
    + '#__scan_panel .sellerbar.open .sb-body{display:block}'
    + '#__scan_panel .sellerbar .sb-qrow{display:flex;align-items:center;gap:8px;margin-bottom:8px}'
    + '#__scan_panel .sellerbar .sb-q{flex:1;min-width:0;border:1px solid var(--line2);border-radius:var(--r-md);padding:7px 11px;font-size:12px;color:var(--ink);background:var(--card);box-sizing:border-box}'
    + '#__scan_panel .sellerbar .sb-q:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,122,255,.16)}'
    + '#__scan_panel .sellerbar .sb-qcnt{flex:none;font-size:11px;color:var(--muted)}'
    + '#__scan_panel .sellerbar .sb-item.hide{display:none}'
    + '#__scan_panel .sb-look{background:var(--fill);color:var(--blue);border:0;border-radius:var(--r-sm);padding:2px 8px;font-size:11px;font-weight:500;cursor:pointer;flex:none}'
    + '#__scan_panel .sb-look:hover{background:rgba(0,122,255,.12)}'
    + '#__scan_panel .sb-look:disabled{opacity:.55;cursor:default}'
    + '#__scan_spm_bg{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.32);z-index:2147482999;display:none;-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}'
    + '#__scan_spm_bg.on{display:block}'
    + '#__scan_spm{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1080px,94vw);height:min(92vh,1100px);background:var(--card);border-radius:var(--r-lg);box-shadow:0 24px 70px rgba(0,0,0,.30);z-index:2147483000;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}'
    + '#__scan_spm.on{display:flex}'
    + '#__scan_spm .sp-h{flex:none;display:flex;align-items:center;gap:10px;padding:13px 16px;background:#f7f7fa;border-bottom:1px solid var(--line)}'
    + '#__scan_spm .sp-h .t{font-size:15px;font-weight:600;color:var(--ink);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-.1px}'
    + '#__scan_spm .sp-h .m{font-size:12px;color:var(--muted2);font-weight:500;flex:none}'
    + '#__scan_spm .sp-h button{flex:none;background:var(--card);color:var(--ink2);border:1px solid var(--line2);border-radius:var(--r-sm);padding:6px 13px;font-size:12px;font-weight:500;cursor:pointer}'
    + '#__scan_spm .sp-h button:hover{background:#f0f0f4}'
    + '#__scan_spm .sp-b{flex:1;overflow:auto;background:#f7f7fa;padding:0;text-align:left}'
    + '#__scan_spm .sp-sum{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:11px 16px;background:var(--card);border-bottom:1px solid var(--line);font-size:12px}'
    + '#__scan_spm .sp-sum .k{color:var(--muted);font-weight:500;margin-right:3px}'
    + '#__scan_spm .sp-sum b{color:var(--ink);font-weight:600;font-size:13px}'
    + '#__scan_spm .sp-sum b.na{color:#c7c7cc;font-weight:500}'
    + '#__scan_spm .sp-sum .tag-warn{background:rgba(255,149,0,.12);color:#a05f00;border:0;border-radius:var(--r-sm);padding:2px 8px;font-weight:500}'
    + '#__scan_spm .sp-sum .tag-bad{background:rgba(255,59,48,.12);color:#c3241b;border:0;border-radius:var(--r-sm);padding:2px 8px;font-weight:500}'
    + '#__scan_spm .sp-intro{padding:9px 16px;background:rgba(52,199,89,.08);border-bottom:1px solid var(--line);font-size:12px;color:#1d7a34;line-height:1.7}'
    + '#__scan_spm .sp-intro .k{color:#34c759;font-weight:600;margin-right:6px}'
    + '#__scan_spm .sp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:10px;padding:12px}'
    + '#__scan_spm .sp-card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;text-decoration:none;display:flex;flex-direction:column;transition:box-shadow .15s,border-color .15s}'
    + '#__scan_spm .sp-card:hover{border-color:rgba(0,122,255,.35);box-shadow:0 4px 14px rgba(0,0,0,.10)}'
    + '#__scan_spm .sp-card .ph{width:100%;aspect-ratio:1/1;background:#f2f2f7;overflow:hidden}'
    + '#__scan_spm .sp-card .ph img{width:100%;height:100%;object-fit:cover;display:block}'
    + '#__scan_spm .sp-card .tt{font-size:12px;color:var(--ink2);line-height:1.45;padding:7px 9px 3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;height:42px}'
    + '#__scan_spm .sp-card .pp{display:flex;align-items:baseline;gap:6px;padding:0 9px}'
    + '#__scan_spm .sp-card .pp b{color:var(--red);font-size:15px;font-weight:600}'
    + '#__scan_spm .sp-card .pp .ar{color:var(--muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '#__scan_spm .sp-card .tm{color:var(--muted);font-size:11px;padding:3px 9px 8px}'
    + '#__scan_spm .sp-more{padding:0 16px 16px;font-size:12px;color:var(--muted)}'
    + '#__scan_spm .sp-tip{flex:none;padding:9px 16px;background:rgba(255,149,0,.08);border-top:1px solid var(--line);font-size:12px;color:#a05f00;line-height:1.7}'
    + '#__scan_spm .sp-load{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--blue);font-size:13px;font-weight:500}'
    + '#__scan_spm .sp-load .sp-sp{width:34px;height:34px;border:3px solid rgba(0,122,255,.20);border-top-color:var(--blue);border-radius:50%;animation:__scan_spin .8s linear infinite}'
    + '#__scan_spm .sp-err{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;color:var(--red);font-size:13px;line-height:1.8;text-align:center}';

  function addStyle() {
    if (document.getElementById('__scan_css')) return;
    var st = document.createElement('style'); st.id = '__scan_css'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ---------- 面板骨架 ---------- */
  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);
    addStyle();
    var el = document.createElement('div');
    el.id = PANEL_ID;
    el.innerHTML = '<div class="wrap">'
      /* 登录失效横幅：默认 display:none，由 loadHits() 按服务端 fresh.loginBad 决定是否显示 */
      + '<div class="loginbar" id="__scan_loginbar">'
      + '<div class="lb-h"><span style="font-size:15px">⚠</span> 登录已失效，现在抓不到新货</div>'
      + '<div class="lb-d" id="__scan_loginbar_txt"></div>'
      + '<div class="lb-f">'
      + '<button class="lb-btn" id="__scan_relogin">扫码登录（面板内直接扫）</button>'
      + '<button class="lb-btn2" id="__scan_relogin_old">用浏览器窗口登录</button>'
      + '<div class="lb-alt">点<b>扫码登录</b>：这里直接出一个二维码，手机闲鱼扫一下就好 —— <b>不会停掉监控，也不用重启</b>。<br>'
      + '（想用老办法也行：点<b>用浏览器窗口登录</b>，或者关掉本页双击 <code>3-重新登录并恢复.cmd</code>）</div>'
      + '</div></div>'
      /* 远程停用公告：默认 display:none，由 loadHits() 按服务端 remote.status 决定是否显示 */
      + '<div class="remotebar" id="__scan_remotebar">'
      + '<div class="rb-h"><span style="font-size:15px">🚫</span> <span id="__scan_remote_title">程序已暂停</span></div>'
      + '<div class="rb-d" id="__scan_remote_txt"></div>'
      + '</div>'
      /* 二维码面板放在横幅外面：登录正常时点标题行那个【登录 / 换号】也能把它叫出来，
         以前它被埋在红横幅里，登录一正常就整块消失，用户想主动换号都没入口。 */
      + '<div class="qmbox" id="__scan_qrbox">'
      + '<div class="qr-frame"><img id="__scan_qrimg" alt="登录二维码"></div>'
      + '<div class="qr-tip"><div><b>手机闲鱼 → 左上角「扫一扫」→ 扫左边这张码</b></div>'
      + '<div>扫完手机会弹「确认登录」，点确认就行。这里会自动检测到，不用刷新页面。</div>'
      + '<div class="qr-st" id="__scan_qrstatus">正在生成二维码…</div>'
      + '<div class="qr-err" id="__scan_qrerr" style="display:none"></div>'
      + '<div class="qr-acts"><button class="qr-s" id="__scan_qrrefresh">换一张码</button>'
      + '<button class="qr-s" id="__scan_qrclose">取消</button>'
      /* 兜底入口：面板内二维码万一扫不动 / 生成失败，这里能直接改走
         「停监控 → 弹真浏览器窗口扫码 → 自动重启」的老流程。 */
      + '<button class="qr-s" id="__scan_qr_old" title="面板内二维码扫不动时用这个：会停一下监控，弹出真浏览器窗口让你扫码，登录完自动重启">二维码扫不动？用浏览器窗口登录</button></div></div>'
      + '</div>'
      /* 标题行：多加登录徽标和登录按钮后宽度变紧，允许换行（窄屏时按钮组自动落到第二行），
         别让 h2 和按钮被压成竖排文字。 */
      + '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">'
      + '<h2>扫货监控<span class="brand" id="__scan_brand" title="关于 闲鱼扫货监控"></span></h2>'
      + '<span id="__scan_count" style="font-size:13px;color:#8e8e93"></span>'
      /* 常驻登录状态 + 常驻登录入口：不管登录是否正常都显示在标题行，
         用户随时能看到"现在是谁登录着、还能撑多久"，也随时能点开扫码换号。 */
      + '<div class="lgn" id="__scan_lgn"><span class="dot"></span><span id="__scan_lgn_txt">登录状态读取中…</span></div>'
      + '<button class="lgn-btn" id="__scan_lgn_btn">登录 / 换号</button>'
      + '<div style="margin-left:auto;display:flex;gap:8px;align-items:center">'
      + '<div class="moremenu" id="__scan_morewrap">'
      + '<button class="btn" id="__scan_more" title="更多操作">⋯</button>'
      + '<div class="moremenu-pop" id="__scan_morepop">'
      + '<button class="btn" id="__scan_readall">全部标记看过</button>'
      + '<button class="btn" id="__scan_selfcheck" title="一键看程序现在是否正常（只读，不发搜索请求、不会扰动风控）">体检</button>'
      + '<button class="btn" id="__scan_clear">清空记录</button>'
      + '<button class="btn" id="__scan_reload">刷新</button>'
      + (STANDALONE ? '' : '<button class="btn" id="__scan_close">关闭</button>')
      + '</div></div>'
      /* 【启动待命 2026-11-04】程序启动后默认不发任何搜索请求，点这里才真正开始。
         文案与样式随 hold 状态在 loadHits() 里实时更新。 */
      + '<button class="btn on" id="__scan_hold" title="程序启动后默认待命：已还原登录态，但不会发任何搜索请求。点这里开始扫。">▶ 开始监控</button>'
      + '</div></div>'
      + '<div class="holdbar" id="__scan_holdbar"><span id="__scan_hold_txt"></span></div>'
      + '<div class="tabs"><div class="tab on" data-tab="list">命中商品</div><div class="tab" data-tab="filter">搜索设置</div></div>'
      + '<div id="__scan_listbar" style="display:flex;align-items:center;gap:10px;margin:0 0 12px;flex-wrap:wrap">'
      + '<button class="btn" id="__scan_scope">显示全部</button>'
      + '<span class="twgrp" id="__scan_tw" title="只看这个时间窗口内发布的商品（按发布时间算）">'
      + TW_OPTS.map(function (h) {
          return '<button class="tw' + (h === timeWin ? ' on' : '') + '" data-h="' + h + '">' + twLabelOf(h) + '</button>';
        }).join('')
      + '</span>'
      + '</div>'
      + '<div style="font-size:12px;color:#8e8e93;margin-top:4px" id="__scan_sub"></div>'
      /* 【2026-11-05】时间钟（当前时间 / 上次刷新 / 距下次刷新倒计时）上次布局优化
         被挪到了页面最底部页脚，命中列表有上千条、滚动高度几万像素，用户根本滚不到，
         会以为"倒计时扫货没了"。现在放回列表上方，做成浅灰胶囊，一眼就能看到。 */
      + '<div id="__scan_foot" style="font-size:12px;color:#6e6e73;margin:10px 0 12px;padding:9px 12px;background:rgba(118,118,128,.10);border-radius:10px;text-align:left">'
      + '<span id="__scan_clock" style="font-variant-numeric:tabular-nums">时间钟加载中…</span>'
      + '</div>'
      + '<div id="__scan_undo" style="display:none;margin-top:7px;font-size:12px;background:rgba(52,199,89,.10);border:1px solid rgba(52,199,89,.35);color:#1d7a34;border-radius:6px;padding:6px 10px">'
      + '<span id="__scan_undo_txt"></span>'
      + '<span id="__scan_undo_btn" style="color:#007aff;font-weight:600;cursor:pointer;margin-left:10px;text-decoration:underline">撤销</span>'
      + '</div>'
      + '<div id="__scan_view"></div>'
      + '</div>'
      + '<div class="toast" id="__scan_toast"></div>';
    document.body.appendChild(el);
    /* 独立模式没有「关闭」按钮（DOM 里根本没这个节点），必须判空，
       否则 querySelector 返回 null，赋值 onclick 直接抛错，整个面板初始化就挂了。 */
    var btnClose = el.querySelector('#__scan_close');
    if (btnClose) btnClose.onclick = closePanel;
    /* 【扫码登录（面板内直接扫）】
       点一下 → 后台无头打开 passport 登录页 → 把二维码 canvas 截图当 PNG 塞进 <img>。
       手机扫完 → 每 2.5s 轮询 /__scan/qrstatus，一旦 unb 出现就：
         monitor 把新 cookie 写进 cookies.json + addCookies 到正在跑的浏览器 → 立刻恢复，不重启。
       轮询有上限（约 3 分钟）；超时就提示换一张码或改用浏览器窗口登录。 */
    var qrTimer = null, qrTries = 0;
    function qrStop() { if (qrTimer) { clearInterval(qrTimer); qrTimer = null; } }
    function qrShow(on) {
      var box = document.getElementById('__scan_qrbox');
      if (box) box.className = 'qmbox' + (on ? ' on' : '');
    }
    function qrErr(msg) {
      var e = document.getElementById('__scan_qrerr');
      if (!e) return;
      if (msg) { e.style.display = 'block'; e.textContent = msg; }
      else { e.style.display = 'none'; e.textContent = ''; }
    }
    function qrSetStatus(t) {
      var s = document.getElementById('__scan_qrstatus');
      if (s) s.textContent = t;
    }
    function qrLoad(forceNew) {
      qrErr('');
      var img = document.getElementById('__scan_qrimg');
      qrSetStatus('正在生成二维码…');
      if (img) img.removeAttribute('src');
      /* new=1 才强制重出码。不加的话服务端 90 秒内会复用同一张（避免并发重载打架），
         用户点「换一张码」就没反应。 */
      fetch('/__scan/qr?' + (forceNew ? 'new=1&' : '') + 't=' + Date.now()).then(function (r) {
        var ct = (r.headers.get('content-type') || '');
        if (ct.indexOf('image/') === 0) return r.blob();
        return r.json().then(function (j) {
          if (j && j.logged) { qrDone('已经是登录态，无需扫码。'); return null; }
          throw new Error((j && j.error) || '二维码生成失败');
        });
      }).then(function (blob) {
        if (!blob) return;
        if (img) img.src = URL.createObjectURL(blob);
        qrSetStatus('二维码已生成，用手机闲鱼扫一下（这页会自动检测）');
        qrWait();
      }).catch(function (e) {
        qrSetStatus('二维码没出来');
        qrErr(String((e && e.message) || e) + '。可以点「换一张码」重试，或改用「用浏览器窗口登录」。');
      });
    }
    function qrWait() {
      qrStop(); qrTries = 0;
      qrTimer = setInterval(function () {
        qrTries++;
        if (qrTries > 72) {                    /* 72 × 2.5s ≈ 3 分钟 */
          qrStop();
          qrSetStatus('二维码已等待 3 分钟，可能过期了。');
          qrErr('点「换一张码」重新生成，或改用「用浏览器窗口登录」。');
          return;
        }
        fetch('/__scan/qrstatus?t=' + Date.now()).then(function (r) { return r.json(); }).then(function (j) {
          /* 【修 BUG-K 的前端配合】服务端现在分别给 sessLogged（本扫码会话）和
             mainLogged（主监控 cookie 登录态）。只有 sessLogged 才代表"这次扫码成功"，
             mainLogged 只说明后台本来就没掉线 —— 两者混用会让用户以为扫了码其实没生效，
             也可能在后台早已登录时一直提示"等待扫码"。 */
          if (j && j.sessLogged) { qrDone('扫码成功，已恢复登录（' + (j.injected || 0) + ' 条 cookie 已注入，监控没停）。'); return; }
          if (j && j.mainLogged && !j.sessLogged) {
            qrSetStatus('后台监控当前登录态正常；如仍要换账号，请继续扫码…');
            qrErr('');
          }
          if (j && j.err) { qrErr(String(j.err)); }
          if (j && j.age) qrSetStatus('等待扫码…（已等待 ' + j.age + ' 秒）');
        }).catch(function () { /* 瞬断忽略，下一轮再试 */ });
      }, 2500);
    }
    function qrDone(msg) {
      qrStop();
      qrShow(false);
      qrSetStatus('');
      qrErr('');
      toast(msg || '已登录');
      setTimeout(function () { loadHits(); }, 1200);
    }
    /* 收起二维码 + 通知服务端关掉后台登录页（不关会一直占着一个浏览器进程） */
    function qrClose() {
      qrStop(); qrShow(false);
      fetch('/__scan/qrclose', { method: 'POST' }).catch(function () {});
    }
    var btnRelogin = el.querySelector('#__scan_relogin');
    if (btnRelogin) btnRelogin.onclick = function () {
      qrShow(true);
      qrLoad();
    };
    /* 标题行那个常驻的【登录 / 换号】：登录正常时也能主动换号。
       以前二维码弹层只挂在失效横幅里，登录一正常整块消失，想换号没入口。 */
    var btnLgn = el.querySelector('#__scan_lgn_btn');
    if (btnLgn) btnLgn.onclick = function () {
      var box = document.getElementById('__scan_qrbox');
      if (box && box.className.indexOf('on') >= 0) { qrClose(); return; }
      qrShow(true);
      qrLoad(true);          /* 主动换号必须出新码，不能复用上一张 */
    };
    var btnQrRefresh = el.querySelector('#__scan_qrrefresh');
    if (btnQrRefresh) btnQrRefresh.onclick = function () { qrLoad(true); };
    var btnQrClose = el.querySelector('#__scan_qrclose');
    if (btnQrClose) btnQrClose.onclick = function () { qrClose(); };
    /* 【用浏览器窗口登录】—— 老流程，原样保留：
       服务端 /__scan/relogin 先回执、再自己退出，然后拉起 3-重新登录并恢复.cmd。 */
    function reloginViaWindow(btn) {
      var oldTxt = btn.textContent;
      if (!confirm('会用浏览器窗口登录（老办法）：\n\n· 监控会先停止\n· 弹出一个浏览器窗口让你扫码\n· 登录完成后自动重启监控\n\n确定继续吗？')) return;
      btn.disabled = true;
      btn.textContent = '正在停止监控…';
      fetch('/__scan/relogin', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok) {
          btn.textContent = '监控已停止，请在新的浏览器窗口里扫码登录';
          toast('登录窗口即将弹出 —— 扫码完成后不用管，监控会自动重启');
        } else {
          btn.disabled = false;
          btn.textContent = oldTxt;
          toast('启动失败：' + JSON.stringify(j) + '，请手动双击 0-首次扫码登录.cmd');
        }
      }).catch(function () {
        /* 监控已经退出、连接被断，这是预期路径，不是错误 */
        btn.textContent = '监控已停止，请在新的浏览器窗口里扫码登录';
      });
    }
    var btnReloginOld = el.querySelector('#__scan_relogin_old');
    if (btnReloginOld) btnReloginOld.onclick = function () { reloginViaWindow(this); };
    /* 二维码弹层里的同款兜底按钮 */
    var btnQrOld = el.querySelector('#__scan_qr_old');
    if (btnQrOld) btnQrOld.onclick = function () { reloginViaWindow(this); };
    /* 【时间档位】六选一，点了立刻重渲染；和"只看没看过的/最近看过/全部"叠着用。
       用事件委托而不是逐个绑：按钮是上面 innerHTML 拼出来的，重渲染时不重建监听。 */
    var twBox = document.getElementById('__scan_tw');
    if (twBox) twBox.onclick = function (ev) {
      var b = ev.target;
      while (b && b !== twBox && b.tagName !== 'BUTTON') b = b.parentNode;
      if (!b || b === twBox) return;
      var h = parseInt(b.getAttribute('data-h'), 10);
      if (!isFinite(h) || h < 0) return;
      timeWin = h;
      try { window.localStorage.setItem(TW_KEY, String(h)); } catch (e) { }
      var kids = twBox.getElementsByTagName('button');
      for (var i = 0; i < kids.length; i++) {
        var kh = parseInt(kids[i].getAttribute('data-h'), 10);
        kids[i].className = 'tw' + (kh === timeWin ? ' on' : '');
      }
      hideUndo();
      loadHits();
    };
    el.querySelector('#__scan_scope').onclick = function () {
      /* 三档切换：没看过的 → 最近看过 → 全部 → 没看过的 */
      scopeMode = scopeMode === 'unread' ? 'recent' : (scopeMode === 'recent' ? 'all' : 'unread');
      hideUndo();
      loadHits();
    };
    el.querySelector('#__scan_clear').onclick = function () {
      if (!confirm('确定清空命中记录？\n（登录状态和筛选设置不受影响；清空后会重新拉一遍当前在售，\n只有之后新发布的商品才算新命中）')) return;
      this.textContent = '清空中…';
      var btn = this;
      /* 【与服务端同步】/__scan/clear 现在要求 body 带 confirm:"CLEAR-HITS"，
         并且服务端会先把 hits.json 复制成 hits.before-clear-<时间戳>.json 再清，
         清错了能从 data 目录捞回来。 */
      fetch('/__scan/clear', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ confirm:'CLEAR-HITS' }) })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d && d.ok === false) { toast('清空失败：' + (d.error || '未知原因')); return; }
          toast('已清空 ' + (d.cleared || 0) + ' 条（已留快照可恢复），正在重新收录当前在售…');
          setTimeout(loadHits, 9000); setTimeout(loadHits, 16000);
        })
        .catch(function(e){ toast('失败:'+e.message); })
        .then(function(){ btn.textContent = '清空记录'; });
    };
    /* 【体检 2026-10-29】一键看程序现在是否正常。
       它和「诊查类」操作的根本区别：那些都要真的连发搜索请求（十几秒、还会扰动风控），
       体检只读内存里已有的状态 + data 目录里的文件，毫秒级返回、零副作用。
       用户平时想知道"是不是坏了""要不要重新登录"时点这个，而不是点对照。 */
    el.querySelector('#__scan_selfcheck').onclick = function () {
      var btn = this;
      btn.textContent = '体检中…';
      fetch('/__scan/selfcheck?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          btn.textContent = '体检';
          if (!d.ok) { toast('体检失败：' + (d.error || '')); return; }
          var RK = { ok: ['rgba(52,199,89,.08)', '#1d7a34', '✓'], warn: ['rgba(255,149,0,.08)', '#a05f00', '!'], bad: ['rgba(255,59,48,.08)', '#c3241b', '✕'] };
          var head = RK[d.rank] || RK.ok;
          var upMin = Math.round((d.uptimeSec || 0) / 60);
          var html = '<div style="background:' + head[0] + ';border:1px solid ' + head[1] + '33;border-radius:10px;padding:12px 14px;margin-bottom:12px">'
            + '<div style="font-size:15px;font-weight:600;color:' + head[1] + '">' + head[2] + ' ' + esc(d.summary) + '</div>'
            + '<div style="font-size:12px;color:#8e8e93;margin-top:4px">'
            + '已运行 ' + (upMin >= 60 ? (Math.floor(upMin / 60) + ' 小时 ' + (upMin % 60) + ' 分') : (upMin + ' 分钟'))
            + ' · 第 ' + (d.roundNo || 0) + ' 轮 · 检查时间 ' + esc(String(d.at || '').replace('T', ' ').slice(0, 19))
            + '</div></div>';
          html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
          (d.items || []).forEach(function (x) {
            var c = RK[x.rank] || RK.ok;
            html += '<tr>'
              + '<td style="padding:7px 6px;border-top:1px solid #d1d1d6;white-space:nowrap;color:' + c[1] + ';font-weight:600;width:1%">' + c[2] + '</td>'
              + '<td style="padding:7px 6px;border-top:1px solid #d1d1d6;white-space:nowrap;font-weight:600">' + esc(x.label) + '</td>'
              + '<td style="padding:7px 6px;border-top:1px solid #d1d1d6;color:#3a3a3c">' + esc(x.detail || '')
              + (x.hint ? '<div style="color:#30b0c7;margin-top:3px">→ ' + esc(x.hint) + '</div>' : '')
              + '</td></tr>';
          });
          html += '</table>';
          html += '<div style="font-size:12px;color:#8e8e93;margin-top:12px;line-height:1.8">'
            + '这项检查<b>不会</b>发任何搜索请求，也不会改数据，可以随时点。<br>'
            + '如果某项标黄/标红又不知道怎么处理，把这个结果截图发出来即可。<br>'
            + '详细排查步骤见程序目录里的 <code>docs\\维护手册.md</code>。</div>';
          var v = document.getElementById('__scan_view');
          if (v) v.innerHTML = html;
          toast(d.rank === 'bad' ? '体检发现需要处理的问题' : (d.rank === 'warn' ? '体检完成，有几项要留意' : '体检完成，一切正常'));
        })
        .catch(function (e) { btn.textContent = '体检'; toast('体检失败：' + e.message + '（监控进程可能没在运行）'); });
    };
    el.querySelector('#__scan_readall').onclick = function () {
      fetch('/__scan/read', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ all:true }) })
        .then(function(){ toast('已全部标记为看过'); loadHits(); })
        .catch(function(e){ toast('失败:'+e.message); });
    };
    el.querySelector('#__scan_reload').onclick = function () { tab === 'list' ? loadHits() : openFilter(); };
    /* 【启动待命 2026-11-04】一个按钮两种状态：待命中→开始；扫描中→暂停。
       暂停不关浏览器、不退出进程，只是不再发请求，所以随时能无缝继续。 */
    el.querySelector('#__scan_hold').onclick = function () {
      var btn = this;
      var want = (btn.getAttribute('data-hold') === '1');  /* 当前是不是待命中 → 点了就是开始 */
      var url = want ? '/__scan/resume' : '/__scan/hold';
      btn.disabled = true;
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          btn.disabled = false;
          if (d && d.ok) {
            /* 连点保护：刚扫过就点开始，服务端会顺延，这里把还要等多久告诉用户 */
            if (want) {
              var wsec = Number((d && d.waitSec) || 0);
              toast(wsec > 0 ? ('已开始监控 · 刚扫过一轮，' + wsec + ' 秒后才跑第一轮') : '已开始监控');
            } else { toast('已暂停扫描'); }
            loadHits();
          }
          else { toast('操作失败：' + ((d && d.error) || '未知原因')); }
        })
        .catch(function (e) { btn.disabled = false; toast('操作失败：' + e.message + '（监控进程可能没在运行）'); });
    };
    el.querySelectorAll('.tab').forEach(function (t) {
      t.onclick = function () { tab = t.getAttribute('data-tab'); switchTab(); };
    });
    /* 「⋯」更多菜单：点开 / 点外面收起 / 点菜单项后收起 */
    var moreWrap = el.querySelector('#__scan_morewrap');
    var moreBtn = el.querySelector('#__scan_more');
    if (moreWrap && moreBtn) {
      moreBtn.onclick = function (e) {
        e.stopPropagation();
        moreWrap.className = moreWrap.className.indexOf('open') >= 0 ? 'moremenu' : 'moremenu open';
      };
      var morePop = el.querySelector('#__scan_morepop');
      if (morePop) morePop.addEventListener('click', function () { setTimeout(function () { moreWrap.className = 'moremenu'; }, 0); });
      document.addEventListener('mousedown', function (e) {
        if (moreWrap.className.indexOf('open') < 0) return;
        var t = e.target;
        while (t && t !== moreWrap) t = t.parentNode;
        if (t !== moreWrap) moreWrap.className = 'moremenu';
      });
    }
    return el;
  }
  function switchTab() {
    var el = document.getElementById(PANEL_ID);
    el.querySelectorAll('.tab').forEach(function (t) { t.className = 'tab' + (t.getAttribute('data-tab') === tab ? ' on' : ''); });
    var lb = document.getElementById('__scan_listbar');
    if (lb) lb.style.display = (tab === 'list') ? 'flex' : 'none';
    var ft = document.getElementById('__scan_foot');
    if (ft) ft.style.display = (tab === 'list') ? 'block' : 'none';
    if (tab === 'list') loadHits(); else openFilter();
  }
  /* 登录横幅开关与文案。
     data 来自 /__scan/hits.json 的 fresh：
       loginBad   —— 服务端已明确判定登录失效（unb 缺失 或 havana 会话标记 <2）
       loginUnb   —— 当前 unb 的值，null = 没有
       loginStrong—— havana 会话标记命中数（满分 5）
     判断只用这三个字段，不去解析 note/degradedWhy 的字符串 ——
     文案一改横幅就失灵，这是不能接受的耦合。
     同时兼容旧服务端（没有 loginBad 字段时退回用 loginUnb 推断）。 */
  function updateLoginBar(fx) {
    var bar = document.getElementById('__scan_loginbar');
    if (!bar) return;
    fx = fx || {};
    var bad;
    if (typeof fx.loginBad === 'boolean') bad = fx.loginBad;
    else bad = !fx.loginUnb;                      /* 旧服务端的兜底判断 */
    if (!bad) { bar.style.display = 'none'; return; }
    var txt = document.getElementById('__scan_loginbar_txt');
    if (txt) {
      var detail = [];
      /* 【2026-11-04】原来看的是 "havana 会话标记 <2"，那也是错的判据 ——
         这个账号根本没有 havana 系 cookie，真凭证是 sgcookie + tfstk。
         现在服务端会把缺什么直接写在 loginWhy 里，这里照抄即可，不再自己猜。 */
      if (fx.loginWhy) detail.push('<b>' + esc(String(fx.loginWhy)) + '</b>');
      else if (!fx.loginUnb) detail.push('登录身份 cookie（<b>unb</b>）已丢失');
      if (fx.newestAgoMinutes != null) detail.push('现在接口能拿到的最新一条是 <b>' + minsText(fx.newestAgoMinutes) + '</b>');
      txt.innerHTML = (detail.length ? detail.join('，') + '。' : '')
        + '闲鱼现在把本程序当成了<b>游客</b>，只会返回几小时前的旧货源 —— 列表里这些是历史记录，<b>不会再有新货进来</b>。'
        + '重新扫码登录一次即可恢复。';
    }
    bar.style.display = 'block';
  }

  /* ---------- 常驻登录状态（标题行那个小圆点徽标）----------
     数据来自服务端每轮体检写的 fresh.login（昵称 / unb 剩几天 / 签名 token 剩几小时）。
     三档：
       绿 ok   —— 已登录，且 unb 还剩 1 天以上
       黄 warn —— 已登录，但 unb 或 _m_h5_tk 快到期了（< 1 天）
       红 bad —— 已失效（loginBad=true），必须重新登录
     ★ 这个徽标和下面的红色横幅是"两个层级"：
       徽标始终在（随时知道状态），横幅只在失效时弹（必须动手）。 */
  function updateLoginBadge(fx) {
    var box = document.getElementById('__scan_lgn');
    var txt = document.getElementById('__scan_lgn_txt');
    var btn = document.getElementById('__scan_lgn_btn');
    if (!box || !txt) return;
    fx = fx || {};
    var lg = fx.login || {};
    var bad = (typeof fx.loginBad === 'boolean') ? fx.loginBad : !fx.loginUnb;
    /* 【2026-11-04】warn 档：登录凭证齐全、只是会话级 cookie 暂时没回来（刚开浏览器常见）。
       这种情况服务端 loginLevel==='warn'，以前面板会直接显示成 ok，看不出区别。 */
    var lvl = String(fx.loginLevel || '');
    var softWarn = (!bad && lvl === 'warn');
    var parts = [];
    /* 昵称来自 cookie 里的 loginId，理论上是 t**9 这种，但一律转义后再拼 HTML */
    var nick = lg.nick ? esc(String(lg.nick)) : '';

    if (bad) {
      box.className = 'lgn bad';
      parts.push('未登录');
      if (nick) parts.push('(' + nick + ' 已掉线)');
      else parts.push('(' + (fx.loginUnb ? '会话不完整' : '没有登录身份') + ')');
      if (btn) { btn.className = 'lgn-btn bad'; btn.textContent = '重新扫码登录'; }
    } else {
      var unbDays = (typeof lg.unbDays === 'number') ? lg.unbDays : null;
      var tkH = (typeof lg.tokenHours === 'number') ? lg.tokenHours : null;
      /* 【2026-11-04】不再用 token(<2h) 触发黄灯：_m_h5_tk 每轮自动续期、寿命只有几十分钟，
         拿它当"快过期"的依据会让徽标常年发黄、按钮常年写"登录快过期，换一个"，
         反而诱导用户去重扫（重扫更容易被平台盯上）。token 只放 tooltip。 */
      var near = (unbDays != null && unbDays < 1) || softWarn;
      box.className = 'lgn ' + (near ? 'warn' : 'ok');
      parts.push(nick ? nick : '已登录');
      parts.push('<span class="sep">·</span>');
      parts.push('unb ' + (unbDays == null ? '会话级' : (unbDays >= 1 ? (unbDays + ' 天') : (Math.round(unbDays * 24) + ' 小时'))));
      if (tkH != null) {
        parts.push('<span class="sep">·</span>');
        parts.push('token ' + (tkH >= 1 ? (tkH + ' 小时') : (Math.round(tkH * 60) + ' 分')));
      }
      if (btn) {
        btn.className = 'lgn-btn';
        btn.textContent = softWarn ? '会话补全中…' : (near ? '登录快过期，换一个' : '登录 / 换号');
      }
    }
    txt.innerHTML = parts.join(' ');
    /* 到期时间作为 tooltip 兜底，鼠标停一下能看到完整信息 */
    var tips = [];
    if (lg.at) tips.push('更新时间：' + String(lg.at).replace('T', ' ').slice(0, 19));
    /* 【2026-11-04】havana 系 cookie 这个账号根本不存在，别显示它。真凭证是 sgcookie / tfstk */
    if (lg.tokenHours != null) tips.push('签名 token（_m_h5_tk）还剩 ' + (lg.tokenHours >= 1 ? (lg.tokenHours + ' 小时') : (Math.round(lg.tokenHours * 60) + ' 分')) + '（每轮自动续期，短属正常）');
    if (lg.unbDays != null) tips.push('登录身份 cookie（unb）还剩 ' + (lg.unbDays >= 1 ? (lg.unbDays + ' 天') : (Math.round(lg.unbDays * 24) + ' 小时')));
    if (lg.sgcookieDays != null) tips.push('sgcookie（登录主凭证）还剩 ' + lg.sgcookieDays + ' 天');
    else tips.push('sgcookie（登录主凭证）不在 —— 会被当游客，只能拿到旧货');
    if (lg.tfstkDays != null) tips.push('tfstk（风控令牌）还剩 ' + lg.tfstkDays + ' 天');
    if (lg.sessionCookies != null) tips.push('会话级 cookie 现有 ' + lg.sessionCookies + ' 条');
    if (lg.total) tips.push('浏览器里共 ' + lg.total + ' 条 cookie（其中 ' + (lg.sessionCookies || 0) + ' 条是会话级）');
    box.title = tips.join('\n');
  }

  /* ---------- 商贩自动屏蔽（顶部条 + 勾选名单）----------
     数据来自 monitor 每轮算的 fresh.sellerSuspects（最近 N 天该卖家出现 ≥ 阈值条）。
     这里只负责"确认"：勾哪些、点屏蔽。真正落库在 /__scan/sellerblock。
     用昵称兜底提交时，key 形如 'nick:xxx'，monitor 侧同样按昵称匹配。 */
  /* 【折叠状态 2026-11-03】
     两个键：sbopen 记住用户上次是展开还是收起；sbseen 记住上次见过的候选 ID 集合。
     有新候选（sbseen 里没有的 ID）时才自动展开一次并标「新增 N」——
     这是「折叠会不会让我漏掉新商贩」这个疑虑的答案：不会，有人新冒出来它会自己弹开。 */
  var SB_OPEN_KEY = '__scan_sbopen', SB_SEEN_KEY = '__scan_sbseen';
  function sbLSGet(k, d) { try { var v = window.localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function sbLSSet(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  function sellerBlockPost(ids, names) {
    var block = ids.map(function (id, i) {
      return { sellerId: id, name: (names && names[i]) || '', rate: '', deals: 0 };
    });
    return fetch('/__scan/sellerblock', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ block: block }) })
      .then(function (r) { return r.json(); });
  }
  function wireSellerBar() {
    var bar = document.getElementById('__scan_sellerbar');
    if (!bar) return;
    var btnAll = document.getElementById('__scan_sb_all');
    var btnNone = document.getElementById('__scan_sb_none');
    var btnGo = document.getElementById('__scan_sb_go');
    var btnManage = document.getElementById('__scan_sb_manage');
    wireLookBtns(bar);
    /* 【折叠头】点整行展开/收起，并把状态写进 localStorage —— 刷新后保持你上次的选择。 */
    var sbHead = bar.querySelector('.sb-head[data-toggle="1"]');
    if (sbHead) sbHead.onclick = function () {
      var open = !bar.classList.contains('open');
      if (open) bar.classList.add('open'); else bar.classList.remove('open');
      sbLSSet(SB_OPEN_KEY, open ? 1 : 0);
      var ch = bar.querySelector('.sb-chev');
      if (ch) ch.textContent = open ? '▴' : '▾';
      sbHead.setAttribute('title', '点一下' + (open ? '收起' : '展开') + '疑似商贩清单');
    };
    /* 【按昵称筛选】只藏不该看的行，不动勾选状态；全选/全不选也只作用于看得见的那些，
       否则「筛着筛着点了全选」会把筛掉的一起勾上，屏蔽时才发现多删了。 */
    var sbQ = bar.querySelector('.sb-q');
    if (sbQ) sbQ.oninput = function () {
      var q = String(sbQ.value || '').trim().toLowerCase();
      var n = 0;
      bar.querySelectorAll('.sb-list .sb-item').forEach(function (it) {
        var nm = String(it.getAttribute('data-sbnm') || '').toLowerCase();
        var hit = !q || nm.indexOf(q) >= 0;
        if (hit) { it.classList.remove('hide'); n++; } else { it.classList.add('hide'); }
      });
      var cnt = bar.querySelector('.sb-qcnt');
      if (cnt) cnt.textContent = q ? ('匹配 ' + n + ' 个') : '';
    };
    var sbVisible = function (c) { var it = c.closest('.sb-item'); return !it || !it.classList.contains('hide'); };
    if (btnAll) btnAll.onclick = function () { bar.querySelectorAll('.sb-list input[type=checkbox]').forEach(function (c) { if (sbVisible(c)) c.checked = true; }); };
    if (btnNone) btnNone.onclick = function () { bar.querySelectorAll('.sb-list input[type=checkbox]').forEach(function (c) { if (sbVisible(c)) c.checked = false; }); };
    if (btnManage) btnManage.onclick = function () {
      fetch('/__scan/sellerblock?t=' + Date.now()).then(function (r) { return r.json(); }).then(function (j) {
        var list = (j && j.blocked) || [];
        if (!list.length) { toast('当前没有已屏蔽的卖家'); return; }
        var rows = list.map(function (s) {
          return '<label class="sb-item"><input type="checkbox" value="' + esc(s.sellerId) + '" data-name="' + esc(s.name || '') + '">'
            + '<span class="sb-nm">' + esc(s.name || ('卖家 ' + String(s.sellerId).slice(0, 6))) + '</span>'
            + (((Number(s.deals) || 0) > 0 && s.rate) ? '<span class="sb-rt">' + esc(s.rate) + '</span>' : '')
            + (((Number(s.deals) || 0) > 0) ? '<span class="sb-dl">' + Number(s.deals) + ' 评价</span>' : '')
            /* 已经屏蔽错了也能先看一眼再决定放不放出来 */
            + (s.sellerId ? '<button type="button" class="sb-look" data-look="' + esc(s.sellerId) + '" data-lookname="' + esc(s.name || '') + '">看主页</button>' : '')
            + '</label>';
        }).join('');
        var box = document.getElementById('__scan_view');
        if (!box) return;
        box.innerHTML = '<div class="sellerbar sbm" style="position:static;box-shadow:none;max-width:none">'
          + '<div class="sb-h">已屏蔽 ' + list.length + ' 个卖家</div>'
          + '<div class="sb-s">勾选想放出来的，点下面的按钮解除（解除后当初撤掉的商品会原样回到列表）</div>'
          + '<div class="sb-list">' + rows + '</div>'
          + '<div class="sb-act"><button class="sb-btn" id="__scan_sb_un_all">全选</button>'
          + '<button class="sb-btn" id="__scan_sb_un_none">全不选</button>'
          + '<button class="sb-btn sb-ok" id="__scan_sb_un">解除勾选的</button>'
          + '<button class="sb-btn" id="__scan_sb_back">返回列表</button>'
          + '<span class="sb-blocked" id="__scan_sb_un_cnt"></span></div></div>';
        /* 全选 / 全不选（只作用于这一份已屏蔽名单，不影响上面「商贩候选」那栏的勾选）。
           一次全勾 = 一次放回上百条货（132 个卖家合计 605 条 hidden），
           所以旁边实时显示「已勾选 N / 总数」，点「解除勾选的」之前能看清到底要放多少。 */
        var unBoxes = function () { return box.querySelectorAll('.sb-list input[type=checkbox]'); };
        var unCnt = document.getElementById('__scan_sb_un_cnt');
        var unRefresh = function () {
          var n = 0;
          unBoxes().forEach(function (c) { if (c.checked) n++; });
          if (unCnt) unCnt.textContent = n ? ('已勾选 ' + n + ' / ' + list.length) : ('共 ' + list.length + ' 个，未勾选');
        };
        unBoxes().forEach(function (c) { c.onchange = unRefresh; });
        unRefresh();
        var btnUnAll = document.getElementById('__scan_sb_un_all');
        var btnUnNone = document.getElementById('__scan_sb_un_none');
        if (btnUnAll) btnUnAll.onclick = function () { unBoxes().forEach(function (c) { c.checked = true; }); unRefresh(); };
        if (btnUnNone) btnUnNone.onclick = function () { unBoxes().forEach(function (c) { c.checked = false; }); unRefresh(); };
        document.getElementById('__scan_sb_un').onclick = function () {
          var picked = [];
          box.querySelectorAll('.sb-list input[type=checkbox]:checked').forEach(function (c) { picked.push(c.value); });
          if (!picked.length) { toast('先勾选要解除的卖家'); return; }
          /* 勾得多的时候先问一句 —— 全选一键解除等于一次放回几百条货，
             手滑点错的话列表会被瞬间冲满，恢复起来很烦。5 个以内不问，直接解。 */
          if (picked.length > 5 && !confirm('要解除 ' + picked.length + ' 个卖家的屏蔽？\n\n'
              + '当初被撤掉的商品会原样回到列表，商品多的话列表会一下子变很长。\n'
              + '如果只是想找回几个疑似误伤的，建议先「全不选」，再逐个勾。')) return;
          var btnUn = document.getElementById('__scan_sb_un');
          if (btnUn) { btnUn.disabled = true; btnUn.textContent = '解除中…'; }
          fetch('/__scan/sellerblock', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ unblock: picked }) })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (j && j.ok) {
                var msg = '已解除 ' + (j.removed || 0) + ' 个卖家';
                if (j.restored) msg += '，放回 ' + j.restored + ' 条商品';
                if (j.keptBack) msg += '（列表已满，' + j.keptBack + ' 条留在名单里下次再放）';
                toast(msg);
              } else { toast('解除失败'); }
              loadHits();
            })
            .catch(function (e) {
              if (btnUn) { btnUn.disabled = false; btnUn.textContent = '解除勾选的'; }
              toast('解除失败：' + e.message);
            });
        };
        document.getElementById('__scan_sb_back').onclick = function () { loadHits(); };
        /* 已屏蔽名单里也有「看主页」—— 屏蔽错了要先看一眼才好决定放不放 */
        wireLookBtns(box);
      }).catch(function (e) { toast('读取名单失败：' + e.message); });
    };
    if (btnGo) btnGo.onclick = function () {
      var picked = [], names = [];
      bar.querySelectorAll('.sb-list input[type=checkbox]:checked').forEach(function (c) {
        picked.push(c.value); names.push(c.getAttribute('data-name') || '');
      });
      if (!picked.length) { toast('先勾选要屏蔽的卖家'); return; }
      btnGo.disabled = true; btnGo.textContent = '屏蔽中…';
      sellerBlockPost(picked, names).then(function (j) {
        btnGo.disabled = false;
        if (j && j.ok) toast('已屏蔽 ' + (j.added || 0) + ' 个卖家，撤掉 ' + (j.dropped || 0) + ' 条历史记录');
        else toast('屏蔽失败');
        loadHits();
      }).catch(function (e) { btnGo.disabled = false; toast('屏蔽失败：' + e.message); });
    };
  }
  /* ---------- 卖家主页预览（「看主页」）----------
     为什么要有：第三路信号是"主页 ≥ 40 件在售 或 简介像商家"自动判的，
     只看数字就屏蔽容易误伤（有人搬家清仓也会挂几十件）。
     所以给一个按钮，把「这个号到底在卖什么」摊开给用户看。

     数据来源是程序自己已经抓到的货（/__scan/sellerpage 返回 JSON），
     不去访问闲鱼 —— 直接开卖家主页必弹 baxia 滑块验证，替用户拖滑块等于拿账号去赌。
     好处：零风控、零等待、点开立刻能看；局限：只包含"进过你筛选条件"的那部分，
     看完整主页要点标题栏的「在闲鱼打开」（那时是你自己浏览器，你自己过滑块）。 */
  function spEnsureBox() {
    var box = document.getElementById('__scan_spm');
    if (box) return box;
    /* 背景遮罩：不加的话弹层周围还是商品列表，看着乱、也容易点错后面的按钮 */
    var bg = document.createElement('div');
    bg.id = '__scan_spm_bg';
    document.body.appendChild(bg);
    box = document.createElement('div');
    box.id = '__scan_spm';
    box.innerHTML = '<div class="sp-h"><div class="t" id="__scan_spm_t">卖家</div>'
      + '<div class="m" id="__scan_spm_m"></div>'
      + '<button id="__scan_spm_go">在闲鱼打开</button>'
      + '<button id="__scan_spm_x">关闭</button></div>'
      + '<div class="sp-b" id="__scan_spm_b"></div>'
      + '<div class="sp-tip">这里列的是<b>本程序抓到过的</b>这个卖家的商品（他可能还有更多没进你的筛选条件）。'
      + '判断方法：一堆同型号、价格成阶梯、标题模板化 → 商贩；只有一两件、什么都有点、像家里清出来的 → 个人。'
      + '看错了可以在「查看/解除屏蔽名单」里放出来，记录会原样恢复。</div>';
    document.body.appendChild(box);
    var bgl = document.getElementById('__scan_spm_bg');
    var closeAll = function () { box.classList.remove('on'); if (bgl) bgl.classList.remove('on'); };
    box.querySelector('#__scan_spm_x').onclick = closeAll;
    if (bgl) bgl.onclick = closeAll;
    box.__close = closeAll;
    return box;
  }
  function spTime(ts) {
    var t = Number(ts);
    if (!isFinite(t) || t <= 0) return '';
    var d = new Date(t);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function spOpen(sid, name) {
    var box = spEnsureBox();
    var tEl = box.querySelector('#__scan_spm_t');
    var mEl = box.querySelector('#__scan_spm_m');
    var bEl = box.querySelector('#__scan_spm_b');
    var goEl = box.querySelector('#__scan_spm_go');
    tEl.textContent = name || ('卖家 ' + String(sid || '').slice(0, 10));
    mEl.textContent = '';
    box.classList.add('on');
    var bgl = document.getElementById('__scan_spm_bg');
    if (bgl) bgl.classList.add('on');
    bEl.className = 'sp-b';
    bEl.innerHTML = '<div class="sp-load"><div class="sp-sp"></div><div>正在整理这个卖家的商品…</div></div>';
    /* 在闲鱼打开：直链，用户自己浏览器里过滑块，能看到完整主页 */
    goEl.onclick = function () {
      var u = sid ? ('https://www.goofish.com/personal?userId=' + encodeURIComponent(sid))
        : ('https://www.goofish.com/search?q=' + encodeURIComponent(name || ''));
      window.open(u, '_blank', 'noopener');
    };
    var q = '/__scan/sellerpage?t=' + Date.now()
      + (sid ? ('&sid=' + encodeURIComponent(sid)) : '')
      + (name ? ('&name=' + encodeURIComponent(name)) : '');
    fetch(q).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '取不到这个卖家的数据');
      var shop = d.shop || null;
      var h = [];
      /* --- 头部统计 --- */
      h.push('<div class="sp-sum">');
      if (shop && shop.items != null) h.push('<span class="k">主页在售</span><b>' + shop.items + ' 件</b>');
      else h.push('<span class="k">主页在售</span><b class="na">还没抓到</b>');
      h.push('<span class="k">我们抓到</span><b>' + (d.count || 0) + ' 条</b>');
      if (d.priceMin != null) h.push('<span class="k">价格区间</span><b>¥' + d.priceMin + ' – ¥' + d.priceMax + '</b>');
      if (shop && shop.rates != null) h.push('<span class="k">评价</span><b>' + shop.rates + ' 条</b>');
      if (shop && shop.lvl) h.push('<span class="k">等级</span><b>' + esc(String(shop.lvl)) + '</b>');
      if (shop && shop.bq === 'licensedOperation') h.push('<span class="tag-warn">持证经营</span>');
      if (d.blocked) h.push('<span class="tag-bad">已在屏蔽名单</span>');
      h.push('</div>');
      /* --- 简介 --- */
      if (shop && shop.intro) {
        h.push('<div class="sp-intro"><span class="k">卖家简介</span>' + esc(shop.intro) + '</div>');
      }
      /* --- 商品卡片墙 --- */
      var list = d.items || [];
      if (!list.length) {
        h.push('<div class="sp-err">这个卖家的商品，一条都没进过你的筛选条件。<br>'
          + '所以看不到内容 —— 点上方的「在闲鱼打开」用自己浏览器看完整主页。</div>');
      } else {
        h.push('<div class="sp-grid">');
        list.forEach(function (x) {
          var url = x.url || (x.itemId ? ('https://www.goofish.com/item?id=' + encodeURIComponent(x.itemId)) : '');
          h.push('<a class="sp-card" href="' + esc(url) + '" target="_blank" rel="noopener">'
            + '<div class="ph">' + (x.pic ? '<img loading="lazy" src="' + esc(x.pic) + '" alt="">' : '') + '</div>'
            + '<div class="tt" title="' + esc(x.title || '') + '">' + esc(x.title || '') + '</div>'
            + '<div class="pp"><b>' + esc(x.priceText || (x.price != null ? ('¥' + x.price) : '面议')) + '</b>'
            + (x.area ? '<span class="ar">' + esc(x.area) + '</span>' : '') + '</div>'
            + '<div class="tm">' + spTime(x.publishTime) + '</div></a>');
        });
        h.push('</div>');
        if ((d.count || 0) > list.length) {
          h.push('<div class="sp-more">只显示最新 ' + list.length + ' 条，共 ' + d.count + ' 条</div>');
        }
      }
      bEl.className = 'sp-b';
      bEl.innerHTML = h.join('');
      mEl.textContent = (d.count || 0) + ' 条';
    }).catch(function (e) {
      bEl.className = 'sp-b';
      bEl.innerHTML = '<div class="sp-err">取不到数据：' + esc(String(e && e.message || e)) + '<br><br>'
        + '这多半是监控进程刚重启还没准备好，稍等再点一次。<br>'
        + '也可以点上面的「在闲鱼打开」用自己浏览器直接看。</div>';
    });
  }
  function wireLookBtns(root) {
    (root || document).querySelectorAll('.sb-look').forEach(function (b) {
      if (b.__wired) return; b.__wired = 1;
      b.onclick = function (e) {
        /* 按钮在 label 里，不拦冒泡会顺手把勾选框切换掉（用户只是想看一眼，不想改勾选） */
        if (e) { e.preventDefault(); e.stopPropagation(); }
        spOpen(b.getAttribute('data-look'), b.getAttribute('data-lookname') || '');
        return false;
      };
      /* mousedown 也得拦：label 的勾选是 mousedown/click 阶段转发到 input 的 */
      b.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    });
  }
  function toast(msg) {    var t = document.getElementById('__scan_toast');
    if (!t) return;
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t.__tm); t.__tm = setTimeout(function () { t.style.display = 'none'; }, 2200);
  }
  function openPanel() {
    var el = buildPanel(); el.style.display = 'block'; setActive(true);
    if (!catalog) fetch('/__scan/catalog').then(function (r) { return r.json(); }).then(function (d) { catalog = d; if (tab === 'filter') openFilter(); });
    if (tab === 'list') loadHits(); else openFilter();
  }
  function closePanel() { var el = document.getElementById(PANEL_ID); if (el) el.style.display = 'none'; setActive(false); }

  /* ---------- 命中列表 ---------- */
  var RECENT_LIMIT = 50;
  var readAtOf = function (x) {
    var t = Number(x.readAt);
    if (isFinite(t) && t > 0) return t;
    var f = Date.parse(x.foundAt);          /* 老记录没有 readAt，用采集时间兜底 */
    return isFinite(f) ? f : 0;
  };
  var scopeLabel = function (all, unread, readed) {
    if (scopeMode === 'unread') return '没看过的 (' + unread.length + ')';
    if (scopeMode === 'recent') return '最近看过 (' + readed.length + ')';
    return '显示全部 (' + all.length + ')';
  };
  /* 误点保护：标记看过之后给 8 秒撤销窗口 */
  var undoState = null;
  function showUndo(item) {
    var bar = document.getElementById('__scan_undo');
    var txt = document.getElementById('__scan_undo_txt');
    var btn = document.getElementById('__scan_undo_btn');
    if (!bar || !txt || !btn) return;
    undoState = { itemId: item.itemId, at: Date.now() };
    txt.textContent = '已移除：' + String(item.title || '').slice(0, 22) + '…（8 秒内可撤销）';
    bar.style.display = 'block';
    if (bar.__tm) clearTimeout(bar.__tm);
    bar.__tm = setTimeout(function () { hideUndo(); }, 8000);
    btn.onclick = function () {
      var st = undoState; hideUndo();
      if (!st) return;
      fetch('/__scan/unhide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId: st.itemId }) })
        .then(function (r) { return r.json(); })
        .then(function (j) { toast(j && j.ok ? '已恢复到列表' : '恢复失败'); loadHits(); })
        .catch(function (e) { toast('恢复失败：' + e.message); });
    };
  }
  function hideUndo() {
    var bar = document.getElementById('__scan_undo');
    if (bar) { bar.style.display = 'none'; if (bar.__tm) clearTimeout(bar.__tm); }
    undoState = null;
  }
  /* ---------- 关于（署名 / 版本 / 协议 / 免责） ----------
     数据来源：/__scan/hits.json 返回的 about 字段（monitor.cjs 里写死的版本与作者常量）。
     取不到时给空字符串兜底，弹窗照常能开，不因为缺字段就报错。 */
  var aboutInfo = null;
  function showAbout() {
    var host = document.getElementById(PANEL_ID); if (!host) return;
    if (host.querySelector(".about-mask")) return;
    var ab = aboutInfo || {};
    var m = document.createElement("div"); m.className = "about-mask";
    m.innerHTML = '<div class="about">'
      + '<h3>闲鱼扫货监控</h3>'
      + '<div class="ver">' + esc("v" + (ab.version || "-") + (ab.builtAt ? " · 构建于 " + fmt(ab.builtAt) : "")) + '</div>'
      + '<div class="arow"><div class="ak">作者</div><div class="av">' + esc(ab.author || "-") + '</div></div>'
      + '<div class="arow"><div class="ak">说明</div><div class="av">只读闲鱼公开在售信息，用于个人选品比价；已内置限速，不代替你下单、不操作你的账号。</div></div>'
      + '<div class="arow"><div class="ak">协议</div><div class="av">MIT License（保留版权与作者署名）</div></div>'
      + '<div class="note">本程序与闲鱼官方无关。请遵守平台使用规则，账号使用风险自负。</div>'
      + '<div style="margin-top:16px;text-align:right"><button class="btn p" data-about-close>知道了</button></div>'
      + '</div>';
    host.appendChild(m);
    var closeBtn = m.querySelector("[data-about-close]");
    if (closeBtn) closeBtn.onclick = function () { m.remove(); };
    m.onclick = function (e) { if (e.target === m) m.remove(); };
  }

  function loadHits() {
    var v = document.getElementById('__scan_view'); if (!v) return;
    v.innerHTML = '<div style="color:#8e8e93;font-size:13px;padding:20px 0">加载中...</div>';
    fetch('/__scan/hits.json?t=' + Date.now()).then(function (r) { return r.json(); }).then(function (d) {
      var all = (d && d.items) || [];
      /* 「标记看过」= hidden，直接从列表里拿掉（点开链接只置灰 read，不 hidden）。 */
      all = all.filter(function (x) { return !x.hidden; });
      /* 【时间档位】按发布时间过滤，timeWin=0 表示不限。
         拿不到 publishAt 的记录不猜（宁可漏掉也不乱显示），和「新」标签用同一个口径 parsePublishAt。 */
      if (timeWin > 0) {
        var cutTw = Date.now() - timeWin * 3600000;
        all = all.filter(function (x) { var t = parsePublishAt(x.publishAt); return isFinite(t) && t >= cutTw; });
      }
      var unread = all.filter(function (x) { return !x.read; });
      var readed = all.filter(function (x) { return !!x.read; })
        .sort(function (a, b) { return readAtOf(b) - readAtOf(a); });
      /* 【原地置灰】点开只置灰、不重排：默认「全部」视图保持采集顺序，已读的原地变灰；
         「没看过」只列未读，「最近看过」按已读时间倒序（这两个视图才需要重排）。 */
      var items = scopeMode === 'unread' ? unread : (scopeMode === 'recent' ? readed.slice(0, RECENT_LIMIT) : all);
      var scopeBtn = document.getElementById('__scan_scope');
      if (scopeBtn) scopeBtn.textContent = scopeLabel(all, unread, readed);
      /* 计数行：开了「最近24小时」就在后面缀一个说明，避免用户以为总数变了 */
      var cntTxt = scopeMode === 'unread'
        ? '没看过的 ' + unread.length + ' 条' + (readed.length ? '（看过 ' + readed.length + '）' : '')
        : scopeMode === 'recent'
          ? '最近看过的 ' + items.length + ' 条（共看过 ' + readed.length + ' 条）'
          : '全部 ' + all.length + ' 条（看过 ' + readed.length + ' 条）';
      if (timeWin > 0) cntTxt += ' · 只看最近' + twLabelOf(timeWin) + '发布的';
      document.getElementById('__scan_count').textContent = cntTxt;
      /* 【署名 2026-11-03】副标题左边的「v1.0.0 · by Wethon」，点一下开「关于」。
         放在这一句后面是因为它俩都在「一次渲染」的同一段里，不用另开请求。 */
      aboutInfo = (d && d.about) || aboutInfo;
      var brandEl = document.getElementById('__scan_brand');
      if (brandEl && aboutInfo) {
        brandEl.textContent = 'v' + (aboutInfo.version || '-') + ' · by ' + (aboutInfo.author || '-');
        brandEl.onclick = showAbout;
      }
      /* 【启动待命 2026-11-04】把 hold 状态渲染出来：按钮文案 + 顶部横幅 + 时间钟。
         用户最关心的是"它到底有没有在用我的账号翻页"，所以待命时把这句话写在最显眼处。 */
      var hold = (d && d.hold) || {};
      var holdOn = !!hold.on;
      var holdMin = (holdOn && hold.since) ? Math.max(0, Math.round((Date.now() - hold.since) / 60000)) : 0;
      var hb = document.getElementById('__scan_hold');
      if (hb) {
        hb.setAttribute('data-hold', holdOn ? '1' : '0');
        hb.textContent = holdOn ? '▶ 开始监控' : '⏸ 暂停扫描';   /* 待命中→邀请点开始；扫描中→点它暂停 */
        hb.className = 'btn' + (holdOn ? ' on' : '');
        hb.title = holdOn
          ? '点一下开始扫描（登录态已就绪，立刻生效）'
          : '点一下暂停：不发任何搜索请求，但程序仍在运行、登录态保持';
      }
      var hbar = document.getElementById('__scan_holdbar');
      var htxt = document.getElementById('__scan_hold_txt');
      if (hbar && htxt) {
        if (holdOn) {
          hbar.style.display = 'block';
          htxt.innerHTML = '⏸ <b>待命中</b> · 浏览器和登录态已就绪，本次启动还<b>没有发出任何搜索请求</b>'
            + (holdMin ? '（已待命 ' + holdMin + ' 分钟）' : '')
            + '<button class="hb-btn" id="__scan_hold_go">▶ 现在开始监控</button>';
          var go = document.getElementById('__scan_hold_go');
          if (go) go.onclick = function () { document.getElementById('__scan_hold').onclick.call(document.getElementById('__scan_hold')); };
        } else if (hold.resumedAt) {
          hbar.style.display = 'block';
          hbar.style.background = 'rgba(52,199,89,.10)';
          hbar.style.borderColor = 'rgba(52,199,89,.32)';
          htxt.innerHTML = '▶ <b>正在扫描</b> · 本次启动已于 ' + hmsText(new Date(hold.resumedAt).toISOString()).hm + ' 开始，点右上角「⏸ 暂停扫描」可随时停下';
        } else {
          hbar.style.display = 'none';
        }
      }
      /* 远程停用公告：服务端在 hits.json 里回 remote（{status,title,detail,updatedAt}），
         down/notice 时弹红条，其余情况隐藏。 */
      var remote = (d && d.remote) || {};
      var rb = document.getElementById('__scan_remotebar');
      if (rb) {
        if (remote.status === 'down' || remote.status === 'notice') {
          rb.style.display = 'block';
          rb.className = 'remotebar' + (remote.status === 'down' ? ' bad' : '');
          var rt = document.getElementById('__scan_remote_title');
          var rx = document.getElementById('__scan_remote_txt');
          if (rt) rt.textContent = remote.status === 'down' ? '程序已暂停（开发者公告）' : (remote.title || '开发者公告');
          if (rx) rx.textContent = (remote.detail || '') + (remote.updatedAt ? ('（更新于 ' + remote.updatedAt + '）') : '');
        } else {
          rb.style.display = 'none';
        }
      }
      clockState.hold = holdOn;
      clockState.holdMin = holdMin;
      var sub = '更新于 ' + fmt(d.updatedAt) + ' · 每 ' + (d.interval || '-') + ' 秒扫一次';
      var fx = (d && d.fresh) || {};
      /* 给时间钟喂数据：上次刷新 / 距下次刷新 */
      clockState.last = isNaN(Date.parse(d.updatedAt)) ? new Date() : new Date(d.updatedAt);
      clockState.next = d.nextScanAt && !isNaN(Date.parse(d.nextScanAt)) ? new Date(d.nextScanAt) : null;
      startClock();
      /* 【两个口径必须分开显示】以前只有一个「接口最新一条」，那是「翻到的池子里最新」，
         里面混着被条件挡掉的 64G/128G、AirPods、iPad、游戏道具。
         用户看到「接口最新 12 分钟前」而商品列表停在 3 小时前，只会认为程序坏了。
         现在：接口最新（含被挡的） + 合格品最新（真正符合条件的那种货多久没上新）。 */
      if (fx.newestAgoMinutes != null) sub += ' · 接口最新一条：' + minsText(fx.newestAgoMinutes);
      /* 只在「本轮确实翻到过货、且一条都没过条件」时才敢说"全被挡掉了"。
         被限流 / 第 1 页就失败时 raw 为 0，那是错误，不能说成过滤结果 ——
         用户会去调筛选条件，方向完全反了。 */
      var hadPool = (fx.perTask || []).some(function (t) { return !t.error && t.raw > 0; });
      if (fx.passedNone && hadPool) {
        sub += ' · <span style="color:#ff3b30;font-weight:600">合格品一条都没有 —— 翻到的货全被条件挡掉了（不是接口没更新，看下面的过滤明细）</span>';
      } else if (fx.newestPassedAgoMinutes != null) {
        var passGap = (fx.newestAgoMinutes != null) ? (fx.newestPassedAgoMinutes - fx.newestAgoMinutes) : 0;
        sub += ' · <span style="color:' + (passGap >= 60 ? '#e58600' : '#34c759') + '">符合条件的货最新：' + minsText(fx.newestPassedAgoMinutes) + '</span>';
        if (passGap >= 60) sub += ' <span style="color:#8e8e93">（比池子里最新的旧 ' + Math.round(passGap / 60) + ' 小时 —— 这期间上新的都不符合条件）</span>';
      }
      /* 登录横幅：独立判断，不受 note 优先级影响。
         以前登录失效只体现在 sub 的一行小字里，而且会被"限流"等更高优先级挤掉，
         用户完全看不到 —— 现在提到最上面一条大横幅。 */
      updateLoginBar(fx);
      updateLoginBadge(fx);
      /* 接口通道是否健康（优先级最高）：限流 > token 过期 > 任务扫描失败 */
      var thr = fx.throttle || {};
      if (fx.throttled) sub += ' · <span style="color:#ff3b30;font-weight:600">⚠ 被平台限流（' + esc(thr.reason || '请求太频') + '）—— 已自动放慢扫描，稍后会自动恢复</span>';
      else if (fx.tokenAlert) sub += ' · <span style="color:#ff3b30;font-weight:600">⚠ 接口连续失败，签名 token 可能已过期 —— 请关闭本窗口，运行【0-首次扫码登录.cmd】重新扫码登录</span>';
      /* 【网络类错误分级 2026-11-04】单轮断网（合盖/切 WiFi/拔网线）走灰色软提示：
         它不是账号问题、不是程序坏了，几十秒后自己就好，挂红字只会让人以为出了大事。
         连续 2 轮断网时后端不再给 netSoft，这里自然退回下面的红字分支。 */
      else if (fx.netSoft && typeof fx.note === 'string' && fx.note.length) sub += ' · <span style="color:#8e8e93">' + esc(fx.note) + '</span>';
      else if (typeof fx.note === 'string' && fx.note.indexOf('扫描失败') >= 0) sub += ' · <span style="color:#ff3b30;font-weight:600">' + esc(fx.note) + '</span>';
      else if (fx.degraded) sub += ' · <span style="color:#ff3b30;font-weight:600">⚠ 疑似被风控降级 —— ' + esc(fx.degradedWhy || ('最新一条已是 ' + minsText(fx.newestAgoMinutes))) + '。请检查登录态</span>';
      else if (fx.newestAgoMinutes != null && fx.newestAgoMinutes >= 120 && !fx.loginBad)
        /* 注意 minsText() 本身已经返回"6 小时前"/"20 分钟前"，模板里不要再拼"前"字，
           否则会渲染成"最新一条本身是 6 小时前 前"（旧版就是这么显示的）。
           `&& !bad`：登录已失效时上面的大横幅已经解释了原因，
           这里再补一句"数据正常（非降级）"就是自相矛盾（实测截图里真的同时出现过）。 */
        /* 【2026-11-04】门槛从 300 分钟降到 120 分钟，和服务端「抓到的是旧数据」告警保持一致。
           且不再一口咬定"数据正常" —— 超过 2 小时就该提醒用户先看登录徽标。 */
        sub += ' · <span style="color:#e58600">接口最新一条已经是 ' + minsText(fx.newestAgoMinutes) + '（门槛 2 小时）—— 先确认登录徽标是绿的；绿的说明该范围本身没新货</span>';
      /* 多任务时：每个任务各自的新鲜度分行显示，不再只显示最后一个任务。
         行首显示"筛选条件"（由 monitor 的 condLabel 生成），比任务名直观 */
      var rows = (fx.perTask || []).map(function (t) {
        var bad = !!t.error;
        /* 网络类错误：圆点降成灰色（不是红的），因为它跟账号、跟程序都没关系 */
        var netSoft = bad && !!t.netError && !(Number(t.failedRounds || 0) >= 2);
        var warn = t.degraded;
        return '<div style="font-size:11px;line-height:1.7">'
          + '<span style="color:' + (netSoft ? '#8e8e93' : (bad || warn ? '#ff3b30' : '#34c759')) + '">●</span> '
          + '<b>' + esc(t.cond || t.name || '') + '</b>'
          + ' · ' + esc(t.scope || '全国')
          + ' · ' + (t.raw != null ? t.raw + ' 条' : '-')
          + (t.declared != null ? '（服务端自报 ' + t.declared + ' 条）' : '')
          /* 逐任务也要两个口径：池子里最新 ≠ 过了条件的货最新。
             只显示前一个时，用户看到「最新 12 分钟前」但列表停在几小时前，会认为程序坏了。 */
          + ' · 池子最新 ' + (t.newestAgoMinutes != null ? minsText(t.newestAgoMinutes) : '—')
          + ' · <span style="color:' + (t.newestPassedAgoMinutes != null && t.newestAgoMinutes != null && (t.newestPassedAgoMinutes - t.newestAgoMinutes) >= 60 ? '#e58600' : '#34c759') + '">合格品 '
            + (t.newestPassedAgoMinutes != null ? minsText(t.newestPassedAgoMinutes) : (bad || !(t.raw > 0) ? '—' : '无')) + '</span>'
          + (netSoft
              ? ' <span style="color:#8e8e93">' + esc(t.netText || '网络暂时不通') + '（下一轮自动重试）</span>'
              : (bad ? ' <span style="color:#ff3b30">扫描失败：' + esc(String(t.error).slice(0, 60)) + '</span>' : ''))
          + (t.shortfall ? ' <span style="color:#ff3b30">只取到 ' + t.shortfall.got + ' 条，疑似限流少返</span>' : '')
          + (t.deepText ? ' <span style="color:#007aff">' + esc(t.deepText) + '</span>' : '')
          + (warn ? ' <span style="color:#e58600">疑似降级</span>' : '')
          + '</div>';
      }).join('');
      if (rows.length >= 1) sub += '<div style="margin-top:6px;border-top:1px dashed #d1d1d6;padding-top:6px">' + rows + '</div>';
      /* 商贩自动屏蔽入口：有候选卖家才显示（没有就整块不出现，不占地方）。
         candidates 里 blocked=true 的已经被确认屏蔽，这里只数没屏蔽的。 */
      var sbAll = (fx.sellerSuspects || []);
      var sbNew = sbAll.filter(function (s) { return !s.blocked; });
      if (sbNew.length) {
        var totalCnt = sbNew.reduce(function (a, b) { return a + (b.count || 0); }, 0);
        /* 标题里的门槛文案按"当前开了哪几路信号"来拼，避免出现"≥5 条以上"却把
           只靠昵称进来的 2 条卖家列在下面的自相矛盾（用户会以为程序算错了）。 */
        var crit = [];
        if (fx.autoBlockOn !== false) crit.push('最近 ' + (fx.autoBlockDays || 7) + ' 天内 ≥ ' + (fx.autoBlockMin || 5) + ' 条');
        if (fx.autoBlockByName !== false) crit.push('昵称像商家且 ≥ 2 条');
        if (fx.autoBlockByShop !== false) crit.push('主页 ≥ ' + (fx.autoBlockMinItems || 40) + ' 件在售或简介像商家');
        if (fx.autoBlockByDeals) crit.push('评价数多');
        var critTxt = crit.length ? ('满足 ' + crit.join(' 或 ') + ' 的卖家') : '卖家';
        /* 【折叠判据】拿上次见过的候选 ID 集合做差集：有几张新面孔就标「新增 N」并强制展开一次。
           首次运行（还没存过集合）不弹开，直接把当前这批记为已知，默认收起 —— 否则第一次用就占地。 */
        var sbIds = sbNew.map(function (s) { return String(s.sellerId || ('nick:' + (s.name || ''))); });
        var sbPrevIds = sbLSGet(SB_SEEN_KEY, null);
        var sbFreshN = 0;
        if (sbPrevIds && sbPrevIds.length !== undefined) {
          var sbPrevSet = {};
          sbPrevIds.forEach(function (k) { sbPrevSet[k] = 1; });
          sbIds.forEach(function (k) { if (!sbPrevSet[k]) sbFreshN++; });
        }
        sbLSSet(SB_SEEN_KEY, sbIds);
        var sbOpen = !!sbLSGet(SB_OPEN_KEY, 0);
        if (sbPrevIds && sbFreshN > 0) { sbOpen = true; sbLSSet(SB_OPEN_KEY, 1); }
        sub += '<div class="sellerbar' + (sbOpen ? ' open' : '') + '" id="__scan_sellerbar">'
          + '<div class="sb-head" data-toggle="1" title="点一下' + (sbOpen ? '收起' : '展开') + '疑似商贩清单">'
          + '<span class="sb-h-ico">🛒</span>'
          + '<span class="sb-h-txt"><b>' + sbNew.length + '</b> 个疑似商贩 · <b>' + totalCnt + '</b> 条商品'
          + (fx.sellerBlocked ? ' · 已屏蔽 <b>' + fx.sellerBlocked + '</b> 个' : '') + '</span>'
          + (sbFreshN > 0 ? '<span class="sb-new">新增 ' + sbFreshN + '</span>' : '')
          + '<span class="sb-chev">' + (sbOpen ? '▴' : '▾') + '</span>'
          + '</div>'
          + '<div class="sb-body">'
          + '<div class="sb-s">' + critTxt + ' —— 多半是商贩。勾选后整只屏蔽，以后他的商品不会再进来；已屏蔽的可以在这里放出来'
          + (fx.shopProbed ? ' · 已收录 ' + fx.shopProbed + ' 个卖家主页' : '') + '</div>'
          + (sbNew.length > 8 ? '<div class="sb-qrow"><input type="text" class="sb-q" placeholder="按昵称筛选这 ' + sbNew.length + ' 个候选…"><span class="sb-qcnt"></span></div>' : '')
          + '<div class="sb-list">' + sbNew.map(function (s, i) {
              /* 同上：0%好评是"没开小店标签"的哨兵值，不是真差评，不展示 */
              var rate = ((Number(s.deals) || 0) > 0 && s.rate) ? (' · 好评率 ' + esc(s.rate)) : '';
              var deals = ((Number(s.deals) || 0) > 0) ? (' · ' + Number(s.deals) + ' 条评价') : '';
              var shop = (s.shopItems != null) ? ('<span class="sb-dl">主页 ' + s.shopItems + ' 件' + (s.shopBq === 'licensedOperation' ? '·持证' : '') + '</span>') : '';
              var intro = s.shopIntro ? ('<span class="sb-dl" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(s.shopIntro) + '">“' + esc(String(s.shopIntro).slice(0, 18)) + '”</span>') : '';
              return '<label class="sb-item" data-sbnm="' + esc(s.name || '') + '"><input type="checkbox" value="' + esc(s.sellerId) + '" data-name="' + esc(s.name || '') + '" data-rate="' + esc(s.rate || '') + '" data-deals="' + (s.deals || 0) + '" checked>'
                + '<span class="sb-nm">' + esc(s.name || ('卖家 ' + String(s.sellerId).slice(0, 6))) + '</span>'
                + '<span class="sb-ct">' + s.count + ' 条</span>'
                + (s.why ? '<span class="sb-why">' + esc(s.why) + '</span>' : '')
                + shop + intro
                + (rate ? '<span class="sb-rt">' + esc(s.rate) + '</span>' : '')
                + (deals ? '<span class="sb-dl">' + s.deals + ' 评价</span>' : '')
                /* 「看主页」：怕误判就必须能亲眼核一下这个号在卖什么。
                   放在 label 里面，所以必须拦住 click 的冒泡，否则点它会连带把勾选框切换掉。 */
                + (s.sellerId ? '<button type="button" class="sb-look" data-look="' + esc(s.sellerId) + '" data-lookname="' + esc(s.name || '') + '">看主页</button>' : '')
                + '</label>';
            }).join('') + '</div>'
          + '<div class="sb-act">'
          + '<button class="sb-btn" id="__scan_sb_all">全选</button>'
          + '<button class="sb-btn" id="__scan_sb_none">全不选</button>'
          + '<button class="sb-btn sb-ok" id="__scan_sb_go">屏蔽勾选的卖家（' + sbNew.length + '）</button>'
          + (fx.sellerBlocked ? '<button class="sb-btn" id="__scan_sb_manage">查看/解除屏蔽名单（' + fx.sellerBlocked + '）</button>' : '')
          + (fx.sellerBlocked ? '<span class="sb-blocked">已屏蔽 ' + fx.sellerBlocked + ' 个卖家</span>' : '')
          + '</div></div></div>';
      } else if (fx.sellerBlocked) {
        sub += '<div class="sellerbar sbm" id="__scan_sellerbar">'
          + '<div class="sb-head flat">'
          + '<span class="sb-h-ico">🛒</span>'
          + '<span class="sb-h-txt">已屏蔽 <b>' + fx.sellerBlocked + '</b> 个卖家 · 目前没有新的疑似商贩</span>'
          + '<button class="sb-btn" id="__scan_sb_manage" style="margin-left:auto">查看/解除屏蔽名单</button>'
          + '</div></div>';
      }
      document.getElementById('__scan_sub').innerHTML = sub;
      wireSellerBar();
      if (!window.__scan_sub_tm) window.__scan_sub_tm = setInterval(function () {
        if (!document.getElementById(PANEL_ID)) { clearInterval(window.__scan_sub_tm); window.__scan_sub_tm = null; return; }
        if (tab === 'list' && document.getElementById(PANEL_ID).style.display !== 'none') loadHits();
      }, 60000);
      if (!items.length && holdOn) {
        v.innerHTML = '<div class="fr" style="text-align:center;color:#8e8e93;padding:40px">'
          + '程序处于<b style="color:#007aff">待命状态</b>，还没有开始扫描<br>'
          + '<span style="font-size:12px">点右上角「▶ 开始监控」就会开始（登录态已经准备好了，立刻生效）</span></div>';
        return;
      }
      if (!items.length) {
        var empty = (timeWin > 0 && scopeMode !== 'recent')
          ? '最近' + twLabelOf(timeWin) + '内没有' + (scopeMode === 'unread' ? '没看过的' : '') + '新商品<br><span style="font-size:12px">监控每 ' + (d.interval || '-') + ' 秒扫一次，一有新发布的就会出现在这里<br>想看看更早的，点右上角的时间档位换成「12小时 / 24小时 / 全部」</span>'
          : scopeMode === 'recent'
          ? '还没有标记过"看过"的商品<br><span style="font-size:12px">点卡片上的「标记看过」或「打开商品」后会出现在这里，随时可以恢复成没看过</span>'
          : (scopeMode === 'all'
            ? '还没有任何记录<br><span style="font-size:12px">监控正在每 ' + (d.interval || '-') + ' 秒扫一次，第一次启动会先把当前在售逐个收进来（分几轮完成，几十分钟内陆续出现）；<br>之后新发布的商品也会自动出现在这里</span>'
             : '当前筛选条件下还没有没看过的记录<br><span style="font-size:12px">监控正在每 ' + (d.interval || '-') + ' 秒扫一次；有新发布的商品会自动出现在这里<br>之前误点过「标记看过」的，点上面的按钮切到「最近看过」就能找回来</span>');
        v.innerHTML = '<div class="fr" style="text-align:center;color:#8e8e93;padding:40px">' + empty + '</div>';
        return;
      }
      var now = Date.now();
      v.innerHTML = items.map(function (x) {
        /* 「新」= 商品发布时间在 30 分钟内（按发布时间，而不是采集时间），更符合真实抢货判断 */
        var t = parsePublishAt(x.publishAt);
        /* 「新」只认发布时间：30 分钟内上架的才算。
           拿不到发布时间就别标（以前回退用 foundAt，导致"刚被收进列表的老货"全被打成新）。 */
        var fresh = isFinite(t) && (now - t) < 1800000 && (now - t) > -60000;
        /* 「0%好评 / 0条评价」是「卖家没开闲鱼小店标签」的哨兵值，不是真的 0 分好评
           实测 700 条里 602 条是这个值，照原样渲染等于把「没数据」说成「差评」。
           新数据 monitor 侧已经置空了，这里再加一层兜底，老数据（已存进 hits.json 的）也一并屏蔽掉。 */
        var hasShopRate = (Number(x.sellerDeals) || 0) > 0 && !!x.sellerRate;
        return '<div class="card' + (x.read ? ' read' : '') + '"><img loading="lazy" src="' + esc(x.pic) + '" onerror="this.style.opacity=.15;this.removeAttribute(\'loading\')">'
          + '<div style="flex:1;min-width:0"><div class="t">' + esc(x.title) + (fresh ? '<span class="new">新</span>' : '') + (x.read ? '<span class="seen">已看</span>' : '') + '</div>'
          + '<div class="p">' + esc(x.priceText) + '</div>'
          + '<div class="m">' + agoText(x) + ' · ' + esc(x.publishAt) + ' · ' + esc(x.area) + ' · ' + esc(x.seller)
          + (x.credit ? ' · <b style="color:#007aff">信用' + esc(x.credit) + '</b>' : '')
          + (hasShopRate ? ' · <b style="color:#8e8e93">' + esc(x.sellerRate) + '好评</b>' : '')
          + (hasShopRate ? ' · ' + Number(x.sellerDeals) + '条评价' : '')
          /* 【修「同一行出现两个互相矛盾的相对时间」】
             relTime 是**采集那一刻**平台自己写的「N小时前发布」，存进 hits 后就是死值，永不更新。
             而卡片开头的 agoText(x) 是按 publishAt 现算的活值。并排渲染就成了：
                 4小时前发布 · 2026/10/23 21:26:51 · 七星区 · xxx · 信用优秀 · 2小时前发布
             同一行两个相对时间互相打脸 —— 用户看到只会认定「程序时间算错了」。
             实测确认两者都没错：relTime = floor(采集时刻 - publishAt)，是快照而非实时。
             所以不删它（偶尔能反推平台侧的粒度），只加前缀标明它是采集时的快照。 */
          + (x.relTime ? ' · <span style="color:#c7c7cc">采集时平台显示' + esc(x.relTime) + '</span>' : '') + '</div>'
          + '<div style="margin-top:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">'
          + '<a href="' + esc(x.url) + '" target="_blank" data-open="' + esc(x.itemId) + '" style="color:#007aff;font-size:12px;font-weight:600;text-decoration:none">打开商品 →</a>'
          + '<span data-read="' + esc(x.itemId) + '" style="color:#ff3b30;font-size:12px;cursor:pointer;font-weight:600">标记看过（移除）</span>'
          + (x.read
            ? '<span data-unread="' + esc(x.itemId) + '" style="color:#8e8e93;font-size:12px;cursor:pointer">恢复未读</span>'
              + '<span style="color:#c7c7cc;font-size:12px">看过 ' + (x.readAt ? fmt(new Date(x.readAt).toISOString()) : '—') + '</span>'
            : '')
          + (x.seller
            ? '<span data-sbname="' + esc(x.seller) + '" data-sbid="' + esc(x.sellerId || '') + '" data-sbrate="' + esc(x.sellerRate || '') + '" data-sbdeals="' + (x.sellerDeals || 0) + '" title="屏蔽卖家「' + esc(x.seller) + '」，以后他的商品不再进来" style="color:#ff9500;font-size:12px;cursor:pointer;font-weight:600">屏蔽此卖家</span>'
            : '')
          + '</div>'
          + '</div></div>';
      }).join('');
      v.querySelectorAll('[data-open]').forEach(function (el2) {
        el2.addEventListener('click', function () {
          var id = el2.getAttribute('data-open');
          if (!id) return;
          /* 点开链接 → 只置灰（read），不 hidden，商品原地留着 */
          fetch('/__scan/read', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ itemId:id }) })
            .then(function () { setTimeout(loadHits, 400); }).catch(function(){});
        });
      });
      v.querySelectorAll('[data-read]').forEach(function (el2) {
        el2.addEventListener('click', function () {
          var id = el2.getAttribute('data-read');
          if (!id) return;
          var cur = items.filter(function (a) { return a.itemId === id; })[0] || { itemId: id, title: '' };
          fetch('/__scan/hide', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ itemId:id }) })
            .then(function () { showUndo(cur); setTimeout(loadHits, 400); }).catch(function(){});
        });
      });
      v.querySelectorAll('[data-unread]').forEach(function (el2) {
        el2.addEventListener('click', function () {
          var id = el2.getAttribute('data-unread');
          if (!id) return;
          fetch('/__scan/unread', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ itemId:id }) })
            .then(function (r) { return r.json(); })
            .then(function (j) { toast(j && j.ok ? '已恢复为没看过' : '恢复失败'); loadHits(); })
            .catch(function (e) { toast('恢复失败：' + e.message); });
        });
      });
      /* 卡片上「屏蔽此卖家」：看到就点，立刻生效。
         优先用 seller_id（可靠）；id 缺失时退回昵称（monitor 侧同样有昵称兜底）。 */
      v.querySelectorAll('[data-sbname]').forEach(function (el2) {
        el2.addEventListener('click', function () {
          var name = el2.getAttribute('data-sbname');
          var sid = el2.getAttribute('data-sbid');
          var rate = el2.getAttribute('data-sbrate');
          var deals = Number(el2.getAttribute('data-sbdeals') || 0);
          if (!confirm('屏蔽卖家「' + name + '」？\n\n以后他的商品不会再进列表，已进来的会当场撤掉。\n以后想放出来，在顶部「查看/解除屏蔽名单」里解除。')) return;
          fetch('/__scan/sellerblock', { method:'POST', headers:{'content-type':'application/json'},
              body: JSON.stringify({ block: [{ sellerId: sid || ('nick:' + name), name: name, rate: rate, deals: deals }] }) })
            .then(function (r) { return r.json(); })
            .then(function (j) { toast(j && j.ok ? ('已屏蔽「' + name + '」，撤掉 ' + (j.dropped || 0) + ' 条') : '屏蔽失败'); loadHits(); })
            .catch(function (e) { toast('屏蔽失败：' + e.message); });
        });
      });
    }).catch(function (e) {
      v.innerHTML = '<div class="fr" style="color:#ff3b30">读取失败：' + esc(e.message) + '</div>';
      /* 【修 BUG-P2：连不上监控进程时，徽标会永远卡在"登录状态读取中…"】
         以前这里只清了列表区，标题行那颗圆点徽标没人管，
         它就一直停在上电时的占位文案「登录状态读取中…」。
         用户看到一颗永远不绿的点和一片空白列表，很自然地说成"启动不了、一直没登录" ——
         而真实原因跟登录毫无关系，是面板根本没连上监控（进程已退出 / 端口被占 / 请求超时）。

         所以这里必须把徽标改成明确的"连不上"，并把红色横幅也压掉：
         登录失效的横幅会误导用户去扫码，可实际问题在进程不在登录。 */
      var box = document.getElementById('__scan_lgn');
      var txt = document.getElementById('__scan_lgn_txt');
      var btn = document.getElementById('__scan_lgn_btn');
      if (box && txt) {
        box.className = 'lgn bad';
        txt.textContent = '连不上监控进程';
        box.title = '拿不到 /__scan/hits.json：' + e.message
          + '\n\n这不是登录问题。请确认监控窗口还在运行；'
          + '\n如果窗口闪一下就没了，双击【闲鱼扫货监控.exe】重新启动。';
        if (btn) { btn.className = 'lgn-btn'; btn.textContent = '重新启动监控'; }
      }
      var bar = document.getElementById('__scan_loginbar');
      if (bar) bar.style.display = 'none';
    });
  }

  /* ---------- 筛选设置 ---------- */
  function openFilter() {
    var v = document.getElementById('__scan_view'); if (!v) return;
    if (!catalog) { v.innerHTML = '<div style="color:#8e8e93;padding:20px 0">加载筛选项...</div>'; return; }
    v.innerHTML = '<div style="color:#8e8e93;padding:20px 0">加载中...</div>';
    fetch('/__scan/config?t=' + Date.now()).then(function (r) { return r.json(); }).then(function (d) {
      conf = d;
      if (!conf.tasks || !conf.tasks.length) conf.tasks = [newTask()];
      /* 【A/B 修复 2026-11-04】先把服务端缓存的筛选项快照拉下来再渲染。
         以前只靠内存 cpvTree，刷新页面就空了 —— 界面显示「还没取到」，
         而配置里其实还存着 cpvFilters，于是一点保存就被清空。 */
      loadCpvCache(function () {
        /* 屏蔽词命中统计（哪个词真在起作用），取不到就按 0 显示，不影响使用 */
        fetch('/__scan/wordstats?t=' + Date.now()).then(function (r) { return r.json(); })
          .then(function (w) { wordStats = (w && w.stats) || {}; })
          .catch(function () { wordStats = {}; })
          .then(function () { renderFilter(); });
      });
    });
  }
  function newTask() {
    return { name: '新任务', keyword: '', minPrice: null, maxPrice: null, province: '', city: '', area: '', sort: 'default',
      priceSort: '', publishDays: 0, credit: '', quickFilters: [], brands: [], versions: [], storages: [], cpvFilters: {},
      mustContain: [], excludeWords: [], descExcludeWords: [], sellerBlockWords: [], rowsPerPage: 30, enabled: true };
  }
  /* ---------- 屏蔽词编辑器（标签化 + 命中统计 + 导入导出） ---------- */
  var wordStats = {};
  function bwEditor(fld, label, words, kindTip) {
    return '<div><span class="lb">' + label + '</span>'
      + '<div class="bwbox" data-bw="' + fld + '">'
      + '<input type="hidden" data-f="' + fld + '" value="' + esc((words || []).join(',')) + '">'
      + '<div class="bwlist"></div>'
      + '<input class="bwin" placeholder="输入一个词，回车就加；也可以直接粘贴多个（逗号/空格/换行分隔）">'
      + '<div class="bwbar">'
      + '<span data-bwcopy>复制词表</span><span data-bwimp>粘贴导入</span><span data-bwclear>清空</span>'
      + '<span class="dim">' + kindTip + '</span>'
      + '</div>'
      + '<div class="bwimp"><textarea placeholder="一行一个，或用逗号分隔，例如：&#10;壳&#10;膜&#10;支架"></textarea>'
      + '<div style="margin-top:6px;display:flex;gap:14px"><span data-bwok style="color:#007aff;font-weight:600">确定导入</span><span data-bwcancel style="color:#8e8e93">取消</span></div></div>'
      + '</div></div>';
  }
  function wireBwEditors(root) {
    root.querySelectorAll('[data-bw]').forEach(function (box) {
      var fld = box.getAttribute('data-bw');
      var kind = fld === 'excludeWords' ? '标题' : (fld === 'sellerBlockWords' ? '卖家' : '内容');
      var hid = box.querySelector('[data-f="' + fld + '"]');
      var list = box.querySelector('.bwlist');
      var inp = box.querySelector('.bwin');
      var imp = box.querySelector('.bwimp');
      var ta = imp.querySelector('textarea');
      var read = function () { return (hid.value || '').split(/[,，、\s]+/).filter(Boolean); };
      var render = function () {
        var ws = read();
        list.innerHTML = ws.map(function (w) {
          var st = (wordStats || {})[kind + '|' + w];
          var n = st ? (Number(st.count) || 0) : 0;
          return '<span class="bwt' + (n ? '' : ' zero') + '" data-w="' + esc(w) + '">' + esc(w)
            + '<span class="h"' + (n ? '' : ' style="background:#f2f2f7;color:#8e8e93"') + '>'
            + (n ? '命中 ' + n : '未命中') + '</span>'
            + '<span class="x" title="删掉这个词">×</span></span>';
        }).join('') || '<span style="font-size:11px;color:#c7c7cc">还没有词，在下面输入框里加</span>';
        list.querySelectorAll('.bwt .x').forEach(function (x) {
          x.onclick = function () {
            var w = x.parentNode.getAttribute('data-w');
            write(read().filter(function (a) { return a !== w; }));
          };
        });
      };
      var write = function (arr) {
        var seen2 = {}, out = [];
        arr.forEach(function (w) { w = String(w).trim(); if (!w || seen2[w]) return; seen2[w] = 1; out.push(w); });
        hid.value = out.join(',');
        render();
      };
      var commit = function () {
        var raw = inp.value; if (!raw || !raw.trim()) return;
        write(read().concat(raw.split(/[,，、\s]+/)));
        inp.value = '';
      };
      inp.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ',' || e.key === '，') { e.preventDefault(); commit(); }
      };
      inp.onblur = commit;
      inp.onpaste = function () { setTimeout(commit, 0); };
      box.querySelector('[data-bwclear]').onclick = function () { write([]); };
      box.querySelector('[data-bwcopy]').onclick = function () {
        var txt = read().join('\n');
        var t2 = document.createElement('textarea');
        t2.value = txt; t2.style.position = 'fixed'; t2.style.opacity = '0';
        document.body.appendChild(t2); t2.select();
        try { document.execCommand('copy'); toast('已复制 ' + read().length + ' 个词'); }
        catch (e) { toast('复制失败，请手动选中'); }
        document.body.removeChild(t2);
      };
      box.querySelector('[data-bwimp]').onclick = function () {
        imp.style.display = imp.style.display === 'block' ? 'none' : 'block';
        if (imp.style.display === 'block') ta.focus();
      };
      box.querySelector('[data-bwok]').onclick = function () {
        write(read().concat((ta.value || '').split(/[,，、\s]+/)));
        ta.value = ''; imp.style.display = 'none';
      };
      box.querySelector('[data-bwcancel]').onclick = function () { imp.style.display = 'none'; };
      render();
    });
  }
  /* ===== 推送设置卡片 =====
     配置来源：GET /__scan/config 返回的 conf.notify（凭据只带 filled/len，不带明文）。
     提交方式：跟"保存并生效"一起 POST /__scan/config 的 notify 字段，
     空字符串 = 保留旧值（服务端 mergeNotifyConfig 处理），所以改开关不会把已填的 key 清掉。

     【下拉选渠道 2026-10-29】
     以前 6 个渠道各占一整块（勾选框 + 输入框 + 三行提示），整张卡片 40 多行，得滑好几次才看得完。
     现在一个下拉选「配哪个渠道」，下面只渲染选中那个的输入框，卡片高度降到约 1/5。
     关键约束：没被渲染的渠道没有 DOM —— 各渠道的勾选状态和已输入的值必须另存一份草稿
     （notifyDraft），切换下拉时先 commit 当前面板再换。否则 readNotifyForm 按 DOM 遍历时，
     未显示的渠道会被当成"用户取消勾选"而全部关掉（这个坑在改版前不存在，因为 DOM 里一直有）。 */
  var NOTIFY_CHANS = [
    { key: 'serverchan', title: 'Server酱（微信推送）',
      hint: '在 sct.ftqq.com 注册后拿 SendKey。免费版每天 5 条。',
      fields: [{ f: 'sendkey', label: 'SendKey', ph: 'SCT 开头的密钥' }] },
    { key: 'wecom', title: '企业微信群机器人',
      hint: '群设置 → 群机器人 → 添加 → 复制 Webhook。限 20 条/分钟，超了本程序会自动排队等待。',
      fields: [{ f: 'webhook', label: 'Webhook 地址', ph: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' }] },
    { key: 'feishu', title: '飞书群机器人',
      hint: '群设置 → 群机器人 → 自定义机器人 → 复制 Webhook；开了「签名校验」就把密钥也填上。',
      fields: [{ f: 'webhook', label: 'Webhook 地址', ph: 'https://open.feishu.cn/open-apis/bot/v2/hook/...' },
               { f: 'secret', label: '签名密钥（没开签名校验就留空）', ph: '签名校验密钥' }] },
    { key: 'gotify', title: 'Gotify（自建推送）',
      hint: '自己搭的 Gotify 服务器。地址填到根路径即可，程序会自动补 /message。',
      fields: [{ f: 'url', label: '服务器地址', ph: 'https://gotify.example.com' },
               { f: 'token', label: '应用 Token', ph: 'A.xxxxxx' },
               { f: 'priority', label: '优先级（0-10，默认 5）', type: 'number', min: 0, max: 10, step: 1 }] },
    { key: 'bark', title: 'Bark（iOS 推送）',
      hint: 'App Store 装 Bark → 打开 App 首页，顶部那条 https://api.day.app/xxxx 就是你的推送地址，'
        + '整条复制粘进来（末尾那段是 DeviceKey，必须带上）。走官方 POST /push 接口，正文放请求体，'
        + '不受网址长度限制；自建的老版本 Bark 若没有 /push 会自动回落到 GET 方式。',
      fields: [{ f: 'url', label: 'Bark 地址', ph: 'https://api.day.app/你的DeviceKey' }] },
    { key: 'generic', title: '自定义 Webhook（钉钉/Slack/其他）',
      hint: '按下面的类型拼请求体。选「裸文本」就发 {"text": "..."}。',
      fields: [{ f: 'url', label: 'Webhook 地址', ph: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
               { f: 'type', label: '请求体格式', type: 'select',
                 options: [['wecom', '企业微信格式'], ['dingtalk', '钉钉格式'], ['feishu', '飞书格式'], ['slack', 'Slack 格式'], ['text', '裸文本 {"text"}']] }] }
  ];
  var notifyDraft = null;    /* 各渠道表单草稿（含未显示的渠道），切换下拉时同步 */
  var notifyServer = null;   /* 服务端给的 channels 原样，只用来取 filled/len/priority */
  var notifyCurChan = '';    /* 当前显示的渠道 key */

  function notifyInitState() {
    var ch = (conf.notify && conf.notify.channels) || {};
    notifyServer = ch;
    notifyDraft = {};
    NOTIFY_CHANS.forEach(function (C) {
      var src = ch[C.key] || {};
      var vals = {};
      C.fields.forEach(function (F) {
        if (F.type === 'select') vals[F.f] = src[F.f] || (F.options[0] ? F.options[0][0] : '');
        else if (F.type === 'number') vals[F.f] = (typeof src[F.f] === 'number' ? String(src[F.f]) : '');
        else vals[F.f] = '';
      });
      notifyDraft[C.key] = { enabled: !!src.enabled, vals: vals, cleared: [] };
    });
    /* 默认选中第一个已启用的渠道；一个都没启用就选 Bark（目前实际在用的就是这个） */
    var pick = '';
    NOTIFY_CHANS.forEach(function (C) { if (!pick && notifyDraft[C.key].enabled) pick = C.key; });
    notifyCurChan = pick || 'bark';
  }
  /* 把当前面板 DOM 里的输入回写到草稿。任何"要先读再说"的动作
     （切换下拉、保存、点清除）都必须先调它，否则刚敲的字会丢。 */
  function notifyCommitPanel() {
    if (!notifyDraft || !notifyCurChan) return;
    var d = notifyDraft[notifyCurChan];
    var cb = document.querySelector('[data-nch="' + notifyCurChan + '"]');
    if (cb) d.enabled = !!cb.checked;
    document.querySelectorAll('[data-nf]').forEach(function (el) {
      var k = String(el.getAttribute('data-nf')).split('.');
      if (k[0] !== notifyCurChan) return;
      d.vals[k[1]] = el.value;
    });
  }
  /* 下拉项文案：一眼看出哪个渠道已启用 / 已填地址，不用逐个点开确认 */
  function notifyChanLabel(C) {
    var d = notifyDraft[C.key] || {};
    var tags = [];
    if (d.enabled) tags.push('已启用');
    var hasCfg = C.fields.some(function (F) {
      var o = (notifyServer[C.key] || {})[F.f];
      return !!(o && typeof o === 'object' && o.filled);
    });
    if (hasCfg) tags.push('已填地址');
    return C.title + '　' + (tags.length ? '· ' + tags.join('、') : '· 未配置');
  }
  function notifyChanPanelHtml() {
    var C = NOTIFY_CHANS.filter(function (x) { return x.key === notifyCurChan; })[0] || NOTIFY_CHANS[0];
    var d = notifyDraft[C.key];
    var src = notifyServer[C.key] || {};
    var h = '<div class="fr" style="padding:12px 14px">'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#1d1d1f;cursor:pointer;margin-bottom:11px">'
      + '<input type="checkbox" data-nch="' + C.key + '"' + (d.enabled ? ' checked' : '') + ' style="width:15px;height:15px;accent-color:#ff9500;cursor:pointer">'
      + esc(C.title)
      + '<button type="button" class="btn" data-ntest="' + C.key + '" style="margin-left:auto;padding:4px 10px;font-size:11px">测试</button>'
      + '</label>';
    C.fields.forEach(function (F) {
      var o = src[F.f];
      var isCfg = o && typeof o === 'object' && o.filled !== undefined;
      var cleared = (d.cleared || []).indexOf(F.f) >= 0;
      var val = d.vals[F.f] == null ? '' : d.vals[F.f];
      if (F.type === 'select') {
        h += '<div style="margin-bottom:6px"><span class="lb">' + esc(F.label) + '</span>'
          + '<select data-nf="' + C.key + '.' + F.f + '">'
          + F.options.map(function (op) {
            return '<option value="' + esc(op[0]) + '"' + (String(val) === String(op[0]) ? ' selected' : '') + '>' + esc(op[1]) + '</option>';
          }).join('')
          + '</select></div>';
        return;
      }
      if (F.type === 'number') {
        h += '<div style="margin-bottom:6px"><span class="lb">' + esc(F.label) + '</span>'
          + '<input type="number" data-nf="' + C.key + '.' + F.f + '" value="' + esc(String(val)) + '"'
          + ' min="' + F.min + '" max="' + F.max + '" step="' + (F.step || 1) + '"></div>';
        return;
      }
      /* 凭据/地址类：已配置时不回显明文，只显示 ●●●●●● 与字符数 */
      var phTxt = cleared ? '点「保存」后清空'
        : (isCfg && o.filled ? '●●●●●● 已配置（' + (o.len || 0) + ' 字符），留空 = 不改' : (F.ph || ''));
      var clrBtn = (isCfg && o.filled && !cleared)
        ? '<span data-nclr="' + C.key + '.' + F.f + '" style="margin-left:6px;font-size:11px;color:#ff3b30;cursor:pointer;text-decoration:underline;flex-shrink:0">清除</span>'
        : (cleared ? '<span style="margin-left:6px;font-size:11px;color:#8e8e93;flex-shrink:0">已标记清除</span>' : '');
      h += '<div style="margin-bottom:6px"><span class="lb">' + esc(F.label) + clrBtn + '</span>'
        + '<input type="text" data-nf="' + C.key + '.' + F.f + '" value="' + esc(String(val)) + '"'
        + ' placeholder="' + esc(phTxt) + '"></div>';
    });
    if (C.hint) h += '<div style="font-size:11px;color:#8e8e93;line-height:1.7;margin-top:8px">' + C.hint + '</div>';
    h += '</div>';
    return h;
  }
  function notifyRedrawChan() {
    var box = document.getElementById('__scan_nt_chanbox');
    if (box) box.innerHTML = notifyChanPanelHtml();
    notifyBindChanCtl();
  }
  /* 面板内按钮：测试 / 清除。每次 innerHTML 重绘都得重绑。 */
  function notifyBindChanCtl() {
    document.querySelectorAll('[data-ntest]').forEach(function (b) {
      b.onclick = function (e) { e.preventDefault(); notifyDoTest(b.getAttribute('data-ntest')); };
    });
    document.querySelectorAll('[data-nclr]').forEach(function (s) {
      s.onclick = function (e) {
        e.preventDefault();
        notifyCommitPanel();
        var p = String(s.getAttribute('data-nclr')).split('.');
        var d = notifyDraft[p[0]]; if (!d) return;
        if (d.cleared.indexOf(p[1]) < 0) d.cleared.push(p[1]);
        d.vals[p[1]] = '';
        notifyRedrawChan();
      };
    });
  }

  function notifyCard() {
    var n = conf.notify || {};
    notifyInitState();

    var html = '<div class="fr" style="margin-bottom:12px;padding:12px 14px">'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#1d1d1f;cursor:pointer">'
      + '<input type="checkbox" id="__scan_nt_on"' + (n.enabled === false ? '' : ' checked') + ' style="width:15px;height:15px;accent-color:#ff9500;cursor:pointer">'
      + '启用推送</label>'
      + '<div class="row2" style="margin-top:10px">'
      + '<div><span class="lb">每条消息最多装几件</span>'
      + '<input type="number" id="__scan_nt_per" min="1" max="50" step="1" value="' + esc(String(n.maxItemsPerMessage || 15)) + '"></div>'
      + '<div><span class="lb">超时（毫秒）</span>'
      + '<input type="number" id="__scan_nt_timeout" min="3000" max="120000" step="1000" value="' + esc(String(n.timeoutMs || 15000)) + '"></div>'
      + '</div>'
      + '<div class="row2" style="margin-top:8px">'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#6e6e73;cursor:pointer;padding:6px 0">'
      + '<input type="checkbox" id="__scan_nt_drop"' + (n.priceDropNotify === false ? '' : ' checked') + ' style="width:15px;height:15px;accent-color:#ff9500;cursor:pointer">'
      + '降价时重推</label>'
      + '<div><span class="lb">降价幅度至少（%）</span>'
      + '<input type="number" id="__scan_nt_droppct" min="0.5" max="90" step="0.5" value="' + esc(String(Math.round((n.priceDropPct || 0.03) * 1000) / 10)) + '"></div>'
      + '</div>'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#6e6e73;cursor:pointer;margin-top:8px">'
      + '<input type="checkbox" id="__scan_nt_onlyinc"' + (n.onlyIncreaseRenotify === false ? '' : ' checked') + ' style="width:15px;height:15px;accent-color:#ff9500;cursor:pointer">'
      + '降价但综合分没提升就<b style="margin:0 2px">不</b>重复打扰（防同价反复推，推荐开）</label>'
      + '<div style="font-size:11px;color:#8e8e93;line-height:1.7;margin-top:8px">'
      + '综合分 = 价格分 50 + 卖家分 30 + 新鲜分 20，降价额外加成（≥8% 加 5、≥20% 加 10）。'
      + '同价位区间里越便宜、卖家越好、发布越新，分数越高。</div>'
      + '</div>';

    /* 6 个渠道收进一个下拉，只渲染选中的那个；其余渠道的状态由 notifyDraft 保存 */
    html += '<div class="fr" style="margin-bottom:12px;padding:12px 14px">'
      + '<span class="lb" style="display:block;margin-bottom:6px">推送渠道（选一个来配置，可同时启用多个）</span>'
      + '<select id="__scan_nt_chan" style="width:100%;font-size:13px;font-weight:600">'
      + NOTIFY_CHANS.map(function (C) {
        return '<option value="' + esc(C.key) + '"' + (C.key === notifyCurChan ? ' selected' : '') + '>'
          + esc(notifyChanLabel(C)) + '</option>';
      }).join('')
      + '</select>'
      + '<div id="__scan_nt_chanbox" style="margin-top:10px"></div>'
      + '</div>';

    html += '<div class="fr" style="margin-bottom:12px;padding:12px 14px">'
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + '<button type="button" class="btn g" id="__scan_nt_testall" style="padding:6px 12px;font-size:12px">测试全部已启用渠道</button>'
      + '<button type="button" class="btn" id="__scan_nt_hist" style="padding:6px 12px;font-size:12px">查看推送记录</button>'
      + '<span id="__scan_nt_result" style="font-size:12px;color:#8e8e93"></span>'
      + '</div>'
      + '<div id="__scan_nt_histbox" style="display:none;margin-top:10px;max-height:260px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.7;color:#3a3a3c;background:#f7f7fa;border-radius:6px;padding:10px"></div>'
      + '<div id="__scan_nt_stats" style="font-size:11px;color:#8e8e93;margin-top:8px"></div>'
      + '</div>';
    return html;
  }

  function renderFilter() {
    var v = document.getElementById('__scan_view');
    document.getElementById('__scan_count').textContent = conf.tasks.length + ' 个任务';
    document.getElementById('__scan_sub').textContent = '改完记得点「保存并生效」，无需重启程序';
    var secH = function (num, title, sub) {
      return '<div style="display:flex;align-items:baseline;gap:10px;margin:20px 0 10px">'
        + '<span style="width:22px;height:22px;border-radius:50%;background:var(--blue);color:#fff;font-size:12px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;flex:none">' + num + '</span>'
        + '<span style="font-size:15px;font-weight:600;color:var(--ink);letter-spacing:-.1px">' + esc(title) + '</span>'
        + (sub ? '<span style="font-size:12px;color:var(--muted)">' + esc(sub) + '</span>' : '')
        + '</div>';
    };
    v.innerHTML = '<div class="secbar">'
      + '<button class="sectab on" data-sec="scan">① 扫什么</button>'
      + '<button class="sectab" data-sec="notify">② 消息推送</button>'
      + '<button class="sectab" data-sec="advanced">③ 高级设置</button>'
      + '</div>'
      + '<div class="secpane on" data-pane="scan"><div style="margin-bottom:4px;font-size:12px;color:var(--muted)">设置关键词、地区、价格和官方筛选项</div>'
      + conf.tasks.map(function (t, i) { return taskForm(t, i); }).join('')
      + '<div style="display:flex;gap:10px;margin:4px 0 0">'
      + '<button class="btn" id="__scan_add">+ 添加任务</button>'
      + '</div></div>'
      + '<div class="secpane" data-pane="notify">' + notifyCard() + '</div>'
      + '<div class="secpane" data-pane="advanced"><div style="padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:16px"><div style="font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:10px">商贩自动识别</div><div class="row2">'
      + '<div><span class="lb">同一卖家最近几天内出现 ≥ N 条就提示屏蔽</span>'
      + '<input type="number" id="__scan_abmin" min="2" max="200" step="1" value="' + esc(String(conf.autoBlockMinCount || 5)) + '">'
      + '</div>'
      + '<div><span class="lb">统计时间窗口（天）</span>'
      + '<input type="number" id="__scan_abdays" min="1" max="30" step="1" value="' + esc(String(conf.autoBlockWindowDays || 7)) + '">'
      + '</div>'
      + '</div>'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#6e6e73;cursor:pointer">'
      + '<input type="checkbox" id="__scan_abon"' + (conf.autoBlockSellers === false ? '' : ' checked') + ' style="width:15px;height:15px;accent-color:#ff9500;cursor:pointer">'
      + '启用自动识别（只做提示 + 勾选确认，不会自己删你的商品）</label>'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#6e6e73;cursor:pointer;margin-top:8px">'
      + '<input type="checkbox" id="__scan_abname"' + (conf.autoBlockByName === false ? '' : ' checked') + ' style="width:15px;height:15px;accent-color:#ff9500;cursor:pointer">'
      + '昵称识别（名字里带 数码/通讯/回收/优品/批发/店 等词，且 ≥2 条）<b style="color:#34c759">推荐开</b></label>'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#6e6e73;cursor:pointer;margin-top:6px">'
      + '<input type="checkbox" id="__scan_abdeals"' + (conf.autoBlockByDeals ? ' checked' : '') + ' style="width:15px;height:15px;accent-color:#ff9500;cursor:pointer">'
      + '评价数识别（评价 ≥ <input type="number" id="__scan_abmdeal" min="1" max="99999" step="1" value="' + esc(String(conf.autoBlockMinDeals || 100)) + '" style="width:74px;display:inline-block;padding:3px 6px;font-size:12px"> 条）'
      + '<b style="color:#ff3b30">误伤多，默认关</b></label>'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#6e6e73;cursor:pointer;margin-top:6px">'
      + '<input type="checkbox" id="__scan_abshop"' + (conf.autoBlockByShop === false ? '' : ' checked') + ' style="width:15px;height:15px;accent-color:#ff9500;cursor:pointer">'
      + '主页识别（卖家主页在售 ≥ <input type="number" id="__scan_abmitems" min="1" max="9999" step="1" value="' + esc(String(conf.autoBlockMinItems || 40)) + '" style="width:74px;display:inline-block;padding:3px 6px;font-size:12px"> 件，或简介里写着实体店/批发/回收等）'
      + '<b style="color:#34c759">推荐开</b></label>'
      + '<div class="row2" style="margin-top:8px">'
      + '<div><span class="lb">每轮最多查几个卖家主页（查得越多越准，但也越慢）</span>'
      + '<input type="number" id="__scan_abprobe" min="0" max="40" step="1" value="' + esc(String(conf.autoBlockMaxProbePerRound != null ? conf.autoBlockMaxProbePerRound : 15)) + '">'
      + '</div>'
      + '<div><span class="lb">已收录卖家主页</span>'
      + '<input type="text" value="' + esc(String(conf.shopProbed || 0)) + ' 个" readonly style="background:#f7f7fa;color:#8e8e93">'
      + '</div>'
      + '</div>'
      + '<div class="tip" style="margin-top:8px;font-size:11px;line-height:1.7;color:#8e8e93">'
      + '只用「频次」会漏掉库存品类宽、我们只搜到一两条的商贩，所以加了「昵称」这一路。<br>'
      + '实测用你已屏蔽的 14 个商贩当标准答案：频次(7天)+昵称 → 全部认出，候选举例 25 个；'
      + '加评价数会多冒出 43 个卖得多的个人号（如「卖原装机的小刘 评价3866」），所以默认关。<br>'
      + '「主页识别」是第三路：直接看这个号本身有多大（宝贝 147 件 vs 个人 3 件），'
      + '能抓到「我们只搜到 1 条但库存几百件」的大商贩（比如 木子数码 1 条 / 主页 238 件）。'
      + '实测 阈值 40 件 → 认出 79% 你屏蔽过的、误判 20%；加上简介关键词 → 认出 87%、误判 29%，'
      + '而且误判那批逐个看基本也是商贩。<br>'
      + '已屏蔽卖家的历史商品会一起参与统计，所以屏蔽得越多不会让识别失灵。</div></div>'
      + '<div style="padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:16px">'
      + '<div style="font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:10px">建基线时只收多久以内发布的货</div>'
      + '<div class="row2">'
      + '<div><span class="lb">建基线补货时，只把最近 N 小时内发布的收进列表</span>'
      + '<input type="number" id="__scan_seedage" min="0" max="720" step="1" value="' + esc(String(conf.seedMaxAgeHours != null ? conf.seedMaxAgeHours : 24)) + '">'
      + '</div>'
      + '<div><span class="lb">说明</span>'
      + '<input type="text" value="0 = 不过滤（旧行为）" readonly style="background:#f7f7fa;color:#8e8e93">'
      + '</div>'
      + '</div>'
      + '<div class="tip" style="margin-top:8px;font-size:11px;line-height:1.7;color:#8e8e93">'
      + '改筛选条件（关键词/价格/地区…）会自动清库并重建基线。建基线的做法是把搜索结果一直翻到第 50 页，'
      + '而第 2 页往后基本是「几天前发布、现在还在卖」的老货 —— 官网照列，但对你扫货没用。<br>'
      + '这里设一个时间闸门：只有最近 N 小时内发布的才进列表，更老的一律只登记不再重复报，不显示。<br>'
      + '填 <b>0</b> 回到旧行为（老货也全收进来）。默认 <b>24</b> 小时。</div>'
      + '</div>'
      + '<div style="padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:16px">'
      + '<div style="font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:10px">命中精度（这几项改完只影响下一轮，不会清库）</div>'
      + '<div class="row2">'
      + '<div><span class="lb">每轮往后翻几页（1 页≈30 条，翻得越多越不容易漏）</span>'
      + '<input type="number" id="__scan_incpages" min="1" max="10" step="1" value="' + esc(String(conf.incrementalPages != null ? conf.incrementalPages : 3)) + '">'
      + '</div>'
      + '<div><span class="lb">新命中时效：只收最近 N 小时内发布的（0=不过滤）</span>'
      + '<input type="number" id="__scan_freshage" min="0" max="720" step="1" value="' + esc(String(conf.freshMaxAgeHours != null ? conf.freshMaxAgeHours : 24)) + '">'
      + '</div>'
      + '</div>'
      + '<div class="row2" style="margin-top:8px">'
      + '<div><span class="lb">占位价阈值（标价 ≤ N 元且带预售话术/加价后缀的丢掉）</span>'
      + '<input type="number" id="__scan_phpricemax" min="0" max="1000" step="1" value="' + esc(String(conf.placeholderPriceMax != null ? conf.placeholderPriceMax : 10)) + '">'
      + '</div>'
      + '<div><span class="lb">标题和标签都看不出容量时</span>'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#6e6e73;cursor:pointer;padding:6px 0">'
      + '<input type="checkbox" id="__scan_strictstorage"' + (conf.storageStrict ? ' checked' : '') + ' style="width:15px;height:15px;accent-color:#ff9500;cursor:pointer">'
      + '严格丢弃（默认关：标题没写容量但看着像手机就放行）</label>'
      + '</div>'
      + '</div>'
      + '<div class="tip" style="margin-top:8px;font-size:11px;line-height:1.7;color:#8e8e93">'
      + '· <b>翻页数</b>：以前固定只翻 1 页，每轮只看 30 条，一个市的货源根本不够。默认 3 页 ≈ 88 条。<br>'
      + '· <b>时效</b>：闲鱼综合排序第 2 页往后常混进「挂了几天还在卖」的老货；只收最近 N 小时的，面板才不会全是前几天的。<br>'
      + '· <b>占位价</b>：¥1 的「iPhone Duo 官方订单 +1000可交」这类入口价帖，标价 1 元真实价 1001，以前直通价格闸门。<br>'
      + '· <b>容量</b>：默认「看不出容量但像手机就放行」，能收下懒得写 256G 的真机，也不会放进 AirPods/手表/MacBook；勾严格后一律不收。</div>'
      + '</div>'
      + '<div style="padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:16px">'
      + '<div style="font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:10px">启动与节奏（改完下一轮生效）</div>'
      + '<div class="row2">'
      + '<div><span class="lb">启动方式</span>'
      + '<select id="__scan_startmode" style="width:100%">'
      + '<option value="hold"' + (String(conf.startMode || 'hold') !== 'auto' ? ' selected' : '') + '>先待命，点「开始监控」再扫（推荐）</option>'
      + '<option value="auto"' + (String(conf.startMode || 'hold') === 'auto' ? ' selected' : '') + '>启动就开始扫（老行为）</option>'
      + '</select>'
      + '</div>'
      + '<div><span class="lb">连点保护：距上一轮不足 N 秒就顺延（0=关闭）</span>'
      + '<input type="number" id="__scan_resumegap" min="0" max="3600" step="10" value="' + esc(String(conf.resumeMinGapSec != null ? conf.resumeMinGapSec : 180)) + '">'
      + '</div>'
      + '</div>'
      + '<div class="tip" style="margin-top:8px;font-size:11px;line-height:1.7;color:#8e8e93">'
      + '· <b>待命</b>：双击程序后浏览器和登录态都就绪，但<b>一个搜索请求都不发</b>；'
      + '点面板右上角「▶ 开始监控」或托盘同款菜单项才开始。待命不过期。<br>'
      + '· 点「开始/暂停」本身不发任何请求，不会增加风控风险；<b>但每点一次「开始」就多跑一轮</b>，'
      + '一两分钟内连点会打出一长串页面请求。所以有连点保护：默认 180 秒，连点十次也只跑一轮。<br>'
      + '· 点「暂停」会立刻中断等待，但<b>不会打断正在跑的那一轮</b>（最长再等 60 秒）。</div>'
      + '</div>'
      + '<div style="padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:16px">'
      + '<div style="font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:10px">重建基线的节奏（改完下一轮生效，不会清库）</div>'
      + '<div class="row2">'
      + '<div><span class="lb">是否往回翻历史（关掉只扫新上架）</span>'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#6e6e73;cursor:pointer;padding:6px 0">'
      + '<input type="checkbox" id="__scan_deepsweep"' + (conf.deepSweep !== false ? ' checked' : '') + ' style="width:15px;height:15px;accent-color:#007aff;cursor:pointer">'
      + '启用全量基线</label>'
      + '</div>'
      + '<div><span class="lb">基线总页数（50 页 ≈ 1500 条，上限 50）</span>'
      + '<input type="number" id="__scan_deepmaxpages" min="10" max="50" step="5" value="' + esc(String(conf.deepMaxPages != null ? conf.deepMaxPages : 50)) + '">'
      + '</div>'
      + '</div>'
      + '<div class="row2" style="margin-top:8px">'
      + '<div><span class="lb">基线每轮翻几页（<b style="color:#ff9500">超过 5 有被挤爆风险</b>）</span>'
      + '<input type="number" id="__scan_deepperround" min="1" max="10" step="1" value="' + esc(String(conf.deepPagesPerRound != null ? conf.deepPagesPerRound : 3)) + '">'
      + '</div>'
      + '<div><span class="lb">基线页间隔毫秒（2000~15000，越大越稳）</span>'
      + '<input type="number" id="__scan_deepgapms" min="1200" max="15000" step="500" value="' + esc(String(conf.deepPageGapMs != null ? conf.deepPageGapMs : 4000)) + '">'
      + '</div>'
      + '</div>'
      + '<div class="tip" style="margin-top:8px;font-size:11px;line-height:1.7;color:#8e8e93">'
      + '· 改关键词 / 改价格 / 改地区都会触发一次「全量基线」，默认 50 页分十几轮慢慢走完（约 1.5 小时），期间<b>不推送</b>，只静默收录。<br>'
      + '· <b>每轮翻几页</b>是唯一真会触发风控的参数：<b style="color:#ff5a4e">10 页已是实测被挤爆的值</b>，默认 3 页从来没出过事。想快点走完可以调到 5，别超过 5。<br>'
      + '· <b>页间隔</b>是每翻一页停多久，调小能变快但更容易被盯上。代码下限 1200 毫秒，填 0 也会按 1200 走。<br>'
      + '· 关闭「启用全量基线」后，改条件只从最新开始扫，<b>挂很久的老货永远进不来</b>，想捞压箱底的便宜货别关。</div>'
      + '</div>'
      + '<div style="padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:16px">'
      + '<div style="font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:10px">其他</div>'
      + '<div class="row2">'
      + '<div><span class="lb">每轮最多抓几条简介（0=不抓；调大增加请求量）</span>'
      + '<input type="number" id="__scan_maxdescround" min="0" max="30" step="1" value="' + esc(String(conf.maxDescPerRound != null ? conf.maxDescPerRound : 15)) + '">'
      + '</div>'
      + '<div><span class="lb">启动监控时自动打开这个面板页</span>'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#6e6e73;cursor:pointer;padding:6px 0">'
      + '<input type="checkbox" id="__scan_autoopen"' + (conf.autoOpen !== false ? ' checked' : '') + ' style="width:15px;height:15px;accent-color:#007aff;cursor:pointer">'
      + '启动时自动打开</label>'
      + '</div>'
      + '</div>'
      + '<div style="margin-top:10px;padding:10px 12px;background:rgba(255,149,0,.07);border:1px solid rgba(255,149,0,.28);border-radius:10px">'
      + '<label style="display:flex;align-items:flex-start;gap:9px;font-size:12px;color:#1d1d1f;cursor:pointer;line-height:1.65">'
      + '<input type="checkbox" id="__scan_showexisting"' + (conf.showExistingOnFirstRun !== false ? ' checked' : '') + ' style="width:15px;height:15px;margin-top:2px;accent-color:#ff9500;cursor:pointer;flex:none">'
      + '<span><b style="color:#ff9500">首次 / 改条件时，把当前在售全部推一遍手机</b><br>'
      + '<span style="color:#6e6e73">这是唯一会造成「手机连响几十次」的开关。默认关闭 = 静默建立基线，只推之后真正新上架的。'
      + '勾上后保存会二次确认。</span></span></label>'
      + '</div>'
      + '<div class="tip" style="margin-top:8px;font-size:11px;line-height:1.7;color:#8e8e93">'
      + '· <b>抓简介</b>：推送正文里那行「简介：」是发送时现抓的，每条是一次额外请求。默认 15 条/轮，调大容易引起注意。<br>'
      + '· 简介有缓存（同一商品只抓一次），所以实际请求量比这个数字小得多。</div>'
      + '</div>'
      + '<div style="padding:0 0 4px">'
      + '<div style="font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:10px">重启后的积压推送（改完下一轮生效，不会清库）</div>'
      + '<div class="row2">'
      + '<div><span class="lb">只看最近 N 小时内发布的积压（0=不限）</span>'
      + '<input type="number" id="__scan_bootage" min="0" max="72" step="1" value="' + esc(String(conf.bootPushMaxAgeHours != null ? conf.bootPushMaxAgeHours : 2)) + '">'
      + '</div>'
      + '<div><span class="lb">启动后积压最多推几条（0=不限）</span>'
      + '<input type="number" id="__scan_bootcnt" min="0" max="50" step="1" value="' + esc(String(conf.bootPushMaxCount != null ? conf.bootPushMaxCount : 15)) + '">'
      + '</div>'
      + '</div>'
      + '<div class="tip" style="margin-top:8px;font-size:11px;line-height:1.7;color:#8e8e93">'
      + '关机/退出程序这段时间里上架的货，重新启动后会被一次翻出来。以前这些会全部推到手机，'
      + '关机久一点就一次响几十声。<br>'
      + '现在按<b>条数</b>封顶：只挑综合分最高的那几条推到手机，其余照常进面板（一条不少，只是不响）。'
      + '超过 3 条时并成<b>一条</b>通知，八条货只响一声。<br>'
      + '启动之后<b>真正新上架</b>的货不受这里限制，永远全推。默认：最近 <b>2</b> 小时、最多 <b>15</b> 条。</div>'
      + '</div></div>'
      + '<div class="savebar"><button class="btn g" id="__scan_save">保存并生效</button></div>'
      + '<div class="fr tip" style="margin-top:14px">说明（照闲鱼网页版搜索页顶栏重做）：<br>'
      + '· 「发布时间」= 官网那个「新发布」按钮里的档位：<b>最新 / 1天内 / 3天内 / 7天内 / 14天内</b><br>'
      + '&nbsp;&nbsp;「最新」= 不限时间、按上架时间最新排序（扫货一般用这个，或配 1天内）<br>'
      + '· 「排序」= 官网「综合」下拉里的子项：<b>综合 / 最近活跃 / 信用排序</b><br>'
      + '&nbsp;&nbsp;注意：发布时间选了某个天数后，官网会忽略排序、按综合返回（这里也一样）<br>'
      + '· 「价格排序」= 官网「价格」下拉：<b>不限 / 价格从低到高 / 价格从高到低</b>，优先于上面两个<br>'
      + '· 官网没有「新发布」这个排序选项——它就是上面那个时间按钮，之前这里写错了，已按官网改正<br>'
      + '· 多个标签可同时勾选（如 个人闲置 + 包邮）<br>'
      + '· 价格、区域、标签是服务端筛选；排除词、发布时间、卖家信用在本地二次过滤<br>'
      + '· 「卖家信用」按闲鱼称号过滤：信用极好 &gt; 优秀 &gt; 良好<br>'
      + '· 「屏蔽标题词」按标题匹配（本地即时过滤，不花请求）<br>'
      + '· 「屏蔽内容词」按商品完整页正文匹配（要读一次详情，只对新商品执行，读过会记住）<br>'
      + '· 「屏蔽卖家词」按卖家昵称匹配（本地即时过滤，不花请求）</div>';
    wireBwEditors(v);
    wireMsels(v);
    wireGroups(v);
    wireSections(v);

    function readForm() {
      var out = [];
      v.querySelectorAll('[data-task]').forEach(function (box) {
        var g = function (k) { var e = box.querySelector('[data-f="' + k + '"]'); return e ? e.value.trim() : ''; };
        var num = function (k) { var s = g(k); return s === '' ? null : Number(s); };
        var pick = function (fld) {
          var e = box.querySelector('.msel[data-msel="' + fld + '"] input[type=hidden]');
          return e ? (e.value || '').split(',').filter(Boolean) : [];
        };
        out.push({
          name: (function () {
            var raw = g('name');
            var kw = g('keyword');
            var prov = g('province'), city = g('city'), area = g('area');
            var auto = kw ? kw : ('任务' + (out.length + 1));
            if (prov) auto += ' · ' + prov + (city ? '·' + city : '') + (area ? '·' + area : '');
            /* 老任务保留原名：name 是内部钥匙（基线/水位线/命中记录都拿它当键），
               改了会把历史命中当孤儿清掉。只有新建任务（占位名「新任务」）才自动取名。 */
            return (raw && raw !== '新任务') ? raw : auto;
          })(),
          keyword: g('keyword'),
          minPrice: num('minPrice'), maxPrice: num('maxPrice'),
          province: g('province'), city: g('city'), area: g('area'),
          /* 三个控件各管一件事，和官网顶栏一一对应：
               发布时间 = 官网「新发布」下拉（最新/1天内/3天内/7天内/14天内）
               排序     = 官网「综合」下拉（综合/最近活跃/信用排序）
               价格排序 = 官网「价格」下拉（不限/从低到高/从高到低） */
          sort: g('sort') || 'default',
          publishDays: Number(g('timeSort') || 0),
          priceSort: g('priceSort') || '',
          credit: g('credit'),
          quickFilters: pick('quickFilters'),
          brands: pick('brands'),
          versions: pick('versions'),
          storages: pick('storages').map(Number),
          cpvFilters: (function () {
            var o = {};
            box.querySelectorAll('.msel[data-msel^="cpv:"] input[type=hidden]').forEach(function (e) {
              var pid = e.closest('.msel').getAttribute('data-msel').slice(4);
              var vids = (e.value || '').split(',').filter(Boolean);
              if (vids.length) o[pid] = vids;
            });
            /* 【A 修复 2026-11-04】界面上没画出筛选项时，绝不能当成「用户清空了」。
               判据：这个关键词在 cpvTree 里没有树（说明压根没渲染下拉），
               而配置里这份任务还存着 cpvFilters —— 那就原样保留。否则
               刷新一次页面再点保存，服务器上已选的筛选项就被静默抹掉了。 */
            var kwKey = String(g('keyword') || '').trim().toLowerCase();
            if (!Object.keys(o).length && !cpvTree[kwKey]) {
              var oldCpvVal = (conf && conf.tasks && conf.tasks[out.length] && conf.tasks[out.length].cpvFilters) || null;
              if (oldCpvVal && typeof oldCpvVal === 'object') {
                var keep = {};
                Object.keys(oldCpvVal).forEach(function (k) {
                  var v = oldCpvVal[k];
                  if (v && v.length) keep[k] = v.slice();
                });
                if (Object.keys(keep).length) return keep;
              }
            }
            return o;
          })(),
          mustContain: g('mustContain').split(/[,，\s]+/).filter(Boolean),
          excludeWords: g('excludeWords').split(/[,，\s]+/).filter(Boolean),
          descExcludeWords: g('descExcludeWords').split(/[,，\s]+/).filter(Boolean),
          sellerBlockWords: g('sellerBlockWords').split(/[,，\s]+/).filter(Boolean),
          rowsPerPage: Number(g('rowsPerPage') || 30),
          enabled: !box.querySelector('[data-f="enabled"]') ? true : box.querySelector('[data-f="enabled"]').checked
        });
      });
      return out;
    }

    /* 【cpvFilters 动态筛选 2026-11-04】关键词变化/手动拉取 → 取官方筛选项并重建表单。
       先 readForm() 把已填字段读回 conf.tasks，否则重建会丢未保存输入。 */
    v.querySelectorAll('[data-cpv-fetch]').forEach(function (b) {
      b.onclick = function () {
        var kwInput = b.closest('[data-task]').querySelector('input[data-f="keyword"]');
        var kw = kwInput ? kwInput.value.trim() : '';
        if (!kw) { toast('先在上方输入关键词'); return; }
        conf.tasks = readForm();
        b.textContent = '拉取中…';
        fetchCpvTree(kw, function () { renderFilter(); });
      };
    });
    v.querySelectorAll('input[data-f="keyword"]').forEach(function (inp) {
      var tmr = null;
      var tidx = (function () { var b = inp.closest('[data-task]'); return b ? Number(b.getAttribute('data-task')) : 0; })();
      var doFetch = function () {
        var kw = inp.value.trim();
        if (!kw) return;
        var key = String(kw).toLowerCase();
        /* 【修「打不了字」2026-11-05】关键词输入框 oninput 防抖回调里原来无条件 renderFilter()
           重建整个表单 —— 每次停手 600ms 就把输入框毁了（失焦 + 光标丢），用户还在打字就被打断，
           表现就是「还没打完就像按了回车」。现在：已有筛选项的直接 return（啥也不重建）；
           只有第一次取到这个词的筛选项时才重建一次，并且重建后恢复关键词输入框的焦点和光标，
           取回期间用户又改了词就放弃这次重建，交给下一轮。 */
        /* 【新建任务拉不到筛选项 2026-11-06】以前这里是 `if (cpvTree[key]) return;` ——
           只要这个词在缓存里就直接跳过，可新建任务的框还停在「关键词为空」的样子
           （只画了提示、没画下拉也没画「拉取筛选项」按钮），于是输入缓存过的词时
           既不拉取也不重画，用户看到的就是「什么都没有」。
           现在只有当框里画的正好是这个词时才跳过。 */
        var cpvBoxEl = inp.closest('[data-task]') && inp.closest('[data-task]').querySelector('[data-cpv-kw]');
        var cpvShown = cpvBoxEl ? String(cpvBoxEl.getAttribute('data-cpv-kw') || '') : '';
        if (cpvTree[key] && cpvShown === key) return;
        fetchCpvTree(kw, function () {
          if (inp.value.trim().toLowerCase() !== key) return;
          if (!cpvTree[key]) return;
          conf.tasks = readForm();
          var focusKw = (document.activeElement === inp);
          var ss = focusKw && typeof inp.selectionStart === 'number' ? inp.selectionStart : null;
          var se = focusKw && typeof inp.selectionEnd === 'number' ? inp.selectionEnd : null;
          renderFilter();
          if (focusKw) {
            var ne = document.querySelector('#__scan_view [data-task="' + tidx + '"] input[data-f="keyword"]');
            if (ne) { try { ne.focus(); if (ss != null) ne.setSelectionRange(ss, se); } catch (e) {} }
          }
        });
      };
      inp.oninput = function () {
        if (tmr) clearTimeout(tmr);
        tmr = setTimeout(doFetch, 600);
      };
      inp.onkeydown = function (e) {
        if (e.key === 'Enter') { if (tmr) clearTimeout(tmr); doFetch(); }
      };
    });
    v.querySelector('#__scan_add').onclick = function () {
      conf.tasks = readForm(); conf.tasks.push(newTask()); renderFilter();
    };
    v.querySelectorAll('.del').forEach(function (b) {
      b.onclick = function () {
        var i = Number(b.getAttribute('data-i'));
        conf.tasks = readForm(); conf.tasks.splice(i, 1); if (!conf.tasks.length) conf.tasks.push(newTask()); renderFilter();
      };
    });
    v.querySelectorAll('.chip').forEach(function (c) {
      c.onclick = function () {
        if (c.hasAttribute('data-hot')) return;   /* 热门城市单独处理 */
        c.className = c.className.indexOf('on') >= 0 ? 'chip' : 'chip on';
      };
    });
    /* ---------- 多选下拉（msel）交互 ---------- */
    /* 每个 msel 组件：btn 开关弹层 / checkbox 改 hidden + 摘要 / 全选 / 清空 / 完成。
       hidden input 是唯一数据源，readForm 的 pick() 直接读它，所以保存逻辑完全不用动。
       点组件外任意处关掉所有弹层（mousedown 捕获阶段，避免和 label 的默认行为打架）。 */
    function wireMsels(root) {
      root.querySelectorAll('.msel[data-msel]').forEach(function (m) {
        var fld = m.getAttribute('data-msel');
        var hid = m.querySelector('input[type=hidden]');
        var btn = m.querySelector('.msel-btn');
        var txt = m.querySelector('.ms-txt');
        var pop = m.querySelector('.msel-pop');
        var list = (catalog[fld] || (m.getAttribute('data-cpv-list') ? JSON.parse(m.getAttribute('data-cpv-list')) : []) || []);
        var val = function (q) { return String(q.v !== undefined ? q.v : q.key); };
        var label = function (v) {
          var o = list.filter(function (q) { return val(q) === String(v); })[0];
          return o ? o.label : v;
        };
        var render = function () {
          var arr = (hid.value || '').split(',').filter(Boolean);
          var s = arr.length ? '已选 ' + arr.length + ' 项：' + arr.map(label).join('、') : (m.getAttribute('data-ph') || '不限');
          txt.textContent = s;
          txt.className = 'ms-txt' + (arr.length ? '' : ' ph');
          pop.querySelectorAll('.mp-i').forEach(function (lab) {
            var cb = lab.querySelector('input');
            lab.className = 'mp-i' + (cb.checked ? ' on' : '');
          });
        };
        btn.onclick = function (e) {
          e.stopPropagation();
          var was = m.className.indexOf('open') >= 0;
          root.querySelectorAll('.msel.open').forEach(function (o) { o.className = 'msel'; });
          m.className = was ? 'msel' : 'msel open';
        };
        pop.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
          cb.onchange = function () {
            var set = {};
            (hid.value || '').split(',').filter(Boolean).forEach(function (v) { set[v] = 1; });
            if (cb.checked) set[cb.value] = 1; else delete set[cb.value];
            /* 保持 CATALOG 里的原始顺序，避免保存后配置项顺序变来变去 */
            hid.value = list.map(val).filter(function (v) { return set[v]; }).join(',');
            render();
          };
        });
        var bar = pop.querySelector('.mp-bar');
        bar.querySelector('[data-msall]').onclick = function () { hid.value = list.map(val).join(','); render(); };
        bar.querySelector('[data-msnone]').onclick = function () { hid.value = ''; render(); };
        bar.querySelector('[data-msdone]').onclick = function () { m.className = 'msel'; };
        /* 占位文案存在组件上，render() 里取 */
        m.setAttribute('data-ph', btn.querySelector('.ms-txt').textContent);
      });
    }
    function wireGroups(root) {
      root.querySelectorAll('[data-grp]').forEach(function (g) {
        var gid = g.getAttribute('data-grp');
        var box = g.closest('[data-task]');
        var tidx = box ? box.getAttribute('data-task') : '0';
        var key = '__scan_grp_' + tidx + '_' + gid;
        var st = null;
        try { st = localStorage.getItem(key); } catch (e) {}
        if (st === '0') g.className = 'grp';
        else if (st === '1') g.className = 'grp open';
        var h = g.querySelector('[data-grp-tog]');
        if (!h) return;
        h.onclick = function () {
          var open = g.className.indexOf('open') >= 0;
          g.className = open ? 'grp' : 'grp open';
          try { localStorage.setItem(key, open ? '0' : '1'); } catch (e) {}
        };
      });
    }
    function wireSections(root) {
      var tabs = root.querySelectorAll('.secbar .sectab');
      var panes = root.querySelectorAll('.secpane');
      function activate(name) {
        tabs.forEach(function (t) { t.className = 'sectab' + (t.getAttribute('data-sec') === name ? ' on' : ''); });
        panes.forEach(function (p) { p.className = 'secpane' + (p.getAttribute('data-pane') === name ? ' on' : ''); });
        try { localStorage.setItem('__scan_sec', name); } catch (e) {}
      }
      tabs.forEach(function (t) {
        t.onclick = function () { activate(t.getAttribute('data-sec')); };
      });
      var saved = null;
      try { saved = localStorage.getItem('__scan_sec'); } catch (e) {}
      if (saved && root.querySelector('.sectab[data-sec="' + saved + '"]')) {
        activate(saved);
      }
    }
    document.addEventListener('mousedown', function (e) {
      /* 捕获阶段（第 3 个参数 true）：label 会把 click 转发给里面的 checkbox，
         而 checkbox 的 change 又要冒泡回 label，用冒泡阶段会在关弹层之前
         先把这一跳当成"点在组件外"，导致刚勾上就立刻收起。 */
      var t = e.target;
      while (t && t !== document.body) {
        if (t.classList && String(t.className).indexOf && String(t.className).indexOf('msel') >= 0) return;
        if (t.getAttribute && t.getAttribute('data-msel')) return;
        t = t.parentNode;
      }
      document.querySelectorAll('#__scan_panel .msel.open').forEach(function (o) { o.className = 'msel'; });
    }, true);

    /* 热门城市：点一下即设定省+市，并取消同一任务的其它热门城市高亮 */
    v.querySelectorAll('.chip[data-hot]').forEach(function (c) {
      c.onclick = function () {
        var box = c.closest('[data-task]');
        var parts = c.getAttribute('data-hot').split('|');
        box.querySelectorAll('.chip[data-hot]').forEach(function (x) { x.className = 'chip'; });
        c.className = 'chip on';
        var ps = box.querySelector('[data-f="province"]');
        var cs = box.querySelector('[data-f="city"]');
        var as = box.querySelector('[data-f="area"]');
        if (ps) ps.value = parts[0];
        if (cs) { cs.innerHTML = cityOpts(parts[0], parts[1]); cs.value = parts[1] || ''; }
        if (as) { as.innerHTML = areaOpts(parts[0], parts[1] || '', ''); as.value = ''; }
      };
    });
    /* 省份变化：联动城市下拉，并同步热门城市高亮 */
    v.querySelectorAll('[data-f="province"]').forEach(function (ps) {
      ps.onchange = function () {
        var box = ps.closest('[data-task]');
        var cs = box.querySelector('[data-f="city"]');
        var as = box.querySelector('[data-f="area"]');
        if (cs) { cs.innerHTML = cityOpts(ps.value, ''); cs.value = ''; }
        if (as) { as.innerHTML = areaOpts(ps.value, '', ''); as.value = ''; }
        box.querySelectorAll('.chip[data-hot]').forEach(function (x) {
          var p = x.getAttribute('data-hot').split('|');
          x.className = (p[0] === ps.value && !p[1]) ? 'chip on' : 'chip';
        });
        updateRegCount(box);
      };
    });
    /* 城市变化：同步热门城市高亮 */
    v.querySelectorAll('[data-f="city"]').forEach(function (cs) {
      cs.onchange = function () {
        var box = cs.closest('[data-task]');
        var ps = box.querySelector('[data-f="province"]');
        var as = box.querySelector('[data-f="area"]');
        if (as) { as.innerHTML = areaOpts(ps ? ps.value : '', cs.value, ''); as.value = ''; }
        box.querySelectorAll('.chip[data-hot]').forEach(function (x) {
          var p = x.getAttribute('data-hot').split('|');
          x.className = (p[0] === (ps ? ps.value : '') && (p[1] || '') === cs.value) ? 'chip on' : 'chip';
        });
        updateRegCount(box);
      };
    });
    /* 区县变化 */
    v.querySelectorAll('[data-f="area"]').forEach(function (as) {
      as.onchange = function () {
        var box = as.closest('[data-task]');
        box.querySelectorAll('.chip[data-hot]').forEach(function (x) { x.className = 'chip'; });
        updateRegCount(box);
      };
    });
    /* 显示当前可选数量，方便确认不是只有几个 */
    function updateRegCount(box){
      var ps = box.querySelector('[data-f="province"]');
      var cs = box.querySelector('[data-f="city"]');
      var as = box.querySelector('[data-f="area"]');
      var el = box.querySelector('.__scan_regcount');
      if (!el) return;
      var prov = ps ? ps.value : '';
      var city = cs ? cs.value : '';
      var nc = citiesOf(prov).length;
      var na = areasOf(prov, city).length;
      var txt = '';
      if (prov) txt += nc + ' 市';
      if (prov && city) txt += ' / ' + na + ' 区县';
      el.textContent = txt;
    }
    /* 初始渲染时也显示一次数量 */
    v.querySelectorAll('[data-task]').forEach(function (box) { updateRegCount(box); });
    /* 推送卡片的按钮要等 innerHTML 落地后再绑 */
    bindNotifyUI();
    /* 清除地区 */
    v.querySelectorAll('.__scan_clearregion').forEach(function (b) {
      b.onclick = function () {
        var box = b.closest('[data-task]');
        var ps = box.querySelector('[data-f="province"]');
        var cs = box.querySelector('[data-f="city"]');
        var as = box.querySelector('[data-f="area"]');
        if (ps) ps.value = '';
        if (cs) { cs.innerHTML = cityOpts('', ''); cs.value = ''; }
        if (as) { as.innerHTML = areaOpts('', '', ''); as.value = ''; }
        box.querySelectorAll('.chip[data-hot]').forEach(function (x) { x.className = 'chip'; });
      };
    });
    v.querySelector('#__scan_save').onclick = function () {
      conf.tasks = readForm();
      var bad = conf.tasks.find(function (t) { return !t.keyword; });
      if (bad) { toast('有任务没填关键词'); return; }
      /* 商贩自动识别参数：以前界面上没有入口，只能手改 config.json 再重启。
         现在跟着"保存并生效"一起提交，服务端 merge 进 config（见 monitor.cjs 的
         ["intervalSeconds","jitterSeconds","notify","publishTimeOffsetHours",
          "autoBlockSellers","autoBlockMinCount","autoBlockWindowDays",
          "autoBlockByName","autoBlockByDeals","autoBlockMinDeals",
          "autoBlockByShop","autoBlockMinItems","autoBlockMaxProbePerRound"] 白名单）。
         注意：这些键都不在 sigOfTask 里，所以改它们不会触发清库重建。 */
      var abMin = document.getElementById('__scan_abmin');
      var abDays = document.getElementById('__scan_abdays');
      var abOn = document.getElementById('__scan_abon');
      var abName = document.getElementById('__scan_abname');
      var abDeals = document.getElementById('__scan_abdeals');
      var abMDeal = document.getElementById('__scan_abmdeal');
      var abShop = document.getElementById('__scan_abshop');
      var abMItems = document.getElementById('__scan_abmitems');
      var abProbe = document.getElementById('__scan_abprobe');
      /* 【修 BUG-A】保存时带清库令牌：服务端只有在 confirmClear===REBUILD 时才会清
         被改条件的那个任务的旧命中记录。少了它，服务端只改配置、不动数据（防误清）。 */
      var payload = { tasks: conf.tasks, confirmClear: 'REBUILD' };
      if (abMin) payload.autoBlockMinCount = Math.max(2, Math.min(200, Number(abMin.value) || 5));
      if (abDays) payload.autoBlockWindowDays = Math.max(1, Math.min(30, Number(abDays.value) || 7));
      if (abOn) payload.autoBlockSellers = !!abOn.checked;
      if (abName) payload.autoBlockByName = !!abName.checked;
      if (abDeals) payload.autoBlockByDeals = !!abDeals.checked;
      if (abMDeal) payload.autoBlockMinDeals = Math.max(1, Math.min(99999, Number(abMDeal.value) || 100));
      if (abShop) payload.autoBlockByShop = !!abShop.checked;
      if (abMItems) payload.autoBlockMinItems = Math.max(1, Math.min(9999, Number(abMItems.value) || 40));
      if (abProbe) payload.autoBlockMaxProbePerRound = Math.max(0, Math.min(40, Number(abProbe.value) || 0));
      /* 推送配置：只收集用户实际填了的字段（空串 = 保留旧值，见服务端 mergeNotifyConfig）。
         凭据类 input 初始 value="" 且 placeholder 写"已配置"，所以留空天然表示"不改"。 */
      payload.notify = readNotifyForm();
      /* 基线补货时效闸门：0 = 不过滤（旧行为），默认 24 小时 */
      var seedAgeEl = document.getElementById('__scan_seedage');
      if (seedAgeEl) payload.seedMaxAgeHours = Math.max(0, Math.min(720, Number(seedAgeEl.value) || 0));
      /* 命中精度四项：都不在 sigOfTask 里，改完只影响下一轮，不会触发清库。
         注意 0 是合法值（0=关闭闸门），不能用 Number(v)||默认值，否则用户填 0 会被顶回默认。 */
      var incPagesEl = document.getElementById('__scan_incpages');
      if (incPagesEl) { var iv = incPagesEl.value.trim(); payload.incrementalPages = iv === '' ? 3 : Math.max(1, Math.min(10, Number(iv) || 3)); }
      var freshAgeEl = document.getElementById('__scan_freshage');
      if (freshAgeEl) { var fv = freshAgeEl.value.trim(); payload.freshMaxAgeHours = fv === '' ? 24 : Math.max(0, Math.min(720, Number(fv) || 0)); }
      var phPriceEl = document.getElementById('__scan_phpricemax');
      if (phPriceEl) { var pv = phPriceEl.value.trim(); payload.placeholderPriceMax = pv === '' ? 10 : Math.max(0, Math.min(1000, Number(pv) || 0)); }
      var strictStEl = document.getElementById('__scan_strictstorage');
      if (strictStEl) payload.storageStrict = !!strictStEl.checked;
      /* 重启积压闸门两项：0 也是合法值（0=不限制），不能用 Number(v)||默认值 */
      var smEl = document.getElementById("__scan_startmode");
      if (smEl) { payload.startMode = (String(smEl.value) === "auto") ? "auto" : "hold"; }
      var rgEl = document.getElementById("__scan_resumegap");
      if (rgEl) { var rgv = rgEl.value.trim(); payload.resumeMinGapSec = rgv === "" ? 180 : Math.max(0, Math.min(3600, Math.round(Number(rgv) || 0))); }
      /* 【基线节奏 2026-11-04】四个原来只能手改 config.json 的键。
         注意 deepSweep / autoOpen / showExistingOnFirstRun 默认都是 true，
         用 "!== false" 判断，不能写 if(el) payload.x = el.checked（那样未渲染时会变成 false）。 */
      var dsEl = document.getElementById('__scan_deepsweep');
      if (dsEl) payload.deepSweep = !!dsEl.checked;
      var dmpEl = document.getElementById('__scan_deepmaxpages');
      if (dmpEl) { var dmpv = dmpEl.value.trim(); payload.deepMaxPages = dmpv === '' ? 50 : Math.max(1, Math.min(50, Math.round(Number(dmpv) || 50))); }
      var dprEl = document.getElementById('__scan_deepperround');
      if (dprEl) { var dprv = dprEl.value.trim(); payload.deepPagesPerRound = dprv === '' ? 3 : Math.max(1, Math.min(20, Math.round(Number(dprv) || 3))); }
      var dgEl = document.getElementById('__scan_deepgapms');
      if (dgEl) { var dgv = dgEl.value.trim(); payload.deepPageGapMs = dgv === '' ? 4000 : Math.max(1200, Math.min(60000, Math.round(Number(dgv) || 4000))); }
      /* 【其他开关 2026-11-04】 */
      var mdrEl = document.getElementById('__scan_maxdescround');
      if (mdrEl) { var mdrv = mdrEl.value.trim(); payload.maxDescPerRound = mdrv === '' ? 15 : Math.max(0, Math.min(30, Math.round(Number(mdrv) || 0))); }
      var aoEl = document.getElementById('__scan_autoopen');
      if (aoEl) payload.autoOpen = !!aoEl.checked;
      var seEl = document.getElementById('__scan_showexisting');
      if (seEl) payload.showExistingOnFirstRun = !!seEl.checked;
      var bootAgeEl = document.getElementById('__scan_bootage');
      if (bootAgeEl) { var bav = bootAgeEl.value.trim(); payload.bootPushMaxAgeHours = bav === '' ? 2 : Math.max(0, Math.min(72, Number(bav) || 0)); }
      var bootCntEl = document.getElementById('__scan_bootcnt');
      if (bootCntEl) { var bcv = bootCntEl.value.trim(); payload.bootPushMaxCount = bcv === '' ? 15 : Math.max(0, Math.min(50, Number(bcv) || 0)); }
      /* 【首次全量推 二次确认 2026-11-04】这是唯一会造成「手机连响几十次」的开关。
         用户 11/2 就被这个刷过屏（当时 maxItemsPerMessage=1，几十条在售 = 几十次通知）。
         只在「关→开」时拦一次；已经是开的、再保存不该反复弹。 */
      var wasShowExisting = !(conf && conf.showExistingOnFirstRun === false);
      if (payload.showExistingOnFirstRun === true && wasShowExisting === false) {
        var okGo = window.confirm(
          '确定要打开「首次/改条件时把当前在售全部推一遍手机」吗？\n\n' +
          '· 当前在售有多少条，手机就会连响多少次\n' +
          '· 每条通知之间没有间隔（受「每条几条」设置影响）\n\n' +
          '如果只是想看看有什么货，直接在面板里翻列表就行，不用开这个。'
        );
        if (!okGo) {
          payload.showExistingOnFirstRun = false;
          try { var seEl2 = document.getElementById('__scan_showexisting'); if (seEl2) seEl2.checked = false; } catch (e) {}
          toast('已取消：保持静默建立基线');
          return;
        }
      }
      toast('保存中...');
      fetch('/__scan/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.ok) { toast('已生效，下一轮扫描即刻使用'); setTimeout(loadHits, 400); tab = 'list'; switchTab(); } else toast('失败:' + d.error); })
        .catch(function (e) { toast('失败:' + e.message); });
    };
  }
  /* 【下拉选渠道 2026-10-29】"清除"标记不再单独存一份数组：每个渠道的净空状态
     已经由 notifyDraft[chan].cleared 记着了（未显示的渠道也必须记住，否则切走再切回、
     或直接点保存时，清除标记就丢了）。这里只保留从草稿拼 payload 的逻辑。 */

  /* 从推送卡片读表单。规则：
     · 凭据/地址类（data-nf="chan.field"）空串 → 不放进 payload（服务端保留旧值）
     · 勾选框 data-nch="chan" → channels[chan].enabled
     · generic.type 是 select，始终提交（它有默认值，不存在"没说"的情况）
     · 数字字段空串 → 不提交（用服务端默认值）
     · 点了"清除"的字段 → channels[chan].__clear = ['field'] + 该字段空串
     关键：数据来源是 notifyDraft（含未显示的渠道），不是 DOM。先 notifyCommitPanel()
     把当前显示的渠道同步进草稿，再整份拼——否则未显示的渠道会被当成"全部取消勾选"。 */
  function readNotifyForm() {
    /* 兜底：正常路径下 notifyCard() 已经初始化过草稿，但如果保存被别处触发
       （或卡片渲染失败），这里补一次，避免 notifyDraft 为 null 时抛异常把整次保存带走。 */
    if (!notifyDraft) notifyInitState();
    notifyCommitPanel();
    var out = { channels: {} };
    var on = document.getElementById('__scan_nt_on');    if (on) out.enabled = !!on.checked;
    var per = document.getElementById('__scan_nt_per');
    if (per && per.value.trim() !== '') out.maxItemsPerMessage = Math.max(1, Math.min(50, Number(per.value) || 15));
    var to = document.getElementById('__scan_nt_timeout');
    if (to && to.value.trim() !== '') out.timeoutMs = Math.max(3000, Math.min(120000, Number(to.value) || 15000));
    var dp = document.getElementById('__scan_nt_drop');
    if (dp) out.priceDropNotify = !!dp.checked;
    var dpp = document.getElementById('__scan_nt_droppct');
    if (dpp && dpp.value.trim() !== '') out.priceDropPct = Math.max(0.005, Math.min(0.9, (Number(dpp.value) || 3) / 100));
    var oi = document.getElementById('__scan_nt_onlyinc');
    if (oi) out.onlyIncreaseRenotify = !!oi.checked;

    NOTIFY_CHANS.forEach(function (C) {
      var d = notifyDraft[C.key] || { enabled: false, vals: {}, cleared: [] };
      var o = { enabled: !!d.enabled };
      C.fields.forEach(function (F) {
        var v = d.vals[F.f];
        if (F.type === 'select') { o[F.f] = v || F.options[0][0]; return; }
        if (F.type === 'number') {
          if (v === '' || v == null) return;              /* 空 = 不改，用服务端默认 */
          var nn = Number(v); if (isFinite(nn)) o[F.f] = nn;
          return;
        }
        if (v != null && String(v).trim() !== '') o[F.f] = String(v);   /* 空 = 不改 */
      });
      (d.cleared || []).forEach(function (f) {
        o[f] = '';
        if (!Array.isArray(o.__clear)) o.__clear = [];
        if (o.__clear.indexOf(f) < 0) o.__clear.push(f);
        /* gotify 的 token 被清掉后渠道本身就没法用了，顺手取消勾选，
           免得保存后界面显示"已启用"但实际发不出去 */
        if (C.key === 'gotify' && f === 'token') o.enabled = false;
      });
      out.channels[C.key] = o;
    });
    return out;
  }

  /* 测试单个渠道 / 全部已启用渠道。提成模块级是因为下拉重绘后按钮会被重建，
     不能只在 bindNotifyUI 的闭包里活着。 */
  function notifyDoTest(chan) {
    var box = document.getElementById('__scan_nt_result');
    var showRes = function (d) {
      if (!box) return;
      if (d.empty) { box.textContent = d.msg || '没有启用任何渠道'; box.style.color = '#ff3b30'; return; }
      var parts = (d.results || []).filter(function (r) { return r.channel !== 'log'; }).map(function (r) {
        return (r.ok ? '✅ ' : '❌ ') + r.channel + (r.ok ? '' : '（' + (r.errors && r.errors[0] ? r.errors[0] : '失败') + '）');
      });
      box.innerHTML = parts.join('　');
      box.style.color = d.ok ? '#34c759' : '#ff3b30';
    };
    if (box) { box.textContent = '测试中...'; box.style.color = '#8e8e93'; }
    fetch('/__scan/notifytest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chan ? { chan: chan } : {}) })
      .then(function (r) { return r.json(); })
      .then(showRes)
      .catch(function (e) { if (box) { box.textContent = '测试失败: ' + e.message; box.style.color = '#ff3b30'; } });
  }

  /* 推送卡片上的按钮：下拉切换 / 看记录 / 测试全部。
     渠道内的「测试」「清除」由 notifyBindChanCtl() 负责（每次重绘都重绑）。 */
  function bindNotifyUI() {
    var sel = document.getElementById('__scan_nt_chan');
    if (sel) {
      sel.onchange = function () {
        notifyCommitPanel();          /* 先把当前渠道刚敲的字收进草稿 */
        notifyCurChan = this.value;
        notifyRedrawChan();           /* 再渲染新渠道 */
      };
    }
    /* 首次渲染选中的渠道。放在这里而不是 notifyCard() 里，是因为 notifyCard 只返回字符串，
       那时元素还没进 DOM，innerHTML 赋值会把它冲掉。 */
    notifyRedrawChan();
    var all = document.getElementById('__scan_nt_testall');
    if (all) all.onclick = function () { notifyDoTest(null); };
    var hist = document.getElementById('__scan_nt_hist');
    var histBox = document.getElementById('__scan_nt_histbox');
    var statsEl = document.getElementById('__scan_nt_stats');
    if (hist && histBox) {
      hist.onclick = function () {
        if (histBox.style.display !== 'none') { histBox.style.display = 'none'; return; }
        histBox.style.display = 'block';
        histBox.textContent = '读取中...';
        fetch('/__scan/notifyhist?t=' + Date.now()).then(function (r) { return r.json(); }).then(function (d) {
          if (statsEl) statsEl.textContent = '累计成功 ' + ((d.stats && d.stats.sent) || 0) + ' 次 / 失败 ' + ((d.stats && d.stats.failed) || 0) + ' 次　价格记忆 ' + (d.priceMemoryCount || 0) + ' 件';
          var its = d.items || [];
          if (!its.length) { histBox.textContent = '还没有推送记录。点「测试全部已启用渠道」发一条试试。'; return; }
          histBox.innerHTML = its.map(function (x) {
            var ok = x.ok !== false;
            return '<div style="padding:3px 0;border-bottom:1px solid #d1d1d6">'
              + '<span style="color:' + (ok ? '#34c759' : '#ff3b30') + '">' + (ok ? '✅' : '❌') + '</span> '
              + esc(String(x.channel || '')) + ' · ' + esc(String(x.at || '').replace('T', ' ').slice(0, 19))
              + ' · ' + esc(String(x.title || '').slice(0, 40))
              + (ok ? '' : '<br><span style="color:#ff3b30">' + esc(String(x.error || '').slice(0, 160)) + '</span>')
              + '</div>';
          }).join('');
        }).catch(function (e) { histBox.textContent = '读取失败: ' + e.message; });
      };
    }
    /* 记录面板一进来就先显示一次累计统计 */
    if (statsEl) {
      fetch('/__scan/notifyhist?t=' + Date.now()).then(function (r) { return r.json(); }).then(function (d) {
        statsEl.textContent = '累计成功 ' + ((d.stats && d.stats.sent) || 0) + ' 次 / 失败 ' + ((d.stats && d.stats.failed) || 0) + ' 次　价格记忆 ' + (d.priceMemoryCount || 0) + ' 件';
      }).catch(function () {});
    }
  }

  function taskForm(t, i) {
    var opts = function (list, val, vk, lk) { return list.map(function (o) { var v = vk ? o[vk] : o; var l = lk ? o[lk] : o; return '<option value="' + esc(v) + '"' + (String(v) === String(val) ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join(''); };
    /* 多选下拉：收起时显示"已选 N 项：A、B"，点开是勾选清单 + 全选/清空。
       仍然写 hidden input（data-f 同名）→ readForm 的 pick() 不用改，语义完全不变。
       说明：list 项可能是 {key,label}（筛选标签）或 {v,label}（品牌/容量/版本），
       取值时统一按 q.v!==undefined ? q.v : q.key，和原 chips 取值逻辑一致。 */
    var msel = function (fld, list, sel, placeholder) {
      var selN = (sel || []).length;
      var txt = selN ? '已选 ' + selN + ' 项：' + (sel || []).map(function (v) {
        var o = (list || []).filter(function (q) { return String((q.v !== undefined ? q.v : q.key)) === String(v); })[0];
        return o ? o.label : v;
      }).join('、') : placeholder;
      var items = (list || []).map(function (q) {
        var val = (q.v !== undefined) ? q.v : q.key;
        var on = (sel || []).indexOf(val) >= 0;
        return '<label class="mp-i' + (on ? ' on' : '') + '"><input type="checkbox" value="' + esc(val) + '"' + (on ? ' checked' : '') + '>'
          + '<span>' + esc(q.label) + '</span></label>';
      }).join('');
      return '<div class="msel" data-msel="' + fld + '">'
        + '<input type="hidden" data-f="' + fld + '" value="' + esc((sel || []).join(',')) + '">'
        + '<button type="button" class="msel-btn"><span class="ms-txt' + (selN ? '' : ' ph') + '">' + esc(txt) + '</span><span class="ms-arw">▼</span></button>'
        + '<div class="msel-pop">'
        + '<div class="mp-bar"><span data-msall>全选</span><span data-msnone>清空</span><span data-msdone>完成</span></div>'
        + items + '</div></div>';
    };
    /* 【cpvFilters 动态筛选 2026-11-04】动态筛选项下拉：复用 msel 的 DOM 结构，
       选项列表来自官方下发的 tabList（data-cpv-list），不是 catalog 里的手机词表。 */
    var cpvMsel = function (pid, values, sel) {
      var list = (values || []).map(function (q) { return { v: String(q.vid != null ? q.vid : ''), label: q.label || String(q.vid != null ? q.vid : '') }; });
      var selN = (sel || []).length;
      var txt = selN ? '已选 ' + selN + ' 项：' + (sel || []).map(function (v) {
        var o = list.filter(function (q) { return String(q.v) === String(v); })[0];
        return o ? o.label : v;
      }).join('、') : '不限';
      var items = list.map(function (q) {
        var on = (sel || []).indexOf(String(q.v)) >= 0;
        return '<label class="mp-i' + (on ? ' on' : '') + '"><input type="checkbox" value="' + esc(q.v) + '"' + (on ? ' checked' : '') + '>'
          + '<span>' + esc(q.label) + '</span></label>';
      }).join('');
      return '<div class="msel" data-msel="cpv:' + esc(pid) + '" data-cpv-list="' + esc(JSON.stringify(list)) + '">'
        + '<input type="hidden" data-f="cpv:' + esc(pid) + '" value="' + esc((sel || []).join(',')) + '">'
        + '<button type="button" class="msel-btn"><span class="ms-txt' + (selN ? '' : ' ph') + '">' + esc(txt) + '</span><span class="ms-arw">▼</span></button>'
        + '<div class="msel-pop">'
        + '<div class="mp-bar"><span data-msall>全选</span><span data-msnone>清空</span><span data-msdone>完成</span></div>'
        + items + '</div></div>';
    };
    var cpvBox = function (t) {
      var kw = String(t.keyword || '').trim();
      /* 【新建任务拉不到筛选项 2026-11-06】记下这个框按哪个词画的。
         空词时是空串；输入关键词后靠它判断「需不需要重画」。 */
      var cpvShownKw = String(kw).toLowerCase();
      var groups = kw ? (cpvTree[String(kw).toLowerCase()] || []) : [];
      var header = '<div style="display:flex;align-items:center;gap:10px;justify-content:space-between">'
        + '<span style="font-size:13px;font-weight:600;color:#1d1d1f">官方筛选项（跟着关键词走）</span>'
        + (kw ? '<button type="button" class="btn" data-cpv-fetch style="padding:4px 10px;font-size:12px">' + (groups.length ? '重新拉取' : '拉取筛选项') + '</button>' : '')
        + '</div>';
      var body;
      if (!kw) {
        body = '<div class="tip" style="font-size:11px;line-height:1.7;color:#8e8e93">先在上方输入关键词，这里会自动出现闲鱼官网搜这个词时的那排筛选项（品牌 / 容量 / 版本 / 成色 / 尺码…），勾选后由服务端按类目属性精准筛。</div>';
      } else if (!groups.length) {
        body = '<div class="tip" style="font-size:11px;line-height:1.7;color:#8e8e93">关键词「' + esc(t.keyword) + '」的筛选项还没取到。点右上角「拉取筛选项」，或保存后等程序扫一轮，会自动拿到。</div>';
      } else {
        body = '';
        for (var i = 0; i < groups.length; i += 3) {
          body += '<div class="row">';
          var j = i;
          for (; j < i + 3 && j < groups.length; j++) {
            var g = groups[j];
            body += '<div><span class="lb">' + esc(g.pname || g.pid) + '</span>' + cpvMsel(g.pid, g.values || [], (t.cpvFilters && t.cpvFilters[g.pid]) || []) + '</div>';
          }
          for (; j < i + 3; j++) body += '<div></div>';
          body += '</div>';
        }
      }
      return '<div class="fr" style="margin-bottom:12px" data-cpv-kw="' + esc(cpvShownKw) + '">' + header + body + '</div>';
    };
    var provOpts = function (cur) {
      var groups = catalog.regionGroups || [];
      var out = '';
      groups.forEach(function (g) {
        out += '<optgroup label="' + esc(g.name) + '">';
        (g.list || []).forEach(function (it) {
          out += '<option value="' + esc(it.p) + '"' + (it.p === cur ? ' selected' : '') + '>' + esc(it.p) + '</option>';
        });
        out += '</optgroup>';
      });
      return out;
    };
    var hotChips = function (t2) {
      return (catalog.hotCities || []).map(function (h) {
        var on = (t2.province === h.province) && ((t2.city || '') === (h.city || ''));
        return '<div class="chip' + (on ? ' on' : '') + '" data-hot="' + esc(h.province) + '|' + esc(h.city) + '">' + esc(h.label) + '</div>';
      }).join('');
    };
    var grpSummary = function (t2) {
      var parts = [];
      parts.push(t2.province ? (t2.province + (t2.city ? ' · ' + t2.city : '') + (t2.area ? ' · ' + t2.area : '')) : '全国');
      parts.push((t2.minPrice != null || t2.maxPrice != null)
        ? ('¥' + (t2.minPrice != null ? t2.minPrice : '') + ' ~ ' + (t2.maxPrice != null ? t2.maxPrice : ''))
        : '价格不限');
      return parts.join(' · ');
    };
    var grp = function (gid, title, summary, body) {
      return '<div class="grp" data-grp="' + gid + '">'
        + '<div class="grp-h" data-grp-tog><span class="grp-chev">▶</span><span class="grp-t">' + esc(title) + '</span><span class="grp-s">' + esc(summary) + '</span></div>'
        + '<div class="grp-b">' + body + '</div></div>';
    };
    var generalBody = '<div style="margin-bottom:12px"><span class="lb">热门城市（点一下即选）</span><div class="chips">' + hotChips(t) + '</div></div>'
      + '<div class="row" style="margin-top:0">'
      + '<div><span class="lb">省份</span><select data-f="province" class="__scan_prov"><option value="">不限</option>' + provOpts(t.province) + '</select></div>'
      + '<div><span class="lb">城市</span><select data-f="city" class="__scan_city">' + cityOpts(t.province, t.city) + '</select></div>'
      + '<div><span class="lb">区 / 县</span><select data-f="area" class="__scan_area">' + areaOpts(t.province, t.city, t.area) + '</select></div>'
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">'
      + '<button type="button" class="btn __scan_clearregion" style="flex:0 0 auto">清除地区</button>'
      + '<span class="__scan_regcount" style="font-size:11px;color:#8e8e93;white-space:nowrap"></span>'
      + '</div>'
      + '<div class="row">'
      + '<div><span class="lb">最低价</span><input type="number" data-f="minPrice" value="' + (t.minPrice == null ? '' : t.minPrice) + '" placeholder="不限"></div>'
      + '<div><span class="lb">最高价</span><input type="number" data-f="maxPrice" value="' + (t.maxPrice == null ? '' : t.maxPrice) + '" placeholder="不限"></div>'
      + '<div><span class="lb">每轮取几条</span><input type="number" data-f="rowsPerPage" value="' + (t.rowsPerPage || 30) + '" min="5" max="30"></div>'
      + '</div>'
      + '<div class="row">'
      + '<div><span class="lb">发布时间（官网「新发布」）</span><select data-f="timeSort">' + opts(catalog.publishDays || [], String(Number(t.publishDays || 0)), 'v', 'label') + '</select></div>'
      + '<div><span class="lb">排序（官网「综合」）</span><select data-f="sort">' + opts(catalog.sorts, t.sort || 'default', 'key', 'label') + '</select></div>'
      + '<div><span class="lb">价格排序（官网「价格」）</span><select data-f="priceSort">' + opts(catalog.priceSorts || [{ key: '', label: '不限' }], t.priceSort || '', 'key', 'label') + '</select></div>'
      + '</div>'
      + '<div class="row">'
      + '<div><span class="lb">筛选标签（官网顶栏那排，可多选同时生效）</span>' + msel('quickFilters', catalog.quickFilters, t.quickFilters, '不限') + '</div>'
      + '<div><span class="lb">卖家信用</span><select data-f="credit">' + opts(catalog.credits || [], t.credit || '', 'v', 'label') + '</select></div>'
      + '<div></div>'
      + '</div>'
      + '<div class="row2" style="margin-top:12px">'
      + '<div><span class="lb">必须包含关键词（标题里都要有）</span><input type="text" data-f="mustContain" value="' + esc((t.mustContain || []).join(',')) + '" placeholder="如：iphone,国行"></div>'
      + '<div><span class="lb">扫描节奏</span><div class="tip" style="font-size:11px;line-height:1.6;color:#8e8e93">'
      + '每轮最多翻 ' + (conf.maxPages || 4) + ' 页；间隔 ' + (conf.intervalSeconds || 240) + ' 秒。<br>'
      + '这两项在 config.json 里改（改完重启监控生效），面板不改它，避免误调把风控触发。'
      + '</div></div>'
      + '</div>';
    var blockBody = '<div class="row2" style="margin-top:0">'
      + bwEditor('excludeWords', '屏蔽标题词（标题里有就不要，快，不花请求）', t.excludeWords, '标题本地即时过滤')
      + bwEditor('descExcludeWords', '屏蔽内容词（商品完整页正文里有就不要）', t.descExcludeWords, '要读详情，只对新商品执行')
      + bwEditor('sellerBlockWords', '屏蔽卖家词（卖家昵称里有就不要）', t.sellerBlockWords, '比卖家昵称，本地即时过滤')
      + '</div>'
      + '<div class="row2" style="margin-top:10px">'
      + '<div class="tip" style="font-size:11px;line-height:1.6;color:#8e8e93">'
      + '标签上的「命中 N」= 这个词到现在为止拦掉过多少条商品（0 命中的会变灰，可以考虑删）。<br>'
      + '输入框里敲<b>回车</b>或<b>逗号</b>就变成一个标签；直接从别处<b>粘贴一串</b>会自动拆成多个标签；点标签上的 <b>×</b> 删单个。'
      + '</div></div>';
    var blkSummary = '已设 ' + (t.excludeWords || []).length + '+' + (t.descExcludeWords || []).length + '+' + (t.sellerBlockWords || []).length + ' 个词';
    return '<div class="fr" data-task="' + i + '">'
      + '<div class="hd"><span class="n">任务 ' + (i + 1) + '</span>'
      + '<span class="tn" title="任务名（自动生成，作内部标识）">' + esc(t.name || '未命名') + '</span>'
      + '<input type="hidden" data-f="name" value="' + esc(t.name) + '">'
      + '<label style="font-size:12px;color:#8e8e93;display:flex;align-items:center;gap:5px"><input type="checkbox" data-f="enabled"' + (t.enabled === false ? '' : ' checked') + '>启用</label>'
      + '<button class="del" data-i="' + i + '">删除</button></div>'
      + '<div class="row">'
      + '<div><span class="lb">搜索关键词</span><input type="text" data-f="keyword" value="' + esc(t.keyword) + '" placeholder="如：苹果"></div>'
      + '<div></div>'
      + '<div></div>'
      + '</div>'
      + cpvBox(t)
      + grp('general', '通用筛选', grpSummary(t), generalBody)
      + grp('block', '屏蔽词筛选', blkSummary, blockBody)
      + '</div>';
  }

  /* ---------- 侧边栏项 ---------- */
  var ourBtn = null;
  function buildNavItem() {
    var nav = getNav(); if (!nav) return false;
    if (nav.querySelector('[data-scan-nav]')) { ourBtn = nav.querySelector('[data-scan-nav]'); return true; }
    var ref = nav.querySelector('button'); if (!ref) return false;
    var btn = ref.cloneNode(true);
    btn.setAttribute('data-scan-nav', '1');
    btn.setAttribute('aria-label', NAV_LABEL); btn.setAttribute('title', NAV_LABEL);
    btn.removeAttribute('aria-current');
    var collapsed = isCollapsed();
    btn.className = 'group relative flex h-11 w-full items-center rounded-xl transition-colors ' + (collapsed ? 'justify-center' : 'gap-3 px-3.5') + ' text-slate-500 hover:bg-slate-100 hover:text-slate-900';
    var spans = btn.querySelectorAll('span');
    if (spans[0]) spans[0].innerHTML = ICON;
    if (spans[1]) spans[1].textContent = NAV_LABEL;
    for (var i = 2; i < spans.length; i++) spans[i].remove();
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var el = document.getElementById(PANEL_ID);
      if (el && el.style.display === 'block') closePanel(); else openPanel();
    });
    nav.appendChild(btn); ourBtn = btn; return true;
  }
  function setActive(on) {
    if (!ourBtn) return;
    var collapsed = isCollapsed();
    var cls = 'group relative flex h-11 w-full items-center rounded-xl transition-colors ' + (collapsed ? 'justify-center' : 'gap-3 px-3.5') + ' '
      + (on ? 'bg-brand text-white shadow-brand-active' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900');
    if (ourBtn.getAttribute('data-cls') === cls) return;
    ourBtn.setAttribute('data-cls', cls); ourBtn.className = cls;
    var s = ourBtn.querySelectorAll('span');
    if (s[0]) { var svg = s[0].querySelector('svg'); if (svg) svg.setAttribute('class', 'h-[19px] w-[19px] ' + (on ? 'text-white' : 'text-slate-400')); }
  }
  function syncCollapsed() { if (!ourBtn) return; var el = document.getElementById(PANEL_ID); setActive(!!(el && el.style.display === 'block')); }

  var tries = 0;
  function boot() { tries++; if (buildNavItem()) { syncCollapsed(); return true; } if (tries < 120) setTimeout(boot, 500); return false; }

  /* 独立模式启动：不需要侧边栏，直接把面板铺满整页。
     #__scan_panel 的 CSS 是 position:fixed;inset:0，本来就占满视口，
     所以这里只要 buildPanel() + display:block 就等于"独立页面"。
     顺手把 index.html 的加载占位（#boot）删掉，否则它会盖在面板上面。 */
  function startStandalone() {
    var b = document.getElementById('boot');
    if (b) b.parentNode.removeChild(b);
    openPanel();
  }

  function start() {
    if (STANDALONE) { startStandalone(); return; }
    boot();
    var pending = false;
    var obs = new MutationObserver(function () {
      if (pending) return; pending = true;
      requestAnimationFrame(function () {
        pending = false;
        if (!getNav()) return;
        if (!document.querySelector('[data-scan-nav]')) buildNavItem();
        syncCollapsed();
      });
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
