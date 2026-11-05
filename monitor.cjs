const path=require("path"),fs=require("fs"),http=require("http"),crypto=require("crypto");
/* 让 fetch 信任 Windows 系统证书库：加速器/企业代理会把根证书装进系统库，
   Node 默认只认自带 Mozilla 根证书，不合并就会报 unable to verify the first certificate，
   推送与公告全部失败。必须在任何 fetch 之前执行。 */
try{ require("./lib-systemca.cjs"); }catch(e){}
/* 运行组件（node + playwright）位置探测 —— 便于把整个文件夹搬到别的电脑/别的盘：
   1) 环境变量 YX_PW（可选）
   2) 本目录 runtime\playwright-driver\package（便携包自带）
   3) runtime.txt 第一行 + \playwright-driver\package
   4) 环境变量 YX_PW / runtime.txt 指定的任意位置
   不再引用 Ydisks闲鱼助手 的安装目录 —— 那是别的程序，卸载会连坐。 */
function _resolvePW(){
  const cand=[];
  if(process.env.YX_PW) cand.push(process.env.YX_PW);
  cand.push(path.join(__dirname,"runtime","playwright-driver","package"));
  try{
    const t=String(fs.readFileSync(path.join(__dirname,"runtime.txt"),"utf8")).replace(/^\uFEFF/,"").split(/\r?\n/)[0].trim();
    if(t) cand.push(path.join(t,"playwright-driver","package"));
  }catch(e){}
  /* 早先这里硬编码了 Ydisks闲鱼助手 的安装路径做兜底，现已删除 ——
     那是另一个程序的目录，对方卸载/升级就会把本程序一起带死。
     仍想复用旧目录的话，设环境变量 YX_PW=<...>\playwright-driver\package 即可。 */
  for(const c of cand){ try{ if(fs.existsSync(path.join(c,"package.json"))) return c; }catch(e){} }
  return cand[0];
}
const PW=_resolvePW();
/* 浏览器目录也从 PW 反推，不依赖任何启动脚本 export 环境变量。
   否则任何启动方式（托盘 / 直接 node monitor.cjs / 计划任务）
   都会去找 C:\Users\...\ms-playwright，然后报 Executable doesn't exist。
   显式设过环境变量的仍然优先，不自作主张覆盖。 */
if(!process.env.PLAYWRIGHT_BROWSERS_PATH){
  try{
    const b=path.join(path.dirname(path.dirname(PW)),"playwright-browsers");
    if(fs.existsSync(b)) process.env.PLAYWRIGHT_BROWSERS_PATH=b;
  }catch(e){}
}
const {chromium}=require(PW);
const ROOT=path.resolve(__dirname);
const DATA=path.join(ROOT,"data");
const CFGF=path.join(ROOT,"config.json");
const HITSF=path.join(DATA,"hits.json");
const SEENF=path.join(DATA,"seen.json");
const LOGF=path.join(DATA,"monitor.log");
const DESCCF=path.join(DATA,"desc-cache.json");
const INJECT=path.join(ROOT,"panel","inject.js");
/* 【网页图标 2026-11-03】由用户提供的原图离线生成了 icon.ico（多尺寸）与 icon-web.png，
   浏览器标签页原来没有图标（默认空白纸），现在改成这个。
   放成常量而不是每次请求现读，是因为字体图标是静态资源，读一次缓存着就够。 */
const FAVICON=path.join(ROOT,"assets","favicon.ico");
const ICONPNG=path.join(ROOT,"assets","icon-web.png");
/* 【署名 2026-11-03】版本号与作者。这两个是程序身份，不是用户配置项，所以写死成常量；
   构建时间取本文件 mtime，改一次代码自动跟着变，不用手动维护。
   下发给面板的是 /__scan/hits.json 里新增的 about 字段（见下方 payload）。 */
const APP_VERSION="1.0.0";
const APP_AUTHOR="Wethon";
let APP_BUILT="";
try{ APP_BUILT=fs.statSync(__filename).mtime.toISOString(); }catch(e){ APP_BUILT=""; }
const ABOUT={version:APP_VERSION,author:APP_AUTHOR,builtAt:APP_BUILT};
/* APP_HOST/APP_PORT 曾是宿主程序（Ydisks闲鱼助手，59188）的地址，用于反向代理。
   独立化后不再有任何对外依赖，这两个常量已删除。 */
const APPKEY="34839810";
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";
const md5=s=>crypto.createHash("md5").update(s).digest("hex");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
/* 可中断等待：关闭时最多 250ms 内响应，不用等完整间隔 */
async function nap(ms){
  const end=Date.now()+ms;
  while(Date.now()<end){
    if(stop) return;
    await sleep(Math.min(250,end-Date.now()));
  }
}
/* 【修 BUG-N：点【停止监控】后最长要等 20 分钟才退出】
   主循环的结构是「先 nap，再检查 while(!stop)」。而限流冷却
   SCHED=[300000,600000,1200000] 最长 20 分钟，nap(preCool) 一次睡满；
   shutdown() 虽然早已把 stop 置成 true，主线程还睡在 nap 里出不来。
   表现：面板点【停止】→ 接口回执 200 → 用户以为停了 → 进程还在跑最多 20 分钟，
   期间继续发请求（更容易被平台限流）、继续写文件。
   nap 本身每 250ms 检查 stop，但那只是"提前 return"，调用方拿到返回后仍然
   继续往下跑完这一轮的日志/推送，并没有真的 break 出主循环。
   这里加一个会明确返回"该不该退出"的版本，让调用方直接 break。 */
async function napBreakable(ms){
  const end=Date.now()+ms;
  while(Date.now()<end){
    if(stop) return "stop";
    /* 【连点保护 2026-11-04】点「暂停」也立刻跳出这次等待：
       否则一轮结束后最长要睡 interval+jitter（约 7 分钟），这期间点开始/暂停都不生效，
       用户会以为按钮坏了，连点几次反而堆出更多轮。 */
    if(holdOn) return "hold";
    await sleep(Math.min(250,end-Date.now()));
  }
  return stop?"stop":(holdOn?"hold":"");
}
const now=()=>new Date().toLocaleString("zh-CN");
/* 【修「日志只增不删」】monitor.log 以前只 append 永不轮转：
   实测 3493 行 / 266 KB，按 1500 行/天估一月 6 MB、一年 72 MB。
   现在每写 400 行检查一次大小，超过 LOG_MAX 就把当前文件改名成
   monitor.log.1（旧的 .1 覆盖掉），只保留一代 —— 最多占 2 份，不会无限增长。
   检查用计数器而不是每次 statSync，避免每行一次系统调用。 */
const LOG_MAX=5*1024*1024;
let __logN=0;
function __logRotate(){
  try{
    const st=fs.statSync(LOGF);
    if(st.size<LOG_MAX) return;
    const bak=LOGF+".1";
    try{ if(fs.existsSync(bak)) fs.unlinkSync(bak); }catch(e){}
    fs.renameSync(LOGF,bak);
  }catch(e){}
}
function log(...a){
  const l="["+now()+"] "+a.join(" ");
  console.log(l);
  try{
    /* 顺序很关键：必须先判断轮转再 append。
       反过来写的话，轮转时机是「写完这一行之后」，rename 会把刚写的行一起搬进 .1，
       而 monitor.log 在这一瞬间不存在 —— 正好被别的 statSync 撞上就 ENOENT。 */
    if(++__logN>=400){ __logN=0; __logRotate(); }
    fs.appendFileSync(LOGF,l+"\r\n");
  }catch(e){}
}
/* ============================================================================
 * 推送层 / 价格记忆（从 second-eye 移植，见 notify.cjs、price-memory.cjs）
 * ----------------------------------------------------------------------------
 * 为什么单独成文件而不是继续塞进本文件：
 *   1) 本文件已经 3991 行，再加 700 行推送逻辑会让人不敢改；
 *   2) 这两个模块必须能单独测（假 HTTP 服务器抓包），塞在 monitor.cjs 里
 *      就得连带启动 chromium，根本没法测；
 *   3) 老 notify() 只有 13 行，替换它不涉及任何扫描逻辑，隔离风险。
 * bindLogger 把本文件的 log() 注入进去，让它们的日志也进 monitor.log。
 * ========================================================================== */
const notifyLayer = require("./notify.cjs");
const priceMemory = require("./price-memory.cjs");
notifyLayer.bindLogger(log);
priceMemory.bindLogger(log);
/* 单一事实来源：让 notify.cjs 的重复抑制读价格记忆，而不是自己再存一份 */
notifyLayer.bindPriceMemory(priceMemory);

/* 读 JSON：必须剥掉 UTF-8 BOM。
   BOM 的坑是实测踩出来的：用 PowerShell（Set-Content -Encoding UTF8 / Out-File / ConvertTo-Json | Set-Content）
   改过 config.json，会写成 ef bb bf 开头。JSON.parse 遇到 U+FEFF 直接抛，
   而这里以前是静默 catch 回默认值 —— 表现是「任务数: 0 | 间隔: 90s」、
   端口莫名变回 59288、筛选条件全丢，日志里一句话都不说，极难查。
   现在先剥 BOM 再解析，并以 _readJSONRaw 留存原始调用点行为。 */
const readJSON=(f,d)=>{
  try{
    let s=fs.readFileSync(f,"utf8");
    if(s.charCodeAt(0)===0xFEFF) s=s.slice(1);
    return JSON.parse(s);
  }catch(e){
    /* 文件存在但解析失败 ≠ 文件不存在，必须喊出来，否则配置被静默丢弃 */
    try{
      if(fs.existsSync(f)&&fs.statSync(f).size>2) log("⚠ 读取失败，已退回默认值: "+path.basename(f)+" —— "+String(e.message).slice(0,110));
    }catch(e2){}
    return d;
  }
};
/* 写 JSON：先留一份 .bak 再覆盖。
   为什么必须留 .bak：hits.json / seen.json / seller-blocklist.json 这些文件
   全是「整体覆盖写」，一旦逻辑判错（条件被误判成"变了"）、接口被误触（/__scan/clear 无确认），
   数据就是永久丢失。以前只 catch 不备份，实测一次误 POST 就把 738 条命中清成 []。
   现在每次覆盖前先把旧文件复制成 <name>.bak，最坏情况还能手工捞回来。 */
const writeJSON=(f,v)=>{
  try{
    try{ if(fs.existsSync(f)&&fs.statSync(f).size>2) fs.copyFileSync(f,f+".bak"); }catch(e2){}
    fs.writeFileSync(f,JSON.stringify(v,null,2));
  }catch(e){log("写文件失败",f,e.message)}
};

/* ===== 发布时间字符串：统一格式 + 容错解析 =====
   【修「全是前几天的商品」根因 B】旧版 publishAt 用
     new Date(pt+off).toLocaleString("zh-CN")
   生成，V8 的中文 locale 在【月/日是个位数时不补零】：
     2026/10/8 12:35:08    ← 10 月 8 日
     2026/11/5 17:10:36    ← 11 月 5 日
   而全项目解析统一用
     Date.parse(s.replace(/\//g,"-").replace(" ","T"))
   → Date.parse("2026-10-8T12:35:08") 在 V8 里返回 **NaN**。
   后果：① 列表按发布时间倒序时这些条目被当成 0 → 沉到最底或排序整体错乱；
        ② 面板「最近24小时」把它们整条丢掉；
        ③ 「新」标记永远不显示。
   两处一起修：生成时补零（fmtPublishAt），解析时手工拆（parsePublishAt），
   这样即使历史文件里全是没补零的老字符串，也能正确解析。 */
function pad2n(n){ n=Number(n)||0; return (n<10?"0":"")+n; }
function fmtPublishAt(ms){
  const t=Number(ms);
  if(!isFinite(t)||t<=0) return "";
  const d=new Date(t);
  if(!isFinite(d.getTime())) return "";
  return d.getFullYear()+"/"+pad2n(d.getMonth()+1)+"/"+pad2n(d.getDate())
    +" "+pad2n(d.getHours())+":"+pad2n(d.getMinutes())+":"+pad2n(d.getSeconds());
}
/* 容错解析：支持 2026/10/8 12:35:08 · 2026-10-08T12:35:08 · ISO · 纯时间戳。
   关键是不依赖 Date.parse 对"月日不补零"的实现差异 —— 手工用 new Date(y,m-1,d,h,mi,s) 重建。 */
function parsePublishAt(s){
  if(s==null||s==="") return NaN;
  if(typeof s==="number") return isFinite(s)?s:NaN;
  const str=String(s).trim();
  /* 带 Z 或带 ±HH:MM 时区偏移的（ISO / RFC3339）必须交给 Date.parse：
     它们表示的是绝对时刻，手工 new Date(y,m,d,...) 只能按本地时区解释，会整体偏 8 小时。
     实测偏差：foundAt="2026-10-21T12:00:57.276Z" 被手工解析成 04:00:57 本地 → 与真实时刻差 28800000ms。
     hitFoundMs 吃它做 ?since= 增量和 ETag 的 maxFoundAt，这个偏差会让增量过滤整段错位。 */
  if(/(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(str)){
    const tz=Date.parse(str);
    if(isFinite(tz)) return tz;
  }
  const m=/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/.exec(str);
  if(m){
    const d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),
      Number(m[4]||0),Number(m[5]||0),Number(m[6]||0));
    const t=d.getTime();
    if(isFinite(t)&&d.getDate()===Number(m[3])) return t;   /* getDate 回读校验，防 2/30 这类溢出 */
    /* 月份/日期越界（2/30、13/45）：不接受任何兜底，直接判无效，
       否则 Date.parse 会把 2026/2/30 静默解释成 3/2。 */
    if(Number(m[2])>=1&&Number(m[2])<=12&&Number(m[3])>=1&&Number(m[3])<=31) return NaN;
  }
  const t=Date.parse(str);
  return isFinite(t)?t:NaN;
}

/* 取一条命中的"发布时间毫秒数"，永远返回数字（拿不到返回 0）。
   优先级：publishTime（接口原始毫秒，最可靠）→ publishTimeAdjusted → publishAt 字符串。
   旧代码就地写 `h.publishTime||h.publishAt||h.publishTimeAdjusted` 再参与加减/比较，
   publishAt 是字符串时 `"2026/10/21 17:10:36" - 0` 得到 NaN，排序和"最近 N 天"全失效。 */
function publishMsOf(h){
  if(!h) return 0;
  const a=Number(h.publishTime||0);
  if(isFinite(a)&&a>0) return a;
  const b=Number(h.publishTimeAdjusted||0);
  if(isFinite(b)&&b>0) return b;
  const c=parsePublishAt(h.publishAt);
  return isFinite(c)&&c>0?c:0;
}

/* 命中的入库时间，统一换算成毫秒数。
   为什么需要这个函数：hits 里的 foundAt 是**ISO 字符串**（"2026-10-21T08:06:25.335Z"），
   不是时间戳数字。早期版本的 /__scan/hits.json 增量过滤直接写 Number(h.foundAt)，
   结果恒为 NaN → 过滤结果恒为空、ETag 恒为 h<N>-0 → 新命中进来 ETag 不变 →
   前端带 If-None-Match 永远拿到 304，**永远看不到新货**。
   这里同时兼容数字、ISO 字符串、以及老的 "2026/10/21 15:48:51" 格式。 */
function hitFoundMs(h){
  if(!h) return 0;
  const v=h.foundAt;
  if(typeof v==="number"&&isFinite(v)) return v;
  const t=parsePublishAt(v);
  if(isFinite(t)) return t;
  /* 兜底：没有 foundAt 的老记录用 publishTime / publishAt 顶，至少还能排序与增量。 */
  const p=Number(h.publishTime||0);
  if(isFinite(p)&&p>0) return p;
  const p2=parsePublishAt(h.publishAt);
  return isFinite(p2)?p2:0;
}

/* 【修 BUG-S】hits 上限 3000 的两处静默丢弃：
   ① 新命中优先保留，被挤出的老记录以前直接蒸发（无日志、无备份），用户永远不知道丢了货；
   ② 建基线 seed 时 add 拼在尾部，slice 恰好把刚加进去的又砍掉，却仍 log「新增 N 条」。
   现在统一走 capHits：超出部分按 itemId 去重累积到 data/hits-overflow.json，并 log 出差额。 */
const OVERFLOWF=path.join(DATA,"hits-overflow.json");
function capHits(list,why){
  if(!Array.isArray(list)) return [];
  if(list.length<=3000) return list;
  const keep=list.slice(0,3000);
  const spill=list.slice(3000);
  try{
    let ov=[];
    try{ ov=JSON.parse(fs.readFileSync(OVERFLOWF,"utf8")); }catch(e){ ov=[]; }
    if(!Array.isArray(ov)) ov=[];
    const have={}; ov.forEach(function(x){ if(x&&x.itemId) have[x.itemId]=1; });
    const add=[];
    spill.forEach(function(x){ if(x&&x.itemId&&!have[x.itemId]){ have[x.itemId]=1; add.push(x); } });
    if(add.length){
      ov=ov.concat(add);
      /* 溢出归档同样设上限，防止无限膨胀 */
      if(ov.length>20000) ov=ov.slice(ov.length-20000);
      writeJSON(OVERFLOWF,ov);
    }
    log("⚠ 命中列表已满（上限 3000）："+(why||"本轮")+" 挤出 "+spill.length+" 条，已归档到 data/hits-overflow.json（累计 "+ov.length+" 条）");
  }catch(e){ log("⚠ 命中列表已满，挤出 "+spill.length+" 条但归档失败："+e.message); }
  return keep;
}


/* 取签名 token（_m_h5_tk）必须按【域名】挑，不能 cs.find() 抓第一个。
   原因（2026-10-21 实测踩到）：同一个浏览器上下文里 .goofish.com 和 .taobao.com
   各有一个同名的 _m_h5_tk，两者是**完全不同**的签名密钥。cs.find() 只看名字、
   返回数组里第一个，于是可能把 taobao 的 token 拿去给 goofish 的 mtop 算 sign，
   MD5 一变服务端就回 `FAIL_SYS_ILLEGAL_ACCESS::非法请求`。
   这个错误的迷惑之处：它长得像封号/限流，实际只是取错域；
   而且 taobao 那份过期消失后（本次就是 16:23:58 过期）程序会「自己好」。
   排序：先精确 goofish 域，再退回非 taobao 域，最后才兜底任意同名 cookie。 */
function goofishTokenOf(list){
  const arr=Array.isArray(list)?list:[];
  const tk=arr.filter(function(c){ return c&&c.name==="_m_h5_tk"; });
  if(!tk.length) return "";
  const score=function(c){
    const d=String(c.domain||"").toLowerCase();
    if(d==="www.goofish.com") return 0;
    if(d==="goofish.com"||d===".goofish.com") return 1;
    if(d.indexOf("goofish")>=0) return 2;
    if(d.indexOf("taobao")>=0||d.indexOf("tmall")>=0||d.indexOf("alicdn")>=0) return 9;
    return 5;
  };
  tk.sort(function(a,b){ return score(a)-score(b); });
  return String(tk[0].value||"").split("_")[0];
}
/* 直接取整个 cookie 值（含 _过期时间戳 后缀），少数场景需要原样比对 */
function goofishTokenRaw(list){
  const arr=Array.isArray(list)?list:[];
  const tk=arr.filter(function(c){ return c&&c.name==="_m_h5_tk"; });
  if(!tk.length) return "";
  tk.sort(function(a,b){
    return (String(a.domain||"").indexOf("goofish")>=0?0:9)-(String(b.domain||"").indexOf("goofish")>=0?0:9);
  });
  return String(tk[0].value||"");
}

/* ===== 闲鱼支持的筛选目录（全部实测验证过） ===== */
const CATALOG={
  quickFilters:[
    {key:"filterPersonal",label:"个人闲置"},
    {key:"filterAppraise",label:"验货宝"},
    {key:"gameAccountInsurance",label:"验号担保"},
    {key:"filterFreePostage",label:"包邮"},
    {key:"filterHighLevelYxpSeller",label:"超赞鱼小铺"},
    {key:"filterNew",label:"全新"},
    {key:"inspectedPhone",label:"严选"},
    {key:"filterOneKeyResell",label:"转卖"}
  ],
  /* 【2026-10-17 重新核对官网顶栏，逐项照抄】
     官网搜索页顶栏实际是 4 个控件，各有各的下拉：
       · 综合 ⌄   → 综合 / 最近活跃 / 距离最近 / 信用排序
       · 新降价   → 一个开关（只看刚降价的），不是排序项
       · 新发布 ⌄ → 最新 / 1天内 / 3天内 / 7天内 / 14天内   ← 时间档位在「新发布」里面
       · 价格 ⌄   → 价格从低到高 / 价格从高到低
     所以面板也照这个结构给三栏：排序(综合系) / 发布时间(新发布系) / 价格排序。
     之前把「新发布」当成排序里的一个选项，是错的 —— 官网没有这个选项。 */
  sorts:[
    {key:"default",label:"综合",sortField:"",sortValue:""},
    {key:"modify",label:"最近活跃",sortField:"modify",sortValue:"desc"},
    {key:"credit",label:"信用排序",sortField:"credit",sortValue:"credit_desc"}
  ],
  /* 「价格」下拉：和发布时间可以同时用（价格排序 + 时间过滤） */
  priceSorts:[
    {key:"",label:"不限",sortField:"",sortValue:""},
    {key:"priceAsc",label:"价格从低到高",sortField:"price",sortValue:"asc"},
    {key:"priceDesc",label:"价格从高到低",sortField:"price",sortValue:"desc"}
  ],
  /* 热门城市（点一下即用） */
  hotCities:[
    {label:"北京",province:"北京",city:""},{label:"上海",province:"上海",city:""},
    {label:"广州",province:"广东",city:"广州"},{label:"深圳",province:"广东",city:"深圳"},
    {label:"杭州",province:"浙江",city:"杭州"},{label:"天津",province:"天津",city:""},
    {label:"武汉",province:"湖北",city:"武汉"},{label:"成都",province:"四川",city:"成都"},
    {label:"重庆",province:"重庆",city:""},{label:"南京",province:"江苏",city:"南京"},
    {label:"苏州",province:"江苏",city:"苏州"},{label:"东莞",province:"广东",city:"东莞"},
    {label:"西安",province:"陕西",city:"西安"},{label:"佛山",province:"广东",city:"佛山"},
    {label:"长沙",province:"湖南",city:"长沙"},{label:"郑州",province:"河南",city:"郑州"}
  ],
  /* 按大区整理的完整省市（含区县）；由 regions.json 注入，见 initCatalog() */
  regionGroups:[],
  /* 兼容旧字段：所有省名 */
  provinces:[],
  /* 「新发布」下拉里的时间档，文字与闲鱼网页版逐字一致：最新 / 1天内 / 3天内 / 7天内 / 14天内 */
  publishDays:[{v:0,label:"最新"},{v:1,label:"1天内"},{v:3,label:"3天内"},{v:7,label:"7天内"},{v:14,label:"14天内"}],
  /* 卖家信用：取自搜索结果标签，本地过滤 */
  credits:[{v:"",label:"不限"},{v:"极好",label:"信用极好"},{v:"优秀",label:"信用优秀及以上"},{v:"良好",label:"信用良好及以上"}],
  /* 品类：决定 localFilter 走哪一套闸门（v2026-11-02）
     phone   = 手机数码：原有的品牌/版本/容量/机型词/配件词五道闸门全开（老行为，默认）
     generic = 通用：只要关键词/价格/地区/信用/屏蔽词，不做机型、容量、配件判断
     加这一档的直接原因：keyword=显卡 时，标题永远命中不了 DEVICE_KEYS，
     30 条里 30 条被判「非目标品类」丢掉 —— 不是没货，是闸门只认识手机。 */
  categories:[
    {v:"phone",label:"手机数码"},
    {v:"generic",label:"通用"}
  ],
  /* 以下三项为本地标签筛选：直接匹配商品标题里的品牌/容量/版本 */
  brands:[
    {v:"apple",label:"Apple/苹果",k:["apple","苹果","iphone","ipad","macbook","airpods","imac","iwatch"]},
    {v:"huawei",label:"华为",k:["华为","huawei"]},
    {v:"honor",label:"荣耀",k:["荣耀","honor"]},
    {v:"xiaomi",label:"小米/红米",k:["小米","xiaomi","redmi","红米"]},
    {v:"oppo",label:"OPPO",k:["oppo"]},
    {v:"vivo",label:"vivo/iQOO",k:["vivo","iqoo"]},
    {v:"samsung",label:"三星",k:["三星","samsung","galaxy"]},
    {v:"oneplus",label:"一加",k:["一加","oneplus"]},
    {v:"realme",label:"真我",k:["realme","真我"]},
    {v:"meizu",label:"魅族",k:["魅族","meizu"]},
    {v:"nubia",label:"努比亚/红魔",k:["努比亚","nubia","红魔"]},
    {v:"sony",label:"索尼",k:["索尼","sony","xperia"]},
    {v:"nokia",label:"诺基亚",k:["诺基亚","nokia"]},
    {v:"zte",label:"中兴",k:["中兴","zte"]},
    {v:"google",label:"Google",k:["google","pixel","谷歌"]}
  ],
  storages:[
    {v:64,label:"64G"},{v:128,label:"128G"},{v:256,label:"256G"},
    {v:512,label:"512G"},{v:1024,label:"1T"}
  ],
  versions:[
    {v:"cn",label:"国行",k:["国行","行货"]},
    {v:"hk",label:"港版",k:["港版","港行"]},
    {v:"us",label:"美版",k:["美版"]},
    {v:"jp",label:"日版",k:["日版"]},
    {v:"kr",label:"韩版",k:["韩版"]},
    {v:"eu",label:"欧版",k:["欧版"]}
  ]
};

/* 完整省市区（由 regions.json 提供；缺文件则退化为仅省份） */
const REGIONF=path.join(ROOT,"regions.json");
const REGIONS=readJSON(REGIONF,[]);

/* ===== 地区反查表（给 localFilter 做本地兜底校验）=====
   【优化#2】为什么需要这张表：
   地区筛选从头到尾 100% 依赖服务端 extraFilter（见 callSearch 里的 divisionList），
   本地一次都没校验过。后果有两个，都实测踩过：
     ① config 里 province/city 为空时（历史上真有过全国搜索的配置），服务端不按地区收窄，
        外省货直接涌进来；
     ② 即使 province/city 正确，闲鱼也会偶尔塞跨省推荐位。
   实测证据：一次「解除屏蔽」把名单 hidden 里的历史记录回灌，列表里立刻多出 458 条外省货
   （江苏 180 / 广东 89 / 天津 69 / 四川 30 / 湖北 28 / 辽宁 23 / 陕西 16 …），
   全部是 area 字段写省级名的外省记录。
   所以这里按 regions.json 建三张反查表，本地再判一次。
   关键点：area 字段的粒度不统一 —— 本地货给区县名（"秀峰区"），外省货常直接给省名（"江苏"），
   所以三种粒度都要能对上；区县名跨市会重名（"和平区"天津有、沈阳也有），因此表里存数组而不是单值。 */
const REGION_IDX=(function(){
  const provSet=new Set();
  const cityMap={};   /* 市名 -> [省, …] */
  const areaMap={};   /* 区县名 -> [{prov,city}, …] */
  try{
    (Array.isArray(REGIONS)?REGIONS:[]).forEach(function(g){
      (g&&g.list||[]).forEach(function(p){
        const pn=String((p&&p.p)||"").replace(/\s+/g,"");
        if(!pn) return;
        provSet.add(pn);
        (p.c||[]).forEach(function(x){
          const cn=String((x&&x.n)||"").replace(/\s+/g,"");
          if(cn){
            if(!cityMap[cn]) cityMap[cn]=[];
            if(cityMap[cn].indexOf(pn)<0) cityMap[cn].push(pn);
          }
          (x&&x.a||[]).forEach(function(a){
            const an=String(a||"").replace(/\s+/g,"");
            if(!an) return;
            if(!areaMap[an]) areaMap[an]=[];
            const hit=areaMap[an].some(function(e){ return e.prov===pn&&e.city===cn; });
            if(!hit) areaMap[an].push({prov:pn,city:cn});
          });
        });
      });
    });
  }catch(e){}
  return {provSet:provSet,cityMap:cityMap,areaMap:areaMap,
          ok:!!(provSet.size&&Object.keys(areaMap).length)};
})();

/* 地区兜底判定：命中任一层级即算本地。返回 true = 保留。
   粒度规则（target 的省/市/区县会真的下发给服务端，见 callSearch 的 div，
   所以这里只做"服务端有没有漏"的兜底，不是另起一套筛选）：
     · 没设省 → 不限，直接放行
     · area 字段为空 / 反查不到 → 放行（宁可多一条待确认，也不把真货挡在外面），单独计数
     · 与 target 的省/市/区县同名 → 放行
     · 报的是市一级：外省城市丢；同省但明确不是目标市也丢（只限省时放行）
     · 报的是区县一级：指定了区县就只认那一个；没指定就要求落在目标市里
     · 明确是别的省 → 丢 */
/* area 里的俗称/别称 → 标准行政区名。只做「让计数不再掉进地区未识别」，
   没有收录的泛称（浦东、中关村、市辖区…）走 notePass 放行，不会被误挡。 */
const AREA_ALIAS={
  "香港岛":"香港","九龙":"香港","九龙区":"香港","新界":"香港","新界区":"香港",
  "港岛":"香港","澳门半岛":"澳门","氹仔":"澳门","路环":"澳门"
};
function regionOk(task,it){
  let P=String((task&&task.province)||"").replace(/\s+/g,"");
  const C=String((task&&task.city)||"").replace(/\s+/g,"");
  const A=String((task&&task.area)||"").replace(/\s+/g,"");
  let a=String((it&&it.area)||"").replace(/\s+/g,"");
  if(!P&&!C) return true;                    /* 完全不限地区 */
  if(!a){ notePass("地区未知"); return true; }
  a=AREA_ALIAS[a]||a;
  if((A&&a===A)||(C&&a===C)) return true;
  if(!REGION_IDX.ok) return P?true:false;    /* regions.json 缺失：有省按放行，只设市无依据才拦 */
  /* 市名必须先判：省名与省内某市同名的情况真的存在（吉林省 / 吉林市），
     原来的 a===P 提前短路会把「吉林/长春」下 area=吉林 的货当成本地放进来。 */
  const cps=REGION_IDX.cityMap[a];
  if(cps&&cps.length){
    if(P&&cps.indexOf(P)<0) return false;    /* 外省的城市 */
    if(C) return false;                      /* 同省但明确不是目标市（a===C 上面已放行） */
    return true;                             /* 只限省：本省的市都放行 */
  }
  if(P&&a===P) return true;                  /* 报的是省一级：只限省时放行，限到市就无从判断，也放行 */
  const acs=REGION_IDX.areaMap[a];
  if(acs&&acs.length){
    /* 走到这里说明 a 是区县名且不等于指定的区县。指定了区县就只认那一个 ——
       否则「广西/桂林/秀峰区」会把象山区的货全放进来，等于区县筛选没生效。 */
    if(A) return false;
    for(let i=0;i<acs.length;i++){
      const e=acs[i];
      if(P&&e.prov!==P) continue;
      if(!C||e.city===C) return true;
    }
    return false;
  }
  if(REGION_IDX.provSet.has(a)) return false;  /* 明确是别的省 */
  notePass("地区未识别");
  return true;
}

const descCache=readJSON(DESCCF,{});
const cfg=readJSON(CFGF,{tasks:[],intervalSeconds:90,jitterSeconds:30,port:59288,publishTimeOffsetHours:0,maxDescPerRound:15});
if(cfg.maxDescPerRound==null) cfg.maxDescPerRound=15;
if(cfg.maxPages==null) cfg.maxPages=2;
if(cfg.showExistingOnFirstRun==null) cfg.showExistingOnFirstRun=true;
if(cfg.publishTimeOffsetHours==null) cfg.publishTimeOffsetHours=0;
/* 【修「筛选出来的都是前几天的商品」根因 A】基线补货的时效闸门（小时）。
   0 = 关闭闸门（回到旧行为：把 50 页里所有在售都收进面板）。 */
if(cfg.seedMaxAgeHours==null) cfg.seedMaxAgeHours=24;
/* 【新增】常规轮每轮翻几页。1 = 旧行为（只看第 1 页 30 条）。
   实测「苹果 / 广西桂林 / ≤500 / 256+512G」这个条件下，30 条过完价格+品牌+容量+屏蔽词
   常常只剩 2-5 条可用；货源又集中在少数翻新大户手里（前 30 条里二十几条是同一卖家），
   翻 1 页等于每轮只盯这一个人 —— 这是"命中不全面、有漏"的主要来源。
   3 页 = 90 条，覆盖度够用，且限流时仍会被压回 1 页。 */
if(cfg.incrementalPages==null) cfg.incrementalPages=3;
/* 【新增】新命中的发布时效闸门（小时）。发布时间早于这个值的一律只登记 seen、不进 hits。
   0 = 关闭（回到旧行为：翻到几条就报几条，包括几天前的历史在售）。
   监控的语义是「抓新上架」，不是「抓所有在售」，所以默认 24 小时。 */
if(cfg.freshMaxAgeHours==null) cfg.freshMaxAgeHours=24;
/* 【新增】占位价阈值（元）。价格 ≤ 该值且标题带 定金/预售/代购/拍下 等话术的判定为占位价丢弃。
   0 = 关闭。实测混进来的「iPhone Duo 256GB 星光白…苹果官方订单」标价 ¥1，
   它轻松通过 maxPrice 上限，还会在"价格从低到高"里永远霸榜。 */
if(cfg.placeholderPriceMax==null) cfg.placeholderPriceMax=10;
/* 【新增】容量严格模式。false（默认）= 标题和平台标签都没写容量时放行；
   true = 看不出容量就丢（旧行为）。
   背景：旧版把「看不出容量」直接当「容量不符」丢掉，实测一轮 88 条里有 67 条栽在这条规则上，
   而其中绝大多数只是卖家标题没写 256G —— 这是用户反馈"命中不完全、有漏"的最大单一来源。
   需要严格筛的时候在面板里勾上即可。 */
if(cfg.storageStrict==null) cfg.storageStrict=false;
/* 【新增】停机空窗补抓：程序停过一段时间（关机/睡眠/手动关掉）后，
   重启时把断档那段往回扫回来，而不是只看最新 30 条。
   catchupMinGapHours = 池子最新比水位线新多少小时才认为断过档（默认 2，0=关闭补抓）
   catchupMaxPages    = 每轮最多往回补几页（默认 12） */
if(cfg.catchupMinGapHours==null) cfg.catchupMinGapHours=2;
if(cfg.catchupMaxPages==null) cfg.catchupMaxPages=4;
/* catchupPageGapMs = 空窗补抓时页间隔毫秒（默认 3500）。
   补抓是「往回翻历史」，请求比正常增量密得多，间隔太小最容易把账号送进风控。
   2026-11-05 实测：间隔 1600ms、单轮 12 页连翻，一小时就把账号打成「必须过滑块」。 */
if(cfg.catchupPageGapMs==null) cfg.catchupPageGapMs=3500;
/* catchupMaxGapHours = 空窗超过这么多小时就不再往回细补（默认 24，0=不限制）。
   停机两三天后那批历史货早卖出去了，为了它们连翻几十页纯属给账号找风控。
   超过上限时直接把水位线推到最新，只从「现在」往后按增量扫。 */
if(cfg.catchupMaxGapHours==null) cfg.catchupMaxGapHours=24;
/* catchupSilent = 空窗补抓货是否静默收录（默认 true）：true=只进列表不推送，false=当新命中推送 */
if(cfg.catchupSilent==null) cfg.catchupSilent=true;
/* bootPushMaxAgeHours = 重启后第一轮，发布超过这么多小时的积压货只进列表不推送（默认 2，0=不限制）
   bootPushMaxCount    = 重启以来积压货累计最多推几条，按综合分取前 N（默认 15，0=不限制）
   这两个只管「进程启动后的第一轮」，之后每轮照旧，与 catchupSilent / showExistingOnFirstRun 完全独立。 */
if(cfg.bootPushMaxAgeHours==null) cfg.bootPushMaxAgeHours=2;
if(cfg.bootPushMaxCount==null) cfg.bootPushMaxCount=15;
/* 【连点保护】resumeMinGapSec = 点「开始监控」时，距上一轮开始不足这么多秒就不立刻开跑，
   而是顺延到「上一轮开始 + 这么多秒」。默认 180（3 分钟），0 = 关闭保护。
   动机：每点一次「开始监控」= 立刻发一轮请求；1 分钟内连点 5 次 ≈ 10~65 页连发，
   正好撞上代码注释里记的「3~4 页连发从没触发限流，第 5 页才被挤爆」。 */
if(cfg.resumeMinGapSec==null) cfg.resumeMinGapSec=180;
/* 【启动待命 2026-11-04】startMode = 启动后是否立刻开扫。
   "hold"（默认）= 启动后只开浏览器、还原 cookie、**不发任何搜索请求**，等用户点「▶ 开始监控」才发第一个；
   "auto"        = 老行为，启动即扫。
   动机：一启动就连续翻页，用户只是想看看/改条件时账号已经在被翻页了；改完条件再重启又是一串请求。
   待命期间只调 ensurePage()（把登录 cookie 还原进浏览器），完全不碰 mtop 搜索接口。 */
cfg.startMode=(String(cfg.startMode||"")==="auto")?"auto":"hold";
/* 【远程停用公告 2026-11-05】remoteStatusUrl = 开发者放的一个公开状态文件（如 GitHub raw 的 STATUS.json）。
   空 = 关闭。程序启动时 + 每隔几小时检查一次，读到 status:"down" 就自动暂停扫描并在面板弹红条，
   并推一条告警到手机；status:"notice" 只提示不停用；读不到 / 格式错 / status:"ok" 都当正常。 */
if(cfg.remoteStatusUrl==null) cfg.remoteStatusUrl="";
const seen=readJSON(SEENF,{});
let hits=readJSON(HITSF,[]);
/* 面板上的"标记看过/恢复未读"是高频小改动：合并 300ms 内的多次点击只落盘一次，
   避免同步写文件在点击瞬间卡住事件循环（记录多时写盘要几十毫秒）。 */
let hitsWriteTm=null, hitsWriteDirty=false;
function scheduleHitsWrite(){
  hitsWriteDirty=true;
  if(hitsWriteTm) return;
  hitsWriteTm=setTimeout(function(){
    hitsWriteTm=null;
    if(!hitsWriteDirty) return;
    hitsWriteDirty=false;
    try{ writeJSON(HITSF,hits); }catch(e){ log("写记录失败: "+e.message); }
  },300);
}
let baselineDone=Object.keys(seen).length>0;
let lastUpdate=new Date().toISOString();
/* 新鲜度体检：本轮接口给的最新发布时间、登录态。用来一眼看出是不是被风控降级了
   freshInfo.perTask 按任务分别记录；顶层字段（newestAgoMinutes/degraded/scope）取"最差"的那个任务，
   保证老版本面板只读顶层字段也能正常工作。 */
let freshInfo={newestAt:null,newestAgoMinutes:null,scannedAt:null,loginUnb:null,degraded:false,note:"",scope:"",narrowScope:false,perTask:[]};
/* 接口连续失败计数：_m_h5_tk（签名 token）过期时 sign 会算出错，接口只回 FAIL_*。
   连续 2 轮失败 → 在面板上明确提示重新扫码登录，避免"以为在扫、其实什么都没拿到"。 */
let tokenFail=0, tokenWarn=false;
/* 【BUG-R】签名被拒（FAIL_SYS_ILLEGAL_ACCESS）单独计数：
   它跟"token 过期"和"平台限流"都不是一回事 —— 是 sign 用的 _m_h5_tk 取错了域。
   单独计数是为了在日志里给出准确指引，而不是把用户往"等风控"或"重扫码"上带。 */
let signFailRounds=0;
/* 【网络类错误分级 2026-11-04】
   合盖睡眠 / 切 WiFi / 拔网线 / 网卡驱动重载，都会让 page.goto 抛下面这些 ERR_*。
   这类错误和「登录失效」「签名被拒」性质完全不同：它跟账号一点关系都没有，
   只要网络回来就自己好，通常几十秒。以前它和真故障一样挂红字横幅，用户以为程序坏了。
   现在：第 1 轮只记一条灰色软提示（面板不刺眼），连续 2 轮才升级成红字。
   注意：这里【不】动告警（手机推送）—— checkAlerts 的 ALERT_NEED_ROUNDS=2 已经覆盖，
   而且 tokenFail 本来就在 apiFail 判据里被清零，不会误报「token 过期」。 */
const NET_ERR_RE=/net::ERR_INTERNET_DISCONNECTED|net::ERR_NAME_NOT_RESOLVED|net::ERR_NETWORK_CHANGED|net::ERR_NETWORK_IO_SUSPENDED|net::ERR_CONNECTION_RESET|net::ERR_CONNECTION_REFUSED|net::ERR_CONNECTION_TIMED_OUT|net::ERR_ADDRESS_UNREACHABLE|net::ERR_PROXY_CONNECTION_FAILED|net::ERR_TIMED_OUT|net::ERR_ABORTED|getaddrinfo ENOTFOUND|getaddrinfo EAI_AGAIN|fetch failed \(ECONNRESET\)|fetch failed \(ENOTFOUND\)|fetch failed \(ETIMEDOUT\)|Timeout 20000ms exceeded|Timeout 35000ms exceeded/i;
let netErrRounds=0;
/* 【2026-11-05 自动重建浏览器会话】
   现象：接口一直返回 SUCCESS，但最新一条永远停在 6 小时前，翻多少页都一样。
   实测（_re_probe 里 6 组对照）：不是 bx 令牌缺失、不是排序字段、不是地区、不是 headless、
   也不是拦截改写本身 —— 而是本进程长期持有的 browser-profile 里那张 _m_h5_tk 到了临界
   （cookie_health.cjs 实测剩余 0 天），sign 仍能算过，但平台走缓存分支给降级数据。
   每新建一个 context、重新 addCookies，平台会顺手发一张新 _m_h5_tk，数据立刻变回 10 分钟前。
   所以：连续若干轮都是旧数据 → 主动关掉上下文重开一次，让 baxia 重新生成令牌。
   只重建会话，不重登、不改任何筛选条件。 */
const STALE_MIN_AGO=300;          /* 最新一条超过 5 小时 = 本轮判定为旧数据 */
const STALE_ROUNDS_TO_REBUILD=3;  /* 连续这么多轮旧数据才动手，避免偶发抖动误触发 */
const SESSION_REBUILD_MAX=3;      /* 一次运行最多重建 3 次，防止和平台死磕 */
let staleRounds=0;                /* 已连续多少轮拿到旧数据 */
let sessionRebuilds=0;            /* 本次运行已重建几次会话 */
function isNetErr(msg){ return NET_ERR_RE.test(String(msg||"")); }
/* 把一句很长的 playwright 报错压成人能读的一句话：
   原文形如「打开搜索页失败: page.goto: net::ERR_INTERNET_DISCONNECTED at https://…\nCall log:\n  - navigating to …」
   面板只需要知道「断网了」，不需要那一坨调用栈。 */
function netErrBrief(msg){
  const m=String(msg||"");
  if(/ERR_INTERNET_DISCONNECTED/i.test(m)) return "网络已断开";
  if(/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(m)) return "DNS 解析失败（网络未就绪）";
  if(/ERR_NETWORK_CHANGED/i.test(m)) return "网络切换中";
  if(/ERR_NETWORK_IO_SUSPENDED/i.test(m)) return "系统睡眠导致网络挂起";
  if(/ECONNRESET|ERR_CONNECTION_RESET/i.test(m)) return "连接被重置";
  if(/ETIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/i.test(m)) return "连接超时";
  if(/ERR_CONNECTION_REFUSED/i.test(m)) return "连接被拒绝";
  if(/Timeout \d+ms exceeded/i.test(m)) return "页面打开超时";
  if(/ERR_ABORTED/i.test(m)) return "页面加载被打断";
  return "网络异常";
}
/* 平台限流（RGV587「哎哟喂，被挤爆啦」/ FAIL_SYS_USER_VALIDATE 等）：
   请求太频或同一账号多进程同时扫，风控会限流 —— 表现可能是直接报错，
   也可能是"少返"（一页本该 30 条只回几条），结果看起来像"程序没数据"。
   命中后指数退避：60s → 120s → 240s → 480s（最多 8 分钟），期间不再硬扫。 */
let throttle={level:0,until:0,reason:"",at:null,count:0};
/* 下一轮开扫的预计时间，给面板做"距下次刷新 mm:ss"倒计时 */
let nextScanAt=null;
/* 【启动待命 2026-11-04】holdOn=true 表示「已就绪但一个搜索请求都不发」。
   落盘到 data\scan-hold.json，面板和托盘据此渲染按钮、guard 据此知道进程还活着（端口照常在听）。 */
const HOLDF=path.join(DATA,"scan-hold.json");
let holdOn=false;
let holdSince=0;
let holdResumedAt=0;
/* 【连点保护 2026-11-04】点「开始监控」时若距上一轮开始太近，顺延到这个时刻再开跑。
   0 = 没有待顺延。放这里是因为 holdSet / resume 路由 / 主循环都要读它。 */
let resumeNotBefore=0;
function holdSave(){
  try{ writeJSON(HOLDF,{hold:!!holdOn,since:holdSince||0,resumedAt:holdResumedAt||0,mode:String(cfg.startMode||"hold"),at:new Date().toISOString()}); }catch(e){}
}
function holdSet(on,by){
  const was=holdOn;
  const next=!!on;
  /* 幂等：状态没变就什么都不做（不重复写盘、不重复打日志）。
     面板 60 秒轮询一次 hits.json，若这里不判，重复点按钮会刷出一堆同样的日志。 */
  if(was===next) return holdOn;
  holdOn=next;
  if(holdOn){ holdSince=Date.now(); }
  else { holdResumedAt=Date.now(); holdSince=0; }
  holdSave();
  if(was!==holdOn){
    if(holdOn) log("⏸ 已进入待命：不会发出任何搜索请求。点面板「▶ 开始监控」或托盘「开始监控」继续（登录态已就绪，点一下立刻开始）。");
    else log("▶ 已解除待命（"+(by||"手动")+"），开始扫描。");
  }
  return holdOn;
}
let writeRound=0;   /* 无变化时的写盘兜底计数 */
const TASK_STATUS={};   /* 每个任务最近一轮的体检结果 */

/* 【体检状态 2026-10-29】给 面板「体检」按钮 / GET /__scan/selfcheck 用的几个即时量。
   为什么不用现成的 freshInfo：freshInfo 是"每轮扫描结束时"才写的快照，而且顶层字段取
   "最差的那个任务"。用户点「体检」时想知道的是"现在到底什么情况"，包括：
   最后一轮什么时候跑的、有没有报错、内核版本是多少 —— 这些 freshInfo 里都没有。 */
let lastRoundAt=0;          /* 最后一轮 scanOnce 开始的时刻 */
let lastRoundDoneAt=0;      /* 最后一轮 scanOnce 结束的时刻（含异常） */
let lastRoundErr="";        /* 最后一轮 scanOnce 抛出的异常原文（空 = 正常） */
let lastRoundFresh=0;       /* 最后一轮新命中条数 */
let lastRoundSeeded=0;      /* 最后一轮基线补货条数 */
let bootAt=Date.now();      /* 进程启动时刻，用于算运行时长 */
/* 轮次号在启动 IIFE 里声明（let round=0），http 接口那层看不到它 ——
   这里单独镜像一份模块级变量，主循环每轮同步，体检端点读这个。 */
let roundNo=0;
let ctx=null,page=null,stop=false;

/* 关键：Chromium 正常关闭时会删掉"会话级 cookie"（_l_g_ / cookie17 / _nk_ / uc1 / munb 等），
   只留下 unb 这类带过期时间的 —— 结果就是网站把我们当游客，只给约 6 小时前的降级数据。
   所以启动时把登录时存下来的完整 cookie 还原回去。 */
const COOKIEF=path.join(DATA,"cookies.json");
async function restoreCookies(){
  try{
    if(!fs.existsSync(COOKIEF)) return 0;
    const cs=JSON.parse(fs.readFileSync(COOKIEF,"utf8"));
    if(!Array.isArray(cs)||!cs.length) return 0;
    await ctx.addCookies(cs.map(function(c){
      return {name:c.name,value:c.value,domain:c.domain,path:c.path||"/",
        expires:(typeof c.expires==="number"?c.expires:-1),
        httpOnly:!!c.httpOnly,secure:!!c.secure,sameSite:c.sameSite||"Lax"};
    }));
    return cs.length;
  }catch(e){ log("还原 cookie 失败: "+String(e.message).slice(0,90)); return 0; }
}
async function saveCookies(){
  try{
    const cs=await ctx.cookies();
    /* 【2026-11-04 防覆盖】这家网站的登录凭证（sgcookie / tfstk）会随浏览器正常关闭一起被删，
       而本函数是"全量覆盖写" —— 某次重启后 ctx.cookies() 里已经缺了它们，
       这一写就把"残废状态"永久钉死在磁盘上，之后每次启动只能还原出一份没有登录态的 cookie，
       程序从此以游客身份抓到 6 小时前的旧数据，日志里一句话都不说。
       实测证据：11/4 13:43 那份 cookies.json（29 条，无 sgcookie/tfstk）就是这么来的；
       重新扫码后最新货立刻从"6 小时前"变回"13 分钟前"。
       规则：新集合里两个登录主凭证【都没有】→ 跳过本次写入，保留磁盘上原有那份。
             只要有一个在就照常写（_m_h5_tk 需要每轮轮换，不能一刀切不写）。 */
    const names=new Set((cs||[]).map(function(c){return c.name;}));
    if(!names.has("sgcookie")&&!names.has("tfstk")){
      if(!saveCookies._warned){
        saveCookies._warned=true;
        log("⚠ 本次抓到的 cookie 里没有 sgcookie / tfstk（登录凭证），已跳过写入，保留磁盘上原有那份");
      }
      return 0;
    }
    saveCookies._warned=false;
    fs.writeFileSync(COOKIEF,JSON.stringify(cs,null,1));
    return cs.length;
  }catch(e){ return 0; }
}
saveCookies._warned=false;

/* ===== 面板内扫码登录（v2026-10-21）=====
   以前的登录流程有四步：停监控 → 弹一个可见浏览器窗口 → 扫码 → 重启监控。
   其中有两步纯粹是为了"别抢 data\browser-profile 这把锁"。
   实测发现登录身份 100% 存在 data\cookies.json（33 条）里，browser-profile 只是缓存 ——
   把 cookies.json 注入一个全新 profile，首页立刻就是登录态（unb=你的账号ID）。
   所以改成：
     · 用【另一个独立 profile】(data\login-profile) 在后台无头打开 passport 登录页
     · 把二维码 canvas 截成 PNG，面板里直接 <img> 显示
     · 手机扫一下，这里轮询到 unb 出现 → 把新 cookie 注入正在跑的 ctx（addCookies）
     · 不停监控、不弹窗口、不重启
   ---- 已验证的前提（别再改回去）：
     · headless 必须带 --headless=new + 真实 UA，否则 passport 页返回"非法访问"
     · 二维码是 <canvas> 148×148，canvas.toDataURL() 抛 SecurityError（跨域污染），
       只能用 page.screenshot({clip}) 截像素
     · 独立 profile 与 monitor 的 browser-profile 互不干扰（并发启动实测 184ms 成功） */
const LOGINPROF=path.join(DATA,"login-profile");
let loginSess=null;            /* {ctx,page,at,png,err,baseUnb} */
let loginOkAt=0, loginOkUnb=null;   /* 最近一次扫码成功（面板据此收横幅） */
let loginIdleTimer=null;

function loginSessClose(){
  const s=loginSess; loginSess=null;
  if(loginIdleTimer){ clearInterval(loginIdleTimer); loginIdleTimer=null; }
  if(!s||!s.ctx) return;
  try{ s.ctx.close().catch(function(){}); }catch(e){}
}
/* 用户点了二维码又直接关掉网页（没点"取消"）的话，后台那个登录页会一直挂着吃内存。
   10 分钟没有任何请求就自己收掉（用 lastHit 而不是 at —— at 是"开始等待"用来算秒数，
   每轮询一次就刷它的话，面板上永远显示"已等待 0 秒"）。 */
function loginIdleGuard(){
  if(loginIdleTimer) return;
  loginIdleTimer=setInterval(function(){
    if(!loginSess){ if(loginIdleTimer){ clearInterval(loginIdleTimer); loginIdleTimer=null; } return; }
    if(Date.now()-(loginSess.lastHit||0)>600000){
      log("面板扫码登录：10 分钟没动静，自动关闭后台登录页。");
      loginSessClose();
    }
  },30000);
  try{ loginIdleTimer.unref&&loginIdleTimer.unref(); }catch(e){}
}

async function loginSessStart(){
  if(loginSess&&loginSess.ctx) return loginSess;
  loginSessClose();
  const args=["--ignore-certificate-errors","--no-sandbox","--disable-blink-features=AutomationControlled",
    "--headless=new","--window-size=1280,900","--disk-cache-size=268435456"];
  /* 【2026-11-05 修：二维码糊到扫不出来】
     登录页二维码 canvas 内部是 176×176，CSS 只显示 148×148。
     deviceScaleFactor 默认 1 时 Playwright 按 CSS 尺寸出图 → 截图正好 148×148，
     等于把 176 压成 148（0.84 倍非整数缩放），模块边界全糊：
     实测中间灰占比 29.8%，手机很难扫出来。
     给到 3 之后截图 444×444、中间灰 12.1%，边缘干净。
     只影响这个后台登录页的渲染精度，跟主扫描互不影响。 */
  const c=await chromium.launchPersistentContext(LOGINPROF,{
    headless:false,userAgent:UA,locale:"zh-CN",viewport:{width:1440,height:1000},
    deviceScaleFactor:3,
    serviceWorkers:"block",args:args});
  /* 【2026-11-05】这里原来是 headless:true —— Playwright 在 headless 模式下会去找
     chromium_headless_shell-<rev>，那个目录已按用户要求删掉（省 269MB），于是
     /__scan/qr 一律 500「Executable doesn't exist」，面板二维码永远出不来。
     现在改成 headless:false（Playwright 用完整 chromium-1228/chrome-win64/chrome.exe）
     再靠上面 args 里的 --headless=new 让它自己无头运行 —— 与主扫描完全同一个模式，
     屏幕上不弹窗，指纹也比老 headless shell 好。 */
  const p=c.pages()[0]||await c.newPage();
  try{ p.setDefaultTimeout(45000); }catch(e){}
  /* login-profile 是持久化目录，上次扫码的登录态还留着。不清掉的话：
       ① 打开的就是"已登录"页面，根本不出二维码
       ② 一打开就把旧 unb 当成"刚扫到"，面板立刻假报登录成功
     所以进会话第一步就是把它清成未登录态。 */
  let baseUnb=null;
  try{
    await c.clearCookies();
    const cs=await c.cookies();
    baseUnb=(cs.find(function(x){return x.name==="unb";})||{}).value||null;
  }catch(e){}
  loginSess={ctx:c,page:p,at:Date.now(),lastHit:Date.now(),png:null,err:"",baseUnb:baseUnb,finishing:false};
  loginIdleGuard();
  log("面板扫码登录：后台登录页已打开（独立 profile，不影响正在跑的扫描）");
  return loginSess;
}

/* 生成/刷新二维码 PNG。返回 Buffer。
   必须串行：用户手快连点「换一张码」会并发打进来，多个 page.goto 同时跑同一个页面
   会互相打断，后到的全报 "Execution context was destroyed"（实测 4 并发 1 成 3 败）。 */
let loginQrChain=Promise.resolve();
function loginSessQr(forceNew){
  const run=loginQrChain.then(function(){ return loginSessQrOnce(forceNew); },
    function(){ return loginSessQrOnce(forceNew); });
  /* 不让失败污染后续链：把链尾换成"总是成功"的版本 */
  loginQrChain=run.then(function(){},function(){});
  return run;
}
/* 二维码有效期按 90 秒算：闲鱼的码大概两分钟过期，缓存太久会给出扫不了的死码。
   forceNew=true（用户点「换一张码」）时无条件重新出码。 */
const QR_TTL_MS=90000;
async function loginSessQrOnce(forceNew){
  const s=await loginSessStart();
  if(!forceNew&&s.png&&s.pngAt&&Date.now()-s.pngAt<QR_TTL_MS){
    s.lastHit=Date.now();
    return s.png;
  }
  const url="https://passport.goofish.com/mini_login.htm?lang=zh_cn&appName=xianyu&appEntrance=web"
    +"&styleType=vertical&bizParams=&notLoadSsoView=false&notKeepLogin=false&isMobile=false&rnd="+Date.now();
  await s.page.goto(url,{waitUntil:"domcontentloaded",timeout:60000});
  let box=null;
  for(let i=0;i<22&&!box;i++){
    await sleep(600);
    box=await s.page.evaluate(function(){
      const cs=[];
      document.querySelectorAll("canvas").forEach(function(e){
        const r=e.getBoundingClientRect();
        if(r.width>=100&&r.width<=260&&Math.abs(r.width-r.height)<40){
          cs.push({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});
        }
      });
      return cs[0]||null;
    }).catch(function(){ return null; });
  }
  if(!box) throw new Error("登录二维码没渲染出来（passport 页可能被风控拦了），请改用浏览器窗口登录");
  const png=await s.page.screenshot({clip:{x:box.x,y:box.y,width:box.w,height:box.h}});
  s.at=Date.now();
  s.lastHit=Date.now();
  s.png=png;
  s.pngAt=Date.now();
  return png;
}

/* 扫码完成后：把登录页的 cookie 落到 cookies.json，并注入正在跑的浏览器。
   不用重启 —— addCookies 之后 monitor 自己就是登录态了。 */
async function loginSessFinish(){
  const s=loginSess; if(!s||!s.ctx) return {ok:false,err:"没有登录会话"};
  /* 面板每 2.5s 轮询一次，可能两三个请求同时在飞。不收口的话会重复注入 + 重复 close。 */
  if(s.finishing) return {ok:false,err:"正在收尾"};
  let cs;
  try{ cs=await s.ctx.cookies(); }catch(e){ return {ok:false,err:"读登录 cookie 失败: "+e.message}; }
  const unb=(cs.find(function(c){return c.name==="unb";})||{}).value||null;
  /* 必须跟"打开二维码时"的基线比。login-profile 是持久化的，可能残留上次登录的 unb ——
     只判"有没有 unb"会让用户一点开二维码就立刻显示"扫码成功"（假成功）。 */
  if(!unb||unb===s.baseUnb) return {ok:false,err:"还没扫到"};
  s.finishing=true;
  try{ fs.writeFileSync(COOKIEF,JSON.stringify(cs,null,1)); }catch(e){}
  let injected=0;
  if(ctx){
    try{
      await ctx.addCookies(cs.map(function(c){
        return {name:c.name,value:c.value,domain:c.domain,path:c.path||"/",
          expires:(typeof c.expires==="number"?c.expires:-1),
          httpOnly:!!c.httpOnly,secure:!!c.secure,sameSite:c.sameSite||"Lax"};
      }));
      injected=cs.length;
      /* 故意【不】在这里重载 page：这时候很可能正有一轮扫描在飞，goto 会把那次请求打断成
         "Execution context was destroyed"，白丢一轮。
         改成挂一个标记，等下一轮开始（页面空闲）时在 ensurePage 里重载一次 ——
         这样页面上的 baxia 风控令牌也会按新身份重新生成。 */
      pageReloadWanted=true;
    }catch(e){ log("扫码成功但注入当前浏览器失败: "+String(e.message).slice(0,90)+"（cookie 已存盘，重启后照样生效）"); }
  }
  loginSessClose();
  loginOkAt=Date.now(); loginOkUnb=unb;
  try{ await checkLogin(); }catch(e){}
  try{ await saveCookies(); }catch(e){}
  /* 刚登录完不该还挂在限流冷却里：清掉退避，让下一轮马上跑 */
  throttle.until=0; throttle.level=0; throttle.reason=""; throttle.count=0;
  nextScanAt=new Date().toISOString();
  log("面板扫码登录成功：unb="+unb+"，已注入当前浏览器 "+injected+" 条 cookie（未重启）");
  return {ok:true,logged:true,unb:unb,injected:injected};
}

/* ===== 卖家主页预览（点「看主页」在面板里核对，别误判）=====
   为什么要有：第三路信号（主页件数/简介）是自动判的，判错了就会把个人卖家误当商贩屏蔽掉。
   光看「主页 75 件」这个数字不够 —— 得能一眼看到这个号在卖什么，才好下决定。

   ---- 走过的弯路（别再走回去）----
   最初想直接打开 https://www.goofish.com/personal?userId=... 截整页长图。
   实测：① cookie 注入成功、页面也确实是登录态，但打开个人主页必弹 baxia 滑块验证
   （「亲，请拖动下方滑块完成验证」，z-index 2147483647 全屏遮罩），截出来是一张
   灰掉的验证窗；② 想绕开就改用页面里的 mtop 接口
   （mtop.idle.web.user.page.head / mtop.idle.web.xyh.item.list），
   结果在「刚打开首页还没产生搜索流量」的会话里一律 TIMEOUT::接口超时。
   → 这条路要能跑通，就得每次替用户拖滑块，那是拿账号去赌，不做。

   ---- 现在的做法 ----
   不访问闲鱼，直接用【程序自己已经抓到的数据】拼一张「这个卖家在卖什么」的清单：
     · hits 里属于这个卖家的所有商品（标题/价格/地区/发布时间/图片/直链）
     · 已抓到的 sellerProfiles（宝贝总数/评价数/等级/持证/简介）
   好处：零风控风险、零等待（<50ms）、点开立刻能看、还能直接点进商品。
   局限（前端有说明）：只能看到「他的商品曾经进过你的筛选条件」的那部分。
   想看完整主页，面板里给了「在闲鱼打开」直链，用户自己浏览器点（那时他自己过滑块）。 */
function sellerPreviewOf(sid,name){
  const key=String(sid||"");
  const nm=String(name||"");
  /* 从 hits 和屏蔽名单的 hidden 里一起找 —— 已经被屏蔽的卖家，货全在 hidden 里 */
  const pool=[];
  (hits||[]).forEach(function(h){ pool.push(h); });
  for(const k in sellerBlocklist){
    const e=sellerBlocklist[k];
    if(Array.isArray(e&&e.hidden)) e.hidden.forEach(function(h){ pool.push(h); });
  }
  const mine=[];
  const seenId={};
  pool.forEach(function(h){
    if(!h) return;
    const hitSid=key&&String(h.sellerId||"")===key;
    const hitNm=!key&&nm&&String(h.seller||"")===nm;
    if(!hitSid&&!hitNm) return;
    if(h.itemId&&seenId[h.itemId]) return;
    if(h.itemId) seenId[h.itemId]=1;
    mine.push(h);
  });
  mine.sort(function(a,b){ return (Number(b.publishTime)||0)-(Number(a.publishTime)||0); });
  const prof=sellerProfiles[key]||null;
  const bl=sellerBlocklist[key]||null;
  /* 价格分布：用户判断"是不是同行"最有用的一条线索 ——
     个人闲置通常就一两件、价格零散；商贩会有一堆同型号、价格成阶梯。 */
  const prices=mine.map(function(h){ return Number(h.price); }).filter(function(n){ return isFinite(n)&&n>0; });
  const itemIds=[];
  const seenTitle={};
  mine.forEach(function(h){
    const t=String(h.title||"").replace(/\s+/g,"").slice(0,30);
    if(t&&!seenTitle[t]){ seenTitle[t]=1; itemIds.push(t); }
  });
  return {
    ok:true,
    sellerId:key, name:(bl&&bl.name)||(mine[0]&&mine[0].seller)||nm,
    blocked:!!bl,
    /* 主页侧的真实情况（可能为 null = 还没抓到） */
    shop:prof?{items:prof.items,rates:prof.rates,lvl:prof.lvl,bq:prof.bq,intro:prof.intro,at:prof.at}:null,
    /* 我们手里有的货 */
    count:mine.length,
    priceMin:prices.length?Math.min.apply(null,prices):null,
    priceMax:prices.length?Math.max.apply(null,prices):null,
    /* 同款重复度：超过 3 条同名（去掉价格和成色）基本就是批量出货 */
    dupTitles:itemIds.length,
    items:mine.slice(0,60).map(function(h){
      return {itemId:h.itemId,title:h.title,price:h.price,priceText:h.priceText,
        area:h.area,publishTime:h.publishTime,pic:h.pic,url:h.url,
        sellerRate:h.sellerRate,foundAt:h.foundAt};
    })
  };
}

/* ===== 搜索 ===== */
/* 浏览器可见性三档（config.json 控制）：
     · noWindow:true  （默认）—— 用 Chromium 的 --headless=new：真浏览器内核、和普通 Chrome 同一套
        指纹（不是老 headless shell），但屏幕上没有窗口，也不占任务栏。被要求验证时会自动弹出可见窗口。
     · noWindow:false 且 headless:false —— 可见窗口（最稳、最方便人工过验证）
     · headless:true —— 老式无头 shell，指纹最差，不推荐
   一旦被要求验证，VISIBLE_OVERRIDE 打开，自动重开成可见窗口，等验证过后再继续。 */
let VISIBLE_OVERRIDE=false;
/* 人工验证态：必须在这里提前声明（ensurePage 里要读它），
   否则会踩 TDZ 报 "Cannot access 'manualVerify' before initialization"。 */
let manualVerify=false, manualVerifyAt=0;
/* 扫码登录成功后想让取数页面按新身份重载一次，但【不能当场重载】—— 那一刻可能正有一轮
   扫描在飞，goto 会把它打断成 "Execution context was destroyed"，白丢一轮。
   所以只挂标记，等下一轮开头（页面空闲）在 ensurePage 里执行。 */
let pageReloadWanted=false;
/* 【取数页面重开上限 2026-10-29】旧版 ensurePage 里是裸递归 `return ensurePage();`：
   ctx.newPage() 连续失败（浏览器起不来 / profile 被占）时会无限自我调用。
   隔离实测（_re_probe\recurse_probe.cjs）会抛 RangeError: Maximum call stack size exceeded。
   上层虽然多半有 try/catch 兜着（最坏只是当轮扫描失败），但会空转 CPU，
   日志里也只剩一堆"新开页面失败"，看不出是死循环。这里限制次数 + 退避。 */
/* 【2026-11-05】关掉取数浏览器上下文并置空，下一轮 ensurePage 会自动重新拉起
   （重新 launchPersistentContext + restoreCookies），baxia 会重新生成 bx-* 与 _m_h5_tk。
   调用时机只在"一轮扫描已经结束"之后，不会打断在飞的请求。 */
async function hardRebuildSession(reason){
  sessionRebuilds++;
  log("♻ 连续 "+STALE_ROUNDS_TO_REBUILD+" 轮只拿到旧数据（接口最新 "+(reason||"?")+"）→ 自动重建浏览器会话（第 "+sessionRebuilds+"/"+SESSION_REBUILD_MAX+" 次）");
  log("   → 不动登录、不动筛选，只是让浏览器重新拉一次登录态和风控令牌");
  try{ await saveCookies(); }catch(e){}
  try{ await ctx.close(); }catch(e){}
  ctx=null; page=null;
  staleRounds=0;
  await sleep(2000);
  try{ await ensurePage(); log("   → 浏览器已重开，下一轮用新会话取数"); }catch(e){ log("   → 重开失败（下一轮自动重试）: "+String(e&&e.message||e).slice(0,80)); }
}
const ENSURE_PAGE_MAX_TRIES=3;
async function ensurePage(tries){
  /* 同上：这个常量在 IIFE（第 4474 行之后）之前就初始化了，读它是安全的；
     但为了和另外两个清理函数保持一致的防御姿态，仍取一份局部副本。 */
  const MAX_TRIES=Number(ENSURE_PAGE_MAX_TRIES)||3;
  tries=Number(tries)||0;
  /* 取数浏览器被手动关掉/崩溃时：ctx 对象还在，但已经断开 —— 每轮都会报
     "browserContext.newPage: Target page, context or browser has been closed"。
     所以要主动探测连接是否还活着，断了就自动重新拉起（并还原登录 cookie）。 */
  if(ctx){
    let dead=false;
    try{ if(typeof ctx.isConnected==="function"&&!ctx.isConnected()) dead=true; }catch(e){ dead=true; }
    if(!dead){ try{ ctx.pages(); }catch(e){ dead=true; } }
    if(dead){
      log("取数浏览器已关闭或断开 → 自动重新打开（并还原登录 cookie）");
      try{ await ctx.close(); }catch(e){}
      ctx=null; page=null;
    }
  }
  if(!ctx){
    const headed=cfg.headless!==true;
    /* noWindow 默认开：--headless=new 不弹窗，但仍是完整 Chromium（GPU/字体/JS 定时器都正常），
       比老 headless shell 的指纹好得多，也不会像"最小化窗口"那样被系统节流。 */
    const noWindow=(cfg.noWindow!==false)&&!VISIBLE_OVERRIDE;
    /* 【缓存瘦身】磁盘缓存封顶 256 MB，避免跑到几百 MB 不回落。Chromium 默认无上限，只按 LRU 淘汰。 */
    const args=["--ignore-certificate-errors","--no-sandbox","--disable-blink-features=AutomationControlled",
      "--disk-cache-size=268435456"];
    if(headed&&noWindow) args.push("--headless=new","--window-size=1280,900");
    else if(headed) args.push("--window-size=1280,860","--window-position=40,40");
    ctx=await chromium.launchPersistentContext(path.join(DATA,"browser-profile"),{
      headless:!headed,userAgent:UA,locale:"zh-CN",viewport:{width:1440,height:1000},
      serviceWorkers:"block",args:args});
    if(headed&&noWindow) log("浏览器模式: 无窗口（--headless=new，真浏览器内核）—— 屏幕上不会出现窗口；被要求验证时会自动改成可见窗口");
    else if(headed) log("浏览器模式: 有头（真实 Chromium）—— 这个窗口用于取数，被要求验证时也在这个窗口里点");
    const n=await restoreCookies();
    if(n>0) log("已还原登录 cookie "+n+" 条");
  }
  if(!page||page.isClosed()){
    try{ page=ctx.pages()[0]||await ctx.newPage(); }catch(e){
      log("新开页面失败（"+e.message.slice(0,60)+"）→ 重新拉起浏览器");
      try{ await ctx.close(); }catch(_){}
      ctx=null; page=null;
      /* 旧版这里是 `return ensurePage();` —— 无上限、无退避。
         连试 3 次还不行就认输，把错误抛给上层（上层会记日志、当轮跳过），
         别把整个进程拖进死循环。两次之间停 1.5 秒，给浏览器/profile 句柄留释放时间。 */
      if(tries+1>=MAX_TRIES){
        throw new Error("重新拉起浏览器连续失败 "+MAX_TRIES+" 次，本轮放弃（下次扫描会再试）："+String(e.message||e).slice(0,120));
      }
      await sleep(1500);
      return ensurePage(tries+1);
    }
    page.setDefaultTimeout(60000);
  }
  /* 人工验证期间绝对不能 goto：重载会把用户正在拖的滑块 / 正在点的验证页直接刷掉，
     baxia 就会一直报"验证失败"，用户永远过不去。这里只在"不在验证态"时才导航首页。 */
  if(!manualVerify&&pageReloadWanted){
    pageReloadWanted=false;
    try{
      await page.goto("https://www.goofish.com/",{waitUntil:"domcontentloaded",timeout:60000});
      await sleep(2000);
      log("扫码登录后：取数页面已按新身份重载（baxia 令牌重新生成）");
    }catch(e){}
  }
  if(!manualVerify&&!/goofish\.com/.test(page.url()||"")){
    await page.goto("https://www.goofish.com/",{waitUntil:"domcontentloaded",timeout:60000});
    await sleep(3000);
  }
  if(!manualVerify) await checkLogin();
  return page;
}

/* 登录体检
   【2026-11-04 重写 —— 旧判据是错的，这是"商品一直停在 6 小时前"的真正原因】
   旧判据：LOGIN_MARKS=["havana_lgc2_77","_hvn_lgc_","csg","aui","cnaui"]，
           unb 在 且 命中 >=2 个就算登录正常。
   实测（同一账号、登录前与登录后各查一次 cookie）：
     · havana_lgc2_77 / _hvn_lgc_  【登录前后都不存在】，根本不是这个账号的登录凭证；
     · csg / aui / cnaui 是长效 cookie（过期时间到 2027 年），关浏览器也不会掉；
   ⇒ 只要 unb 在，就恒判"3/5 通过"，日志一直打"登录态正常"，
     而接口实际返回 FAIL_SYS_SESSION_EXPIRED::Session过期，
     平台按【游客】返回约 6 小时前的旧数据。用户看到的就是"最新商品停在 6 点"。
   真正的登录凭证（重新扫码后才出现，且能把最新货从 6 小时前立刻变回 13 分钟前）：
     · sgcookie  淘宝登录主凭证，122 字符，有效期约 1 年
     · tfstk     风控令牌串，453 字符
     · unb       用户 id
   所以现在：三样齐全才算登录正常；缺任一样 = 登录已失效 = 抓到的一定是旧数据。
   cookie2 / _tb_token_ 是会话级，刚开浏览器时短暂缺失属正常，单独给 warn 不给 bad。 */
const LOGIN_MARKS=["sgcookie","tfstk","unb"];
const SESSION_COOKIES=["cookie2","_tb_token_","havana_lgc2_77","_hvn_lgc_"];
let lastLoginWarn=0;
/* 面板顶部那个"常驻登录状态"徽标要用的细节：昵称、unb 还剩几天、签名 token 还剩几小时。
   纯读取，不改变任何抓取/筛选行为 —— 只是把 cookie 里本来就有的事实透给面板。
   unb 是决定"闲鱼认不认你是本人"的那个 cookie，实测只有 3 天寿命，
   所以面板上必须能看到它还剩多久，否则用户只能等到抓不到货了才发现。 */
function loginDetailOf(all){
  const pick=function(n){ return (all||[]).find(function(x){ return x.name===n; })||null; };
  const daysOf=function(c){
    if(!c) return null;
    const e=Number(c.expires);
    if(!isFinite(e)||e<=0) return null;        /* -1 = 会话级 cookie，关浏览器才丢，不算到期 */
    return Math.max(0,Math.round((e*1000-Date.now())/8640000)/10);
  };
  const hoursOf=function(c){
    if(!c) return null;
    const e=Number(c.expires);
    if(!isFinite(e)||e<=0) return null;
    return Math.max(0,Math.round((e*1000-Date.now())/36000)/10);
  };
  let nick="";
  const tk=pick("tracknick");
  if(tk) nick=String(tk.value||"");
  /* tracknick 是那种 tb597491489 的淘宝号，没什么辨识度；
     优先用 sdkSilent 里的 loginId（形如 t**9，是闲鱼自己展示给用户看的那个）。
     该 cookie 的值是 base64 的 JSON（实测 eyJoaWQ... → {"hid":...,"loginId":"t**9",...}），
     不是 URL 编码，所以先按 base64 解；解不出来再退回 decodeURIComponent 兜一次。 */
  const sd=pick("last_u_xianyu_xianyu_sdkSilent")||pick("last_u_xianyu_web");
  if(sd){
    const raw=String(sd.value||"");
    const tryParse=function(s){ try{ const j=JSON.parse(s); return (j&&j.loginId)?String(j.loginId):""; }catch(e){ return ""; } };
    let got=tryParse(raw);
    if(!got){ try{ got=tryParse(Buffer.from(raw,"base64").toString("utf8")); }catch(e){} }
    if(!got){ try{ got=tryParse(decodeURIComponent(raw)); }catch(e){} }
    if(got) nick=got;
  }
  return {
    nick:nick,
    unbDays:daysOf(pick("unb")),
    tokenHours:hoursOf(pick("_m_h5_tk")),
    havanaDays:daysOf(pick("havana_lgc2_77")),
    /* 【2026-11-04】sgcookie 才是真正的登录主凭证，面板该看它的剩余寿命 */
    sgcookieDays:daysOf(pick("sgcookie")),
    tfstkDays:daysOf(pick("tfstk")),
    sessionCookies:(all||[]).filter(function(c){ return !(Number(c.expires)>0); }).length,
    total:(all||[]).length,
    at:new Date().toISOString()
  };
}
async function checkLogin(){
  try{
    const all=await ctx.cookies();
    const have=new Set(all.map(function(c){return c.name;}));
    const pick=function(n){ return (all.find(function(c){return c.name===n;})||{}).value||null; };
    const unb=pick("unb"), sg=pick("sgcookie"), tf=pick("tfstk");
    const strong=LOGIN_MARKS.filter(function(k){return have.has(k);});
    const sess=SESSION_COOKIES.filter(function(k){return have.has(k);});
    freshInfo.loginUnb=unb;
    freshInfo.loginStrong=strong.length;
    freshInfo.loginMarks=strong;
    freshInfo.loginSessMarks=sess.length;
    /* 三档：
         ok   = sgcookie + tfstk + unb 三样齐全，且会话级 cookie 也在（真登录）
         warn = 三样齐全但会话级 cookie 暂时没有（刚开浏览器的一小会儿，会自己长回来）
         bad  = 缺 sgcookie 或 tfstk ⇒ 平台按游客给数据，抓到的必然是旧的
       判据只看 cookie 在不在，不额外发请求，所以可以每轮都调，零风控成本。 */
    const hasMain=!!(sg&&tf&&unb);
    let level="bad", why="";
    if(hasMain){
      level="ok";
      if(!sess.length){ level="warn"; why="会话级 cookie（cookie2/_tb_token_）暂时缺失，刚开浏览器时常见，通常下一轮自动补全"; }
    }else{
      why="缺少登录凭证："+[sg?null:"sgcookie",tf?null:"tfstk",unb?null:"unb"].filter(Boolean).join(" / ");
    }
    freshInfo.loginLevel=level;
    freshInfo.loginWhy=why;
    freshInfo.loginBad=(level==="bad");
    freshInfo.login=loginDetailOf(all);
    if(level==="ok"){
      if(freshInfo._logged!==true){ freshInfo._logged=true; log("登录态正常：unb="+unb+"（sgcookie+tfstk 齐全）"); }
    }else if(level==="warn"){
      if(Date.now()-lastLoginWarn>600000){
        lastLoginWarn=Date.now();
        log("提示："+why+"。这不影响抓取，通常下一轮自动恢复。");
      }
    }else if(Date.now()-lastLoginWarn>600000){
      lastLoginWarn=Date.now();
      log("警告：登录已失效（"+why+"）。");
      log("      平台会把你当游客，只返回约 6 小时前的旧数据 —— 面板上的商品会停在某个时间点不动。");
      log("      → 双击【0-首次扫码登录.cmd】，或在面板点【登录 / 换号】重新扫码一次（扫完会自动存好 cookie）。");
    }
  }catch(e){}
}

/* 任务的地区范围文字（用于区分"范围太窄导致最新一条偏旧"和"真被风控降级"） */
function regionLabel(task){
  const p=[task.province,task.city,task.area].filter(Boolean).join("/");
  return p||"全国";
}

/* 把任务还原成一句"人话筛选条件"，面板体检条直接显示它，比任务名直观 */
function condLabel(task){
  const out=[];
  if(!task.keyword) out.push("不限关键词"); else out.push("搜索："+task.keyword);
  if(task.minPrice!=null||task.maxPrice!=null){
    out.push("价格 "+(task.minPrice==null?"不限":task.minPrice)+"-"+(task.maxPrice==null?"不限":task.maxPrice));
  }
  const q=(task.quickFilters||[]).map(function(k){
    const f=CATALOG.quickFilters.find(function(x){ return x.key===k; });
    return f?f.label:k;
  });
  if(q.length) out.push(q.join("+"));
  const pd=Number(task.publishDays||0);
  /* 照官网「新发布」下拉的文字：最新 / 1天内 / 3天内 / 7天内 / 14天内 */
  out.push("发布 "+(pd>0?pd+"天内":"最新"));
  const ps=CATALOG.priceSorts.find(function(x){ return x.key===(task.priceSort||""); });
  if(ps&&ps.key) out.push(ps.label);
  const s=CATALOG.sorts.find(function(x){ return x.key===(task.sort||"default"); });
  if(s&&s.key!=="default") out.push(s.label);
  if((task.mustContain||[]).length) out.push("必含 "+task.mustContain.join("/"));
  if((task.excludeWords||[]).length) out.push("屏蔽标题 "+task.excludeWords.join("/"));
  if((task.descExcludeWords||[]).length) out.push("屏蔽内容 "+task.descExcludeWords.join("/"));
  if((task.sellerBlockWords||[]).length) out.push("屏蔽卖家 "+task.sellerBlockWords.join("/"));
  return out.join(" · ");
}

/* ===== 清空记录后的"重建基线" =====
   问题：/__scan/clear 只清 hits 不清 seen，而 seen 是"这个商品已经见过/已经报过"的唯一依据，
   所以清空记录的下一轮扫描会把当前在售的全部旧商品当成"新命中"重新灌回来（12 天前的记录也是这么回来的）。
   做法：清空 hits 之后立刻手动跑一轮 scanOnce({seedAll:true})：
     - 现有在售商品全部登记进 seen（不会再把旧记录当新命中）
     - 同时把它们收进显示列表（不算新命中、不推送），避免面板清完一片空白让人以为坏了 */
let rebaselining=false;
let deepForceFull=false;   /* 只有「清空记录后重建」「条件变更后重建」才走全量翻页（不参与错峰轮转） */
let deepTurnIdx=0;         /* 【错峰 2026-11-02】多任务欠基线时按轮次轮转，每轮只让一个任务走基线 */
/* 分轮基线期间，seedAll 必须跨轮保持。
   以前 scanOnce({seedAll:true}) 是一轮翻完，现在要分 8-9 轮，
   如果只给第 1 轮传 seedAll，后 8 轮收进列表的货会丢——面板会比官网少，正是我们要避免的。
   所以改成"待补基线任务集合"：每轮结束时若该任务基线未走完，就留在集合里，下一轮自动继续 seedAll。 */
const SEEDPENDINGF=path.join(DATA,"seed-pending.json");   /* 落盘：进程重启后仍知道哪些任务基线没走完 */
let __seedPending=(function(){ try{ const o=readJSON(SEEDPENDINGF,{}); return (o&&typeof o==="object")?o:{}; }catch(e){ return {}; } })();
function seedPendingSave(){ try{ writeJSON(SEEDPENDINGF,__seedPending); }catch(e){} }
function seedPendingAdd(taskName){ if(!taskName) return; __seedPending[taskName]=1; seedPendingSave(); }
function seedPendingHas(taskName){ return !!__seedPending[taskName]; }
function seedPendingDel(taskName){ if(__seedPending[taskName]){ delete __seedPending[taskName]; seedPendingSave(); } }

/* 「首次运行」判定必须跨进程记住（v2026-10-20 修）。
   旧版用 task.__seededOnce，它只挂在内存里的任务对象上，进程一重启就没了 →
   每次启动都把当前在售的 29 条重新当"首次运行"灌进 hits，foundAt 被刷成当前时间，
   面板上这批老货又会重新带上"新"标记（用户看到的就是"怎么又变新的了"）。
   改成落盘 data\seeded-once.json = {任务名: 签名}：
   签名一致 = 这个条件已经建过基线 = 不是首次运行。条件一改签名就变，自然重新算首次。 */
const SEEDONCEF=path.join(DATA,"seeded-once.json");
let __seedOnce=(function(){ try{ const o=readJSON(SEEDONCEF,{}); return (o&&typeof o==="object")?o:{}; }catch(e){ return {}; } })();
function seedOnceSave(){ try{ writeJSON(SEEDONCEF,__seedOnce); }catch(e){} }
function seedOnceHas(taskName,sig){ return !!taskName&&__seedOnce[taskName]===sig; }
function seedOnceMark(taskName,sig){ if(!taskName||!sig) return; if(__seedOnce[taskName]===sig) return; __seedOnce[taskName]=sig; seedOnceSave(); }

async function rebaselineNow(reason){
  if(rebaselining) return {skipped:true};
  rebaselining=true;
  deepForceFull=true;
  try{
    log("重建基线（"+reason+"）：把当前在售商品登记为已见过，并收进列表（不推送）…");
    /* 重建基线一定要走全量，否则"收进列表"只有几页，看起来还是比官网少。
       注意：这里清 deepState 签名 = 重新开始走全量；同时清掉旧进度，避免拿旧进度接着翻。 */
    for(const t of (cfg.tasks||[])){
      delete deepState[t.name];
      deepClearProgress(t);
      seedPendingAdd(t.name);   /* 基线没走完之前，每轮都要 seedAll */
    }
    const r=await scanOnce({seedAll:true});
    /* 分轮模式下这里只走完第一段，进度已落盘；剩余部分由主循环后续轮次自动接着翻。
       "重建基线完成"的最终日志由主循环在基线真正走完时打印。 */
    log("重建基线第 1 段完成：seen 合计 "+r.seen+" 条，收入列表 "+r.seeded+" 条"
      +"，剩余页数将在后续轮次自动续翻（每轮 "+(Number(cfg.deepPagesPerRound)||3)+" 页）");
    return r;
  }finally{ rebaselining=false; deepForceFull=false; }
}

/* 条件变更 / 首次运行也要能自动续翻，而不只是手动触发时才走全量。
   deepSweep 默认开：签名变了就进入"待补基线"集合，主循环每轮自动补几页。 */
function markTasksNeedDeep(){
  for(const t of (cfg.tasks||[])){
    if(t.enabled===false) continue;
    if(deepState[t.name]!==sigOfTask(t)) seedPendingAdd(t.name);
  }
}

function buildRequest(task){
  const sf=[];
  /* 【v2026-10-20】publishDays 不再下发给服务端：服务端时间过滤会让召回变少，
     且不按时间排序时还会漏掉边界商品。时间期限改由 localFilter() 本地判定。
     这里只保留 quickFilter 和 priceRange 两个真正影响召回的服务端筛选。 */
  const qf=(task.quickFilters||[]).filter(k=>CATALOG.quickFilters.some(x=>x.key===k));
  if(qf.length) sf.push("quickFilter:"+qf.join(","));
  if(task.minPrice!=null||task.maxPrice!=null) sf.push("priceRange:"+(task.minPrice??"")+","+(task.maxPrice??""));
  /* 【cpvFilters 动态筛选 2026-11-04】官方筛选项序列化进 searchFilter。
     格式 pid:vid,vid;pid:vid;（与 quickFilter/priceRange 同一段，末尾由下面 join 补分号）。
     只有非空才写，否则 propValueStr 保持 {}，页面走默认。 */
  if(task.cpvFilters && typeof task.cpvFilters==="object" && !Array.isArray(task.cpvFilters)){
    const cpv=[];
    Object.keys(task.cpvFilters).forEach(function(pid){
      const vids=(Array.isArray(task.cpvFilters[pid])?task.cpvFilters[pid]:[]).map(function(v){return String(v);}).filter(Boolean);
      if(vids.length) cpv.push(String(pid)+":"+vids.join(","));
    });
    if(cpv.length) sf.push(cpv.join(";"));
  }
  /* 排序两层优先级，对应官网两个控件：
       ① 价格排序（官网「价格」下拉）最高，选了就按价格
       ② 其余一律 sortField=create/desc（= 官网「新发布 → 最新」），保证第 1 页永远是最新上架

     【v2026-10-20 修正】以前 pd>0 时会把排序清空改走「综合」，而且还要额外带 publishDays:N。
     这条路对监控是错的，实测两个后果：
       · 综合不按时间排 → 轮询只看第 1 页时，新上架的货不在第 1 页，直接漏单；
       · 服务端时间过滤会顺手裁掉边界商品（发布时间 23h59m 的也会被算进"1天内"以外的分支），召回变少。
     所以「发布时间」这个筛选不再交给服务端：API 永远按最新倒序拉全，时间期限在本地
     localFilter() 里按 publishTimeAdjusted 判（见下方 days 分支），这样既不漏单又真的限了期。 */
  let sort=CATALOG.sorts.find(s=>s.key===(task.sort||"default"))||CATALOG.sorts[0];
  const ps=CATALOG.priceSorts.find(s=>s.key===(task.priceSort||""))||CATALOG.priceSorts[0];
  if(ps.sortField) sort=ps;
  else if(!sort.sortField) sort={key:"create",label:"最新",sortField:"create",sortValue:"desc"};
  const div={};
  if(task.province) div.province=task.province;
  if(task.city) div.city=task.city;
  if(task.area) div.area=task.area;
  /* 地区参数也照官网原样：官网（2026-10-17 抓包，区域=广西/桂林）只发三个键
       {"divisionList":[{"province":"广西","city":"桂林"}],"excludeMultiPlacesSellers":"0","extraDivision":""}
     空的 area 不写进去；不再额外塞 userPositionJsonp / userLocations / customDistances / mode
     —— 多带字段会让服务端走"按地址+距离"的另一条分支，召回和官网对不上。 */
  const extraFilter=(task.province||task.city||task.area)
    ? JSON.stringify({divisionList:[div],excludeMultiPlacesSellers:"0",extraDivision:""})
    : "{}";
  return {
    pageNumber:1, keyword:task.keyword||"",
    fromFilter: !!(sf.length||sort.sortField||task.province||task.city||task.area),
    rowsPerPage:Math.min(30,Math.max(5,task.rowsPerPage||30)),
    sortValue:sort.sortValue, sortField:sort.sortField,
    customDistance:"", gps:"",
    propValueStr: sf.length?{searchFilter:sf.join(";")+";"}:{},
    customGps:"", searchReqFromPage:"pcSearch",
    extraFilterValue:extraFilter, userPositionJson:"{}"
  };
}

/* 最近一次搜索请求的"参数 + 服务端自报数据量"，用于诊断"为什么拿到的比官方少"。
   官方响应里 resultInfo 会带 numFound / hasNextPage 之类的总量信息，
   把请求参数和这些总量一起落盘（data\last-request.json），就能直接和官方页面逐项对照。
   另外每个筛选条件下的条数也留一份历史，便于发现"同一条件忽然变少"（限流少返）。 */
const LASTREQF=path.join(DATA,"last-request.json");
let lastSearchMeta={};
/* 每页的最新元数据（callSearch 每次都会刷新）。
   基线续翻时按页判"少返"要用它 —— lastSearchMeta 只保留第 1 页那份，判不到第 4-25 页。 */
let pageMeta={};

/* 【cpvFilters 动态筛选 2026-11-04】搜索时把官方下发的筛选项 tabList 按关键词缓存，
   面板要渲染「这个关键词有哪些筛选项」时直接读缓存，零额外请求。 */
let filterTreeCache={};
/* 【筛选项缓存落盘 2026-11-04】以前它只在内存里，monitor 一重启就空了 ——
   面板刷新时 /__scan/filtercache 拿不到树，界面上就显示「筛选项还没取到」，
   而 config 里其实还存着 cpvFilters，用户一点保存就把它们清空了。
   落盘后重启也能把已保存的筛选项原样画出来。 */
const FILTERTREEF=path.join(DATA,"filter-tree-cache.json");
let filterTreeLoaded=false;
function filterTreeLoad(){
  if(filterTreeLoaded) return;
  filterTreeLoaded=true;
  try{
    const o=readJSON(FILTERTREEF,null);
    if(o&&typeof o==="object") filterTreeCache=o;
  }catch(e){}
}
function filterTreeSave(){
  try{ writeJSON(FILTERTREEF,filterTreeCache); }catch(e){}
}
/* 【缓存上限 2026-11-04】原来只增不减：用户每改一次关键词就多一条，改一百次就一百条。
   每条是一个完整 tabList（几十个 pid/vid），实测单个关键词 4~6 KB。不封顶的话
   长期运行会缓慢吃内存。50 条关键词够用了（真的翻回第 51 个旧词时最多再拉一次）。 */
const FILTERTREE_CACHE_MAX=50;
function filterTreeStore(key,groups){
  try{
    filterTreeCache[key]=groups;
    const keys=Object.keys(filterTreeCache);
    if(keys.length>FILTERTREE_CACHE_MAX){
      /* 按插入顺序淘汰最老的（JS 对象字符串键保持插入顺序） */
      const drop=keys.slice(0,keys.length-FILTERTREE_CACHE_MAX);
      drop.forEach(function(k){ delete filterTreeCache[k]; });
    }
    filterTreeSave();
  }catch(e){}
}

/* 少返判定：本页要 30 条却只回很少（且服务端自报总量更大）→ 多半是被限流少返，不是"没货" */
function detectShortfall(){
  const m=lastSearchMeta||{};
  if(m.rows==null||!m.requested) return null;
  /* 修 bug：这里以前读 m.numFound / m.totalCount，但 callSearch 写进 meta 的键名是 declared
     （见 callSearch 里的 declared: ... 那一行），两个键在 meta 里根本不存在
     → declared 恒为 null → 本函数恒返回 null → 下面 954 行的"疑似被限流少返"日志从来没打印过，
       面板上也永远看不到"服务端自报 N 条只取到 M 条"的诊断。
     data\last-request.json 40 条历史实测：全部只有 "declared" 键，没有 numFound/totalCount。 */
  const declared=(m.declared!=null?Number(m.declared):null);
  if(m.rows>=m.requested) return null;            /* 满页 = 正常 */
  if(declared!=null&&declared>m.rows) return {declared:declared,got:m.rows};
  return null;
}

/* 基线专用少返判定（给"基线是否走完"用，不能直接用 detectShortfall）。
   原因：detectShortfall 读的是 lastSearchMeta，也就是【最后一页】的元数据，
   而基线的最后一页本来就可能不满页（这个条件就是这么多货），
   拿它判"没走完"会让基线永远走不完 —— 每轮都从头再翻一次，等于自残。
   正确判据：本轮所有页里，出现"某页该 30 条却明显只回几条，且服务端自报总量大于已取条数"才算少返。
   ⚠ 两处实测踩出来的坑，都必须排除：
      ① 空页：空页 = 真的到底了（hasNextPage 已 false 或平台就这么多货），不是少返；
      ② 差一两条的页：第 12 页实测回 29 条（30 里少 1 条），这是平台分页边界的正常抖动，
         不是限流。旧判据 `rows<requested` 会把它当少返，于是货不足 50 页的条件永远走不完、
         每轮从头续翻。真正的限流少返是"要 30 只给 5-10 条"那种量级，
         所以这里用"少于一半"作阈值。 */
function detectShortfallForBaseline(pageMetas,gotTotal){
  const arr=pageMetas||[];
  for(let i=0;i<arr.length;i++){
    const m=arr[i]||{};
    if(m.rows==null||!m.requested) continue;
    if(m.rows===0) continue;                     /* 空页 = 到底了，不是少返 */
    if(m.hasNextPage===false) continue;          /* 平台自己说没有下一页了 */
    /* 同 detectShortfall：meta 里的键名是 declared，不是 numFound/totalCount。 */
    const declared=(m.declared!=null?Number(m.declared):null);
    if(declared==null) continue;
    const half=Math.max(1,Math.floor(m.requested/2));
    if(m.rows<half&&declared>gotTotal) return {declared:declared,got:m.rows,page:i+1};
  }
  return null;
}

/* 搜索：拦截页面自身请求 -> 替换参数并重算签名 -> 由页面发出（复用其风控令牌） */
async function callSearch(task,pageNo){
  pageNo=pageNo||1;
  const p=await ensurePage();
  const searchUrl="https://www.goofish.com/search?q="+encodeURIComponent(task.keyword||"")+"&__pg="+pageNo;
  const wanted=JSON.stringify(buildRequest(task));

  const raw=await new Promise(function(resolve,reject){
    let settled=false;
    const cleanup=function(){
      try{ p.off("response",onResp); }catch(e){}
      try{ p.unroute("**/*idlemtopsearch*",onRoute); }catch(e){}
      try{ if(typeof __cst!=="undefined"&&__cst) clearTimeout(__cst); }catch(e){}
    };
    const finish=function(fn,arg){ if(settled) return; settled=true; cleanup(); fn(arg); };

    const onRoute=async function(route){
      const r=route.request();
      try{
        const u=new URL(r.url());
        const pd=r.postData()||"";
        const m=/data=([^&]*)/.exec(pd);
        if(m && u.pathname.indexOf("idlemtopsearch.pc.search/1.0")>=0){
          const obj=JSON.parse(decodeURIComponent(m[1]));
          {
            obj.pageNumber=pageNo;
            const mine=JSON.parse(wanted);
            ["fromFilter","sortField","sortValue","propValueStr","extraFilterValue","rowsPerPage"].forEach(function(k){
              if(mine[k]!==undefined) obj[k]=mine[k];
            });
            const nd=JSON.stringify(obj);
            const t=u.searchParams.get("t");
            const cs=await ctx.cookies();
            /* 【修 BUG-Q】按域取 goofish 的 token，别再 find() 抓第一个（会抓到 taobao 那份） */
            const token=goofishTokenOf(cs);
            if(token&&t) u.searchParams.set("sign",md5(token+"&"+t+"&"+APPKEY+"&"+nd));
            /* 关键：原始 postData 除 data= 外还带风控令牌（bx-ua / bx-umidtoken / bx-et 等，
               由页面 baxia SDK 动态生成）。只替换 data= 那一段、其余原样保留；
               一旦把这些令牌丢掉，风控会把请求当成脚本，返回"延迟约 6 小时"的降级数据。 */
            const segs=String(pd||"").split("&");
            let hit=false;
            const keep=segs.map(function(sg){
              if(sg.slice(0,5)==="data="){ hit=true; return "data="+encodeURIComponent(nd); }
              return sg;
            });
            if(!hit) keep.unshift("data="+encodeURIComponent(nd));
            const newPd=keep.join("&");
            const bxNames=keep.filter(function(sg){ return /^bx[-_]/.test(sg); }).map(function(sg){ return sg.split("=")[0]; });
            if(!bxNames.length) log("警告：原始请求不含 bx-* 风控令牌，返回结果可能被风控降级");
            return route.continue({url:u.toString(),postData:newPd});
          }
        }
      }catch(e){}
      return route.continue();
    };

    const onResp=async function(r){
      if(r.url().indexOf("idlemtopsearch.pc.search/1.0")<0) return;
      let body=""; try{ body=await r.text(); }catch(e){ return; }
      finish(resolve,body);
    };

    p.route("**/*idlemtopsearch*",onRoute).then(function(){
      p.on("response",onResp);
      p.goto(searchUrl,{waitUntil:"domcontentloaded",timeout:20000}).catch(function(e){
        finish(reject,new Error("打开搜索页失败: "+e.message));
      });
    }).catch(function(e){ finish(reject,new Error("注册拦截失败: "+e.message)); });

    /* 【修 BUG-C：goto 的 45s 超时是永远走不到的死代码，且整体计时器比 goto 短】
       原来：p.goto(...,{timeout:45000}) 与 setTimeout(...,30000) 并存。
       30000 先触发 → finish(reject) → cleanup() 把路由和 response 监听都拆了，
       可页面还在加载；等 45s goto 真的超时，catch 里那句"打开搜索页失败"
       已经因为 settled=true 被 finish 直接丢弃 —— 日志里永远只有"搜索超时（30秒）"，
       看不出到底是"页面打不开"还是"接口没回包"，排查时容易误判成风控。
       现在：goto 超时收到 20s（小于总计时器），总超时 35s，并且 finish 时清掉计时器，
       避免每次搜索都留一个 30s 定时器在跑。 */
    const __cst=setTimeout(function(){ finish(reject,new Error("搜索超时（35秒，接口未回包）")); },35000);
    if(__cst.unref) __cst.unref();
  });

  let j; try{ j=JSON.parse(raw); }catch(e){ throw new Error("响应非JSON: "+String(raw).slice(0,80)); }
  const ret=(j.ret||[]).join("|");
  if(!/SUCCESS/.test(ret)) throw new Error("接口返回: "+ret.slice(0,120));
  const off=(cfg.publishTimeOffsetHours||0)*3600000;
  const items=[];
  for(const it of ((j.data&&j.data.resultList)||[])){
    const m=(it.data&&it.data.item&&it.data.item.main)||{}, ex=m.exContent||{}, a=(m.clickParam&&m.clickParam.args)||{};
    const id=String(ex.itemId||a.item_id||"");
    if(!id) continue;
    const pt=Number(a.publishTime||0);
    let credit="", relTime="";
    try{
      const ft=ex.fishTags;
      if(ft&&typeof ft==="object"){
        Object.keys(ft).forEach(function(g){
          const tl=ft[g]&&ft[g].tagList;
          if(!Array.isArray(tl)) return;
          tl.forEach(function(x){
            const c=x&&x.data&&x.data.content;
            if(!c) return;
            const mm=/卖家信用(极好|优秀|良好|一般)/.exec(c);
            if(mm) credit=mm[1];
            if(/(分钟|小时|天)前发布|刚刚发布/.test(c)) relTime=c;
          });
        });
      }
    }catch(e){}
    /* 平台属性标签（卖家填的真实属性，与手机筛选同源） */
    let tags=[];
    try{
      const su=JSON.parse(a.serviceUtParams||"[]");
      su.forEach(function(x){
        const c=x&&x.args&&x.args.content;
        if(c&&String(c).length<30) tags.push(String(c));
      });
    }catch(e){}
    /* 卖家稳定 ID + 店铺评价：给"自动识别商贩"用。
       seller_id 在原始响应里有两处（exContent.jump2XianYuHao.clickParam.args 和 main.clickParam.args），
       实测 30/30 全覆盖、24 字符 base64、与昵称 1:1 无冲突。
       「同一昵称对应多个 seller_id」= 0，所以用它当键比用昵称可靠
       （昵称会空：本次样本里 3/30 为空，库里 864 条里有 28 条空）。 */
    let sid="";
    try{
      const jh=(ex.jump2XianYuHao&&ex.jump2XianYuHao.clickParam&&ex.jump2XianYuHao.clickParam.args)||{};
      sid=String(jh.seller_id||a.seller_id||"");
    }catch(e){}
    /* 好评率 / 评价数：商贩最直接的信号（例：616条评价/好评率40%）
       这两个值只在"闲鱼小店/鱼小铺"标签里出现，个人卖家一般是 0条评价/好评率0%
       —— 注意这两个 0 是「没有这个标签」的哨兵值，不是「0 条真实评价 / 0% 真实好评」。
       实测 700 条里 602 条 rate=0%、599 条 deals=0，全被前端渲染成"0%好评"，
       等于把「没数据」显示成「差评」，会误导判断。所以 deals=0 时直接把 rate 置空，
       前端拿不到自然就不显示（前端也做了同样的兜底，老数据照样不显示）。 */
    let sellerRate="",sellerDeals=0;
    try{
      const tl=(ex.userFishShopLabel&&ex.userFishShopLabel.tagList)||[];
      for(const x of tl){
        const c=x&&x.data&&x.data.content;
        if(!c) continue;
        const m1=/(\d+(?:\.\d+)?)\s*条评价/.exec(c); if(m1) sellerDeals=Number(m1[1]);
        const m2=/好评率\s*(\d+(?:\.\d+)?)%/.exec(c); if(m2) sellerRate=m2[1]+"%";
      }
    }catch(e){}
    if(!sellerDeals) sellerRate="";
    /* priceText 对哨兵值特殊处理：显示"价格面议"而不是 ¥99999999 */
    const _p=a.price, _sent=(_p!=null&&Number(_p)>=1000000);
    items.push({itemId:id,task:task.name,keyword:task.keyword,credit:credit,relTime:relTime,tags:tags,
      title:String(ex.title||"").replace(/\s+/g," ").trim(),
      price:Number(_p),priceText:_sent?"价格面议":("¥"+(_p==null?"":_p)),
      area:ex.area||"",seller:ex.userNickName||"",
      sellerId:sid,sellerRate:sellerRate,sellerDeals:sellerDeals,
      publishTime:pt,publishTimeAdjusted:pt?pt+off:0,
      publishAt:pt?fmtPublishAt(pt+off):"",
      ageMinutes:pt?Math.round((Date.now()-(pt+off))/60000):null,
      pic:(ex.picUrl||"").replace(/^http:/,"https:"),
      url:"https://www.goofish.com/item?id="+id,
      foundAt:new Date().toISOString()});
  }
  /* 记录"本次请求参数 ↔ 服务端返回量"，用于和官方页面逐项对照 & 发现限流少返。
     pageMeta 每页都更新（基线续翻要按页判少返，只留第 1 页那份是不够的）；
     落盘 last-request.json 仍然只记第 1 页，避免每轮刷 25 条历史。
     修 bug：旧版 pageMeta 只在 pageNo===1 时赋值，导致基线的 pageMetas 全是第 1 页的重复快照，
     detectShortfallForBaseline 里"第 N 页少返"永远只能测到第 1 页。 */
  try{
    const wantObj=JSON.parse(wanted);
    const ri=(j.data&&j.data.resultInfo)||{};
    const rf=ri.searchResControlFields||{};
    const declared=(rf.numFound!=null?Number(rf.numFound):(ri.numFound!=null?Number(ri.numFound):(ri.totalCount!=null?Number(ri.totalCount):null)));
    const meta={at:new Date().toISOString(),task:task.name,pageNo:pageNo,keyword:task.keyword,
      params:wantObj,requested:Number(wantObj.rowsPerPage||0),rows:items.length,
      declared:(isFinite(declared)?declared:null),
      hasNextPage:(ri.hasNextPage==null?null:!!ri.hasNextPage),
      resultInfoKeys:Object.keys(ri).slice(0,18),
      rawListLen:((j.data&&j.data.resultList)||[]).length};
    pageMeta=meta;                 /* 每页都刷新，供基线少返判定使用 */
    if(pageNo===1){
      lastSearchMeta=meta;
      /* 缓存官方筛选项（按关键词） */
      try{
        const cpv=(ri.sqiControlFields&&ri.sqiControlFields.cpvNavigatorDo&&ri.sqiControlFields.cpvNavigatorDo.tabList)||[];
        if(cpv.length){
          filterTreeStore(String(task.keyword||"").toLowerCase(), cpv.map(function(g){
            return {pid:String(g.pid||""), pname:g.pname||"", values:(g.pvTermList||[]).map(function(x){
              return {vid:String(x.vid!=null?x.vid:""), label:x.vname||String(x.vid||"")};
            })};
          }));
        }
      }catch(e){}
      let hist=readJSON(LASTREQF,[]); if(!Array.isArray(hist)) hist=[];
      hist.push(meta); writeJSON(LASTREQF,hist.slice(-40));
      const sf=detectShortfall();
      if(sf) log("注意：第1页只要到 "+sf.got+" 条，服务端却自报有 "+sf.declared+" 条 —— 疑似被限流少返（不是没货）");
    }
  }catch(e){}
  return items;
}

/* 本地二次筛选：排除词 + 发布时间 */
/* 容量匹配：256G / 256GB / 256 g（1T 对应 1024） */
/* 标题里到底有没有写容量。用来区分「写了但是别的容量」和「一个字没写」两种情况：
   前者该丢（写 128G 就是要 128G），后者不该丢（卖家懒得写而已）。 */
function storageWritten(titleLower){
  /* 尾断言只能用 [^0-9]，绝不能加 a-z：标题里"64gid已退""128Gid已退"这类连写非常常见
     （卖家把"64G ID已退"的空格省了），加了 a-z 就会把这类当成"没写容量"而放行，
     而它们恰恰明确写了 64G —— 条件要 256/512 就该丢。实测踩过：
     「苹果xr美版换电池面容有问题 64gid已退不包邮到付邮费248」这条 64G 就因此混进了 hits。 */
  return /(^|[^0-9])(\d{2,4})\s*(gb?|tb?)([^0-9]|$)/i.test(String(titleLower||""));
}
function matchStorage(titleLower,n){
  if(n>=1024) return /(^|[^0-9])(1\s*tb?|1024\s*gb?)([^0-9]|$)/i.test(titleLower);
  const re=new RegExp("(^|[^0-9])"+n+"\\s*gb?([^0-9]|$)","i");
  return re.test(titleLower);
}
/* 【修「命中不准确」根因 D】keyword 本身就是品牌词时，自动兜底做品牌校验。
   背景：面板里「品牌」默认是空数组（[]），旧版 localFilter 见到空数组就整段跳过，
   等于 100% 信任服务端按关键词分词召回的结果。实测「苹果」这个条件里因此混进了
   「终身质保 闪迪 256GB DDE1 固态 U 盘 读 1000MB/s」这种完全无关的商品。
   规则：keyword 去掉空白后，若等于某个品牌别名、或包含品牌名本身，就返回该品牌 key。
   只做"关键词里明写了品牌"这一种判断，不做模糊联想，避免把别的品类误杀。 */
function brandFromKeyword(kw){
  const s=String(kw||"").toLowerCase().replace(/\s+/g,"");
  if(!s) return [];
  for(const b of (CATALOG.brands||[])){
    for(const k of (b.k||[])){
      const kk=String(k).toLowerCase();
      if(kk&&s.indexOf(kk)>=0) return [b.v];
    }
  }
  return [];
}
function hasAnyKeyword(titleLower,list){
  return (list||[]).some(function(k){
    const def=(CATALOG.brands||[]).concat(CATALOG.versions||[]).find(function(x){return x.v===k;});
    if(def&&def.k) return def.k.some(function(kk){ return titleLower.indexOf(String(kk).toLowerCase())>=0; });
    return false;
  });
}
/* ===== 平台标签匹配（优先用卖家填的真实属性） ===== */
const LABEL_BRANDS={
  apple:["Apple/苹果","Apple","苹果"],
  huawei:["华为"],honor:["荣耀"],xiaomi:["小米","红米","Redmi"],
  oppo:["OPPO"],vivo:["vivo","iQOO"],samsung:["三星"],oneplus:["一加"],
  realme:["真我"],meizu:["魅族"],nubia:["努比亚","红魔"],sony:["索尼"],
  nokia:["诺基亚"],zte:["中兴"],google:["Google","谷歌"]
};
/* 标签里是否含指定品牌 */
function tagBrand(tags,key){
  const want=LABEL_BRANDS[key]||[];
  return (tags||[]).some(function(t){ return want.some(function(w){ return String(t).indexOf(w)>=0; }); });
}
/* 标签里的容量（返回数字，如 256 / 1024） */
function tagStorage(tags){
  const out=[];
  (tags||[]).forEach(function(t){
    const m=/^\s*(\d+)\s*(GB|TB|G|T)\s*$/i.exec(String(t));
    if(!m) return;
    let n=Number(m[1]);
    if(/^T/i.test(m[2])) n=n*1024;
    if(n===1024||n===512||n===256||n===128||n===64||n===32||n===16) out.push(n);
  });
  return out;
}

/* 【修「命中不准确」收尾·根因 F】「未写容量放行」只该给手机/平板，不该给配件。
   b108 那版把「标题和标签都没写容量」一律放行，本意是救「卖家懒得写 256G」的真机，
   实测却把一整个配件柜放了进来：AirPods 2 代 / AirPods Pro / MacBook Pro A1278 /
   iPad mini 4 / 苹果高仿手表 —— 这些标题根本不会写「256G」，因为它们的卖点不是容量。
   它们能凑到 ¥100-300 这个价位段，于是把真正的 256/512G 二手 iPhone 挤出面板前列。
   收窄方式（不是恢复严格模式，那会把真机重新漏掉）：
     只有当标题命中「手机/平板型号词」时才享受宽松放行；
     配件、电脑、手表这类非手机品类，仍然要有可见容量才放行。 */
const DEVICE_KEYS=[
  "iphone",
  "苹果x","苹果xs","苹果xr","苹果se","苹果6","苹果7","苹果8","苹果9",
  "苹果11","苹果12","苹果13","苹果14","苹果15","苹果16","苹果17","苹果18",
  "xsmax","xs max","iphonex","se一代","se二代","se1 ","se2 ","se3 ",
  /* 平板/手表/Mac/AirPods：用户明确要 iPad，且这三类都是真设备。
     旧版把它们排除在外，导致「要 iPad」和「挡配件」直接冲突 ——
     想收 iPad 就必须关掉整个闸门，一关配件全进来。 */
  "ipad","平板","macbook","imac","苹果电脑","watch","手表","手环","airpods"
];
/* 平板（iPad）**故意不算**手机：实测这一档价位（≤500）能筛到的 iPad 基本是
   "iPad mini 4 ¥220" / "iPad pro2017 10.5寸 伊拉克成色 解锁机 ¥406" 这类古董机，
   它们不写容量就会被放行，和真手机抢面板。想要 iPad 的人把 keyword 换成 ipad 即可，
   那时标题通常带 64G/128G 会被容量闸门正常判定。 */
/* 配件词表：只在「没有明确机型词」的次判定里用，用来挡「苹果保护壳 13pro」这种
   把机型数字挂在配件名后面的标题（实测踩到：保护壳 13pro 全新 带发票 被判成手机）。 */
const ACCESSORY_RE=/保护壳|手机壳|保护套|保护膜|贴膜|钢化膜|数据线|充电线|充电头|充电器|耳机套|耳塞|表带|表壳|支架|卡托|转接头|扩展坞|内存卡|硬盘盒|拆机|配件|后盖|外壳|排线|总成|镜片|手写笔|键盘|鼠标|收纳包|防尘塞/;

function deviceTitle(titleLower){
  const t=String(titleLower||"");
  /* ① 先算「机型词在标题里第一次出现的位置」，-1 表示整条标题没提机型。
     位置而不是布尔，是为了下面判配件词是不是在「卖配件」而不是「描述成色」。 */
  let posHs=-1;
  for(const k of DEVICE_KEYS){
    const p=t.indexOf(k);
    if(p>=0&&(posHs<0||p<posHs)) posHs=p;
  }
  /* 不带「苹果/iphone」字样的代际写法：必须紧跟 pro/max/plus/mini，
     否则「12期免息」「保修12个月」里的纯数字会被当成机型。 */
  const gen=/(?:^|[^0-9a-z])(?:1[1-9]|x|xr|xs)(?:\s*(?:pro|max|plus|mini))\b/.exec(t);
  if(gen){
    const lead=/^[^0-9a-z]/.test(gen[0])?1:0;
    const p=gen.index+lead;
    if(posHs<0||p<posHs) posHs=p;
  }
  if(posHs<0&&/(?:^|[^a-z])ip(?:hone|ad)?(?:[0-9]|$)/.test(t)) posHs=t.search(/(?:^|[^a-z])ip(?:hone|ad)?(?:[0-9]|$)/);
  /* 兜底：标题同时写了「苹果」和容量（16/32/64/128/256/512/1024 + GB/TB），
     按设备处理 —— 只有真机才会两个都写。实测救回「苹果ipone16promax国行256G」
     这种机型名拼错的真机（拼成 ipone，任何词表都认不出）。 */
  if(posHs<0&&/苹果/.test(t)&&/(^|[^0-9])(16|32|64|128|256|512|1024)\s*(gb?|tb?)([^0-9]|$)/i.test(t)) posHs=0;
  /* ② 配件词只有两种位置才算「在卖配件」：
        · 标题开头就是配件（手机壳 / 数据线 / 苹果保护壳）—— 卖家主语是配件；
        · 紧跟在机型词后面（苹果13pro手机壳 / iPhone原装充电器）—— 机型是定语。
     实测踩到两条真机被误杀：「女大自用苹果x,换过一次电池…后盖和摄像头那有一点缝隙」
     「苹果iPhone SE一代…当配件机出！」—— 描述正文里出现"后盖/配件"是在讲成色，
     整段一刀切会把真机丢掉，比放行配件更伤。 */
  const acc=ACCESSORY_RE.exec(t);
  if(acc){
    const p=acc.index;
    if(p<=6) return false;
    if(posHs>=0&&p>=posHs&&p<=posHs+10) return false;
  }
  return posHs>=0;
}

function localFilter(task,it){
  /* 价格哨兵值：闲鱼把"回收 / 询价 / 非卖品"类商品的 price 置成 99999999 当占位符
     （实测命中的两条：「苹果筐，6斤一个」¥99999999、「iPhone 17 Pro Max」回收话术帖 ¥99999999）。
     这不是真实售价，一律当"价格面议"处理，不进库 —— 否则面板里会冒出荒谬的天价，
      按价格排序时也会被顶到最前面。 */
  if(it.price!=null&&Number(it.price)>=1000000){ noteDrop("价格哨兵","¥"+it.price); return false; }
  if(task.minPrice!=null&&!(it.price>=task.minPrice)){ noteDrop("低于最低价","¥"+it.price+" < "+task.minPrice); return false; }
  if(task.maxPrice!=null&&!(it.price<=task.maxPrice)){ noteDrop("高于最高价","¥"+it.price+" > "+task.maxPrice); return false; }
  const title=it.title||"";
  const tl=title.toLowerCase();
  /* 【cpvFilters 动态筛选 2026-11-04】勾了官方筛选项（品牌/容量/版本/成色…）时，
     服务端已经按类目属性筛过一遍，本地的品牌/版本/容量三道闸门就没必要再跑——
     它们用的是手机词表，会把「显卡」「相机」这类被服务端正确筛出来的货再误杀一次。
     其余规则（价格/地区/屏蔽词/必须包含/信用/时间）照旧保留。 */
  const hasCpv=!!(task.cpvFilters && typeof task.cpvFilters==="object" && Object.keys(task.cpvFilters).length);

  /* 必须包含关键词：全部命中才保留（仍按标题，用于快速收敛） */
  for(const w of (task.mustContain||[])) if(w&&tl.indexOf(String(w).toLowerCase())<0){ noteDrop("缺少必须词","需「"+w+"」"); return false; }

  /* 【优化#2】地区本地兜底校验。
     以前地区只在服务端 extraFilter 里生效，本地一次都不判 —— 服务端偶尔放跨省推荐位、
     或配置里的省市为空时，外省货会直接进库（实测一次解屏回灌 458 条外省记录）。
     这里再判一遍，条件与粒度规则见 regionOk() 的注释。
     放在关键词之后、品牌等重逻辑之前：地区是硬条件，早丢早省 CPU。 */
  if(!regionOk(task,it)){ noteDrop("非目标地区","「"+String((it&&it.area)||"未知")+"」"); return false; }

  /* 【修「命中不准确」根因 E】占位价识别。
     ¥1 / ¥0.01 / ¥9.9 这类"标价"不是真实售价，常见于代购预售帖与"拍下改价"话术帖。
     实测混进来的：「iPhone Duo 256GB 星光白，苹果官方订单，南宁万象城Apple Store」标 ¥1，
     它轻松通过 maxPrice=500 的上限，还会在"价格从低到高"里永远霸榜，把真实货挤到后面。
     判定（满足全部才丢）：价格 ≤ placeholderPriceMax（默认 10 元）
                         且标题里出现 定金/订金/预售/代购/尾款/拍下/改价/咨询/联系 之一。
     不做"价格≤10 就丢"的一刀切：真有一元起拍、一元福利的实货，那种标题不带这些话术词。 */
  {
    const phMax=Number(cfg.placeholderPriceMax==null?10:cfg.placeholderPriceMax);
    if(phMax>0&&it.price!=null&&Number(it.price)<=phMax){
      const phRe=/(定金|订金|预售|代购|尾款|拍下|改价|咨询|联系|私聊|补差价|一元拍|预约|排队|官方订单|官网订单|京东首发|天猫首发|抢购|代抢|改单|锁单)/;
      /* 加价话术：标价 ¥1 只是入口价，真实成交价写在后面的“+1000/加价/补差”里。
         实测「iPhone Duo 256GB 星光白，苹果官方订单，南宁 万象城Apple Store 当面交，+1000可交」
         标 ¥1 通过了 maxPrice=500，加 1000 后实际 1001 元，根本不该进库。
         只在 price<=phMax（默认 10 元）区间内生效，误杀面很小：真·一元福利帖不会写 +500。 */
      const phMarkup=/(?:[+＋]\s*\d{2,5})|(?:加价|加钱|另加|补差|再加)/;
      if(phRe.test(tl)||phMarkup.test(tl)){ noteDrop("占位价/预售","≤"+phMax+"元 "+title.slice(0,20)); return false; }
    }
  }
  /* 【修「命中不准确」根因 G】加价帖在正常价位上也必须挡：标价不是成交价。
     上面那段只在 price<=placeholderPriceMax(10 元) 时生效，于是价签写得"正常"的加价帖直通。
     实测（全国条件下本轮「合格品最新」那条）：
       「iPhone duo折叠屏首发，北京西单大悦城24号10点取货，全新未拆封黑色256GB +500白色256GB +500」
       标价 ¥500 刚好等于 maxPrice → 通过 → 被当成"12 分钟前的合格新货"报出来。
       可 +500 之后真实成交价是 1000 元，是预算的两倍。
     判据：标题里的 “+N” 解析出加价数字，且 标价+N > maxPrice → 丢。
     只在「真的会超预算」时丢，且必须有 maxPrice 才判（没设上限时加价不构成超预算）。 */
  {
    const mx=(task.maxPrice!=null?Number(task.maxPrice):null);
    if(mx!=null&&it.price!=null){
      const mk=String(title).match(/[+＋]\s*(\d{2,5})/);
      if(mk){
        const add=Number(mk[1]);
        const real=Number(it.price)+add;
        if(add>0&&real>mx){ noteDrop("加价后超预算","¥"+it.price+"+"+add+"="+real+" > "+mx); return false; }
      }
    }
  }
  /* 品牌：优先用平台标签，标签没有才退回标题。
     【修「命中不准确」根因 D】task.brands 为空时旧版整段跳过 → 完全信任服务端的分词召回。
     实测「苹果」条件里因此收进「终身质保 闪迪 256GB DDE1 固态 U 盘 读 1000MB/s」（与苹果无关）。
     现在 brands 为空就从 keyword 反推品牌（brandFromKeyword）；反推不出来才真的跳过
     （比如 keyword 是「相机」「显卡」这种品类词，硬套品牌反而会误杀）。 */
  const brandNeed=hasCpv?[]:((task.brands||[]).length?task.brands:brandFromKeyword(task.keyword));
  if(brandNeed.length){
    const tags=it.tags||[];
    const hit=brandNeed.some(function(k){ return tagBrand(tags,k); });
    if(!hit && !hasAnyKeyword(tl,brandNeed)){ noteDrop("非目标品牌","需 "+brandNeed.join("/")); return false; }
  }
  /* 版本：平台不提供标签，只能按文字（标题+描述） */
  if(!hasCpv && (task.versions||[]).length && !hasAnyKeyword(tl,task.versions)){ noteDrop("非目标型号","需 "+task.versions.join("/")); return false; }
  /* 存储容量：优先用平台标签，标签没有才退回标题 */
  if(!hasCpv){
    const tags=it.tags||[];
    const st=tagStorage(tags);
    const want=(task.storages||[]).map(Number);
    /* 【品类自动判断 2026-11-04】不再让用户手选「手机数码/通用」。
       keyword 能反推出手机品牌（苹果/华为/小米…）→ 按手机走机型/容量闸门、挡壳膜线；
       反推不出来（显卡/相机/衣服/娃娃…）→ 按通用走，跳过手机专属闸门。 */
    const generic=!brandFromKeyword(task.keyword).length;
    if(generic){
      /* 【v2026-11-02 通用品类】下面那整块（deviceTitle 品类纯度闸门 + storageStrict 严格模式）
         只在「要的是手机/平板/手表/耳机」时才说得通：显卡、相机、衣服、娃娃的标题里
         永远不会写 256G，一过 deviceTitle 就被判「非目标品类」丢掉。
         实测：keyword=显卡 + 广西桂林，服务端自报召回 1500 条、单页取回 30 条，
         30 条全部倒在 deviceTitle 上，命中 0 —— 不是没货，是闸门不认识显卡。
         通用品类下只保留「用户真的填了容量」这一种判定，而且是宽松的：
         标签或标题写了容量就按它比对，写不出来就放行（通用品类里不写容量是常态）。 */
      if(want.length){
        if(st.length){
          if(!want.some(function(n){ return st.indexOf(Number(n))>=0; })){
            noteDrop("容量不符(标签)","标签 "+st.join("/")+"GB · "+title.slice(0,20)); return false; }
        } else if(storageWritten(tl) && !want.some(function(n){ return matchStorage(tl,Number(n)); })){
          noteDrop("容量不符(标题)","需 "+task.storages.join("/")+"GB · "+title.slice(0,20)); return false;
        }
      }
    } else if(!want.length){
      /* 【修「命中不准确」根因 H】不筛容量时的品类纯度闸门。
         用户场景：不限容量、但要 iPhone/iPad、不要手机壳和数据线。
         旧版把这一整段包在 if(storages.length) 里，容量一留空，
         deviceTitle 就不执行 —— 于是配件、游戏账号、衣服全部放行。
         现在拆开：容量不填，就只问一句「这是不是一台设备」。
         放行的品类：iPhone / iPad / Apple Watch / Mac / AirPods（见 DEVICE_KEYS）。 */
      if(!deviceTitle(tl)){ noteDrop("非目标品类",title.slice(0,20)); return false; }
    } else if(st.length){
      /* ① 平台标签写了容量：标签是卖家填的结构化属性，比标题文字可信，严格按标签判 */
      if(!want.some(function(n){ return st.indexOf(Number(n))>=0; })){
        noteDrop("容量不符(标签)","标签 "+st.join("/")+"GB · "+title.slice(0,20)); return false; }
    } else if(storageWritten(tl)){
      /* ② 标题自己写了容量 → 按标题判。写了 128G 而条件要 256/512，就该丢 */
      if(!want.some(function(n){ return matchStorage(tl,Number(n)); })){
        noteDrop("容量不符(标题)","需 "+task.storages.join("/")+"GB · "+title.slice(0,20)); return false; }
    } else if(cfg.storageStrict){
      /* ③-a 严格模式（面板可开）：看不出容量就丢，回到旧行为 */
      noteDrop("未写容量(严格模式)",title.slice(0,20)); return false;
    } else if(deviceTitle(tl)){
      /* ③-b 宽松放行（仅限手机/平板）：标题和标签都没写容量 → 放行。
         实测一轮 88 条里 67 条栽在旧版这条规则上，其中绝大多数是「卖家标题懒得写容量」，
         不是「容量不对」。把这类货丢掉，就是用户感觉"漏抓"的最大单一原因。
         宁可多一条待确认，也别把真货漏在外面；放行条数单独统计，不混进"被挡掉"。 */
      notePass("标题未写容量");
    } else {
      /* ③-c 非手机品类（AirPods / Apple Watch / MacBook / 数据线 / 保护壳 …）：
         它们的标题永远不会写 256G，因为卖点不是容量；一旦放行，整个配件柜会挤满面板。
         这类必须有可见容量才进，否则按"不是要找的机型"丢掉。 */
      noteDrop("非手机品类(未写容量)",title.slice(0,20)); return false;
    }
  }
  /* 屏蔽标题词：只比标题，命中即丢（本地过滤，不发额外请求）
     命中顺便记一笔，面板上就能看到"这个词到底拦掉过多少条"（0 命中的可以考虑删） */
  for(const w of titleBlockWordsOf(task)){
    if(w&&tl.indexOf(String(w).toLowerCase())>=0){ noteDrop("标题屏蔽词","「"+w+"」"); noteWordHit("标题",w,it.itemId); return false; }
  }
  /* 屏蔽卖家词：只比卖家昵称，命中即丢（同样本地即时过滤，昵称是搜索结果里直接带的）
     命中也记一笔，面板上和标题/内容屏蔽词共用一套命中计数 */
  for(const w of sellerBlockWordsOf(task)){
    const sn=String((it&&it.seller)||"").toLowerCase();
    if(w&&sn.indexOf(String(w).toLowerCase())>=0){ noteDrop("卖家屏蔽词","「"+w+"」"); noteWordHit("卖家",w,it.itemId); return false; }
  }

  /* 自动商贩屏蔽（seller-blocklist.json）：按 seller_id 拦，命中即丢。
     与上面的"卖家屏蔽词"是两套东西：那个是用户手打的昵称关键词，这个是自动/手动确认的整个卖家。
     这里只做"新货不进门"；已经躺在 hits 里的历史记录由面板显示时再过滤一次。 */
  {
    const bl=sellerBlocked(it);
    if(bl){
      if(sellerBlockLogSilent){
        sellerBlockSilentCount++;
      }else{
        log("   [自动屏蔽卖家] "+((it.title||"").slice(0,24))+" ← 卖家 "+(bl.name||it.seller||""));
      }
      noteDrop("自动屏蔽卖家",(bl.name||it.seller||""));
      return false;
    }
  }

  /* 卖家信用（本地过滤） */
  const need=task.credit||"";
  if(need){
    const RANK={"一般":1,"良好":2,"优秀":3,"极好":4};
    const got=RANK[it.credit]||0;
    if(got<(RANK[need]||0)){ noteDrop("信用不足","需"+need+" 实为"+(it.credit||"未知")); return false; }
  }
  const days=Number(task.publishDays||0);
  if(days>0&&it.publishTimeAdjusted){
    const age=(Date.now()-it.publishTimeAdjusted)/86400000;
    if(age>days){ noteDrop("超出发布天数",Math.round(age)+"天 > "+days+"天"); return false; }
  }
  return true;
}

/* ===== 读取商品详情文案（拦截页面自身请求，约 0.7~1.3 秒） ===== */
async function fetchDesc(itemId){
  let p;
  try{ p=await ensurePage(); }catch(e){ return null; }
  let done=false, captured=null;
  const onRoute=async(route)=>{
    const r=route.request();
    try{
      const u=new URL(r.url());
      const pd=r.postData()||"";
      const m=/data=([^&]*)/.exec(pd);
      if(m && !done){
        done=true;
        const obj=JSON.parse(decodeURIComponent(m[1]));
        obj.itemId=String(itemId);
        const nd=JSON.stringify(obj);
        const t=u.searchParams.get("t");
        const cs=await ctx.cookies();
        /* 【修 BUG-Q】详情接口同样按域取 token（之前 find() 抓第一个会拿错 taobao 的那份） */
        const token=goofishTokenOf(cs);
        if(token&&t) u.searchParams.set("sign",md5(token+"&"+t+"&"+APPKEY+"&"+nd));
        return route.continue({url:u.toString(),postData:"data="+encodeURIComponent(nd)});
      }
    }catch(e){}
    return route.continue();
  };
  const onResp=async(r)=>{
    if(captured) return;
    if(r.url().indexOf("idle.pc.detail")<0) return;
    try{
      const t=await r.text();
      if(t.indexOf('"desc"')<0) return;
      const j=JSON.parse(t);
      const it=(j.data&&j.data.itemDO)||{};
      captured={title:it.title||"",desc:String(it.desc||"").slice(0,2000)};
    }catch(e){}
  };
  try{
    await p.route("**/*idle.pc.detail*",onRoute);
    p.on("response",onResp);
    try{ await p.goto("https://www.goofish.com/item?id="+itemId,{waitUntil:"commit",timeout:20000}); }catch(e){}
    for(let i=0;i<30&&!captured;i++) await sleep(150);
  }finally{
    try{ await p.unroute("**/*idle.pc.detail*",onRoute); }catch(e){}
    try{ p.off("response",onResp); }catch(e){}
  }
  return captured;
}

/* 取描述（优先缓存）
   修 bug：以前"拿不到详情"时把空串 "" 写进缓存，而 descPass() 只在 d==null 时放行、
   收到 "" 会走 indexOf 然后全不命中 → 也放行。结果是：只要某次 fetchDesc 失败
   （首个请求不是详情接口 / 4.5s 没等到），该商品的「屏蔽内容词」就永久失效，
   而且 hasOwnProperty 判存在即返回，永远不会重试。
   现在改成：失败不写缓存，只在 descFail 里记次数；试满 3 次才认命写 "" 放过，
   并且下轮还会重新试 —— 既不会无限拖慢，也不会一次失败就永久失效。 */
const descFail={};
async function getDesc(itemId){
  if(Object.prototype.hasOwnProperty.call(descCache,itemId)) return descCache[itemId];
  let d=null;
  try{
    const r=await fetchDesc(itemId);
    if(r&&typeof r.desc==="string"&&r.desc.length) d=r.desc;
  }catch(e){}
  if(d==null){
    descFail[itemId]=(descFail[itemId]||0)+1;
    if(descFail[itemId]<3) return null;      /* 还没试满：这轮当"未知"，下轮重试 */
    d="";                                     /* 试了 3 次都为空：认命，别一直拖 */
  }
  delete descFail[itemId];
  if(d===""){ return null; }  /* 空描述不落缓存：下轮可重试，避免空串永久记忆 */
  descCache[itemId]=d;
  /* 缓存上限，超出后裁剪最旧的 */
  const keys=Object.keys(descCache);
  if(keys.length>4000){ keys.slice(0,keys.length-3000).forEach(function(k){ delete descCache[k]; }); }
  return d;
}

/* 完整描述是否命中屏蔽词：返回 true = 保留，false = 丢弃
   三栏分开：
     · excludeWords        = 屏蔽标题词（只比标题，本地即时过滤，不花额外请求）
     · descExcludeWords    = 屏蔽内容词（要比【商品完整页正文】，需要读详情，每轮有配额）
     · sellerBlockWords    = 屏蔽卖家词（只比卖家昵称，本地即时过滤，不花额外请求） */
function titleBlockWordsOf(task){
  return (task.excludeWords||[]).filter(Boolean);
}
function blockWordsOf(task){
  return (task.descExcludeWords||[]).filter(Boolean);
}
/* 卖家屏蔽词：按卖家昵称匹配，命中即丢。
   和「屏蔽标题词」同属本地即时过滤 —— 昵称是搜索结果里直接带的（ex.userNickName），
   不需要额外请求，所以不占"读详情"的配额。 */
function sellerBlockWordsOf(task){
  return (task.sellerBlockWords||[]).filter(Boolean);
}

/* ===== 自动识别商贩（按卖家出现频次）=====
   为什么单独一份名单文件，而不是把商贩塞进 sellerBlockWords：
     · sellerBlockWords 是用户手打的词，进 sigOfTask；改它就会触发清库 + 重翻 50 页基线
     · 自动识别的结果随时在变，写进用户词表会把两件事搅在一起，也没法一键撤销
     · 所以这里用独立文件 data\seller-blocklist.json，键是 seller_id（不是昵称）：
       昵称会重复、会改、还会为空（库里 864 条里 28 条空），seller_id 才是稳定主键
   屏蔽/解屏都是当场生效，不动签名、不清库。 */
const SBLOCKF=path.join(DATA,"seller-blocklist.json");
let sellerBlocklist=readJSON(SBLOCKF,{});   /* {sellerId:{name,rate,deals,at,why}} */
function sellerBlockSave(){
  writeJSON(SBLOCKF,sellerBlocklist);
}
/* 【优化#1】清掉名单里所有人的 hidden[]。
   背景（这是 458 条外省货反复出现的根因）：
     · 屏蔽卖家时，已入库的记录不是删掉，而是搬进该卖家的 hidden 数组（见下方 /__scan/sellerblock 路由）；
     · 「解除屏蔽」时又把 hidden 原样放回 hits —— 这是设计意图，用户说"有些也是好商贩"，撤了还得能捞回来；
     · 但 hits 有两条清库出口：「条件变更清库」和「清空记录」，它们**只清 hits、不清 hidden**。
   结果就是：用户因为换了地区/价格条件而清库，清完再去解屏，被屏蔽期间囤下的老货
   （包含旧条件收进来的外省货）全部回灌 —— 实测一次解屏回了 1080 条，其中 458 条外省。
   所以两条清库出口都要顺手把 hidden 一起清掉：清库的语义是"这批记录不要了"，
   藏在名单里的那部分同样属于"这批记录"。
   只清 hidden 数组，不删名单条目本身（屏蔽关系继续有效，下一个被屏蔽的货照样能囤）。 */
function sellerBlockClearHidden(){
  let n=0,owners=0;
  try{
    for(const k in sellerBlocklist){
      const e=sellerBlocklist[k];
      if(e&&Array.isArray(e.hidden)&&e.hidden.length){ n+=e.hidden.length; owners++; e.hidden=[]; }
    }
    if(owners) sellerBlockSave();
  }catch(e2){ log("清理名单 hidden 失败: "+e2.message); }
  return {items:n,sellers:owners};
}
/* 返回被挡下的名单条目（没挡返回 null），顺带兜底昵称匹配 —— 防止老记录没存 sellerId */
function sellerBlocked(it){
  const sid=it&&it.sellerId;
  if(sid&&sellerBlocklist[sid]) return sellerBlocklist[sid];
  const nm=it&&it.seller;
  if(nm){
    for(const k in sellerBlocklist){
      if(sellerBlocklist[k]&&sellerBlocklist[k].name===nm) return sellerBlocklist[k];
    }
  }
  return null;
}
/* ===== 第三路信号：卖家主页（在售件数 / 简介）=====
   为什么需要它：频次和昵称这两路都抓不到「库存很宽、但在我们的搜索词下只命中 1-2 条」的商贩。
   典型反例（用户实测点名）：木子数码 在我们库里只有 1 条，简介写着「桂林有实体店」，
   主页 238 件在售 —— 频次永远到不了门槛，昵称里也没有更多线索。

   怎么取（实测可用，不用打开商品页）：
     在监控自己的取数页面里直接调 window.lib.mtop.request，这是页面自带的 mtop SDK，
     会自动带 baxia 风控令牌、自己算 sign —— 不经过 callSearch 那套拦截重签。
       api: "mtop.idle.web.user.page.head"，data: {self:false, userId:"<seller_id>"}
     返回：
       module.tabs.item.number           宝贝总数
       module.tabs.rate.number           评价数
       module.shop.level / score         等级 / 芝麻分
       module.shop.businessQuality.type  licensedOperation = 持证经营
       module.base.introduction          卖家简介

   准确性（2026-10-20 用用户已屏蔽的 39 个当标准答案 + 69 个未屏蔽卖家实测）：
     宝贝数分布  已屏蔽 最小3 P25=46 中位=101 P75=349 最大2928
                 未屏蔽 最小1 P25=4  中位=14  P75=35  最大421
     阈值>=40    召回 79%  误伤 20%
     >=40 或 简介含商家词  召回 87%  误伤 29%（但逐个看误伤那 14 个，12 个确实是商贩：
       勤奋小伙持证421件「仅需850一台 仅限自取」、柏树林典型的馍馍「桂林实体店专业批发...回收 抵押」）

   频率是硬约束（实测）：
     320ms 间隔连打 122 个 → 76 成 46 败，而且失败是成段的（先连 22 成，再连 18 败）
     700ms 间隔连打 40 个 → 25 成 15 败
     1500ms 间隔 → 46 个补查全部成功
     所以这里用 1500ms、每轮限量、连败 3 次就整轮放弃等下一轮。
     好在增量极小：实测每小时只新增 2-11 个卖家（每轮约 1 个），一轮只多花几秒。 */
const SPROF=path.join(DATA,"seller-profile.json");
let sellerProfiles=readJSON(SPROF,{});   /* { sellerId:{items,rates,lvl,bq,intro,at} } */
const SPROF_TTL=7*86400000;              /* 主页数据一周内复用，商贩不会突然变成个人 */
const SPROF_GAP=1500;                    /* 实测安全间隔，再快就被成段挡回 */
function sellerProfileSave(){ writeJSON(SPROF,sellerProfiles); }
/* 挑出「需要去查主页」的卖家：没缓存、或缓存超过 7 天。 */
function sellerProfileNeed(sids){
  const now=Date.now();
  const out=[];
  for(const sid of (sids||[])){
    if(!sid) continue;
    const p=sellerProfiles[sid];
    if(p&&p.at&&now-p.at<SPROF_TTL) continue;
    out.push(sid);
  }
  return out;
}
/* 简介里的商家关键词。实测：已屏蔽 21/39(54%) 命中，未屏蔽 12/69(17%) 命中。
   注意别加「原装/正品/全新」这种个人卖家也爱写的词 —— 会把散户一起圈进来。 */
function sellerIntroLooksShop(s){
  const t=String(s||"");
  if(t.length<4) return false;
  return /实体店|批发|库存|现货|回收|置换|新机|二手|数码|专业|厂家|代理|拿货|同行|档口|出货|质保|包换|售后|走量|支持验机|批量/.test(t);
}
let sprofBusy=false, sprofFailRun=0, sprofLastAt=0;
/* 真正去查。串行 + 固定间隔，绝不能和扫描并发 —— 一个 page 上同时跑两个 evaluate 会互相打断。 */
async function sellerProfileProbe(sids){
  if(!sids||!sids.length) return {ok:0,fail:0,skipped:true};
  if(sprofBusy) return {ok:0,fail:0,skipped:true};
  if(manualVerify||stop) return {ok:0,fail:0,skipped:true};
  sprofBusy=true;
  let ok=0,fail=0,consecFail=0;
  try{
    const p=await ensurePage();
    /* 页面必须在 goofish 域下，window.lib.mtop 才存在。不在就放弃，等下一轮。 */
    const has=await p.evaluate(function(){
      try{ return !!(window.lib&&window.lib.mtop&&typeof window.lib.mtop.request==="function"); }catch(e){ return false; }
    }).catch(function(){ return false; });
    if(!has) return {ok:0,fail:0,skipped:true};
    for(const sid of sids){
      if(stop||manualVerify) break;
      let r=null;
      try{
        r=await p.evaluate(async function(s){
          try{
            const res=await window.lib.mtop.request({api:"mtop.idle.web.user.page.head",v:"1.0",type:"POST",
              data:{self:false,userId:s}});
            const m=(res&&res.data&&res.data.module)||{};
            const tabs=m.tabs||{}, shop=m.shop||{}, base=m.base||{};
            const num=function(x){ const n=Number(x); return isFinite(n)?n:0; };
            return {ok:true,
              items:num((tabs.item||{}).number),
              rates:num((tabs.rate||{}).number),
              lvl:shop.level||"",
              bq:(shop.businessQuality||{}).type||"",
              intro:String(base.introduction||"").slice(0,120)};
          }catch(e){ return {ok:false,why:String(e&&e.message||e).slice(0,80)}; }
        }, sid);
      }catch(e){ r={ok:false,why:String(e&&e.message||e).slice(0,80)}; }
      if(r&&r.ok){
        sellerProfiles[sid]={items:r.items,rates:r.rates,lvl:r.lvl,bq:r.bq,intro:r.intro,at:Date.now()};
        ok++; consecFail=0;
      }else{
        /* 失败不写缓存，下一轮会重新排队。连续 3 次失败说明被限了，整轮收手。 */
        fail++; consecFail++;
        if(consecFail>=3) break;
      }
      await nap(SPROF_GAP);
    }
    if(ok) sellerProfileSave();
    sprofLastAt=Date.now();
  }catch(e){
    log("   [主页信号] 本轮探测异常: "+String(e&&e.message).slice(0,80));
  }finally{
    sprofBusy=false;
  }
  /* 连败累加：整轮一个都没成、还失败了 3 次以上 → 记一笔，连续两轮就先歇着 */
  sprofFailRun = (fail>=3 && ok===0) ? (sprofFailRun+1) : 0;
  return {ok:ok,fail:fail};
}
/* 每轮扫完后调一次：只挑增量（缓存里没有的），限量，连败就跳过。 */
async function probeSellerProfilesRound(){
  if(cfg.autoBlockSellers===false) return;
  if(cfg.autoBlockByShop===false) return;
  if(sprofFailRun>=2) return;                  /* 上两轮都被挡 → 歇着，下轮再试 */
  if(Date.now()-sprofLastAt < 60000) return;    /* 一分钟内不重复探 */
  const cap=Math.max(0,Math.min(40,Number(cfg.autoBlockMaxProbePerRound!=null?cfg.autoBlockMaxProbePerRound:15)));
  if(!cap) return;
  /* 候选来源：列表里的 + 屏蔽名单里的（后者已确认是商贩，补齐主页数据好在面板上显示原因）。
     按发布时间倒序 → 新货的卖家最值得先看。 */
  const seenSid=new Set();
  const order=[];
  const eat=function(h){
    const sid=h&&h.sellerId;
    if(!sid||seenSid.has(sid)) return;
    seenSid.add(sid); order.push(sid);
  };
  const sorted=hits.slice().sort(function(a,b){
    /* 【修】不能直接 `publishTime||publishAt`：publishAt 是字符串，
       字符串相减得 NaN → 排序回调返回 NaN → 顺序完全不可预测，主页探测也失去"先看新货卖家"的意义。 */
    return (publishMsOf(b)-publishMsOf(a));
  });
  for(const h of sorted) eat(h);
  for(const k in sellerBlocklist) eat({sellerId:k});
  const need=sellerProfileNeed(order).slice(0,cap);
  if(!need.length) return;
  const r=await sellerProfileProbe(need);
  if(r.ok||r.fail) log("   [主页信号] 本轮查了 "+(r.ok+r.fail)+" 个卖家主页（成功 "+r.ok+"，失败 "+r.fail+"），累计已收录 "+Object.keys(sellerProfiles).length+" 个");
  if(r.ok) updateSellerSuspects();
}

/* 自动统计：只算「最近 autoBlockWindowDays 天 + 还挂在列表里」的卖家。
   不按全库算，否则 50 页基线把历史货全堆进来，个人卖家也会被误判成商贩。
   键优先用 seller_id；老记录（加这个功能之前收的）没有 sellerId，
   退回 'nick:昵称' —— 实测同昵称 ↔ 同 sid 1:1 无冲突，所以老记录也能正确归并。

   【2026-10-20 第一次修：屏蔽过的卖家必须继续参与统计】
   以前这里只遍历 hits，而屏蔽一个卖家时他的货会被从 hits 撤进
   seller-blocklist.json 的 hidden[] 里 —— 等于「屏蔽 = 把自己的识别信号删掉」。
   实测后果：屏蔽掉顶部 11 个大户后，池子里剩下 414 个活跃卖家的频次顶格只有 6，
   阈值 8 就永远打不中了，横幅再也不会出现（功能实际只能用一次）。
   现在把名单里 hidden[] 的记录也算进来，被屏蔽者照样出现在候选里（标记 blocked:true），
   这样阈值判断永远基于完整货源，不会自我失效。

   【2026-10-20 第二次修：从「只看条数」改成「两路信号」】
   起因：用户发现「唐朝公子 / 手机数码师傅一枚 / 木子数码」没被识别出来。
   用已屏蔽的 14 个（人工确认过的真商贩）当标准答案实测各路信号：

     信号                          召回        新候选   吃掉条数
     A 频次 ≥5（3 天窗）            14/14 100%     1 个      11 条
     A 频次 ≥5（7 天窗）            14/14 100%    12 个      83 条
     C 昵称像商家 + ≥2 条           8/14   57%    18 个      69 条
     B 评价数 ≥50 + ≥1 条           7/14   50%    49 个      80 条
     A+C（7 天窗）                 14/14 100%    25 个     116 条

   结论：
   · 时间窗口必须从 3 天改成 7 天 —— 库里总共才 4-5 天货，3 天窗等于把大半数据
     挡在统计外。改成 7 天后唐朝公子（7 条）、手机数码师傅一枚（8 条）直接进来。
   · 信号 C（昵称）值得留：它多抓 13 个，样本全是「爱数码小李 / 吉光数码刘刘 /
     桂林二手机批发 / 星辰科技」，精准度好；而且能抓「新开号、评价还是 0、
     频次没积累起来」的新商贩，这是频次信号永远抓不到的。
   · 信号 B（评价数）默认关闭：仅靠它进来的 43 个样本是「卖原装机的小刘 评价3866」、
     「香猪小可爱 评价2269」、「我不是乔神 评价847 卖 iPad2 电池饿死了」这类
     卖得多的个人号，误伤严重。它的唯一价值是抓「库存品类宽、我们只命中 1 条」
     的商贩（比如木子数码只有 1 条但 198 条评价），所以留成可选开关，
     默认 false，门槛 autoBlockMinDeals 默认 100。
   · 好评率不能当信号：已屏蔽的 14 个平均 49.2%，但区间 0%~100% 全有
     （枝忧iPad数码店 100%、咘咘数码店 98%、大滕小滕都姓滕 91%），完全不可分。
   · 标题模板化也不能当信号：能抓 26 个但那批里混着「夏日终曲」「真的讨厌吃葱花」
     这种明显在出个人闲置的。 */
function sellerNameLooksShop(name){
  const s=String(name||"");
  if(!s) return false;
  return /数码|通讯|手机|回收|置换|优品|严选|科技|商行|旗舰|专卖|批发|维修|电子|商城|店|配件|靓机|二手|当铺|典当|通讯行/.test(s);
}
function computeSellerSuspects(){
  if(!cfg.autoBlockSellers) return [];
  const min=Math.max(2,Number(cfg.autoBlockMinCount||5));          /* 信号 A 的条数门槛 */
  const days=Math.max(1,Number(cfg.autoBlockWindowDays||7));       /* 改成 7 天（原 3 天） */
  const useName=cfg.autoBlockByName!==false;                       /* 信号 C：默认开 */
  const useDeals=!!cfg.autoBlockByDeals;                           /* 信号 B：默认关 */
  const minDeals=Math.max(1,Number(cfg.autoBlockMinDeals||100));
  /* 信号 D（第三路）：卖家主页。默认开。
     它和频次是互补的 —— 频次看「在我们这个搜索词下挂了几条」，
     主页看「这个号本身有多大」，能抓到只命中 1 条但库存几百件的大商贩。 */
  const useShop=cfg.autoBlockByShop!==false;
  const minItems=Math.max(1,Number(cfg.autoBlockMinItems||40));    /* 宝贝数门槛，实测 40 是召79%/误20% 的拐点 */
  const cut=Date.now()-days*86400000;
  const m={};   /* key -> {name,count,rate,deals,newest} */
  const eat=function(h){
    if(!h) return;
    /* 【修】旧版 `h.publishTime||h.publishAt||h.publishTimeAdjusted` 会拿到
       "2026/10/21 17:10:36" 这种字符串去做 `ts<cut` 数值比较 → 恒 false，
       publishAt 是字符串时同一卖家会被重复计数/时序错乱。统一走数值。 */
    const ts=publishMsOf(h);
    if(!ts||ts<cut) return;
    const key=h.sellerId||("nick:"+(h.seller||""));
    if(key==="nick:"||key==="nick:undefined") return;
    if(!m[key]) m[key]={name:h.seller||"",count:0,rate:h.sellerRate||"",deals:h.sellerDeals||0,newest:ts};
    m[key].count++;
    if(ts>m[key].newest) m[key].newest=ts;
    if(h.sellerRate) m[key].rate=h.sellerRate;
    if(h.sellerDeals) m[key].deals=h.sellerDeals;
  };
  for(const h of hits) eat(h);
  /* 把已屏蔽卖家的历史货也算进来（否则大户一清、阈值就再也够不到） */
  for(const k in sellerBlocklist){
    const e=sellerBlocklist[k];
    if(!e) continue;
    if(Array.isArray(e.hidden)) for(const h of e.hidden) eat(h);
  }
  const out=[];
  for(const k in m){
    const e=m[k];
    /* 各路信号取并集，每项记下是因为哪条进来的，面板能显示给用户看 */
    const why=[];
    if(e.count>=min) why.push("频次 " + e.count + " 条");
    if(useName && e.count>=2 && sellerNameLooksShop(e.name)) why.push("昵称像商家");
    if(useDeals && e.count>=1 && (e.deals||0)>=minDeals) why.push("评价 " + e.deals);
    /* 信号 D：主页。只在「查到了主页数据」时才判 —— 没查到不等于不是商贩，
       不能因为探测失败就把人放过去，也不能因此算他没嫌疑，所以纯粹是"查到了就多一条证据"。 */
    let prof=null;
    if(useShop){
      prof=sellerProfiles[k]||null;
      if(prof){
        const it=Number(prof.items||0);
        if(it>=minItems) why.push("主页 " + it + " 件在售");
        else if(sellerIntroLooksShop(prof.intro)) why.push("简介像商家");
      }
    }
    if(!why.length) continue;
    out.push({sellerId:k,name:e.name||("卖家 "+k.slice(0,6)),count:e.count,rate:e.rate||"",deals:e.deals||0,newest:e.newest,blocked:!!sellerBlocklist[k],why:why.join(" · "),
      /* 面板要展示主页那两个数字，直接带上，省得前端再查一次 */
      shopItems:prof?Number(prof.items||0):null,shopIntro:prof?String(prof.intro||""):"",shopLvl:prof?String(prof.lvl||""):"",shopBq:prof?String(prof.bq||""):""});
  }
  /* 排序：先按命中信号数（两路都中的更可疑），再按条数 */
  out.sort(function(a,b){
    const wa=(a.why||"").split(" · ").length, wb=(b.why||"").split(" · ").length;
    if(wb!==wa) return wb-wa;
    return b.count-a.count;
  });
  return out;
}
function updateSellerSuspects(){
  try{
    const list=computeSellerSuspects();
    freshInfo.sellerSuspects=list;
    freshInfo.sellerBlocked=Object.keys(sellerBlocklist).length;
    freshInfo.autoBlockOn=!!cfg.autoBlockSellers;
    freshInfo.autoBlockMin=Math.max(2,Number(cfg.autoBlockMinCount||5));
    freshInfo.autoBlockDays=Math.max(1,Number(cfg.autoBlockWindowDays||7));
    freshInfo.autoBlockByName=cfg.autoBlockByName!==false;
    freshInfo.autoBlockByDeals=!!cfg.autoBlockByDeals;
    freshInfo.autoBlockByShop=cfg.autoBlockByShop!==false;
    freshInfo.autoBlockMinItems=Math.max(1,Number(cfg.autoBlockMinItems||40));
    freshInfo.shopProbed=Object.keys(sellerProfiles).length;
  }catch(e){}
}
/* 把某批卖家加进屏蔽名单；返回实际新增的条数。
   list 项可以是 {sellerId,name,rate,deals}（来自 suspects / 卡片按钮），
   也可以是纯字符串 sellerId（卡片上拿不到 suspects 时用）。 */
function sellerBlockAdd(list){
  let added=0;
  const now=Date.now();
  for(const s of (list||[])){
    if(!s) continue;
    const id=typeof s==="string"?s:s.sellerId;
    if(!id) continue;
    if(sellerBlocklist[id]) continue;
    const nm=typeof s==="string"?"":(s.name||"");
    sellerBlocklist[id]={name:nm,rate:(s.rate||""),deals:(s.deals||0),at:now,why:"手动确认"};
    added++;
  }
  if(added){
    sellerBlockSave();
    log("🚫 卖家屏蔽名单新增 "+added+" 个，合计 "+Object.keys(sellerBlocklist).length+" 个（已有记录当场按名单过滤，不清库）");
  }
  updateSellerSuspects();
  return added;
}
/* 解除屏蔽。**注意：不在这里 delete 掉名单条目里的 hidden 数组**，
   因为路由那边要先读 hidden 才能把货放回列表 —— 顺序是：
   路由读 hidden → 恢复记录 → 调 sellerBlockDel 删键 → sellerBlockSave 落盘。 */
function sellerBlockDel(ids){
  let del=0;
  for(const id of (ids||[])){
    if(sellerBlocklist[id]){ delete sellerBlocklist[id]; del++; }
  }
  if(del) log("✅ 解除卖家屏蔽 "+del+" 个，剩 "+Object.keys(sellerBlocklist).length+" 个");
  updateSellerSuspects();
  return del;
}

async function descPass(task,it){
  const words=blockWordsOf(task);
  if(!words.length) return true;
  const d=await getDesc(it.itemId);
  if(d==null) return true;                 /* 拿不到详情就不误杀 */
  const low=d.toLowerCase();
  for(const w of words){
    if(low.indexOf(String(w).toLowerCase())>=0){
      log("   [内容屏蔽] 命中「"+w+"」: "+(it.title||"").slice(0,28));
      noteWordHit("内容",w,it.itemId);
      return false;
    }
  }
  return true;
}

/* ===== 屏蔽词命中统计 =====
   面板上每个屏蔽词后面显示"命中 N"，用来判断哪些词真有用、哪些可以删。
   同一个商品（itemId）对同一个词只记一次，避免每轮重复计数把数字刷爆；
   每个词只保留最近 300 个 itemId 做去重，所以内存和文件都不会无限长。 */
const WORDF=path.join(DATA,"word-hits.json");
let wordHits=readJSON(WORDF,{});
function noteWordHit(kind,word,itemId){
  const k=kind+"|"+String(word);
  let e=wordHits[k];
  if(!e||typeof e!=="object") e=wordHits[k]={count:0,lastAt:0,recent:[]};
  if(!Array.isArray(e.recent)) e.recent=[];
  if(itemId){
    if(e.recent.indexOf(String(itemId))>=0) return;   /* 这条商品已经为这个词记过一次 */
    e.recent.push(String(itemId));
    if(e.recent.length>300) e.recent.splice(0,e.recent.length-300);
  }
  e.count=(Number(e.count)||0)+1;
  e.lastAt=Date.now();
}
/* ===== 每轮丢弃原因统计 =====
   作用：把"这个条件到底没货，还是货被条件挡掉了"这件事变成可看的数字。
   以前 localFilter 直接 return false，丢了什么都不留痕，用户只能看到"命中就几条"，
   分不清是市场没货还是自己条件太窄 —— 这是"命中不准确/有漏"最容易被误判成程序 bug 的地方。
   只统计、不落盘（每轮清零），日志末尾打一行汇总。 */
let dropStats={};
/* 【2026-11-04】基线期把「自动屏蔽卖家」日志合并成一行摘要：基线翻历史页时同一卖家几十条商品
   会被逐条打日志刷屏，只计数、结束时汇总一条。常规轮照旧逐条打。 */
let sellerBlockLogSilent=false;
let sellerBlockSilentCount=0;
function noteDrop(reason,detail){
  const k=String(reason||"其他");
  dropStats[k]=(dropStats[k]||0)+1;
  if(detail&&!dropStats["_ex_"+k]) dropStats["_ex_"+k]=String(detail).slice(0,40);
}
function dropStatsLine(){
  const ks=Object.keys(dropStats).filter(function(k){ return k.indexOf("_ex_")!==0&&k.indexOf("_pass_")!==0; });
  if(!ks.length) return "";
  ks.sort(function(a,b){ return dropStats[b]-dropStats[a]; });
  return ks.map(function(k){ return k+" "+dropStats[k]; }).join(" · ");
}
/* 「宽松放行」：这些条没被挡掉、已经进了候选，只是值得让用户知道其中有多少条是
   因为【看不出容量】才放行的。单独一行打印，绝不混进「被条件挡掉」的数字里，
   否则又变成新的说不清。 */
function notePass(reason){
  const k="_pass_"+String(reason||"其他");
  dropStats[k]=(dropStats[k]||0)+1;
}
function dropPassLine(){
  const ks=Object.keys(dropStats).filter(function(k){ return k.indexOf("_pass_")===0; });
  if(!ks.length) return "";
  ks.sort(function(a,b){ return dropStats[b]-dropStats[a]; });
  return ks.map(function(k){ return k.slice(6)+" "+dropStats[k]; }).join(" · ");
}
function pruneWordHits(){
  const keep={};
  const cut=Date.now()-60*86400000;   /* 60 天没命中的词不带进文件，避免越攒越大 */
  Object.keys(wordHits).forEach(function(k){
    const e=wordHits[k];
    if(!e||typeof e!=="object") return;
    if((Number(e.lastAt)||0)<cut) return;
    keep[k]={count:Number(e.count)||0,lastAt:Number(e.lastAt)||0,recent:Array.isArray(e.recent)?e.recent:[]};
  });
  wordHits=keep;
}

/* ===== seen.json 清理（防无限增长）=====
   背景：seen 是"这个商品已经见过/已经报过"的唯一判据，只写不删。
   实测增速约 930 条/天（基线期更高），一年就是 34 万条 ≈ 11MB，
   而且每轮落盘都要把整个对象序列化一遍，越到后期写盘越慢、事件循环越容易卡。
   清理规则（保守，宁可不删）：
     1) hits 里还在展示的商品 itemId 一律保留 —— 删了会被当成新命中重复报；
     2) 保留最近 SEEN_KEEP_DAYS 天登记的全部记录 —— 二手商品挂 90 天基本早已下架；
     3) 剩下的按"最老优先"削到 SEEN_MAX 条以内，保证文件有硬上限。
   被清掉的都是"当初扫到、但一直没成为命中、且早已过期"的噪音，不影响任何展示。 */
const SEEN_KEEP_DAYS=90;
/* 【修「seen 快撞上限」】上限从 20000 提到 100000。
   测出来的账：全国模式 + keyword「苹果」每轮过条件 300 条上下，
   实测最近 1 小时入库 1140 条 → 20000 条只够撑约 17 小时，撞顶后按最老优先削，
   被削掉的老货若还在卖，下一轮会被当成「新命中」重复报一遍。
   100000 条约需 8 MB 内存 / 6 MB 磁盘，对这台机器不构成负担，
   换算成时长约 3.7 天，并且 SEEN_KEEP_DAYS=90 的时间清理始终先于条数清理生效。 */
const SEEN_MAX=100000;
function pruneSeen(){
  const keys=Object.keys(seen);
  const cutTm=Date.now()-SEEN_KEEP_DAYS*86400000;
  /* 规则 1 必须最先建立：正在展示的记录无论多老都不清，否则会被当成新命中重复报 */
  const keepIds=new Set();
  (hits||[]).forEach(function(h){ if(h&&h.itemId) keepIds.add(String(h.itemId)); });
  let n=0;
  if(keys.length<=SEEN_MAX){
    /* 条数没超上限，仍按时间清一次（避免长期低频使用时文件悄悄变大） */
    for(const k of keys){
      if(keepIds.has(k)) continue;
      const t=Number(seen[k])||0;
      if(t && t<cutTm){ delete seen[k]; n++; }
    }
    if(n) log("seen 清理：清掉 "+n+" 条 "+SEEN_KEEP_DAYS+" 天前的过期记录，剩余 "+Object.keys(seen).length+" 条");
    return n;
  }
  /* 超上限：过期直接清，其余按最老优先削到 SEEN_MAX */
  const pool=[];
  for(const k of keys){
    if(keepIds.has(k)) continue;            /* 规则 1：正在展示的永久保留 */
    const t=Number(seen[k])||0;
    if(t && t<cutTm){ delete seen[k]; n++; continue; }   /* 规则 2：过期直接清 */
    pool.push([k,t]);                        /* 规则 3：候选 */
  }
  const over=Object.keys(seen).length-SEEN_MAX;
  if(over>0){
    pool.sort(function(a,b){ return (a[1]||0)-(b[1]||0); });   /* 最老在前 */
    for(let i=0;i<over&&i<pool.length;i++){ delete seen[pool[i][0]]; n++; }
  }
  if(n) log("seen 清理：清掉 "+n+" 条（过期/超上限），剩余 "+Object.keys(seen).length+" 条");
  return n;
}

/* 面板读配置时用：把 notify 配置转成"能显示但不泄密"的形态。
   凭据只回传 filled:true/false，前端留空 = 不修改（服务端 merge 保留旧值）。
   为什么不明文回传：面板跑在 127.0.0.1 没错，但 webhook URL 里直接带 key
   （企微 ?key=xxx、飞书 /hook/xxx），一旦用户截图发出去就等于泄露。
   second-eye 的 settings.html 把整段 Cookie 明文渲染进 textarea，是个可被
   GET /settings 直接拿走的凭据回显缺陷，这里不重复那个错误。 */
function notifyConfigForPanel(raw){
  const n=notifyLayer.normalizeConfig(raw||{});
  const mask=function(s){ return { filled:!!(s&&String(s).trim()), len:String(s||"").length }; };
  return {
    enabled:n.enabled!==false,
    priceDropNotify:n.priceDropNotify!==false,
    priceDropPct:n.priceDropPct,
    onlyIncreaseRenotify:n.onlyIncreaseRenotify!==false,
    maxItemsPerMessage:n.maxItemsPerMessage,
    timeoutMs:n.timeoutMs,
    retry:n.retry,
    channels:{
      serverchan:{ enabled:!!n.channels.serverchan.enabled, sendkey:mask(n.channels.serverchan.sendkey) },
      wecom:{ enabled:!!n.channels.wecom.enabled, webhook:mask(n.channels.wecom.webhook) },
      feishu:{ enabled:!!n.channels.feishu.enabled, webhook:mask(n.channels.feishu.webhook), secret:mask(n.channels.feishu.secret) },
      gotify:{ enabled:!!n.channels.gotify.enabled, url:mask(n.channels.gotify.url), token:mask(n.channels.gotify.token), priority:n.channels.gotify.priority },
      bark:{ enabled:!!n.channels.bark.enabled, url:mask(n.channels.bark.url) },
      generic:{ enabled:!!n.channels.generic.enabled, url:mask(n.channels.generic.url), type:n.channels.generic.type }
    }
  };
}

/* 面板 POST 上来的 notify：逐字段 merge，空字符串/null 表示"保留旧值"。
   为什么要自己 merge 而不是直接赋值：面板上密码类的 input 是空的（不回显明文），
   如果直接 cfg.notify=n 会把用户原来填的 sendkey 覆盖成空字符串 —— 用户只是改了个
   开关，渠道就被清空了。second-eye 的 save_settings 用 pop 处理同一件事。 */
function mergeNotifyConfig(n, raw){
  const old=notifyLayer.normalizeConfig(cfg.notify||{});
  const o=(n&&typeof n==="object")?n:{};
  const pick=function(v,prev){ return (v===undefined||v===null||v==="")?prev:v; };
  const oc=old.channels, nc=(o.channels&&typeof o.channels==="object")?o.channels:{};
  /* clear = 用户点了某个凭据字段的「清除」。数组形式，只清列出的字段。
     为什么需要：空串在本层语义是"不改"，没有这个开关的话密钥一旦存过就删不掉。
     为什么按字段而不是按渠道：用户只想删飞书 secret，不该连 webhook 一起清掉。 */
  const clrList=function(k){
    const v=nc[k]&&nc[k].__clear;
    if(Array.isArray(v)) return v.map(String);
    if(typeof v==="string"&&v) return [v];
    return [];
  };
  const clr=function(k,f){ return clrList(k).indexOf(String(f))>=0; };
  const pk=function(k,f,v,prev){ return clr(k,f)?'':pick(v,prev); };
  const out={
    enabled:o.enabled!==undefined?!!o.enabled:old.enabled!==false,
    priceDropNotify:o.priceDropNotify!==undefined?!!o.priceDropNotify:old.priceDropNotify!==false,
    priceDropPct:(o.priceDropPct===undefined||o.priceDropPct===null||o.priceDropPct==="")?old.priceDropPct:(Number(o.priceDropPct)||old.priceDropPct),
    onlyIncreaseRenotify:o.onlyIncreaseRenotify!==undefined?!!o.onlyIncreaseRenotify:old.onlyIncreaseRenotify!==false,
    maxItemsPerMessage:(o.maxItemsPerMessage===undefined||o.maxItemsPerMessage==="")?old.maxItemsPerMessage:(Number(o.maxItemsPerMessage)||old.maxItemsPerMessage),
    timeoutMs:(o.timeoutMs===undefined||o.timeoutMs==="")?old.timeoutMs:(Number(o.timeoutMs)||old.timeoutMs),
    retry:(o.retry===undefined||o.retry==="")?old.retry:(Number(o.retry)||old.retry),
    channels:{
      serverchan:{ enabled:!!(nc.serverchan&&nc.serverchan.enabled), sendkey:pk('serverchan','sendkey',nc.serverchan&&nc.serverchan.sendkey, oc.serverchan.sendkey) },
      wecom:{ enabled:!!(nc.wecom&&nc.wecom.enabled), webhook:pk('wecom','webhook',nc.wecom&&nc.wecom.webhook, oc.wecom.webhook) },
      feishu:{ enabled:!!(nc.feishu&&nc.feishu.enabled), webhook:pk('feishu','webhook',nc.feishu&&nc.feishu.webhook, oc.feishu.webhook), secret:pk('feishu','secret',nc.feishu&&nc.feishu.secret, oc.feishu.secret) },
      gotify:{ enabled:!!(nc.gotify&&nc.gotify.enabled), url:pk('gotify','url',nc.gotify&&nc.gotify.url, oc.gotify.url), token:pk('gotify','token',nc.gotify&&nc.gotify.token, oc.gotify.token), priority:(nc.gotify&&nc.gotify.priority!==undefined&&nc.gotify.priority!=="")?Number(nc.gotify.priority):oc.gotify.priority },
      bark:{ enabled:!!(nc.bark&&nc.bark.enabled), url:pk('bark','url',nc.bark&&nc.bark.url, oc.bark.url) },
      generic:{ enabled:!!(nc.generic&&nc.generic.enabled), url:pk('generic','url',nc.generic&&nc.generic.url, oc.generic.url), type:(nc.generic&&nc.generic.type)||oc.generic.type }
    }
  };
  /* 老格式顶层键顺手清掉，避免两套并存时 normalizeConfig 又把它映射回来 */
  delete out.bark; delete out.webhook; delete out.webhookType;
  return out;
}

/* ============================================================================
 * notify —— 已整体替换为多渠道路由推送层（见文件顶部 require 的 notify.cjs）
 * ----------------------------------------------------------------------------
 * 旧实现（13 行）的 7 个致命缺陷，全部在这里修掉：
 *   ① 只有 Bark + 单一 webhook      → 6 渠道：serverchan/wecom/feishu/gotify/bark/generic
 *   ② 飞书无签名                    → HMAC-SHA256(timestamp\nsecret)，对齐 second-eye/feishu.py
 *   ③ 无重试/无超时/无限流          → AbortSignal.timeout + 5xx/网络错误指数退避重试
 *   ④ 不查响应码，500 也打"已推送"  → 解析 errcode/code，非 0 即失败
 *   ⑤ 不落历史                      → data/notify-history.jsonl 逐条记录成功/失败原因
 *   ⑥ 拼一条长文本，飞书 20KB 必挂  → 按渠道字节上限自动分条
 *   ⑦ 无重复抑制                    → 结合 price-memory.cjs 的 notifiedScore
 *
 * 调用点签名保持不变（monitor.cjs 主循环里的 `if(freshAll.length) await notify(freshAll)` 不用改）。
 * 新增可选第二参数 taskMap（itemId → task），用于算"相对任务价格区间"的分数。
 * ========================================================================== */
async function notify(list, taskMap){
  if(!Array.isArray(list)) list=[];
  const ncfg=notifyLayer.normalizeConfig(cfg.notify||{});
  if(ncfg.enabled===false) return {sent:0,failed:0,skipped:0};
  const targets=notifyLayer.buildEnabled(ncfg);
  /* 只剩 log 渠道时也照常走（本地日志要留痕），但不算"推送" */
  const realTargets=targets.filter(t=>t.def.key!=="log");
  if(!realTargets.length){
    log("推送未启用或未配置任何渠道，本轮 "+list.length+" 条仅写入本地日志");
  }

  /* 【修 BUG-LOST 2026-10-29】推送失败不能把商品永久吞掉。
     问题：主循环在判定"新命中"时就把 itemId 写进 seen.json 了，而 notifiedScore 只在推送
     成功时才写。于是"推送失败"的商品同时满足两件坏事：seen 里已经有了（以后不会当新命中
     再出现）、notifiedScore 是空的（would notify 但永远不会被再次调用）→ 永久漏推。
     实测 15:38 那轮 71 条里有 20 条就是这样消失的（首片 ECONNRESET 连坐整批）。
     修法：失败的那一批原样存进 data/notify-retry.json，下一轮开推时先补发，
     成功后从队列移除；同一条最多重试 5 次、最长挂 24 小时，避免坏数据无限重试。 */
  const RETRY_MAX_TRIES=5, RETRY_MAX_AGE_MS=24*3600*1000, RETRY_MAX_ITEMS=300;
  let retry=notifyRetryLoad();
  const pending=[];
  const keepRetry=[];
  const nowMs=Date.now();
  retry.forEach(function(r){
    if(!r||!r.item||!r.item.itemId){ return; }
    const tries=Number(r.tries||0);
    if(tries>=RETRY_MAX_TRIES){ log("   ✗ 补推放弃 "+r.item.itemId+"：已重试 "+tries+" 次仍未成功"); return; }
    if(nowMs-Number(r.at||nowMs)>RETRY_MAX_AGE_MS){ log("   ✗ 补推放弃 "+r.item.itemId+"：已挂 24 小时仍未成功"); return; }
    const it=Object.assign({}, r.item, {__retry:true, __score:(r.score!=null?r.score:r.item.__score)});
    it.__extra=Object.assign({}, r.extra||{});
    pending.push(it);
    keepRetry.push(r);
  });
  /* 队里全是过期/放弃项时要立刻写回，否则每一轮都会重复打同一批"放弃"日志 */
  if(retry.length && pending.length<retry.length){
    try{ notifyRetrySave(keepRetry.slice(-RETRY_MAX_ITEMS)); }catch(e){}
  }
  if(pending.length) log("↻ 补推上一轮失败的 "+pending.length+" 条（重试队列）");

  /* 补推的条目没有 taskMap（它来自别的轮次），用 item.task 名字反查任务 */
  const byName={};
  (cfg.tasks||[]).forEach(function(t){ if(t&&t.name!=null) byName[String(t.name)]=t; });
  const tmOf=function(it){
    const tm0=taskMap||{};
    return tm0[it.itemId]||byName[String(it.task)]||null;
  };

  if(!list.length&&!pending.length) return {sent:0,failed:0,skipped:0};

  /* ---- 逐条：更新价格记忆 + 算综合分 + 判定是否该推 ---- */
  const toSend=[];
  let skipped=0;
  /* 本次推送最多现读几次详情页（缓存命中不计数）。默认 8 —— 一次推 15 条时
     连开 15 个详情页会明显变慢且更容易触发风控，8 条够覆盖绝大多数批次。 */
  let descBudget=Math.max(0, Number(cfg.maxDescPerPush!=null?cfg.maxDescPerPush:8));
  const workList=pending.concat(list);
  for(const it0 of workList){
    const it=it0;
    const task=tmOf(it);
    let pm=null;
    /* 补推的条目价格记忆早就 observe 过了，再 observe 会把它当成"当前价"从而掩盖降价判断，
       但这里只用于算分，重复 observe 是幂等的（同价只更新 lastAt），无副作用。 */
    try{ pm=priceMemory.observe(it, Date.now()); }catch(e){ log("价格记忆更新失败: "+String(e.message||e).slice(0,120)); }
    /* 【易错点，实测踩过】主循环在判定 seen 之前已经 observe 过一次了，那一次把 e.last
       刷新成了当前价。所以这里再用 pm.prev 判"是否降价"永远得到 false（prev==现价），
       降价重推会被自己的重复抑制逻辑吃掉。
       正确做法：优先采信主循环打的 __isRenotify 标记，price-memory 只作兜底。 */
    const preMark=!!it.__isRenotify;
    const dropPct=(it.__dropPct!=null)?it.__dropPct:(pm?pm.dropPct:0);
    const prevPrice=(it.__prevPrice!=null)?it.__prevPrice:(pm?pm.prev:null);
    const isRenotify=preMark||!!(pm&&!pm.isNew&&pm.prev!=null&&Number(it.price)<Number(pm.prev));
    const score=priceMemory.satisfaction(it, task, {freshMaxAgeHours: cfg.freshMaxAgeHours, dropPct: dropPct});

    /* 降价幅度不够 → 不算重推（对齐 second-eye DROP_PCT_DISPLAY_THRESHOLD 的语义） */
    const dropEnough=dropPct>=ncfg.priceDropPct;
    const ren=isRenotify&&(dropEnough||ncfg.priceDropNotify===false);

    const verdict=notifyLayer.shouldNotify(
      Object.assign({}, it, {__isRenotify:ren}),
      score,
      {onlyIncreaseRenotify: ncfg.onlyIncreaseRenotify}
    );
    if(!verdict.yes){ skipped++; if(verdict.reason&&verdict.reason.indexOf("未提升")>=0) log("   ↷ 不重推 "+it.itemId+"："+verdict.reason); continue; }

    const extra={};
    if(ren){
      extra.dropPct=dropPct;
      extra.prevPriceText="¥"+(prevPrice!=null?prevPrice:"");
    }
    extra.satisfaction=score;
    /* 【把商品详情塞进推送】以前消息里只有"价格+地区+发布+卖家+链接"，用户的原话是
       "并没有商品详细的介绍，推送这个都没什么用"。描述其实一直在 data\desc-cache.json 里
       （scan 阶段配了「屏蔽内容词」时才会读），但渲染层从来没取过它。
       这里补上：先查本地缓存（零成本），缓存没有且还有配额就现读一次详情页。
       配额取 cfg.maxDescPerPush（默认 8），避免一次推 15 条时连开 15 个详情页被限流。
       读失败不影响推送，只是这条少一行"简介"。 */
    try{
      if(!Object.prototype.hasOwnProperty.call(descCache, it.itemId) && descBudget>0){
        descBudget--;
        await getDesc(it.itemId);
      }
      const d=descCache[it.itemId];
      if(typeof d==="string"&&d.trim()) extra.desc=d;
    }catch(e){}
    /* 本批最优：本轮候选里分数最高的那件标记一下 */
    toSend.push(Object.assign({}, it, {__extra: extra, __score: score, __reason: verdict.reason}));
  }

  /* ---- 重启积压三层闸门（2026-11-03 用户要求「三层 + 汇总」）----
     背景：停机 93 分钟后重启，第一轮把停机期间上架的 17 条全推了手机。
     用户的原话是「两个小时内关闭的也推送，关闭太久就别推，不然信息爆炸；
     但目前只是桂林，将来全国了 2 小时同样会爆炸」——所以判据不能按「停机多久」，
     要按「通知条数」：
       ① 时效层：新鲜度闸门 freshMaxAgeHours（已有），管老货；
       ② 积压时效层：本次启动前发布的货，只保留最近 bootPushMaxAgeHours 小时（默认 2）；
       ③ 条数上限层：本次启动以来「积压货」累计最多推 bootPushMaxCount 条（默认 15），
          按综合分取前 N，其余只进面板不响手机。与地区密度、停机时长都无关，条数永远可控；
       ④ 汇总：本轮命中超过 3 条时并成一条通知，连响十几次压成 1 次。
     【为什么是累计而不是只看第一轮】停机很久时积压货要分好几轮才翻完（每轮只翻 2~3 页），
     只锁第一轮的话第二、三轮又冒出来十几条，等于没治。
     【什么不受限制】启动之后真正新上架的货（pt>=BOOT_MS）永远全推；
     补推队列条目（__retry）也永远全推 —— 它们本来就是该发的。 ---- */
  let bootDigest=false;
  {
    const bMaxAgeH=Math.max(0,Number(cfg.bootPushMaxAgeHours!=null?cfg.bootPushMaxAgeHours:2));
    const bMaxCnt=Math.max(0,Number(cfg.bootPushMaxCount!=null?cfg.bootPushMaxCount:15));
    let bootAged=0, bootCapped=0;
    const backlog=[], newborn=[], retries=[];
    toSend.forEach(function(x){
      if(x.__retry){ retries.push(x); return; }
      const pt=Number((x.publishTimeAdjusted||x.publishTime)||0);
      if(pt>0&&pt<BOOT_MS){
        if(bMaxAgeH>0&&(BOOT_MS-pt)>bMaxAgeH*3600000){ bootAged++; return; }
        backlog.push(x);
      }else{
        newborn.push(x);
      }
    });
    let keepBacklog=backlog;
    /* 已经推出去过的积压条数要从上限里扣掉，保证「整次运行累计不超过 N 条」 */
    const room=Math.max(0,bMaxCnt-bootBacklogPushed);
    if(bMaxCnt>0&&backlog.length>room){
      bootCapped=backlog.length-room;
      keepBacklog=room>0?backlog.slice()
        .sort(function(a,b){ return (Number(b.__score)||0)-(Number(a.__score)||0); })
        .slice(0,room):[];
    }
    if(bootAged||bootCapped){
      toSend.length=0;
      Array.prototype.push.apply(toSend, retries.concat(newborn, keepBacklog));
      log("   ⏸ 重启积压静默 "+bootAged+" 条（发布超过 "+bMaxAgeH+" 小时）· 超上限 "+bootCapped+" 条（本次运行累计上限 "+bMaxCnt+" 条，已用 "+bootBacklogPushed+" 条）→ 只进面板，不推送手机");
    }
    bootBacklogPushed+=keepBacklog.length;
    /* 汇总只在「本轮确实有积压货要推」时启用：日常轮次里零星 4~10 条新上架，
       用户一直习惯一条一条收，不要因为这次改动就把它们也并成一条。
       积压货是你没盯着的时候攒下的，一次汇总最容易接受。 */
    bootDigest=keepBacklog.length>0&&toSend.filter(function(x){ return !x.__retry; }).length>3;
  }
  if(!toSend.length){
    log("推送阶段：本轮 "+list.length+" 条均无需推送（跳过 "+skipped+" 条），仅更新价格记忆");
    /* 走到这里说明连补推队列里的条目也没被选中（已经推过 / 分数没提升），
       它们就此作废，否则会一直挂在队列里直到 24 小时过期。 */
    if(pending.length){
      try{ notifyRetrySave([]); }catch(e){}
      log("   ✓ 补推队列清理："+pending.length+" 条已不再需要补发");
    }
    priceMemory.prune(); priceMemory.save(true);
    return {sent:0,failed:0,skipped:skipped};
  }

  /* 本批最优 */
  let bestId=null, bestScore=-1;
  toSend.forEach(function(x){ if(x.__score>bestScore){ bestScore=x.__score; bestId=x.itemId; } });
  toSend.forEach(function(x){ if(x.itemId===bestId) x.__extra.best=true; });
  const bestItem=toSend.filter(function(x){ return x.itemId===bestId; })[0]||null;

  /* ---- 分批发（每批 maxItemsPerMessage 条，避免一条消息过长） ---- */
  /* 汇总模式（重启第一轮命中过多）：全部并成一条通知，避免手机连响十几次 */
  const per=bootDigest?Math.max(1,toSend.length):Math.max(1, ncfg.maxItemsPerMessage);
  let sentOk=0, sentFail=0;
  /* 失败队列：本批失败的商品 + 之前遗留的重试项，逐条记重试次数 */
  const failedNow=[];
  for(let i=0;i<toSend.length;i+=per){
    const batch=toSend.slice(i, i+per);
    const head=(bootDigest?("重启后命中 "+toSend.length+" 条，已按综合分排序"):("闲鱼扫货 命中 "+batch.length+" 条"))
      +(toSend.length>per?("（"+(Math.floor(i/per)+1)+"/"+Math.ceil(toSend.length/per)+"）"):"");
    /* jump：点【通知本体】跳转的地址。取本片里分数最高的那件（用户最可能想看），
       没有分数就退回本批最优。Bark 的顶层 url 字段吃它；其他渠道忽略。
       mobileUrl 在 notify.cjs 里统一做（www → h5.m，才能触发 Universal Link 拉起 App）。 */
    let jumpItem=null, jumpScore=-1;
    batch.forEach(function(x){ if(x.url && x.__score>jumpScore){ jumpScore=x.__score; jumpItem=x; } });
    const jumpSrc=jumpItem?jumpItem.url:(bestItem?bestItem.url:'');
    const msg=notifyLayer.buildMessage(batch, {head:head, jump:jumpSrc, compact:bootDigest});
    const results=await notifyLayer.send(msg, ncfg);
    const real=results.filter(function(r){ return r.channel!=="log"; });
    const anyOk=real.length?real.some(function(r){ return r.ok; }):true;
    if(real.length){
      if(anyOk) sentOk+=batch.length; else sentFail+=batch.length;
      /* 这里**不再**调 notifyLayer.bumpStats —— sendOne 已经按渠道计过数了。
         以前两处都计，点一次推送面板统计会 +2，数字对不上真实请求数。 */
    }
    if(anyOk){
      /* 只有真发出去才记"已通知分数"，否则下次降价会因为分数没变而被误抑制 */
      batch.forEach(function(x){ try{ priceMemory.setNotifiedScore(x.itemId, x.__score); }catch(e){} });
    }else{
      batch.forEach(function(x){ failedNow.push(x); });
    }
    if(i+per<toSend.length) await sleep(800);
  }

  /* 重写重试队列：本批失败的留在队列里（重试次数 +1），成功的和已被抑制的自然淘汰。
     注意这里的判定口径 —— 只要这条这一轮没进 failedNow，就说明它已经发出去或被抑制，
     两种情况都不该再补推。 */
  const failedIds={};
  failedNow.forEach(function(x){ if(x&&x.itemId) failedIds[x.itemId]=1; });
  const nextRetry=[];
  const seenIds={};
  const slimItem=function(it){
    return { itemId:it.itemId, task:it.task, keyword:it.keyword, title:it.title,
      price:it.price, priceText:it.priceText, area:it.area, seller:it.seller,
      sellerRate:it.sellerRate, publishAt:it.publishAt, publishTime:it.publishTime,
      url:it.url, pic:it.pic, credit:it.credit };
  };
  /* ① 上一轮遗留的：这轮又失败了 → 留在队列里并把重试次数 +1 */
  keepRetry.forEach(function(r){
    const id=r&&r.item&&r.item.itemId;
    if(!id||seenIds[id]) return;
    if(!failedIds[id]) return;   /* 这轮没失败 = 已发出或被抑制，不再补推 */
    seenIds[id]=1;
    nextRetry.push({at:Number(r.at||nowMs), tries:Number(r.tries||0)+1,
      score:(r.score!=null?r.score:null), extra:(r.extra||null), item:slimItem(r.item)});
  });
  /* ② 本轮新失败的入队（重试次数从 1 起算） */
  failedNow.forEach(function(x){
    const id=x&&x.itemId;
    if(!id||seenIds[id]) return;
    seenIds[id]=1;
    nextRetry.push({at:nowMs, tries:1, score:(x.__score!=null?x.__score:null),
      extra:(x.__extra||null), item:slimItem(x)});
  });
  try{ notifyRetrySave(nextRetry.slice(-RETRY_MAX_ITEMS)); }catch(e){}
  if(failedNow.length) log("   ⏳ 已把 "+failedNow.length+" 条失败商品放进补推队列（data/notify-retry.json），下一轮自动补发");

  priceMemory.prune(); priceMemory.save(true);
  notifyLayer.saveState();
  log("推送阶段完成：待推 "+toSend.length+" 条 → 成功 "+sentOk+" / 失败 "+sentFail+"（跳过 "+skipped+"）");
  return {sent:sentOk, failed:sentFail, skipped:skipped};
}

/* 补推队列的读写。独立小文件，坏了不影响主数据。
   注意：这两个函数声明会提升，notify() 里可以直接用；文件路径用函数内计算，
   不放在模块顶层常量里 —— 避免 notify() 万一在顶层初始化阶段被调用时踩到 TDZ。 */
function notifyRetryFile(){ return path.join(DATA,"notify-retry.json"); }
function notifyRetryLoad(){
  try{
    const a=readJSON(notifyRetryFile(),[]);
    return Array.isArray(a)?a:[];
  }catch(e){ return []; }
}
function notifyRetrySave(arr){
  try{ writeJSON(notifyRetryFile(), Array.isArray(arr)?arr:[]); }catch(e){ log("写补推队列失败: "+String(e.message||e).slice(0,120)); }
}

/* 条件签名 + 全量基线状态：同一条件只做一次"把所有页走全"，
   条件一改签名就变，下次自动重新走全量。 */
function sigOfTask(t){
  /* 【v2026-10-20】publishDays 已不进签名。
     原因：它现在只作用于本地 localFilter，不再下发给服务端（见 buildRequest 注释），
     也就是"服务端召回的那批货"跟时间窗口无关。若仍放进签名，用户只是把
     「7天内」改成「1天内」这种纯本地显示口径的调整，就会判成"条件变了"
     → 清掉已有命中记录 + 重跑 50 页全量基线，代价完全没必要。
     签名只保留真正影响服务端召回的字段：关键词/价格/地区/排序/快捷筛选/品牌型号等。 */
  /* 【2026-11-04】cpvFilters 只有【非空】才进签名。
     旧写法固定塞一个 t.cpvFilters||{} —— 老配置（没有这个字段）一升级，
     签名末尾就多出一个 {}，被判成"条件变了" → 清命中 + 重翻 50 页。
     空对象本来就不产生任何请求差异，不该进签名。 */
  const _cpv=(t.cpvFilters&&typeof t.cpvFilters==="object"&&Object.keys(t.cpvFilters).length>0)?t.cpvFilters:null;
  const _sig=[t.keyword,t.minPrice,t.maxPrice,t.province,t.city,t.area,
    t.sort,t.priceSort||"",t.quickFilters||[],t.brands||[],t.versions||[],t.storages||[],
    t.mustContain||[],t.excludeWords||[],t.descExcludeWords||[],t.sellerBlockWords||[]];
  if(_cpv) _sig.push(_cpv);
  /* 【v2026-11-02 品类】只有「通用」才追加进签名，手机数码（默认）保持原签名长度。
     原因：老配置里根本没有 category 字段，如果无条件追加一项，
     所有已有任务升级瞬间就判成「条件变更」→ 清命中 + 重翻 50 页，代价没人想付。
     而「通用」必须进签名：它会跳过五道闸门，过滤结果完全不同，不重扫就不准。 */
  if(String(t.category||"")==="generic") _sig.push("generic");
  return JSON.stringify(_sig);
}
let deepState=(function(){ try{ const o=readJSON(path.join(DATA,"deep-state.json"),{}); return (o&&typeof o==="object")?o:{}; }catch(e){ return {}; } })();

/* ===== 全量基线：分轮渐进（v2026-10-19） =====
   背景：以前一次连翻 25 页，日志实测第 5 页就被 RGV587「被挤爆」打回，
        整轮作废、deepState 不写签名，下次又要从头翻 —— 等于每次重建都吃一次限流。
   做法：把 25 页拆成每轮 deepPagesPerRound 页（默认 3，日志里 3-4 页连发从未触发限流），
        进度落盘到 data\deep-progress.json，跨轮、跨进程续翻。
        限流中断【不清】进度，恢复后从下一页接着翻，不再从头开始。
        翻满全部页（或翻到空页）才算完成，才写 deepState 签名。 */
const DEEPPF=path.join(DATA,"deep-progress.json");
function readDeepProgress(){
  try{ const o=readJSON(DEEPPF,{}); return (o&&typeof o==="object")?o:{}; }catch(e){ return {}; }
}
function writeDeepProgress(o){ try{ writeJSON(DEEPPF,o||{}); }catch(e){ log("写基线进度失败: "+e.message); } }
/* 第 1 页每轮都要取（抓新），续翻从 nextPage 开始 */
function deepResumePage(task,sig){
  const o=readDeepProgress()[task.name];
  if(!o||o.sig!==sig) return 1;
  const p=Number(o.nextPage)||1;
  return Math.max(1,p);
}
function deepSavePage(task,sig,nextPage,totalPages){
  const o=readDeepProgress();
  o[task.name]={sig:sig,nextPage:Math.max(1,nextPage),totalPages:totalPages||0,at:new Date().toISOString()};
  writeDeepProgress(o);
}
function deepClearProgress(task){
  const o=readDeepProgress();
  if(o[task.name]){ delete o[task.name]; writeDeepProgress(o); }
}
function deepProgressLabel(task,sig){
  const o=readDeepProgress()[task.name];
  if(!o||o.sig!==sig||!o.totalPages) return "";
  const done=Math.max(0,Math.min(o.totalPages,(Number(o.nextPage)||1)-1));
  return "基线重建中：第 "+done+"/"+o.totalPages+" 页";
}

/* 【新增】扫描水位线（停机空窗补抓）。
   问题：程序在 02:37 停机、22:42 才被重新启动，中间 20 小时一条都没扫。
   重启后只翻第 1 页（最新 30 条），这 30 条全是停机之后才发布的，
   再往后翻到的第 2 页已经越过那道空窗，白天 20 小时的货永远不会再被看到 ——
   这就是「从 22:45 一滑直接跳到凌晨 1 点、白天那么多商品都看不到」的成因。
   修法：每轮记下「已经扫到的最新发布时间」当水位线；下次开轮时如果发现池子里的
   最新一条比水位线新了很远（超过 cfg.catchupMinGapHours 小时），说明中间断过档，
   本轮就把翻页数临时放大，从第 2 页开始顺序往回扫把空窗补上。
   补不完不跳过：水位线只推进到本轮已覆盖处，并记住下一轮从第几页接着往回补。 */
/* 【2026-11-03 停机积压静默】进程启动时刻（毫秒）。
   用途：停机几小时/几天后重启，空窗补抓会把这段时间新上架的货一次性捞回来。
   旧逻辑把它们全部当「新命中」推手机 —— 实测 2026-11-03 09:05 一口气推了 10 条，
   全是 10/28 23:00 停机以来积压的货。catchupSilent 管不到它们，因为那些货从未进过 seen，
   走的是 freshCut 新鲜度闸门那条路，压根不经过 gapOK 分支。
   现在统一按「发布时间早于本次启动」判为积压：只收进列表，不推送。
   启动之后真正新上架的仍然照推（ptb >= BOOT_MS）。 */
const BOOT_MS=Date.now();
/* 【重启积压闸门】进程启动以来，「发布于本次启动之前」的积压货已经推出了几条。
   不用一次性布尔量是因为：停机很久时积压要分好几轮才翻完（每轮只翻 2~3 页），
   第一轮清不干净，第二、三轮还会冒出来 —— 用累加计数才能保证「重启后累计最多响 N 次」。 */
let bootBacklogPushed=0;
const WMF=path.join(DATA,"scan-watermark.json");
function readWatermark(){
  try{ const o=readJSON(WMF,{}); return (o&&typeof o==="object")?o:{}; }catch(e){ return {}; }
}
function writeWatermark(o){ try{ writeJSON(WMF,o||{}); }catch(e){ log("写扫描水位线失败: "+e.message); } }
function watermarkOf(task,sig){
  const o=readWatermark()[task.name];
  if(!o||o.sig!==sig) return null;
  const v=Number(o.newestMs)||0;
  if(!(v>0)) return null;
  return {newestMs:v,catchupNextPage:Math.max(0,Number(o.catchupNextPage)||0),toMs:Math.max(0,Number(o.toMs)||0),at:o.at||""};
}
function saveWatermark(task,sig,newestMs,coveredFromMs,nextPg,done,gapToMs){
  const nw=Number(newestMs)||0;
  if(!(nw>0)) return;
  const o=readWatermark();
  const prev=o[task.name];
  const prevMs=(prev&&prev.sig===sig)?(Number(prev.newestMs)||0):0;
  const cf=Number(coveredFromMs)||0;
  /* gt = 本轮认定的「空窗终点」（第一次发现空窗时池子的最新时间）。
     补抓没走完时把它一起落盘，下一轮算法就和这一轮完全一致，
     不会再出现「上轮空窗 129 小时、这轮 180 小时」这种每轮都在变的数字。 */
  const gt=Number(gapToMs)||0;
  let ms=nw, np=0, toMs=0;
  const npWant=Math.max(0,Number(nextPg)||0);
  if(npWant>0){
    /* 本轮是被单轮页数上限截断的（没翻到空页）→ 空窗一定没补完：
       水位线最多推进到本轮最早一条，并记住下一页继续往回补。
       这一条必须排在 done 之前：没补完就不能把水位线归位到最新，
       否则剩下的空窗会被当成"已覆盖"永远放弃。 */
    /* 【2026-11-05 修复】这里原来写 ms=cf（本轮翻到的最早一条），
       结果每往回补一轮，水位线就被拖得更早：gapH 从 3.4 小时一路虚涨到 162 小时，
       于是每轮都重新算「要补 12 页」，一小时连翻几十页把账号打成风控。
       newestMs 的语义是「连续覆盖到的前沿」，补抓没走完时前沿不该倒退 ——
       保持上一轮的值，gapH 才会稳定在同一条空窗上，补完再一次性归位到最新。 */
    ms=prevMs>0?prevMs:(cf>0?cf:nw); np=npWant;
    toMs=gt>0?gt:nw;
  }else if(done){
    /* 补抓真正走完了（翻到空页，或已到深度上限）→ 水位线归位到池子最新。
       必须显式归位：以前靠"本轮最早一条是否比旧水位线更老"来推断，
       而补抓期间水位线是被故意拖在后面的，于是每轮都判定成"还没补完"，
       在第 2-12 页原地重扫，空窗永远闭合不了。 */
    ms=nw; np=0;
  }else{
    /* 普通增量轮：水位线只会前进（多任务/时钟回拨都不回退） */
    ms=Math.max(prevMs,nw);
  }
  o[task.name]={sig:sig,newestMs:ms,catchupNextPage:np,toMs:toMs,at:new Date().toISOString()};
  writeWatermark(o);
}

/* 【2026-10-29 补推】基线启动时刻。
   要解决的问题：改筛选条件 → 重建 50 页基线（20~40 分钟），基线期间旧逻辑
   一条都不推，这半小时上新全被吞掉。现在要放行「基线开始之后才上架」的货，
   判定只能靠一个时刻：基线什么时候开始跑的。
   为什么不用 deep-progress.json 的 at：它每轮都被覆盖，读出来是"上一轮"的时间，
   不是基线起点；而且基线一轮就走完时它压根不会写。
   为什么不用 hits 最新发布时间：改条件会清空 hits，清空后就没有基准了。 */
function baselineClockFile(){ return path.join(DATA,"baseline-clock.json"); }
function baselineClockRead(){
  try{ const o=readJSON(baselineClockFile(),{}); return (o&&typeof o==="object")?o:{}; }catch(e){ return {}; }
}
function baselineClockMark(taskName){
  if(!taskName) return 0;
  try{
    const o=baselineClockRead();
    const v=Number(o[taskName])||0;
    /* 【2026-11-03 修复】基线时钟过期刷新：距上次记录超过 2 小时（7200000ms）说明中间
       停机/换号/被风控中断过，沿用旧时刻会把停机期历史货全当「新上架」爆推。
       此时把起点刷新成「现在」，只推刷新后真上架的货，历史货静默进列表。 */
    if(v>0 && (Date.now()-v) < 7200000) return v;
    o[taskName]=Date.now();
    writeJSON(baselineClockFile(),o);
    return o[taskName];
  }catch(e){ return Date.now(); }
}
function baselineClockClear(taskName){
  if(!taskName) return;
  try{
    const o=baselineClockRead();
    if(o[taskName]==null) return;
    delete o[taskName];
    writeJSON(baselineClockFile(),o);
  }catch(e){}
}

/* 【2026-10-29 新增：退出标记】给 guard.cjs 看的。
   目的：让守护进程能区分「用户自己停的」（点面板【停止监控】/【立即重新登录】/关窗口）
   和「意外死掉的」（崩溃 / 被系统杀掉 / 睡眠唤醒后进程没了）。
   前者不该推告警（他自己干的），后者必须推 —— 否则手机端只表现为"安静"，
   跟"没货"完全区分不出来。标记只在 3 分钟内有效，避免上次的旧标记误判下一次。 */
function exitMarkFile(){ return path.join(DATA,"monitor-exit.json"); }
function writeExitMark(reason){
  try{ writeJSON(exitMarkFile(),{ at:Date.now(), reason:String(reason||"unknown"), pid:process.pid }); }catch(e){}
}

/* 【修「筛选出来的都是前几天的商品」根因 A / C】基线补货的时效闸门。
   背景：改筛选条件 → 签名变 → 自动重建基线，deepMaxPages=50，每轮翻 10 页。
   第 2 页往后全是「综合排序的历史在售」—— 几天前发布、现在还在卖，官网照列。
   旧版对 seed 不做任何时间限制（publishDays=0 时 localFilter 也不卡时间），
   于是每轮都把这 300+ 条老货当成「当前在售」灌进 hits，面板就成了「全是前几天的商品」。
   现在：只有发布时间在 cfg.seedMaxAgeHours（默认 24）以内的才进显示列表；
   更老的一律只登记 seen（防以后重复报新命中），不显示、不推送。
   拿不到发布时间的（publishTimeAdjusted=0）保守放行 —— 宁可多显示一条，
   也别把真新货挡在外面。 */
function seedAgeKeep(task,items){
  const h=Number(cfg.seedMaxAgeHours==null?24:cfg.seedMaxAgeHours);
  const list=Array.isArray(items)?items:[];
  if(!(h>0)) return {keep:list.slice(),dropped:0,h:0};
  const cut=Date.now()-h*3600000;
  const keep=[]; let dropped=0;
  for(const it of list){
    const pt=Number((it&&(it.publishTimeAdjusted||it.publishTime))||0);
    if(pt>0&&pt<cut){ dropped++; continue; }
    keep.push(it);
  }
  return {keep:keep,dropped:dropped,h:h};
}

async function scanOnce(opts){
  opts=opts||{};
  let freshAll=[];
  /* 重建基线时顺手把"当前在售"收进显示列表（不推送），否则刚清完记录面板会一片空白，
     用户会以为监控坏了——其实只是在等新商品。 */
  let seededAll=[];
  await saveCookies();   /* 每轮把 cookie 落一次盘：_m_h5_tk 会轮换，会话 cookie 关了浏览器就没了 */
  /* 每轮开始前对齐一次"哪些任务的基线还没补"：
     首次运行、改了筛选条件、签名变了 —— 都要自动进入分轮续翻队列。
     旧版这个函数定义了却从没被调用，所以"改条件后自动补全"从来没生效过。 */
  markTasksNeedDeep();
  /* 【错峰 2026-11-02】多任务并行走基线 = 同一账号同轮连打几十页，30 秒内被平台 RGV587 挤爆。
     先算清"本轮哪些任务真的还欠基线"，下面只放行其中一个走基线（轮次轮转），
     其余任务本轮只做常规增量翻页，下一轮轮到它再补 —— 从根上杜绝多任务叠加。 */
  const deepEligible=(cfg.tasks||[]).filter(function(t){
    if(!t||t.enabled===false) return false;
    if(cfg.deepSweep===false) return false;
    if(deepState[t.name]===sigOfTask(t)) return false;
    return seedPendingHas(t.name);
  }).map(function(t){ return t.name; });
  for(const task of (cfg.tasks||[])){
    if(task.enabled===false) continue;
    /* 【BUG-T】每个任务开始时清零丢弃统计。
       以前 dropStats 只在模块顶层初始化一次，之后从不重置，于是日志里的
       「条件过滤明细」是**从进程启动到现在的累计值**。实测能打出这种自相矛盾的行：
          取回 88 条, 去重 88 条, 筛后 34 条
          条件过滤明细：容量不符(标题) 135 · 非目标品牌 15 …
       去重才 88 条，怎么可能有 135 条栽在容量上 —— 用户看到只会以为自己漏了一大堆货。
       数字越跑越大，还会把「本轮真的挡了 0 条」糊成「挡了 300 条」，完全失去诊断价值。 */
    dropStats={};
    /* 这几个变量必须在 try 之外声明：catch 分支（限流处理）要用它们保住基线进度，
       放在 try 里会变成块级作用域，catch 里读到就是 ReferenceError。 */
    let needDeep=false, dp=0, perRun=0, startPg=1, deepFailedAt=0, taskSig="";
    let deferredByRotation=false;   /* 【错峰】本轮被轮转跳过基线，而不是"签名已失效" */
    try{
      /* 恢复期自动降档：只要还处在限流冷却/退避中，本轮只取第 1 页 30 条，
         等连续几轮恢复正常（throttle.level 归零）再自动回到 cfg.maxPages 页。 */
      let pages=Math.max(1,Math.min(5,Number(cfg.maxPages)||1));
      /* 全量基线：官网同一条件可能是十几二十几页（它有"737 件宝贝"这种总量），
         我们每轮只翻 4 页就会"看起来比官网少"。所以每次启动/条件变更后，
         先把这个条件下能翻到的页全走一遍（默认上限 25 页，页间 1.2s 慢走防限流），
         之后每轮只翻 maxPages 页抓新的。 */
      const taskSigX=sigOfTask(task);
      taskSig=taskSigX;
      const deepWanted=(cfg.deepSweep!==false)&&(deepState[task.name]!==taskSigX);
      /* 需要走全量的两种情况：
         ① 清空记录后重建 / 条件变更后重建（deepForceFull 或待补集合里有它）
         ② 签名变了（改条件/首次运行）且启用了 deepSweep —— 这在旧版只在手动触发时才走，
            导致改了条件却永远补不全，面板一直比官网少。现在改成自动、但分轮渐进。 */
      const inSeedPending=seedPendingHas(task.name);
      needDeep=(deepForceFull||inSeedPending)&&deepWanted&&throttle.level===0;
      /* 【错峰 2026-11-02】手动重建（deepForceFull）时全量都走；平时多个任务都欠基线时，
         本轮只让"轮到的那个"走基线，其余本轮先跳过（它们仍会走下面的常规增量翻页）。 */
      if(needDeep&&!deepForceFull&&deepEligible.length>1&&deepEligible[deepTurnIdx%deepEligible.length]!==task.name){
        needDeep=false;
        deferredByRotation=true;
      }
      /* 【死锁修复 v2026-10-28】"待补基线"残留必须能自愈，否则永久静默不推送。
         事故链（实测）：deepState 里签名已与当前条件一致 ⇒ deepWanted=false ⇒ needDeep 恒 false；
         但 seed-pending.json 里还留着这个任务 ⇒ baselineInProgress 恒 true
         ⇒ 每轮所有商品只 seen 登记、不进 fresh ⇒ notify() 永远收不到货，一条都不推。
         根因：清理 seedPending 的 seedPendingDel() 只写在 `if(needDeep&&walkedAll…)` 分支里，
         needDeep 一旦转 false，该分支永远进不去，残留就再也删不掉。
         这里补一条自愈：既然本轮不打算走基线（throttle 也没在退避），待补集合里的残留就是无效的，
         直接清掉，让后续轮次正常按"新命中"判定并推送。 */
      if(inSeedPending&&!needDeep&&!deferredByRotation&&(throttle.level===0||!deepWanted)){
        seedPendingDel(task.name);
        log("   基线标记已失效（签名已一致或无待补页），清除待补残留 → 之后按新命中正常推送");
      }
      /* 全量基线的三个数：
         dp      = 这个条件一共要走多少页（上限 30，默认 25）
         perRun  = 本轮最多走几页（默认 3；日志实测连发 3-4 页从未触发限流，第 5 页才被挤爆）
         startPg = 从第几页续翻（第 1 页每轮都重取，续翻页从进度里读） */
      if(needDeep){
        /* dp = 这个条件一共要走多少页。
           闲鱼接口对单个条件的硬上限是 1500 条（resultInfo.numFound 实测就是 1500），
           1500 / 30 = 50 页 —— 所以上限必须放到 50，否则永远只能拉到一半，
           面板条数看着"比官网少"就是这个原因（不是漏抓，是我们自己把深度掐了）。
           默认 25 页是保守值，用户可在配置里把 deepMaxPages 调到 50 走满。
           注意：深翻页确实更容易被限流，所以仍然分轮 + 页间慢走，不一次性打完。 */
        dp=Math.max(1,Math.min(50,Number(cfg.deepMaxPages)||25));
        perRun=Math.max(1,Math.min(20,Number(cfg.deepPagesPerRound)||3));
        startPg=deepResumePage(task,taskSig);
        /* 第 1 页已经走过（续翻），本轮从 startPg 开始；否则从头走 */
        pages=Math.min(dp, startPg-1+perRun);
        log("   全量基线（分轮渐进）：共 "+dp+" 页，本轮走 第1页"
          +(pages>1?(" + 第 "+(startPg>1?startPg:2)+"-"+pages+" 页"):"")
          +"（每轮最多 "+perRun+" 页，页间慢走）");
      }
      /* 【修「命中不全面、有漏」根因 B：每轮只翻第 1 页】
         非基线轮 pages 只取 cfg.maxPages，默认 1 → 每轮只看 30 条。
         这 30 条还要过价格/品类/容量/屏蔽词等多道本地闸门，实测常常只剩 2-5 条可用；
         货源集中在少数翻新大户手里时，30 条里二十几条是同一个人的货，
         翻第 1 页等于每轮只盯着这一个人 —— 这就是"命中的只有几个是对的"。
         现在：本轮翻页数取 max(maxPages, incrementalPages)，默认 3 页 = 90 条。
         只改"往后翻几页"，不动排序：第 1 页仍是最新发布，新货照样第一时间抓到。
         限流时下面 throttle 分支仍会强行压回 1 页，所以不会把风控风险放大。 */
      {
        const inc=Math.max(1,Math.min(10,Number(cfg.incrementalPages)||3));
        if(inc>pages){
          if(pages>1||needDeep) log("   （常规轮加翻到 "+inc+" 页，减少过滤后剩不下几条导致的漏抓）");
          pages=inc;
        }
      }
      if(throttle.level>0){
        if(pages>1) log("   （恢复期：本轮只取第 1 页，等不再被限流再自动取 "+pages+" 页）");
        pages=1;
        /* 恢复期也保住基线进度：别把它丢掉，恢复后还能接着翻 */
        if(needDeep) perRun=0;
      }
      let raw=[];
      /* walkedAll 的语义要精确：表示"这个条件真的翻到底了（遇到空页）"。
         旧版初值是 true，只有"某页抛错"才置 false —— 于是 basline 只走 1 页 30 条、根本没到底，
         却被当成"走完了"，直接写签名，永久停在 30 条。这就是"面板比官网少"的根因。 */
      let walkedAll=false;
      let hitEmpty=false;
      const pageMetas=[];   /* 每页的元数据快照：基线少返判定要用全页信息，不能用最后一页 */
      /* 续翻时（startPg>1）第 1 页仍然【每轮必抓】：
         旧版循环从 startPg 开始，于是基线走 50 页要 17 轮约 68 分钟，
         这 68 分钟里第 1 页一条都没取 —— 等于"监控"停摆，用户会以为程序不灵了。
         现在第 1 页单独先走（它就是"新货"来源），再从 startPg 续翻历史页。 */
      let firstPageDone=false;
      const fetchPage=async function(pg){
        const got=await callSearch(task,pg);
        pageMetas.push(Object.assign({},pageMeta||{}));
        log("   第"+pg+"页: "+got.length+" 条");
        raw=raw.concat(got);
        return got;
      };
      /* ① 永远先抓第 1 页（新货） */
      try{
        const g1=await fetchPage(1);
        firstPageDone=true;
        if(g1.length===0){ hitEmpty=true; pages=0; }
      }catch(e){
        log("   第1页失败: "+e.message);
        deepFailedAt=1;
        pages=0;
        /* 第 1 页就是新货的唯一来源，它失败 = 本轮没拿到任何数据。
           这里必须往上抛，交给外层 catch 去走限流退避（throttle.level+1、退避 5/10/20 分钟）。
           以前在这里把异常吞掉，结果：日志打「无新命中（取回 0 条）」+「接口已恢复」，
           限流计数永远是 0，程序每 3.5 分钟就去撞一次 RGV587，把冷却窗口一直续上，永远恢复不了。 */
        throw e;
      }
      /* ①-B 【新增】停机空窗补抓。
         第 1 页已经在手，池子里的最新时间已知；拿它和上轮水位线比，
         差得远就是中间断过档，本轮临时往回多翻几页把那段时间补回来。
         限流退避期间不做（风控优先，throttle 分支已经把 pages 压回 1）。
         全量基线进行中也不做：那条路径本来就在从第 2 页往回顺序翻，
         两边同时改 pages/startPg 会把 deep-progress 的页号改乱（基线进度回退）。 */
      let wmBefore=null, coveredFrom=0, catchupPages=0, wmOk=false;
      /* 本轮是否真的处在「停机空窗」里；以及这次空窗的固定终点 */
      let gapActive=false, gapToMs=0, gapSkip=false;
      if(firstPageDone&&!hitEmpty&&!deepFailedAt&&throttle.level===0&&!needDeep){
        wmOk=true;
        wmBefore=watermarkOf(task,taskSig);
        const poolNewest=raw.reduce((m,it)=>Math.max(m,Number(it.publishTime||0)),0);
        /* 没有水位线（首次运行、刚换过机器、或文件被删）时不能直接放弃：
           此时我们并不知道上一轮扫到哪儿，按 freshMaxAgeHours 保守假设
           「只覆盖到 N 小时前」，于是照常往回补一轮。补完自然落下水位线。 */
        if(!wmBefore){
          const fh=Number(cfg.freshMaxAgeHours==null?24:cfg.freshMaxAgeHours);
          const fhH=Math.max(1,Math.min(72,Number(fh)||24));
          const assumed=poolNewest-fhH*3600000;
          if(poolNewest>0){
            wmBefore={newestMs:assumed,catchupNextPage:0,at:""};
            log("   ⓘ 没有扫描水位线，按最近 "+fhH+" 小时保守补抓一轮（建立基线水位）");
          }
        }
        if(wmBefore&&poolNewest>wmBefore.newestMs){
          /* 续翻时空窗终点必须钉死在「第一次发现空窗时的池子最新」。
             以前每轮都拿本轮 poolNewest 去算，而补抓期间水位线被故意拖在后面，
             于是 gap 从 129 小时一路涨到 180 小时，日志每轮都重新喊「检测到停机空窗」，
             看上去像根本没在补。终点固定之后，同一段空窗在补完之前数字不变。 */
          const gapTarget=(wmBefore.toMs>0&&wmBefore.catchupNextPage>0)
            ?Math.max(wmBefore.toMs,wmBefore.newestMs):poolNewest;
          const gapH=(gapTarget-wmBefore.newestMs)/3600000;
          const minGap=Math.max(0.5,Number(cfg.catchupMinGapHours==null?2:cfg.catchupMinGapHours));
          const needCap=Math.max(2,Math.min(30,Number(cfg.catchupMaxPages==null?4:cfg.catchupMaxPages)));
          if(gapH>=minGap){
            gapActive=true; gapToMs=gapTarget;
            const maxGapH=Math.max(0,Number(cfg.catchupMaxGapHours==null?24:cfg.catchupMaxGapHours));
            if(maxGapH>0&&gapH>maxGapH){
              const f0=function(ms){ return new Date(ms).toLocaleString("zh-CN",{hour12:false}); };
              log("   ⏱ 检测到停机空窗 "+gapH.toFixed(1)+" 小时（上轮扫到 "+f0(wmBefore.newestMs)+"）—— 超过上限 "+maxGapH+" 小时");
              log("      → 判定为长时间停机：不往回翻历史（那些货早卖出去了），本轮直接把水位线推到最新");
              gapSkip=true;
            }else{
            /* 用第 1 页的时间跨度估「一页大概覆盖多少小时」，再算要往回翻几页。
               第 1 页跨度异常小（有置顶/刚被编辑过的旧货混在里面）时按 1 小时/页保守估。 */
            const p1=raw.filter(it=>Number(it.publishTime||0)>0);
            const p1New=p1.length?Math.max.apply(null,p1.map(it=>Number(it.publishTime))):0;
            const p1Old=p1.length?Math.min.apply(null,p1.map(it=>Number(it.publishTime))):0;
            let spanH=(p1New>p1Old)?((p1New-p1Old)/3600000):0;
            if(!(spanH>0.2)) spanH=1;
            let need=Math.ceil(gapH/spanH)+1;
            need=Math.max(2,Math.min(needCap,need));
            const resume=wmBefore.catchupNextPage;
            /* 续翻上限必须放宽到 deepMaxPages（默认 50）。
               以前写成 needCap*3（默认 36 页），补到第 37 页时 resume(37)>36 就掉进
               「从头补」的分支，于是每轮都在第 2-12 页原地打转、永远走不到第 37 页，
               空窗后半段就永远补不上 —— 日志上表现为页号一直不前进。 */
            const resumeMax=Math.max(needCap,Math.min(50,Number(cfg.deepMaxPages)||50));
            if(resume>resumeMax){
              /* 已经翻到深度上限还没到底 → 这个条件下的货就这么多，后面的空窗补不出来。
                 此时必须收手把水位线归位，否则会和上面那个 bug 一样无限重扫。 */
              startPg=2;
              pages=Math.max(1,Math.min(5,Number(cfg.maxPages)||1));
              catchupPages=0;
              log("   ✔ 补抓已到深度上限第 "+resumeMax+" 页仍未到底，判定该条件下的货已扫尽（水位线归位）");
            }else if(resume>1){
              /* 上一轮没补完：从上次停下的那页继续往回走 */
              startPg=resume;
              pages=Math.min(50,resume+needCap-1);
              catchupPages=pages;
            }else{
              /* 第一轮补抓：必须从第 2 页顺序走，不能用基线的续翻起点（它可能已越过空窗） */
              startPg=2;
              pages=Math.max(2,need);
              catchupPages=pages;
            }
            if(catchupPages>0){
              const f=function(ms){ return new Date(ms).toLocaleString("zh-CN",{hour12:false}); };
              log("   ⏱ 检测到停机空窗 "+gapH.toFixed(1)+" 小时（上轮扫到 "+f(wmBefore.newestMs)
                +"，池子最新 "+f(gapTarget)+"）");
              log("      → 本轮往回翻到第 "+pages+" 页补抓"
                +(resume>1?("（从第 "+resume+" 页续，上轮没补完）"):"（从第 2 页顺序走）")
                +"，单轮上限 "+needCap+" 页");
            }
            }
          }
        }
      }
      /* ② 再续翻历史页（第 2 页起；走过了就跳过第 1 页） */
      if(!hitEmpty&&!deepFailedAt){
        const from=Math.max(2,startPg);
        for(let pg=from;pg<=pages;pg++){
          if(pg>1) await nap(needDeep?Math.max(1200,Number(cfg.deepPageGapMs)||1500):(catchupPages?Math.max(1500,Number(cfg.catchupPageGapMs)||3500):1500));
          try{
            const g=await fetchPage(pg);
            if(g.length===0){ hitEmpty=true; pages=pg-1; break; }   /* 空页说明到底了 */
          }catch(e){
            log("   第"+pg+"页失败: "+e.message);
            walkedAll=false; deepFailedAt=pg; break;
          }
        }
      }
      if(firstPageDone&&pages<1) pages=1;
      /* 只有"翻到空页"才算真正到底；页数走满 dp 也算到底（我们主动设的搜索深度上限） */
      walkedAll=hitEmpty||(pages>=dp&&!deepFailedAt);
      /* 少返只按"全页元数据"判：某页不满且服务端自报总量大于已取条数 */
      const sfBase=detectShortfallForBaseline(pageMetas,raw.length);
      /* 基线的三种收尾：
         ① 走完了（翻到空页，或页数走满 dp）→ 写签名，之后只增量
         ② 中途被限流/出错 → 【保留进度】写 deep-progress，下一轮接着翻，绝不从头开始
         ③ 少返（服务端自报总量更大）→ 当作没走完，保留进度，下轮再试 */
      if(needDeep&&walkedAll&&!sfBase){
        if(pages>=dp){
          deepState[task.name]=taskSig;
          try{ writeJSON(path.join(DATA,"deep-state.json"),deepState); }catch(e){ }
          deepClearProgress(task);
          seedPendingDel(task.name);   /* 基线真正走完，退出待补集合 */
          baselineClockClear(task.name);   /* 基线结束，时刻记录作废（下一轮不再按它放行） */
          log("   全量基线完成：本条件已走全 "+pages+" 页，之后每轮只翻 "+Math.max(1,Math.min(5,Number(cfg.maxPages)||1))+" 页抓新");
        }else{
          /* 翻到空页提前结束：也视为走完（这个条件确实只有这么多货） */
          deepState[task.name]=taskSig;
          try{ writeJSON(path.join(DATA,"deep-state.json"),deepState); }catch(e){ }
          deepClearProgress(task);
          seedPendingDel(task.name);
          baselineClockClear(task.name);
          log("   全量基线完成：本条件实际只有 "+pages+" 页（已翻到空页），之后每轮只翻 "
            +Math.max(1,Math.min(5,Number(cfg.maxPages)||1))+" 页抓新");
        }
      }else if(needDeep){
        /* 没走完：下一轮从"本轮最后一页的下一页"接着翻。
           注意 pages 在 hitEmpty 时被我改成了 pg-1，所以这里要用实际走过的末页+1。
           deepFailedAt 非 0 说明是某页直接失败，重试该页。 */
        const nextPg=deepFailedAt?(deepFailedAt):Math.max(startPg,pages+1);
        deepSavePage(task,taskSig,nextPg,dp);
        seedPendingAdd(task.name);   /* 没走完 → 留在待补集合，下一轮继续 seedAll */
        const sfx=sfBase?"（第 "+sfBase.page+" 页少返：自报 "+sfBase.declared+" 条只给 "+sfBase.got+" 条，判定为未走完）":"";
        log("   基线未走完"+sfx+"：已保存进度，下一轮从第 "+nextPg+" 页接着翻（共 "+dp+" 页）");
      }
      const uniqRaw=[]; const seenId=new Set();
      for(const it of raw){ if(!seenId.has(it.itemId)){ seenId.add(it.itemId); uniqRaw.push(it); } }
      if(pages>1||startPg>1) log("   翻页合计 "+raw.length+" 条 → 去重 "+uniqRaw.length+" 条");
      /* 新鲜度体检：本轮所有条里最新的一条是什么时候发布的
         注意：这是启发式判断。"最新一条"只代表这个筛选范围里最新的在售商品，
         范围收得越窄（比如只筛到某个区），在售量本来就少，最新一条自然可能很旧，
         这种情况不是接口/登录态被风控降级，必须和真降级区分开，否则会误导。 */
      let newest=0,newestItem=null;
      tokenFail=0;      /* 本轮接口正常返回数据 → 清掉失败计数，token 警告随之解除 */
      netErrRounds=0;   /* 【网络类错误分级 2026-11-04】网络恢复了，把断网轮数清零，下次断网重新算 1 */
      /* 这一轮正常拿到数据 → 限流退避降一级（逐步恢复正常频率） */
      if((throttle.level||0)>0&&Date.now()>=(throttle.until||0)){
        throttle.level=Math.max(0,throttle.level-1);
        /* level 归 0 表示已经完全恢复 —— 必须把 reason 一起清掉。
           以前只降 level 不清 reason，字段就自相矛盾了：
           {"level":0,"until":0,"reason":"上次运行末尾仍被限流（RGV587）","count":3}
           现在面板只在 throttled===true 时读 reason 才没露出来，
           哪天面板改成常显就会冒出"正在被限流"但实际没限流。 */
        if(throttle.level===0){ throttle.reason=""; throttle.count=0; throttle.until=0; }
        log("接口已恢复 → 限流退避降到第 "+throttle.level+" 级");
      }
      for(const it of uniqRaw){ const v=Number(it.publishTime||0); if(v>newest){ newest=v; newestItem=it; } }
      /* 水位线推进：coveredFrom = 本轮翻到的最早一条发布时间。
         它仍比旧水位线新 = 空窗没补完 → 只推进到 coveredFrom，下一轮接着往回补；
         否则空窗已闭合，水位线推到本轮最新，正常增量就够。 */
      if(wmOk&&firstPageDone&&!deepFailedAt){
        for(const it of raw){ const v=Number(it.publishTime||0); if(v>0&&(!coveredFrom||v<coveredFrom)) coveredFrom=v; }
        const wmCapped=!!(catchupPages&&!hitEmpty&&!deepFailedAt&&pages>=catchupPages);
        /* 补抓走完 = 本轮开了补抓、没被页数上限截断、也没有页失败（空页到底也算走完）。 */
        const wmDone=!!(catchupPages&&!deepFailedAt&&!wmCapped);
        if(gapSkip){
          /* 长时间停机：不往回翻，直接把水位线归位到池子最新，从「现在」开始按增量扫。
             不归位的话下一轮又会重新判定同一段空窗，永远在原地喊「停机 N 小时」。 */
          try{ saveWatermark(task,taskSig,newest,0,0,true,0); }catch(e){ }
          log("      ✔ 水位线已直接推到池子最新，下一轮起按增量扫（不再回头翻历史）");
        }else{
          try{ saveWatermark(task,taskSig,newest,coveredFrom,wmCapped?(pages+1):0,wmDone,gapToMs); }catch(e){ }
          if(wmCapped) log("      ↻ 本轮补抓被单轮上限截断（已翻到第 "+pages+" 页），下一轮从第 "+(pages+1)+" 页接着往回补");
          else if(wmDone) log("      ✔ 空窗补抓完成（本轮走到第 "+pages+" 页），水位线已推进到池子最新");
        }
      }
      const areaLabel=regionLabel(task);
      /* 分轮基线的进度文案（面板上显示"基线重建中：第 N/M 页"）。
         只有 baseline 未完成时才有意义；完成后留空。 */
      let deepText="";
      if(needDeep&&dp>0&&deepState[task.name]!==taskSig){
        /* 基线还没真正完成（签名未写）→ 显示进度。
           已完成就不再显示，避免"完成了还挂着进度条"的错觉。 */
        const o=readDeepProgress()[task.name];
        const done=(o&&o.sig===taskSig)?Math.max(0,(Number(o.nextPage)||1)-1):Math.max(0,pages-1);
        deepText="基线重建中：已走 "+Math.min(done,dp)+"/"+dp+" 页（每轮最多 "+(Number(cfg.deepPagesPerRound)||3)+" 页，防限流）";
      }
      const st={name:task.name||task.keyword||"(未命名)",cond:condLabel(task),scope:areaLabel,
        narrowScope:!!(task.city||task.area),raw:uniqRaw.length,
        newestAt:null,newestAgoMinutes:null,degraded:false,note:"",error:"",failedRounds:0,
        netError:false,netText:"",
        deepText:deepText,
        scannedAt:new Date().toISOString()};
      if(newest){
        st.newestAt=new Date(newest).toISOString();
        st.newestAgoMinutes=Math.round((Date.now()-newest)/60000);
        const stale=st.newestAgoMinutes>=300;          /* 最新一条超过 5 小时 */
        /* 【v2026-10-20 修】旧判据 `stale && !narrowScope` 是个靠不住的假设。
           它认为"范围窄 → 在售量少 → 最新一条旧是正常的"，于是把 regionLabel 里有 city 的任务
           一律排除在降级之外。实测反例：同条件同范围，00:53 最新一条 11 分钟前，
           12:06 变成 393 分钟前 —— 范围一点没变，这就是降级，却被显示成"数据正常"，
           等于在最需要报警的时候把报警关掉了。
           改成四路判断（任一成立即判降级）：
             ① 最新一条超过 5 小时（绝对阈值，兜底）
             ② 明显差于本任务自己的历史最好水平（相对阈值，最关键）
             ③ 登录身份 cookie（unb / havana hid）缺失
             ④ 服务端少返
           范围窄只影响「解释文案」，不再影响「是否报警」——
           因为窄范围也可能因为登录掉线而拿不到新货，这两件事必须分开。 */
        const hist=task.__bestAgo;                     /* 本任务历史最好的新鲜度（分钟） */
        const relBad=!!(hist!=null&&hist<180&&st.newestAgoMinutes>Math.max(180,hist*6));
        const loginBad=!freshInfo.loginUnb;            /* unb 丢了 = 服务端很可能已按游客给数据 */
        /* 【2026-11-04 修】绝对阈值「最新一条超过 5 小时」在窄范围且登录态正常时不再单独报警。
           窄范围（只盯某市/某区）深夜本就没新货，5 小时旧货是正常现象，报成"风控降级"只会诱导用户
           去重登（重登反而更容易被平台盯上）。真降级交给两条硬判据：relBad（明显差于自身历史水平）、
           loginBad（登录 cookie 真丢了）。范围窄只有在"登录态也丢了"时才可能是降级。 */
        st.degraded=!!((stale&&!(st.narrowScope&&!loginBad))||relBad||loginBad);
        st.degradedWhy = (stale&&!(st.narrowScope&&!loginBad))?"最新一条超过 5 小时"
          : relBad?("明显差于本任务历史水平（历史最好 "+hist+" 分钟前，现在 "+st.newestAgoMinutes+" 分钟前）")
          : "登录身份 cookie（unb）缺失，服务端可能已按游客返回旧数据";
        if(!st.degraded) st.degradedWhy="";
        /* 记历史最好水平：只在数据正常时更新，避免降级期的坏值把基准拉低 */
        if(!st.degraded&&(hist==null||st.newestAgoMinutes<hist)) task.__bestAgo=st.newestAgoMinutes;
        st.narrowScope=!!(task.city||task.area);
        st.note=st.degraded
          ? ("疑似风控降级："+st.degradedWhy+"。请检查登录态（必要时重跑【0-首次扫码登录.cmd】）")
          : (stale?"该范围（"+areaLabel+"）在售量少，最新一条本身就较旧，不是风控降级":"");
      }
      /* 少返体检：一页本该 rowsPerPage 条却只回几条，而服务端自报总量更大
         → 平台限流的典型表现（不是"这个条件没货"，也不是程序 bug） */
      const sf=detectShortfall();
      if(sf){ st.shortfall=sf; st.note="服务端自报 "+sf.declared+" 条，本轮只取到 "+sf.got+" 条 —— 疑似被限流少返"; }
      if(Date.now()<(throttle.until||0)){ st.throttled=true; st.note="平台限流中："+(throttle.reason||""); }
      st.req=lastSearchMeta;
      if(lastSearchMeta.declared!=null) st.declared=lastSearchMeta.declared;
      TASK_STATUS[st.name]=st;
      /* 【2026-11-04】基线期合并自动屏蔽卖家日志：翻历史页时逐条打会刷屏。 */
      sellerBlockLogSilent=!!(needDeep||seedPendingHas(task.name));
      sellerBlockSilentCount=0;
      const items=uniqRaw.filter(it=>localFilter(task,it));
      /* 【修「依然有错」：两个新鲜度口径必须分开说，别再混成一个数字】
         旧版这里只打一个 st.newestAgoMinutes，它来自 L2226 的 uniqRaw 全体，
         包含被 localFilter 挡掉的游戏道具、AirPods、64G 机。
         于是出现自相矛盾：日志说「最新一条发布于 12 分钟前」，面板商品却停在 4 小时前 ——
         两个数字都没算错，但它们量的不是同一个东西：
           · 池子最新   = 平台这一轮返回里最新的一条（可能根本不合格）
           · 合格品最新 = 通过 localFilter 的里面最新的一条 ← 这才是面板上能看到的最新
         现在两个都算、都打，并把合格品口径写进 TASK_STATUS 交给面板显示。 */
      let newestPassed=0;
      for(const it of items){ const v=Number(it.publishTime||0); if(v>newestPassed) newestPassed=v; }
      st.newestPassedAt=newestPassed?new Date(newestPassed).toISOString():null;
      st.newestPassedAgoMinutes=newestPassed?Math.round((Date.now()-newestPassed)/60000):null;
      {
        const poolTxt=(st.newestAgoMinutes==null?"—":(st.newestAgoMinutes+" 分钟前"));
        const passTxt=(st.newestPassedAgoMinutes==null?"无一条合格":(st.newestPassedAgoMinutes+" 分钟前"));
        log("   接口最新 "+poolTxt+"（含被条件挡掉的）；合格品最新 "+passTxt
          +"（本轮翻到 "+uniqRaw.length+" 条，过条件 "+items.length+" 条）");
        if(st.newestPassedAgoMinutes==null&&st.newestAgoMinutes!=null){
          log("      → 翻到货了但一条都过不了条件：不是接口没更新，是这些货不符合当前条件（看下面的过滤明细）");
        }else if(st.newestPassedAgoMinutes!=null&&st.newestAgoMinutes!=null&&st.newestPassedAgoMinutes>st.newestAgoMinutes+30){
          log("      → 两者差 "+Math.round(st.newestPassedAgoMinutes-st.newestAgoMinutes)+" 分钟：这期间上新的全被条件挡掉了");
        }
        if(st.degraded) log("      （偏旧，疑似降级："+st.degradedWhy+"）");
        else if(st.narrowScope&&st.newestAgoMinutes>=300) log("      （范围 "+areaLabel+" 在售量少，非降级）");
      }
      /* 基线未走完期间（needDeep 或待补集合里还有它）：
         本轮翻到的第 4-25 页全是【历史在售】，一条都不算"新命中"。
         旧版没有这个闸门，续翻时把历史页的老货当成新命中一次报了 42 条，等于误报。
         基线期间只做两件事：登记进 seen（防以后重复报）、收进显示列表（不推送）。 */
      const baselineInProgress=needDeep||seedPendingHas(task.name);
      const fresh=[];
      let descUsed=0, deferred=0, staleSkipped=0;
      const needDesc=blockWordsOf(task).length>0;
      /* 【修「命中不准确」根因 F】新命中时效闸门。
         把常规轮从 1 页加到 3 页之后，第 2-3 页里混着大量"几天前发布、现在还在卖"的历史在售。
         它们对本程序是第一次见到（seen 里没有），旧逻辑会全部当成"新命中"写进 hits，
         面板一次涌进几十条老货 —— 这正是用户看到的"滑下去都是很久之前的"。
         监控的语义是「抓新上架」，不是「抓所有在售」，所以这里加闸门：
         发布时间早于 freshMaxAgeHours（默认 24 小时）的，只登记 seen 防重复扫，不进 hits。
         拿不到发布时间的（publishTimeAdjusted=0）保守放行，宁可多一条也别漏真新货。
         freshMaxAgeHours=0 可关闭闸门（回到旧行为）。 */
      const freshMaxH=Number(cfg.freshMaxAgeHours==null?24:cfg.freshMaxAgeHours);
      const freshCut=freshMaxH>0?(Date.now()-freshMaxH*3600000):0;
      const hitsIdSet={};
      for(const h0 of hits){ if(h0&&h0.itemId) hitsIdSet[h0.itemId]=1; }
      const catchupFromMs=(catchupPages>0&&wmBefore)?(Number(wmBefore.newestMs)||0):0;
      /* 【2026-10-29 补推】基线/补抓期间也要推「真新货」。
         基线期一轮要翻 10 页历史在售，把老货当新命中一次报几十条是误报（所以有下面那道闸门）；
         但基线开始之后才上架的商品，本质上就是新货，不能因为"正好在重建基线"被吞掉 ——
         这正是用户抱怨的场景：改完筛选条件，接下来 20~40 分钟的提示全哑了。
         判定基准 = baselineClock（本条件开始重建基线的那一刻），跨轮续翻时保持不变。 */
      const baselineClock=baselineInProgress?baselineClockMark(task.name):0;
      let recovered=0;
      let baselineNewborn=0;
      let backlogSeeded=0;
      for(const it of items){
        /* 【核心改动：价格记忆必须先于 seen 判定】
           旧逻辑第 2772 行 `if(wasSeen) continue` 直接跳过已见过的商品，
           于是同一个 itemId 的价格**永远不会被读第二次** —— 降价在 Node 版里
           不是"没实现"，是"没有数据可判"。
           现在先无条件观测一次价格（写进 price-memory.json），再走原来的 seen 分支；
           已见过但降价幅度够的，破例放行当"重推候选"。 */
        let pmObs=null;
        try{ pmObs=priceMemory.observe(it, Date.now()); }catch(e){}
        const wasSeen=!!seen[it.itemId];
        /* gapPass=true 表示这条已经凭「空窗补抓」通过了一次判定（见下面 gapOK 分支），
           后面的 freshCut 闸门和基线闸门都不该再拦它 —— 它本来就是空窗里错过的真货。 */
        let gapPass=false;
        /* 【2026-11-03 停机积压静默】本轮只要处在空窗补抓里（或上一轮还没补完），
           所有「没进过 seen、发布时间早于本次进程启动」的货都是停机期间的积压，
           只静默收进列表，不推手机。启动之后真正新上架的（ptb>=BOOT_MS）照旧走下面流程。
           注意位置：必须放在 wasSeen 分支之前，且只对 !wasSeen 生效 ——
           已见过的货有它自己的降价重推/gapOK 逻辑，不能被这里截胡。 */
        if(!wasSeen&&cfg.catchupSilent!==false
           &&(gapActive||(wmBefore&&wmBefore.catchupNextPage>0))){
          const ptb=Number((it.publishTimeAdjusted||it.publishTime)||0);
          if(ptb>0&&ptb<BOOT_MS){
            seededAll.push(it); seen[it.itemId]=Date.now(); backlogSeeded++;
            continue;
          }
        }
        if(wasSeen){
          const pt0=Number((it.publishTimeAdjusted||it.publishTime)||0);
          const inGap=catchupFromMs>0&&pt0>0&&pt0>=catchupFromMs;
          const gapOK=inGap&&!hitsIdSet[it.itemId];
          if(!gapOK){
            /* 降价重推：价格比上次观测到的低，且降幅达到阈值 → 进 fresh 并标 __isRenotify。
               阈值取 cfg.notify.priceDropPct（默认 0.03 = 3%），对齐 second-eye 的
               DROP_PCT_DISPLAY_THRESHOLD 语义（低于这个幅度属于噪声，不值得打扰）。 */
            const dropNeeded=Number((cfg.notify&&cfg.notify.priceDropPct)||0.03);
            const dropped=!!(pmObs&&!pmObs.isNew&&pmObs.prev!=null
              &&Number(it.price)<Number(pmObs.prev)&&pmObs.dropPct>=dropNeeded);
            if(dropped&&!(freshCut>0&&pt0>0&&pt0<freshCut)){
              it.__isRenotify=true;
              it.__dropPct=pmObs.dropPct;
              it.__prevPrice=pmObs.prev;
              fresh.push(it); seen[it.itemId]=Date.now(); recovered++;
              log("   ↓ 降价重推候选 "+it.itemId+"："+pmObs.prev+" → "+it.price
                +"（较首见 -"+(pmObs.dropPct*100).toFixed(1)+"%）");
            }
            continue;
          }
          /* 【2026-10-29 补推】走到这里说明 gapOK=true —— 这条是空窗期（水位线之后）
              新上架的、且还没进过显示列表。它本身就是停机那段时间错过的货。
              空窗货是否推送由 catchupSilent 开关决定（默认 true=静默）：
              · true ：静默收录进显示列表（不算新命中、不推送），只推重启后真正新上架的，
                      避免停机几小时重启后连推几十条的洪泛。
              · false：照旧当新命中推出去（旧行为）。 */
          if(cfg.catchupSilent!==false){
            seededAll.push(it); seen[it.itemId]=Date.now(); recovered++;
            continue;
          }
          gapPass=true;
        }
        if(!gapPass&&baselineInProgress){
          /* 基线期间默认静默登记，不进 fresh（不推送、不算新命中）——
             因为翻的是历史页，一条都不该报。
             例外：发布时间晚于「本条件基线启动时刻」的，是基线跑起来之后真上架的货，
             照常进 fresh 走推送，否则重建基线的 20~40 分钟里上新全被吞掉。 */
          const ptb=Number((it.publishTimeAdjusted||it.publishTime)||0);
          const isNewborn=baselineClock>0&&ptb>0&&ptb>=baselineClock&&!hitsIdSet[it.itemId];
          if(!isNewborn){
            seen[it.itemId]=Date.now();
            continue;
          }
          baselineNewborn++;
        }
        if(!gapPass&&freshCut>0){
          const pt=Number((it.publishTimeAdjusted||it.publishTime)||0);
          if(pt>0&&pt<freshCut){ staleSkipped++; seen[it.itemId]=Date.now(); continue; }
        }
        if(needDesc){
          if(descUsed>=(cfg.maxDescPerRound||15)){ deferred++; continue; }
          descUsed++;
          const ok=await descPass(task,it);
          if(!ok) continue;
        }
        fresh.push(it); seen[it.itemId]=Date.now();
        if(wasSeen) recovered++;
      }
      /* seedAll 的来源有两个：本轮显式传入（opts.seedAll），或"待补基线集合"里还有这个任务（跨轮续翻）。
         后者是关键：分轮基线要 8-9 轮才能走完，这期间每轮都必须把当前在售收进列表，
         否则第 2-9 轮看到的货不会进面板，面板就永远比官网少。 */
      const wantSeed=!!(opts.seedAll||seedPendingHas(task.name));
      if(wantSeed){
        /* 只把「够新」的收进显示列表；历史在售照样已登记进 seen。 */
        const g=seedAgeKeep(task,items);
        if(g.dropped) log("   基线补货时效闸门：只收 "+g.keep.length+" 条（"+g.h+" 小时内发布），略过 "+g.dropped+" 条更早的历史在售");
        seededAll=seededAll.concat(g.keep);
      }
      if(recovered) log("   ↺ 空窗回流 "+recovered+" 条（这些在上一次不完整扫描里只登记了 seen、没进列表）");
      if(backlogSeeded) log("   ⏸ 停机积压 "+backlogSeeded+" 条（发布于本次启动之前）→ 只收进列表，不推送");
      if(deferred) log("   （本轮详情检查已达上限 "+cfg.maxDescPerRound+" 条，剩余 "+deferred+" 条下一轮继续）");
      /* 首轮判定必须按"任务"粒度，不能按全局 baselineDone：
         分轮基线下每个任务要跨 8-9 轮，若沿用全局标志，第 2 轮之后就会被当"首轮"重复把在售当新命中灌进列表。 */
      /* 判定"首次运行"= 这个条件从来没建过基线。两个证据任一成立就不算首次：
         ① deepState 里已有本签名（全量基线走完过）；② seeded-once 里记过本签名（基线进行中已开过张）。
         这样进程重启、改无关配置都不会再把在售当"首次运行"重灌一遍。 */
      const firstRunOfTask=!(deepState[task.name]===taskSig)&&!seedOnceHas(task.name,taskSig);
      if(needDeep||wantSeed) seedOnceMark(task.name,taskSig);
      if(baselineInProgress){
        /* 这里必须报 g.keep.length 而不是 items.length：加了时效闸门后，
           本轮翻到的 items 里有一部分（几天前的历史在售）只进 seen、不进显示列表，
           还报 items.length 会让人误以为面板应该多出这么多条，进而怀疑闸门没生效。 */
        const gKeep=seedAgeKeep(task,items);
        log("["+task.name+"] 基线进行中：本轮收入 "+gKeep.keep.length+" 条（翻到 "+items.length+" 条"
          +(gKeep.dropped?("，略过 "+gKeep.dropped+" 条更早的历史在售"):"")+"；不推送、不算新命中）");
        /* 【2026-10-29 补推】唯一例外：本轮放行的「基线开始之后才上架」的新货要照常推。
           fresh 在基线期只可能装这一类（其余全被上面的闸门 continue 掉了）。 */
        if(fresh.length){
          log("   ★ 基线期间新上架 "+fresh.length+" 条（发布于基线开始之后）→ 照常推送");
          for(const x of fresh.slice(0,5)) log("   "+x.priceText+" | "+x.publishAt+" | "+x.area+" | "+x.title.slice(0,40));
          freshAll=freshAll.concat(fresh);
        }else if(baselineNewborn){
          log("   （基线期间新上架 "+baselineNewborn+" 条已在列表里，不重复推）");
        }
      }
      else if(firstRunOfTask&&cfg.showExistingOnFirstRun===false){ log("["+task.name+"] 建立基线 "+items.length+" 条（不推送）"); }
      else if(firstRunOfTask){
        const g=seedAgeKeep(task,items);
        log("["+task.name+"] 首次运行：收入当前在售 "+g.keep.length+" 条（与手机显示一致）"
          +(g.dropped?("，略过 "+g.dropped+" 条更早的历史在售"):""));
        for(const x of g.keep.slice(0,8)) log("   "+x.priceText+" | "+x.area+" | "+x.title.slice(0,38));
        freshAll=freshAll.concat(g.keep);
      }
      else if(fresh.length){
        log("["+task.name+"] 新命中 "+fresh.length+" 条"
          +(staleSkipped?("（另有 "+staleSkipped+" 条发布时间超过 "+freshMaxH+" 小时，已跳过只登记）"):""));
        for(const x of fresh.slice(0,5)) log("   "+x.priceText+" | "+x.publishAt+" | "+x.area+" | "+x.title.slice(0,40));
        freshAll=freshAll.concat(fresh);
      } else{
        log("["+task.name+"] 无新命中（取回 "+raw.length+" 条, 去重 "+uniqRaw.length+" 条, 筛后 "+items.length+" 条"
          +(staleSkipped?("，其中 "+staleSkipped+" 条超过 "+freshMaxH+" 小时"):"")+"）");
      }
      /* 【新增】丢弃原因汇总：把"没货"和"被条件挡掉"分开。
         以前只报"筛后 N 条"，用户看不出是被价格拦了、被品牌拦了、还是被屏蔽词拦了，
         只能凭感觉怀疑程序漏抓。现在每轮把这个条件挡掉多少条按原因列出来。 */
      {
        const dl=dropStatsLine();
        if(dl) log("   条件过滤明细："+dl+"（说明：这些是翻到了但被条件挡掉的条数，不是漏抓）");
        /* 宽松放行单独一行：这些条没被挡掉、已经进了候选或命中，
           只是其中有一部分是「标题和标签都没写容量」才放行的，用户可能想复核。 */
        const pf=dropPassLine();
        if(pf) log("   宽松放行："+pf+"（这些没被挡掉；标题没写容量，可能是真货也可能是别的容量）");
        if(sellerBlockSilentCount>0) log("   基线期自动屏蔽卖家 "+sellerBlockSilentCount+" 条（已合并，不逐条列出）");
      }
    }catch(e){
      const msg=String(e.message||"");
      log("["+task.name+"] 扫描失败: "+msg);
      /* 浏览器被关掉/崩溃：立刻作废 ctx/page，下一轮自动重新拉起，不算 token 失败 */
      if(/has been closed|Target closed|Browser closed|Target page, context or browser|Protocol error/i.test(msg)){
        log("      → 取数浏览器已断开，下一轮会自动重新打开（无需操作）");
        try{ await ctx.close(); }catch(_){}
        ctx=null; page=null; tokenFail=0;
        continue;
      }
      /* 【BUG-R】FAIL_SYS_ILLEGAL_ACCESS 必须从「限流」里拆出来，单独当签名错误处理。
         2026-10-21 实测：它长得像封号/限流，实际根因是 sign 算错（取到了 .taobao.com 那份
         _m_h5_tk 去给 goofish 的 mtop 签名）。旧版把它塞进 punished 正则，后果是：
           ① 白白退避 5→10→20 分钟，把一次「本轮就能修好」的错误拖成半小时不扫；
           ② 面板提示「平台限流，常见原因：请求太频」—— 把用户往「换账号/等风控」的错方向带；
           ③ 连累 throttle.level 抬到 3 级，真限流时才该有的重退避被提前用光。
         现在：它是 signFail，本轮立刻重新读 cookie（下一轮 goofishTokenOf 会拿到正确域那份）
         + 计数提示，不动 throttle。 */
      const signFail=/FAIL_SYS_ILLEGAL_ACCESS::|FAIL_SYS_ILLEGAL_ACCESS$/i.test(msg);
      if(signFail){
        signFailRounds=(signFailRounds||0)+1;
        tokenFail++;
        log("      → 签名被拒（FAIL_SYS_ILLEGAL_ACCESS）：不是封号，是 sign 用的 _m_h5_tk 不对。");
        log("        下一轮会自动重新读浏览器 cookie 重签（同域优先，不会再拿淘宝那份）。");
        if(signFailRounds>=3) log("        连续 "+signFailRounds+" 轮仍失败 → 运行【0-首次扫码登录.cmd】重登一次最稳。");
        const nm0=task.name||task.keyword||"(未命名)";
        const pv0=TASK_STATUS[nm0]||{name:nm0,cond:condLabel(task),scope:regionLabel(task),narrowScope:!!(task.city||task.area),raw:null,newestAgoMinutes:null,degraded:false};
        pv0.error="签名被拒（sign 用错 token 域），已自动重签"; pv0.failedRounds=tokenFail; pv0.scannedAt=new Date().toISOString();
        TASK_STATUS[nm0]=pv0;
        await nap(1200);
        continue;
      }
      /* 平台限流：RGV587「被挤爆啦」/ 需要滑块验证 —— 这跟 token 过期是两回事，
         千万不要提示用户去重新扫码（重登也没用，反而更容易被盯上）。 */
      const punished=/RGV587|被挤爆|挤爆啦|FAIL_SYS_USER_VALIDATE|punish|滑块|验证码|FAIL_SYS_TRAFFIC_LIMIT/i.test(msg);
      if(punished){
        /* 被限流时：【一定要保住基线进度】，并留在这个任务的待补集合里。
           旧版是直接 continue，进度和 seedAll 标记一起丢，恢复后又从第 1 页重来 —— 越重来越容易被盯。 */
        if(needDeep||seedPendingHas(task.name)){
          try{ deepSavePage(task,taskSig,deepFailedAt||startPg,dp||Number(cfg.deepMaxPages)||25); }catch(_){}
          seedPendingAdd(task.name);
          log("      → 基线进度已保留，恢复后从第 "+(deepFailedAt||startPg)+" 页接着翻，不会从头再来。");
        }
        throttle.level=Math.min(3,(throttle.level||0)+1);
        /* 退避梯度：5 分钟 → 10 分钟 → 20 分钟。
           不要隔一两分钟就再试探一次 —— 每次试探都会把这个冷却窗口重新续上。 */
        const SCHED=[300000,600000,1200000];
        const waitMs=SCHED[Math.min(SCHED.length-1,throttle.level-1)];
        throttle.until=Date.now()+waitMs; throttle.reason=msg.slice(0,90); throttle.at=new Date().toISOString(); throttle.count=(throttle.count||0)+1;
        log("被平台限流（"+throttle.reason+"）—— 本次自动放慢：未来 "+(waitMs/1000).toFixed(0)+"s 内不扫。");
        if(throttle.count===1) log("      → 常见原因：请求太频 / 同一账号同时开了两个监控 / 刚做过大量筛选。等它自己恢复即可。");
        /* 把窗口显示出来 + 存一张现场截图：平台要求验证时，用户要在这个窗口里点一下 */
        try{
          if(page&&!page.isClosed()){
            await page.bringToFront().catch(()=>{});
            const shot=path.join(DATA,"punish-last.png");
            await page.screenshot({path:shot,fullPage:false}).catch(()=>{});
            log("      → 浏览器窗口已切到前台，现场截图: data\\punish-last.png");
          }
        }catch(_){}
        if(throttle.count>=3) log("      → 已连续 "+throttle.count+" 次被限流：请在浏览器窗口里手动打开闲鱼首页/搜索页，按平台提示完成验证（滑块）；验证通过后本程序会自动恢复。");
        /* 页面真的弹出验证（滑块/点选）时：立刻进入"人工验证等待"，此后完全不碰这个页面 ——
           不停刷新/重新搜索会把用户正在做的验证直接打断，baxia 就会一直报"验证失败"。 */
        if(await pageLooksChallenged()){
          manualVerify=true; manualVerifyAt=Date.now();
          throttle.until=Date.now()+900000;   /* 人工验证期间再兜底静默 15 分钟 */
          /* 无窗口模式下没法人工过验证 → 立刻切成可见窗口，并保留当前页面状态（cookie 会自动存/还原），
             让用户能在屏幕上点滑块/点选。验证完成、页面恢复正常后自动收回去。 */
          if(cfg.headless!==true&&cfg.noWindow!==false&&!VISIBLE_OVERRIDE){
            VISIBLE_OVERRIDE=true;
            log("      → 当前是无窗口模式，弹了验证页：正在切换成【可见窗口】，请稍等几秒并在屏幕上完成验证。");
            try{ await saveCookies(); }catch(e){}
            try{ await ctx.close(); }catch(e){}
            ctx=null; page=null;
            /* 重开成可见窗口后【不再立刻发请求】：立刻请求 = 立刻又触发限流，
               验证页会被刷掉，用户根本来不及点。所以这里只负责把窗口摆出来（goto 首页），
               真正等待由主循环的 manualVerify 分支负责（每 60s 检查，最多 120s 一轮）。 */
            try{
              await ensurePage();
              if(page&&!page.isClosed()){ await page.bringToFront().catch(()=>{}); }
              log("      → 可见窗口已就绪：请在屏幕上完成验证，程序会一直等着（不会刷新页面、不会打断你）。");
            }catch(e){ log("      → 切可见窗口失败："+String(e.message).slice(0,80)); }
            /* 关键：不 continue 到下一轮就结束，而是留在 manualVerify 状态里 */
            manualVerify=true; manualVerifyAt=Date.now();
            break;
          }
          log("      → 检测到验证页（滑块/点选）：已完全停止扫描 15 分钟，这个浏览器窗口不再刷新、不再点击，");
          log("        请在这个窗口里完成验证；验证通过后程序会自动继续（每 60 秒检查一次，不打断你）。");
        }
        const nm=task.name||task.keyword||"(未命名)";
        const prev=TASK_STATUS[nm]||{name:nm,cond:condLabel(task),scope:regionLabel(task),narrowScope:!!(task.city||task.area),raw:null,newestAgoMinutes:null,degraded:false};
        prev.error="平台限流："+throttle.reason; prev.failedRounds=0; prev.throttled=true; prev.scannedAt=new Date().toISOString();
        /* 基线进度留在面板上：让用户知道恢复后会从第几页接着翻，而不是从头再来 */
        if(needDeep||seedPendingHas(task.name)){
          const dd=Number(cfg.deepMaxPages)||25;
          prev.deepText="基线重建中：已走 "+Math.max(0,(deepFailedAt||startPg)-1)+"/"+dd+" 页（限流中断，恢复后从第 "+(deepFailedAt||startPg)+" 页续翻）";
        }
        TASK_STATUS[nm]=prev;
        tokenFail=0;   /* 限流不是 token 问题，不计入 token 失败 */
        await nap(1500);
        continue;
      }
      /* 只有"接口层"失败（FAIL_* 或 401 或签名错）才计入 token 过期计数；网络抖动等不算 */
      const apiFail=/FAIL_|FAIL_SYS|令牌|token|sign|401|403|登录|not login|Unauthorized/i.test(msg);
      if(apiFail) tokenFail++; else tokenFail=0;
      /* 【网络类错误分级 2026-11-04】断网不往「账号/登录」方向带，单独记轮数。
         注意失败轮数要在网络恢复的那一轮清零（见 3235 行附近的 tokenFail=0 同处）。 */
      const netErr=isNetErr(msg);
      if(!netErr) netErrRounds=0;
      const nm=task.name||task.keyword||"(未命名)";
      const prev=TASK_STATUS[nm]||{name:nm,cond:condLabel(task),scope:regionLabel(task),narrowScope:!!(task.city||task.area),raw:null,newestAgoMinutes:null,degraded:false};
      prev.error=msg.slice(0,120);
      prev.failedRounds=tokenFail;
      /* 【网络类错误分级 2026-11-04】标记这条失败是不是网络原因，
         面板据此决定挂红字还是灰字（详见 publishFreshInfo 的 note 分支）。 */
      prev.netError=netErr;
      prev.netText=netErr?netErrBrief(msg):"";
      prev.scannedAt=new Date().toISOString();
      TASK_STATUS[nm]=prev;
      if(tokenFail===2){
        tokenWarn=true;
        log("连续 "+tokenFail+" 轮接口失败 —— 大概率是登录签名 token（_m_h5_tk）已过期。");
        log("      → 请关闭本窗口后运行【0-首次扫码登录.cmd】重新扫码登录。");
      }
    }
    await nap(8000+Math.floor(Math.random()*7000));   /* 【错峰 2026-11-02】任务间随机 8~15s，避免多任务同轮叠加 */
  }
  deepTurnIdx++;   /* 【错峰 2026-11-02】每轮推进一次轮转指针 */
  if(!baselineDone) baselineDone=true;
  lastUpdate=new Date().toISOString();
  const freshChanged=publishFreshInfo();
  /* 【异常推手机】每轮体检之后判一次异常（登录失效 / 连续接口失败 / 被限流 / 任务连续失败）。
     checkAlerts 内部自带「连续 2 轮才报 + 30 分钟冷却 + 恢复回执」，
     所以这里每轮无脑调用即可，不会刷屏。失败不影响扫描主流程。 */
  try{ await checkAlerts(); }catch(e){ log("⚠ 告警检查异常: "+String(e&&e.message||e).slice(0,160)); }
  writeRound=(writeRound||0)+1;
  if(freshAll.length) hits=capHits([...freshAll,...hits],"新命中写入");
  /* 建基线时把当前在售也收进显示列表（去重、不推送、不改 read 状态）。
     分轮基线下 seededAll 每轮都有内容（待补集合里的任务每轮都 seedAll），
     所以写盘条件也要带上 seedAll 的"本轮是否有货"，否则面板补了货却没落盘。 */
  let seeded=0;
  const wantSeedRound=!!(opts.seedAll||seededAll.length);
  if(wantSeedRound&&seededAll.length){
    const have={}; hits.forEach(h=>{ have[h.itemId]=1; });
    const add=[];
    seededAll.forEach(x=>{ if(x&&x.itemId&&!have[x.itemId]){ have[x.itemId]=1; add.push(x); } });
    if(add.length){
      /* 【修 BUG-S】add 放前面：以前拼在尾部，slice 恰好把刚加进去的又砍掉，却仍报「新增 N 条」。 */
      const hsBefore=hits.length;
      hits=capHits([...add,...hits],"基线补货");
      seeded=Math.max(0,hits.length-hsBefore);
    }
    log("已把当前在售 "+seededAll.length+" 条收进列表（新增 "+seeded+" 条，不算新命中、不推送）");
  }
  /* 显示顺序：按发布时间倒序（新的在上）。
     接口用「综合排序」时（官网在有时间档位时就是这个排序）返回顺序是推荐位，不是时间序，
     面板上如果照接口顺序排，用户会觉得"怎么老的混在前面"，所以这里统一按发布时间重排。 */
  const __pub=(s)=>{ const t=parsePublishAt(s); return isFinite(t)?t:0; };
  hits.sort((a,b)=>__pub(b.publishAt)-__pub(a.publishAt));
  /* 全局按 itemId 去重（保最新一条）。
     实测面板 118 条里只有 90 个唯一 itemId —— 分轮基线每轮都把同一批货 seed 一遍，
     跨轮去重只对比了"写盘前的 hits"，历史遗留的重复项没人清，越攒越多。
     这里在写盘前统一做一次，彻底断根；同一商品保留发布时间最新的那条（价格/标题可能被卖家改过）。 */
  (function dedupeHitsById(){
    const keep=[]; const idx={};
    for(const h of hits){
      if(!h||!h.itemId){ continue; }
      const prev=idx[h.itemId];
      if(prev==null){ idx[h.itemId]=keep.length; keep.push(h); }
      else if(__pub(h.publishAt)>__pub(keep[prev].publishAt)){ keep[prev]=h; }
    }
    if(keep.length!==hits.length){
      log("列表去重：合并 "+hits.length+" 条中的重复商品 → "+keep.length+" 条");
      hits=keep;
    }
  })();
  /* seen / desc-cache 体积大，改成按需写盘：有新命中、或体检结论变了、或每 10 轮兜底一次。
     分轮基线期间 seen 每轮都在涨（每轮都把新页收进 seen），必须每轮落盘，不能等 10 轮。 */
  if(freshAll.length||seeded||freshChanged||wantSeedRound||writeRound>=10){
    pruneSeen();      /* 先按"过期 + 硬上限"瘦身，再落盘，避免文件无限增长 */
    writeJSON(SEENF,seen); writeJSON(HITSF,hits); writeJSON(DESCCF,descCache);
    pruneWordHits(); writeJSON(WORDF,wordHits);
    writeRound=0;
  }
  /* 推送前把 itemId → task 建好：综合分要用任务的 minPrice/maxPrice 算"这件货在
     这个价位区间里算不算便宜"。缺了它就只剩卖家分和新鲜分，所有货分数长得一样。 */
  /* 【2026-10-29】以前这里是 if(freshAll.length) 才调 notify，于是「上一轮推送失败、
     本轮又没新命中」时补推队列永远不会被消费 —— 那些货就静静躺到 24 小时过期。
     现在改成：本轮有新命中，或者补推队列里有货，都要进 notify()。 */
  {
    const byName={};
    (cfg.tasks||[]).forEach(function(t){ if(t&&t.name!=null) byName[String(t.name)]=t; });
    const taskMap={};
    freshAll.forEach(function(x){ if(x&&x.itemId&&x.task!=null) taskMap[x.itemId]=byName[String(x.task)]||null; });
    let hasRetryQ=false;
    try{ hasRetryQ=notifyRetryLoad().length>0; }catch(e){}
    if(freshAll.length||hasRetryQ){
      try{
        await notify(freshAll, taskMap);
      }catch(e){
        /* 推送失败绝不能把这一轮的抓取结果一起带走 —— 数据已经落盘了，
           这里只记日志，主循环继续。 */
        log("⚠ 推送阶段异常（不影响本轮抓取结果）: "+String(e&&e.message||e).slice(0,200));
      }
    }
  }
  return {fresh:freshAll.length,seeded:seeded,seen:Object.keys(seen).length};
}

/* 把本轮各任务的体检结果聚合成"最差情况"，写进 /__scan/hits.json 的 fresh 字段。
   返回 true 表示体检结论有变化（需要把 hits.json 重写一遍给面板读）。 */
let __freshSig="";
function publishFreshInfo(){
  /* 任务改名/删除后，旧名字的体检行不该继续挂在面板上 —— 每轮按当前任务表清理一次 */
  try{
    const alive=new Set(((cfg&&cfg.tasks)||[]).map(t=>t.name));
    Object.keys(TASK_STATUS).forEach(k=>{ if(!alive.has(k)) delete TASK_STATUS[k]; });
  }catch(e){}
  const list=Object.keys(TASK_STATUS).map(k=>TASK_STATUS[k]);
  if(!list.length) return false;
  const ok=list.filter(t=>!t.error&&t.newestAgoMinutes!=null);
  const worst=ok.slice().sort((a,b)=>b.newestAgoMinutes-a.newestAgoMinutes)[0]||null;
  const badTask=list.find(t=>t.error);
  /* 【网络类错误分级 2026-11-04】把「断网」和「真故障」分开。
     - 断网且本轮是第 1 轮：只给一条灰色软提示（panel 按 netSoft 渲染灰字），不挂红横幅、不改 perTask 红点；
     - 断网且连续 >=2 轮：升级成真正的 error（红字 + 告警），因为这时候确实需要人看一眼；
     - 非网络错误：原样不动。 */
  const netFailList=list.filter(t=>t.error&&t.netError);
  const netOnly=!!(badTask&&badTask.netError&&!netFailList.some(t=>Number(t.failedRounds||0)>=2));
  if(netFailList.length&&!netOnly) netErrRounds=Math.max(netErrRounds||0,2);
  else if(netFailList.length&&netOnly) netErrRounds=Math.max(netErrRounds||0,1);
  /* 【网络类错误分级 2026-11-04】网络错误不算「token 连续失败」。
     断网 2 轮就说「请重新扫码」，用户照做就会反复重登 —— 重登才是真正的风控诱因。
     所以这里显式排掉 netError 的任务：断网交给 netOnly 分支，真错误才提 token。 */
  tokenWarn = tokenFail>=2 || !!(badTask&&badTask.failedRounds>=2&&!badTask.netError);
  const throttled=list.some(t=>t.throttled)||Date.now()<(throttle.until||0);
  freshInfo.perTask=list;
  /* 面板据此决定横幅颜色：true = 灰字软提示（单轮断网），false = 红字（真故障） */
  freshInfo.netSoft=netOnly;
  freshInfo.scannedAt=new Date().toISOString();
  freshInfo.degraded=list.some(t=>t.degraded);
  /* 【2026-11-05】自动重建会话的两个计数，透过 hits.json 的 fresh 字段交给面板/体检：
       staleRounds    = 当前已连续几轮只拿到旧数据（归零说明数据恢复新鲜）
       sessionRebuilds= 本次运行已自动重建几次浏览器会话
     注意必须在这里赋值：freshInfo 是 hits.json 里 fresh 那一坨的唯一来源，
     只在 selfcheck 里读全局变量的话面板拿不到。 */
  freshInfo.staleRounds=staleRounds;
  freshInfo.sessionRebuilds=sessionRebuilds;
  /* 面板要给"登录已失效"弹一条醒目横幅，必须有独立、明确的判断依据，
     不能靠解析 degradedWhy 的字符串（文案一改横幅就失灵）。
     loginBad = unb 缺失 或 havana 会话标记不足 2 个 —— 两者任一成立，
     服务端就会按游客返回约 6 小时前的旧数据。 */
  /* 【修 BUG-L：loginBad 用的 loginStrong 还没兜底就被读了】
     原顺序：先算 loginBad（此时 loginStrong 可能是 undefined）→ 再给 loginStrong 兜 0。
     Number(undefined) = NaN，NaN>=2 为 false → loginBad 直接变成 true，
     即使 unb 完全正常也会被判成"登录失效"，面板横幅误弹（checkLogin 恰好先写过该字段，
     所以平时看不出来，属于顺序脆弱：任何一条不经过 checkLogin 的路径都会踩）。 */
  freshInfo.loginStrong=freshInfo.loginStrong||0;
  /* 【2026-11-04】判据已换成 sgcookie+tfstk+unb（见 checkLogin）。
     这里如果还按旧的 ">=2 个标记" 重算，会把 checkLogin 的结论覆盖掉，等于 Fix1 白改
     —— 所以有 loginLevel 就直接用，没有才退回旧逻辑。 */
  if(freshInfo.loginLevel) freshInfo.loginBad=(freshInfo.loginLevel==="bad");
  else freshInfo.loginBad=!(freshInfo.loginUnb&&Number(freshInfo.loginStrong)>=2);
  /* 自动商贩识别结果（seller-blocklist.json 相关的候选名单）每轮重算一次 */
  updateSellerSuspects();
  freshInfo.tokenAlert=tokenWarn;
  freshInfo.throttled=throttled;
  freshInfo.throttle={level:throttle.level||0,until:(throttle.until||0)>Date.now()?new Date(throttle.until).toISOString():null,
    reason:throttle.reason||"",count:throttle.count||0};
  freshInfo.lastRequest=lastSearchMeta||null;
  if(worst){
    freshInfo.scope=worst.scope;
    freshInfo.narrowScope=worst.narrowScope;
    freshInfo.newestAt=worst.newestAt;
    freshInfo.newestAgoMinutes=worst.newestAgoMinutes;
  }
  /* 【合格品最新】必须单独算、单独给前端，不能和上面的 newestAgoMinutes 混用。
     newestAgoMinutes 是「本轮翻到的池子里最新一条」，里面混着被 localFilter 挡掉的
     游戏道具 / 64G·128G / AirPods / iPad —— 面板显示「接口最新 12 分钟前」而商品列表
     停在 3 小时前，用户只会认为程序坏了。
     合格品最新 = 过了本地条件的货里最新那条，这才是「我想要的那种货多久没上新」。 */
  {
    const okPass=list.filter(t=>!t.error&&t.newestPassedAgoMinutes!=null);
    const worstPass=okPass.slice().sort((a,b)=>b.newestPassedAgoMinutes-a.newestPassedAgoMinutes)[0]||null;
    freshInfo.newestPassedAgoMinutes=worstPass?worstPass.newestPassedAgoMinutes:null;
    freshInfo.newestPassedAt=worstPass?worstPass.newestPassedAt:null;
    /* passedNone 只能在「本轮真的扫成功了、而且确实翻到过货」时才为 true。
       漏掉这个前置条件会出现更糟的误报：本轮被限流 / 第1页就失败时，
       done 为空 → worstPass 为 null → passedNone=true → 面板打出
       「合格品一条都没有，翻到的货全被条件挡掉了」——
       实际是一条都没翻到，用户会以为过滤器坏了。错误必须报成错误，不能报成过滤结果。 */
    const done=list.filter(t=>!t.error);
    const hadPool=done.some(t=>Number(t.raw||0)>0);
    freshInfo.passedNone=!worstPass&&hadPool;
  }
  /* note 优先级：限流 > token 过期 > 偏旧降级 > 单任务失败 > 范围窄解释 */
  if(throttled) freshInfo.note="⚠ 被平台限流（"+(throttle.reason||"请求太频")+"）：已自动放慢扫描。同条件比官方少多半就是这个原因 —— 关闭多余窗口、等几分钟即可自动恢复。";
  else if(tokenWarn) freshInfo.note="⚠ 接口连续 "+(badTask?badTask.failedRounds:"多")+" 轮失败：登录签名 token（_m_h5_tk）大概率已过期。请关闭窗口后运行【0-首次扫码登录.cmd】重新扫码登录。";
  else if(freshInfo.degraded){
    /* 降级原因来自任务级判定（绝对阈值 / 相对历史水平 / unb 缺失），这里把最具体的那条透出来，
       不要只说"偏旧"——用户需要知道是"真的旧"还是"登录掉了"，两种处理方式完全不同。 */
    const dt=list.find(t=>t.degraded)||{};
    freshInfo.degradedWhy=dt.degradedWhy||"";
    freshInfo.note="⚠ 疑似被风控降级："+(dt.degradedWhy||("最新一条 "+dt.newestAgoMinutes+" 分钟前"))
      +"。这多半是登录态掉了，请重跑【0-首次扫码登录.cmd】。";
  }
  /* 【网络类错误分级 2026-11-04】单轮断网排在 badTask 之前，避免红字横幅。
     连续 2 轮以上断网时 netOnly 为 false，会落到下面的 badTask 分支 → 红字 + 走告警。 */
  else if(netOnly) freshInfo.note="网络暂时不通（"+((badTask&&badTask.netText)||"网络异常")+"）：已经记下来了，下一轮自动重试，不用管。";
  else if(badTask&&badTask.shortfall) freshInfo.note="⚠ 服务端自报 "+badTask.shortfall.declared+" 条，本轮只取到 "+badTask.shortfall.got+" 条 —— 疑似被限流少返（不是没货）";
  else if(badTask) freshInfo.note="⚠ 有任务扫描失败："+badTask.name+" — "+badTask.error;
  else if(list.some(t=>t.shortfall)){ const t=list.find(t=>t.shortfall); freshInfo.note="⚠ 服务端自报 "+t.shortfall.declared+" 条，本轮只取到 "+t.shortfall.got+" 条 —— 疑似被限流少返（不是没货）"; }
  else if(worst&&worst.newestAgoMinutes>=300) freshInfo.note="当前筛选范围（"+worst.scope+"）在售量少，最新一条本身就较旧，不是风控降级";
  else freshInfo.note="";
  if(!freshInfo.degraded) freshInfo.degradedWhy="";
  /* sig 必须带上合格品口径，否则「合格品最新」变了但 sig 没变 → changed=false
     → hits.json 不重写 → 面板上的数字永远停在上一轮（和 BUG 里 ETag 含 lastUpdate 同一类坑）。 */
  const sig=JSON.stringify([freshInfo.note,!!freshInfo.netSoft,freshInfo.degraded,freshInfo.tokenAlert,freshInfo.throttled,freshInfo.newestAgoMinutes,
    freshInfo.newestPassedAgoMinutes,
    list.map(t=>[t.name,t.raw,t.newestAgoMinutes,t.newestPassedAgoMinutes,!!t.error,t.failedRounds,!!t.shortfall])]);
  const changed=sig!==__freshSig;
  __freshSig=sig;
  return changed;
}

/* ===== 异常告警推送（2026-10-29）=====
   解决的问题：登录掉了 / 被限流 / 连续多轮接口失败时，程序在面板上挂个横幅就完事，
   手机那头只会表现为「静悄悄」—— 和「今天没货」完全无法区分。用户在外面根本不知道
   程序已经瘫了，白等一天。
   设计要点（都是为了避免变成噪音源）：
   ① 连续 2 轮才报：单轮抖动（偶发一页失败、刚好被限流一次）不打扰。
   ② 同类 30 分钟冷却：真的坏了也别每 4 分钟推一次，同一件事半小时说一次够了。
   ③ 条件消失要清零并回一条「已恢复」：否则下次再坏，因为冷却/状态没清而被吞掉。
   ④ 告警不走命中统计（cfg.__test=true），面板「累计成功 N 次」只反映商品推送。 */
function alertFile(){ return path.join(DATA,"alert-state.json"); }
function alertLoad(){
  try{ const o=readJSON(alertFile(),{}); return (o&&typeof o==="object")?o:{}; }catch(e){ return {}; }
}
function alertSave(o){ try{ writeJSON(alertFile(), o||{}); }catch(e){} }

/* ===== 远程停用公告（2026-11-05）=====
   开发者能通过一个公开 JSON（GitHub raw 的 STATUS.json）远程通知所有用户：
     {"status":"down","title":"…","detail":"…","updatedAt":"…"}   → 自动暂停 + 红条 + 推手机
     {"status":"notice","title":"…","detail":"…"}                 → 只红条提示，不停用
     {"status":"ok"} 或读不到 / 格式错                             → 当正常
   设计要点：① fetch 失败静默当未知，绝不误报；② 按 updatedAt 去重，同一条不重复弹/重复推；
   ③ 只停不自动恢复（恢复后仍保持待命，由用户自己点「开始监控」）；④ 内部时间节流，几小时才查一次。 */
const REMOTE_STATUS_URL=(typeof cfg.remoteStatusUrl==="string"&&cfg.remoteStatusUrl.trim())?cfg.remoteStatusUrl.trim():"";
let remoteStatus=null;      /* {status,title,detail,updatedAt,checkedAt}，null=从未读到有效文件 */
let remoteLastCheck=0;
const REMOTE_CHECK_INTERVAL=3*3600*1000;   /* 3 小时查一次 */
async function checkRemoteStatus(force){
  if(!REMOTE_STATUS_URL) return;
  if(!force && (Date.now()-remoteLastCheck)<REMOTE_CHECK_INTERVAL) return;
  remoteLastCheck=Date.now();
  let js=null;
  try{
    const r=await fetch(REMOTE_STATUS_URL,{signal:AbortSignal.timeout(8000),headers:{"cache-control":"no-cache"}});
    if(r.status!==200) return;
    js=await r.json();
  }catch(e){ return; }   /* 网络/解析失败：当未知，不动现有状态 */
  if(!js||typeof js!=="object") return;
  const st=String(js.status||"").toLowerCase();
  if(st!=="down"&&st!=="notice"&&st!=="ok") return;
  const upd=String(js.updatedAt||"");
  const prev=remoteStatus;
  remoteStatus={status:st,title:String(js.title||""),detail:String(js.detail||""),updatedAt:upd,checkedAt:Date.now()};
  if(st==="down"){
    const isNew=(!prev||prev.status!=="down"||prev.updatedAt!==upd);
    if(isNew){
      log("🚫 远程停用公告："+(remoteStatus.title||"（无标题）")+(remoteStatus.detail?(" —— "+remoteStatus.detail):""));
      holdSet(true,"远程停用");
      try{ await sendAlert("程序已暂停（开发者公告）", (remoteStatus.title?remoteStatus.title+"\n":"")+remoteStatus.detail); }catch(e){}
    } else {
      /* 仍是同一条 down：保持停用即可（用户可能手动点过开始，这里再兜一次） */
      if(!holdOn) holdSet(true,"远程停用");
    }
  } else if(st==="notice"){
    const isNew=(!prev||prev.status!=="notice"||prev.updatedAt!==upd);
    if(isNew) log("📢 远程公告："+(remoteStatus.title||"")+(remoteStatus.detail?(" —— "+remoteStatus.detail):""));
  } else { /* ok */
    if(prev&&prev.status==="down"){
      log("✅ 远程停用公告已解除（开发者恢复为 ok），如需继续扫描请点面板「▶ 开始监控」。");
    }
  }
}
const ALERT_NEED_ROUNDS=2;            /* 连续 2 轮成立才报 */
const ALERT_COOLDOWN_MS=30*60*1000;   /* 同类告警 30 分钟冷却 */

/* 当前成立的异常清单。key 稳定不变，用于冷却与恢复判断。 */
function collectAlerts(){
  const out=[];
  const list=Array.isArray(freshInfo.perTask)?freshInfo.perTask:[];
  if(freshInfo.loginBad){
    out.push({ key:"login", title:"登录已失效",
      body:"闲鱼登录态掉了（"+String(freshInfo.loginWhy||"缺少 sgcookie 或 tfstk")+"）。\n"
        +"平台会按游客返回约 6 小时前的旧数据，所以商品列表会停在某个时间点不动。\n"
        +"处理：面板点【登录 / 换号】重新扫码，或运行【0-首次扫码登录.cmd】。\n"
        +"在此之前抓到的结果都不可信。" });
  }
  if(freshInfo.tokenAlert){
    const bad=list.find(t=>t.error)||null;
    out.push({ key:"token", title:"接口连续失败",
      body:"接口连续 "+(bad?bad.failedRounds:"多")+" 轮失败，大概率是登录签名 token（_m_h5_tk）过期"
        +(bad&&bad.error?("\n最近错误："+String(bad.error).slice(0,120)):"")+"\n"
        +"处理：关掉监控窗口，运行【0-首次扫码登录.cmd】重新扫码。" });
  }
  if(freshInfo.throttled){
    const th=freshInfo.throttle||{};
    out.push({ key:"throttle", title:"被平台限流",
      body:"被闲鱼限流（"+(th.reason||"请求太频")+"），已自动放慢扫描。\n"
        +"表现为同条件下比官网少很多货。\n处理：关掉多余窗口，等几分钟会自动恢复。" });
  }
  /* 【2026-11-04】数据陈旧告警：接口返回的最新一条落后 >=2 小时。
     为什么另起一条：degraded 判据在"窄范围（只看某个市）+ 登录正常"时被刻意豁免
     （深夜小城市没人上新是正常的，报降级会诱导用户重扫，重扫反而更容易被平台盯上）。
     代价是 11/4 那次"6 小时旧货连续跑 13 小时"完全没有提示，全靠用户自己盯面板发现。
     这条不看范围宽窄，只看"最新一条到底多旧"，门槛 120 分钟
     （正常每 5 分钟一轮，120 分钟 = 连续 24 轮都只翻到老货）。
     登录已失效时不重复报 —— login 那条告警已经把原因说清楚了。 */
  const agoMin=Number(freshInfo.newestAgoMinutes);
  if(isFinite(agoMin)&&agoMin>=120&&!freshInfo.loginBad){
    const h=Math.round(agoMin/6)/10;
    out.push({ key:"stale", title:"抓到的是旧数据",
      body:"接口返回的最新一条已经是 "+h+" 小时前发布的（门槛 2 小时，正常应该在几分钟内）。\n"
        +"先看面板顶部登录徽标：不是绿色就点【登录 / 换号】重新扫码。\n"
        +"如果重扫后最新一条还是这么久以前，那就是这个关键词 / 地区本身没有新货，属正常。" });
  }
  const bad=list.filter(t=>t.error&&Number(t.failedRounds||0)>=2);
  if(bad.length&&!freshInfo.tokenAlert){
    out.push({ key:"task:"+bad[0].name, title:"任务扫描失败",
      body:"任务「"+bad[0].name+"」连续 "+bad[0].failedRounds+" 轮失败。\n"
        +"错误："+String(bad[0].error||"").slice(0,160) });
  }
  return out;
}

/* 推一条告警。返回 true 表示确实发出去了。 */
async function sendAlert(title, body){
  const ncfg=notifyLayer.normalizeConfig(cfg.notify||{});
  if(ncfg.enabled===false) return false;
  const on=notifyLayer.buildEnabled(ncfg).filter(t=>t.def.key!=="log");
  if(!on.length) return false;
  const msg={ title:"闲鱼扫货 告警："+title, content:body, url:"", jump:"" };
  ncfg.__test=true;       /* 不污染「累计成功 N 次」的商品推送统计 */
  let anyOk=false;
  try{
    const rs=await notifyLayer.send(msg, ncfg);
    anyOk=rs.some(r=>r.channel!=="log"&&r.ok);
  }catch(e){
    log("⚠ 告警推送异常: "+String(e&&e.message||e).slice(0,160));
    return false;
  }
  log((anyOk?"   📣 已推送告警：":"   ⚠ 告警推送失败：")+title);
  return anyOk;
}

async function checkAlerts(){
  if(!Array.isArray(freshInfo.perTask)||!freshInfo.perTask.length) return;
  const now=Date.now();
  const st=alertLoad();
  const active=collectAlerts();
  const activeKey={};
  let dirty=false;
  for(const a of active){
    activeKey[a.key]=1;
    const rec=st[a.key]||{ rounds:0, since:0, lastAt:0 };
    rec.rounds=Number(rec.rounds||0)+1;
    if(!rec.since) rec.since=now;
    st[a.key]=rec;
    dirty=true;
    if(rec.rounds<ALERT_NEED_ROUNDS) continue;                 /* 单轮抖动不报 */
    if(now-Number(rec.lastAt||0)<ALERT_COOLDOWN_MS) continue;  /* 冷却中 */
    if(await sendAlert(a.title, a.body+("\n\n[连续 "+rec.rounds+" 轮]"))){
      rec.lastAt=now;
      /* 报过就不再累计轮数，避免日志/正文里的数字无限涨 */
      rec.rounds=ALERT_NEED_ROUNDS;
    }
  }
  /* 条件消失：清状态；如果之前确实报过，回一条「已恢复」，让用户知道警报解除 */
  for(const k of Object.keys(st)){
    if(activeKey[k]) continue;
    const rec=st[k];
    delete st[k];
    dirty=true;
    if(rec&&Number(rec.lastAt||0)>0){
      try{ await sendAlert("已恢复", "之前报告的「"+k+"」异常已解除，扫描恢复正常。"); }catch(e){}
    }
  }
  if(dirty) alertSave(st);
}

/* ===== 反向代理 + 注入 + 配置接口 ===== */
/* 用 regions.json 数据填充 CATALOG */
(function initCatalog(){
  if(!Array.isArray(REGIONS)||!REGIONS.length) return;
  CATALOG.regionGroups=REGIONS;
  const names=[];
  REGIONS.forEach(function(g){ (g.list||[]).forEach(function(p){ names.push(p.p); }); });
  CATALOG.provinces=names;
  let c=0,a=0; REGIONS.forEach(function(g){ (g.list||[]).forEach(function(p){ c+=(p.c||[]).length; (p.c||[]).forEach(function(x){ a+=(x.a||[]).length; }); }); });
  log("地区数据已加载: "+names.length+" 省 / "+c+" 市 / "+a+" 区县");
})();

/* injectIntoHtml() 已删除（v2026-10-20 独立化）：
   它当年只干一件事 —— 把 <script src="/__scan/inject.js"> 塞进宿主程序返回的 HTML 里。
   现在根路径直接吐自己的 panel\index.html，页面里已经写好了 script 标签，不再需要注入。 */
function readBody(req){return new Promise(res=>{const c=[];req.on("data",d=>c.push(d));req.on("end",()=>res(Buffer.concat(c).toString("utf8")));});}

/* 【修 BUG-Q：端口冲突时误杀自己的浏览器】
   启动序列原来是 `startProxy(); await ensurePage();` —— listen 是异步的，
   所以第二个实例会在"端口已被占用"这件事被判定之前，就先把 chromium 拉起来了。
   随后 EADDRINUSE 分支 `process.exit(2)` 把这个刚起来的 chromium(以及共享的
   data\browser-profile 配置锁) 一起带走，日志里表现为
     `预热失败(稍后重试): browserType.launchPersistentContext: Target page, context or browser has been closed`
     `→ 取数浏览器已断开`
   而用户其实是双击了第二次图标 —— 他什么都没做错，只是被自己的第二个实例打断了。

   现在 startProxy 返回 Promise<boolean>：true = 端口就绪可以继续开浏览器；
   false = 已经有实例在跑，本实例连浏览器都不要碰，直接等退出。 */
function startProxy(){
  const port=cfg.port||59288;
  return new Promise(function(resolvePort){
    const srv=http.createServer(async(req,res)=>{
    const u=req.url||"/";
    if(u.startsWith("/__scan/inject.js")){
      let b="/*missing*/"; try{b=fs.readFileSync(INJECT,"utf8")}catch(e){}
      res.writeHead(200,{"content-type":"application/javascript; charset=utf-8","cache-control":"no-store"}); return res.end(b);
    }
    /* 网页图标：/favicon.ico、/__scan/favicon.ico 走 favicon.ico；/icon.png 走 icon-web.png（192×192）。
       浏览器默认去根路径要 /favicon.ico（取不到就是白纸标签），
       Chrome/Edge 更认 png，index.html 里两种都声明了，所以这里两种都得能取。
       缓存给 1 天：图标不会天天换，没必要每次刷新都重新拉。 */
    if(u==="/favicon.ico"||u.startsWith("/favicon.ico?")||u.startsWith("/__scan/favicon")||u==="/icon.png"||u.startsWith("/icon.png?")){
      const isPng=(u.indexOf(".png")>0);
      const fp=isPng?ICONPNG:FAVICON;
      let b=null; try{ b=fs.readFileSync(fp); }catch(e){}
      if(!b){ res.writeHead(404,{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}); return res.end("no icon"); }
      res.writeHead(200,{"content-type":(isPng?"image/png":"image/x-icon"),"content-length":b.length,"cache-control":"public, max-age=86400"});
      return res.end(b);
    }
    if(u.startsWith("/__scan/catalog")){
      res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
      return res.end(JSON.stringify(CATALOG));
    }
    if(u.startsWith("/__scan/filtertree")){
      /* 【cpvFilters 动态筛选 2026-11-04】按关键词返回官方筛选项。
         有缓存直接给；没有就做一次单页只读搜索拿 tabList（callSearch 不写 hits/seen/word-hits、不推送）。
         面板只在关键词变化或手动点「拉取」时调，零额外常驻请求。 */
      try{
        filterTreeLoad();
        const dq=new URLSearchParams((u.split("?")[1]||""));
        const kw=String(dq.get("keyword")||"").trim();
        const key=kw.toLowerCase();
        if(!kw){
          res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
          return res.end(JSON.stringify({ok:true,keyword:"",groups:[],fromCache:true}));
        }
        if(filterTreeCache[key]){
          res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
          return res.end(JSON.stringify({ok:true,keyword:kw,groups:filterTreeCache[key],fromCache:true,holdOnce:!!holdOn}));
        }
        /* 【筛选项缓存只读 2026-11-04】cacheOnly=1 时只回缓存，绝不触网。
           用途：面板刷新后要把「已保存的筛选项」重新画出来 —— 这时候不该为了一次渲染
           就去打一页搜索。没有缓存就老实回空，让用户自己点「拉取筛选项」。 */
        if(String(dq.get("cacheOnly")||"")==="1"){
          res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
          return res.end(JSON.stringify({ok:true,keyword:kw,cacheOnly:true,groups:[],fromCache:false,msg:"缓存里还没有这个词的筛选项"}));
        }
        const base=(cfg.tasks||[]).find(function(t){return t.enabled!==false;})||(cfg.tasks||[])[0]||{keyword:""};
        const task=Object.assign({},base,{keyword:kw});
        /* 【待命期拉筛选项 2026-11-05 修正】
           11-04 这里原本是「待命中且无缓存 → 直接拒绝」，想法是守住「待命不动网」。
           但真实工作流是「先配好筛选条件 → 再点开始监控」，而配条件时关键词往往是新词、
           缓存里没有 ⇒ 用户永远拉不到筛选项，等于把配置流程卡死。这是守过头了。
           现在的做法：待命期间也放行，但明确限定为「一次性」——
           每调一次只发 1 个 request（下面是 callSearch(task,1)），拿完 tabList 立刻返回，
           不进扫描循环、不写 hits/seen/word-hits、不推送。
           为了不让人误以为已经开始扫了，日志单独记一行，返回里带 holdOnce 标记。 */
        const holdOnce=!!holdOn;
        if(holdOnce){
          log("[筛选项] 待命期一次性拉取（关键词："+kw+"）—— 只发 1 个请求，不进扫描循环");
        }
        await callSearch(task,1);
        const groups=filterTreeCache[key]||[];
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify({ok:true,keyword:kw,groups:groups,fromCache:false,holdOnce:holdOnce}));
      }catch(e){
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify({ok:false,error:String(e.message||e),groups:[]}));
      }
    }
    if(u.startsWith("/__scan/filtercache")){
      /* 【筛选项缓存快照 2026-11-04】一次把所有已缓存的官方筛选项给面板。
         面板刷新后用它把「已保存但界面上看不见」的筛选项重新画出来，避免用户
         以为筛选项丢了、或者顺手点保存把它们清空。只读，零请求。 */
      filterTreeLoad();
      res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
      const out={};
      Object.keys(filterTreeCache).forEach(function(k){ out[k]=filterTreeCache[k]; });
      return res.end(JSON.stringify({ok:true,count:Object.keys(out).length,trees:out}));
    }

    if(u.startsWith("/__scan/wordstats")){
      /* 屏蔽词命中统计：{"标题|壳":{count,lastAt}, "内容|进水":{...}} */
      res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
      return res.end(JSON.stringify({ok:true,stats:wordHits}));
    }
    /* ===== 推送自检：POST /__scan/notifytest =====
       面板上每个渠道后面有个「测试」按钮。不发真货，发一条样例消息，
       返回每个渠道的真实成败与错误原文。
       为什么不走 notify()：notify() 会顺手更新价格记忆、标已通知分数，
       测试消息污染了真实数据，以后真降价会被当成"已经推过"而静默掉。 */
    if(u.startsWith("/__scan/notifytest")){
      try{
        const body=await readBody(req);
        const q=body?JSON.parse(body):{};
        /* 支持只测单个渠道（chan），也支持测全部已启用渠道 */
        const probe={ enabled:true, channels:{} };        const cur=notifyLayer.normalizeConfig(cfg.notify||{});
        const wanted=q.chan?String(q.chan):null;
        Object.keys(cur.channels).forEach(function(k){
          if(wanted&&k!==wanted) return;
          probe.channels[k]=Object.assign({}, cur.channels[k], { enabled: (k==="log")?false:true });
        });
        if(wanted&&!probe.channels[wanted]){
          res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
          return res.end(JSON.stringify({ok:false,msg:"未知渠道: "+wanted}));
        }
        const ncfg=notifyLayer.normalizeConfig(probe);
        /* __test 标记：notify.cjs 里 sendOne 见到它就不计"累计成功/失败"。
           否则用户每点一次测试，面板统计就 +1，会误以为真实推送早就通了。 */
        ncfg.__test=true;
        const msg=notifyLayer.buildMessage([{
          itemId:"TEST-0",
          priceText:"¥1234",
          title:"这是一条测试消息，收到说明推送配置正确",
          area:"测试地区",
          seller:"测试卖家",
          sellerRate:"99%",
          publishAt:new Date().toLocaleString("zh-CN"),
          url:"https://www.goofish.com/"
        }], { head:"闲鱼扫货 推送测试" });
        const results=await notifyLayer.send(msg, ncfg);
        const real=results.filter(function(r){ return r.channel!=="log"; });
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify({
          ok: real.length?real.every(function(r){ return r.ok; }):false,
          empty: real.length===0,
          msg: real.length? null : "没有启用任何渠道：先在下面勾上渠道并填好地址/密钥，保存后再测",
          results: results.map(function(r){ return {channel:r.channel, ok:r.ok, sent:r.sent, failed:r.failed, errors:(r.errors||[]).map(function(e){ return String(e).slice(0,200); })}; })
        }));
      }catch(e){
        res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:false,msg:"测试失败: "+String(e.message||e).slice(0,200)}));
      }
    }
    /* ===== 推送判定演练：POST /__scan/notifydry =====
       用途：不等真的抓到货，先验证"降价重推 / 分数抑制"整条链是否符合预期。
       body {price, prevPrice?} 可以只发一次，也可以连续发几次看判定变化。
       为什么需要这个：降价重推要靠 price-memory 的历史价，用户不可能为了测试
       去等某个商品真降价；以前只能读日志猜。这里用 dryRun 走真实的
       observe → satisfaction → shouldNotify，但**不落盘、不真发**。 */
    if(u.startsWith("/__scan/notifydry")){
      try{
        const body=await readBody(req);
        const q=body?JSON.parse(body):{};
        const ncfg=notifyLayer.normalizeConfig(cfg.notify||{});
        const task=(cfg.tasks||[]).find(function(t){ return String(t.name)===String(q.task); })||(cfg.tasks||[])[0]||{};
        const sample={
          itemId:String(q.itemId||"DRYRUN-1"),
          title:String(q.title||"演练用商品"),
          price:Number(q.price)||1000,
          priceText:"¥"+(Number(q.price)||1000),
          sellerRate:String(q.sellerRate||"99%"),
          sellerDeals:Number(q.sellerDeals)||120,
          ageMinutes:Number(q.ageMinutes!=null?q.ageMinutes:120),
          area:String(q.area||"演练地区"),
          url:"https://www.goofish.com/"
        };
        /* dryRun 版 observe：只算不写。price-memory 没有 dryRun 参数，
           所以这里自己复刻判定逻辑，避免污染真实价格记忆。 */
        const pm=priceMemory.get(sample.itemId);
        const prev=pm?Number(pm.last):null;
        const first=pm?Number(pm.first):null;
        const dropPct=(prev!=null&&prev>0&&sample.price<prev)?((prev-sample.price)/prev):0;
        const isNew=!pm;
        const score=priceMemory.satisfaction(sample, task, {
          freshMaxAgeHours: cfg.freshMaxAgeHours,
          dropPct: dropPct
        });
        const isRenotify=!isNew&&prev!=null&&sample.price<prev;
        const dropEnough=dropPct>=ncfg.priceDropPct;
        const ren=isRenotify&&(dropEnough||ncfg.priceDropNotify===false);
        const verdict=notifyLayer.shouldNotify(
          Object.assign({}, sample, {__isRenotify:ren}),
          score,
          {onlyIncreaseRenotify: ncfg.onlyIncreaseRenotify}
        );
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify({
          ok:true,
          memory: pm ? {first:first, last:prev, low:Number(pm.low), notifiedScore:pm.notifiedScore} : null,
          input: {price:sample.price, sellerRate:sample.sellerRate, ageMinutes:sample.ageMinutes, task:String(q.task||task.name||"")},
          computed: {
            isNew:isNew,
            prevPrice:prev,
            dropPct:Number((dropPct*100).toFixed(2)),
            dropThreshold:Number((ncfg.priceDropPct*100).toFixed(2)),
            dropEnough:dropEnough,
            isRenotify:ren,
            satisfaction:Number(score.toFixed(1)),
            verdict:verdict
          },
          note:"dry-run：只读价格记忆、不写入、不发送。想造历史价请先让它真抓一轮。"
        }));
      }catch(e){
        res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:false,msg:"演练失败: "+String(e.message||e).slice(0,200)}));
      }
    }
    /* ===== 推送历史：GET /__scan/notifyhist =====
       读 data/notify-history.jsonl 的最后 N 条，让用户能看到"哪条发了、哪条失败了、为什么"。 */
    if(u.startsWith("/__scan/notifyhist")){
      try{
        const lines=[];
        try{
          const txt=fs.readFileSync(notifyLayer.paths.HISTF,"utf8");
          const arr=txt.split(/\r?\n/).filter(Boolean);
          arr.slice(-200).forEach(function(s){ try{ lines.push(JSON.parse(s)); }catch(e){} });
        }catch(e){}
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify({ok:true,stats:notifyLayer.getStats(),priceMemoryCount:priceMemory.count(),items:lines.reverse()}));
      }catch(e){
        res.writeHead(500,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:false,error:String(e.message).slice(0,200)}));
      }
    }
    /* ===== 自动商贩屏蔽：查询候选 / 加入名单 / 移出名单 =====
       名单单独存 data\seller-blocklist.json（键是 seller_id），
       不动 sellerBlockWords、不动 sigOfTask → 屏蔽当场生效，不清库、不重翻基线。 */
    if(u.startsWith("/__scan/sellerblock")){
      if(req.method==="GET"){
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify({ok:true,on:!!cfg.autoBlockSellers,min:Math.max(2,Number(cfg.autoBlockMinCount||5)),
          days:Math.max(1,Number(cfg.autoBlockWindowDays||7)),byName:cfg.autoBlockByName!==false,byDeals:!!cfg.autoBlockByDeals,
          byShop:cfg.autoBlockByShop!==false,minItems:Math.max(1,Number(cfg.autoBlockMinItems||40)),shopProbed:Object.keys(sellerProfiles).length,
          blocked:Object.keys(sellerBlocklist).map(function(k){ const e=sellerBlocklist[k]; return {sellerId:k,name:e.name||"",rate:e.rate||"",deals:e.deals||0,at:e.at}; }),
          suspects:(freshInfo.sellerSuspects||[]).map(function(s){ return {sellerId:s.sellerId,name:s.name,count:s.count,rate:s.rate,deals:s.deals,newest:s.newest,blocked:!!s.blocked,why:s.why||"",
            shopItems:s.shopItems,shopIntro:s.shopIntro||"",shopLvl:s.shopLvl||"",shopBq:s.shopBq||""}; })}));
      }
      try{
        const body=await readBody(req);
        const q=body?JSON.parse(body):{};
        if(Array.isArray(q.block)&&q.block.length){
          /* 支持三种提交：{sellerId,name,...}（来自 suspects）、纯字符串 sellerId、卡片按钮的 nick: 兜底键 */
          const src=(freshInfo.sellerSuspects||[]);
          const pick=q.block.map(function(x){
            if(typeof x==="string") return x;
            const f=src.find(function(s){ return s.sellerId===x.sellerId; });
            return f||{sellerId:x.sellerId,name:x.name||"",rate:x.rate||"",deals:x.deals||0};
          });
          sellerBlockAdd(pick);
          /* 已入库的历史记录当场按名单撤掉，但**先存进名单条目里**（hidden 数组）——
             这样解除屏蔽时能把货原样放回列表，用户说"有些也是好的商贩"，
             一撤就永久消失的话，解屏等于白解。 */
          let dropped=0;
          const keep=[];
          hits.forEach(function(h){
            const bl=sellerBlocked(h);
            if(bl){
              dropped++;
              if(!Array.isArray(bl.hidden)) bl.hidden=[];
              bl.hidden.push(h);
              return;
            }
            keep.push(h);
          });
          hits=keep;
          if(dropped) log("🚫 卖家屏蔽名单生效：撤掉 "+dropped+" 条历史记录（已存入名单，解除屏蔽可原样恢复）");
          writeJSON(HITSF,hits); sellerBlockSave();
          res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
          return res.end(JSON.stringify({ok:true,added:q.block.length,dropped:dropped}));
        }
        if(Array.isArray(q.unblock)&&q.unblock.length){
          /* 解除屏蔽：把当初存在名单条目 hidden 里的记录放回列表。
             必须先读 hidden 再删键（sellerBlockDel 会 delete 整个条目）。 */
          const back=[];
          q.unblock.forEach(function(id){
            const e=sellerBlocklist[id];
            if(!e) return;
            (e.hidden||[]).forEach(function(h){ back.push(h); });
          });
          sellerBlockDel(q.unblock);
          let restored=0, keptBack=0;
          if(back.length){
            const have={}; hits.forEach(function(h){ have[h.itemId]=1; });
            const add=[];
            back.forEach(function(h){
              if(!h||!h.itemId||have[h.itemId]) return;
              have[h.itemId]=1; add.push(h);
            });
            /* 以前是 hits=hits.concat(add).slice(0,3000); restored=add.length;
               两个问题：① slice 会把超出 3000 的记录直接丢掉，永久消失；
               ② restored 报的是 add.length 而不是真正落库的条数，面板说"恢复 800"
               实际只回 500，另 300 条静默没了。
               现在：先算还剩多少位置，只放能放下的，放不下的原样留在名单的 hidden 里
               等下次解屏（或记录被清理出空间）再放；restored 报真实条数。 */
            const room=Math.max(0,3000-hits.length);
            if(add.length<=room){
              hits=hits.concat(add);
              restored=add.length;
            }else{
              const take=add.slice(0,room);
              const left=add.slice(room);
              hits=hits.concat(take);
              restored=take.length;
              keptBack=left.length;
              /* 放不下的按卖家塞回各自条目的 hidden，保证下次解屏还能捞回来 */
              const byId={};
              q.unblock.forEach(function(id){ const e=sellerBlocklist[id]; if(e) byId[id]=e; });
              left.forEach(function(h){
                const sid=h.sellerId;
                let owner=byId[sid];
                if(!owner){
                  for(const id in byId){ if(byId[id].name===h.seller){ owner=byId[id]; break; } }
                }
                if(owner){ if(!Array.isArray(owner.hidden)) owner.hidden=[]; owner.hidden.push(h); }
              });
              log("解除屏蔽：列表已满（上限 3000），本次放回 "+restored+" 条，"+keptBack+" 条留在名单里下次再放");
            }
          }
          sellerBlockSave();
          if(restored) log("✅ 解除屏蔽：恢复 "+restored+" 条历史记录回列表");
          writeJSON(HITSF,hits);
          res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
          return res.end(JSON.stringify({ok:true,removed:q.unblock.length,restored:restored,keptBack:keptBack}));
        }
        res.writeHead(400,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:false,error:"缺 block 或 unblock 数组"}));
      }catch(e){
        res.writeHead(400,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:false,error:e.message}));
      }
    }
    /* ===== 卖家主页预览（面板「看主页」按钮）=====
       给「怕误判屏蔽」用的：第三路信号只看数字（主页 75 件在售），
       看不到这个号到底在卖什么。这里把真主页拍成整页长图，用户自己一眼判断。
       返回 JSON（该卖家在本程序里的商品清单 + 主页统计），前端拼卡片墙显示。 */
    if(u.startsWith("/__scan/sellerpage")){
      const qs=(u.split("?")[1]||"");
      const mm=/[?&]sid=([^&]*)/.exec("?"+qs);
      const mn=/[?&]name=([^&]*)/.exec("?"+qs);
      let sid="", nm="";
      try{ sid=decodeURIComponent(mm?mm[1]:""); }catch(e){ sid=mm?mm[1]:""; }
      try{ nm=decodeURIComponent(mn?mn[1]:""); }catch(e){ nm=mn?mn[1]:""; }
      if(!sid&&!nm){
        res.writeHead(400,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify({ok:false,error:"缺少 sid 或 name 参数"}));
      }
      try{
        const r=sellerPreviewOf(sid,nm);
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify(r));
      }catch(e){
        log("卖家主页预览失败: "+String(e&&e.message).slice(0,120));
        res.writeHead(500,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify({ok:false,error:String(e&&e.message||e).slice(0,180)}));
      }
    }
    if(u.startsWith("/__scan/config")){
      if(req.method==="POST"){
        try{
          const body=await readBody(req);
          const n=JSON.parse(body);
          if(Array.isArray(n.tasks)){
            /* 只要"筛选条件"整体变了（关键词/价格/地区/排序/发布时间/标签/品牌…）就清掉该任务的旧记录，
               否则会出现"面板里混着上一个条件收进来的货"——看着就像"和官网差得离谱"。
               清完立刻重建基线，避免刚清掉的那批已进 seen、面板反而变空。 */
            /* 签名必须只有一个来源：直接复用 sigOfTask()。
               以前这里内联了一份，和 sigOfTask 各写一遍，改一处漏一处就会
               出现"面板以为条件没变、主循环以为条件变了"的分裂判断。 */
            const SIGF=t=>sigOfTask(t);
            /* 签名必须只有一个来源：直接复用 sigOfTask()。
               以前这里内联了一份，和 sigOfTask 各写一遍，改一处漏一处就会
               出现"面板以为条件没变、主循环以为条件变了"的分裂判断。 */
            /* 【修 BUG-A 第二轮：根因不是"没补默认值"，而是"缺字段被当成改条件"】
               第一版只给缺字段补默认值(normTask)，但补出来的默认值和旧配置里
               用户真实设置的值不同（旧任务 maxPrice=500、storages=[256,512]），
               所以「只提交了 name/keyword/province/city/sort/enabled 六个字段」
               依然被判成条件变更，实测 340 条命中照样被清成 []。
               正确语义是【部分更新】：按 name 对齐旧任务，提交里没出现的键保留旧值，
               只有"明确提交且值真的不同"的键才算条件变更。
               另外把清库改成要令牌：面板提交带 confirmClear:"REBUILD"，
               非面板来源（curl / 脚本 / 别的网页 CSRF）不带令牌就只改配置、不动数据。
               两道闸一起上：漏字段不再误判，误判了也删不掉。 */
            const normTask=function(t){
              t=t||{};
              return {
                name:t.name!=null?String(t.name):"",
                keyword:t.keyword!=null?String(t.keyword):"",
                minPrice:(t.minPrice==null||t.minPrice==="")?null:Number(t.minPrice),
                maxPrice:(t.maxPrice==null||t.maxPrice==="")?null:Number(t.maxPrice),
                province:t.province||"",
                city:t.city||"",
                area:t.area||"",
                sort:t.sort||"default",
                priceSort:t.priceSort||"",
                quickFilters:Array.isArray(t.quickFilters)?t.quickFilters:[],
                brands:Array.isArray(t.brands)?t.brands:[],
                versions:Array.isArray(t.versions)?t.versions:[],
                storages:Array.isArray(t.storages)?t.storages.map(Number).filter(function(x){ return isFinite(x); }):[],
                mustContain:Array.isArray(t.mustContain)?t.mustContain:[],
                excludeWords:Array.isArray(t.excludeWords)?t.excludeWords:[],
                descExcludeWords:Array.isArray(t.descExcludeWords)?t.descExcludeWords:[],
                sellerBlockWords:Array.isArray(t.sellerBlockWords)?t.sellerBlockWords:[],
                /* cpvFilters：官方筛选项 {pid:[vid,...]}，服务端属性筛选用 */
                cpvFilters:(t.cpvFilters&&typeof t.cpvFilters==="object"&&!Array.isArray(t.cpvFilters))?t.cpvFilters:{},
                /* 品类：只用两个值，别的（含老配置里的 undefined）一律按 phone 走老逻辑 */
                category:(String(t.category||"")==="generic"?"generic":"phone"),
                /* 下面四个不进签名，但必须原样留住，否则 cfg.tasks 被新数组覆盖后会丢配置
                   （尤其 enabled:false 会变成 undefined → 任务被当成启用）。 */
                publishDays:(t.publishDays==null?0:(Number(t.publishDays)||0)),
                credit:t.credit||"",
                rowsPerPage:Math.max(5,Math.min(30,Number(t.rowsPerPage)||30)),
                enabled:t.enabled!==false
              };
            };
            const oldByName={};
            (cfg.tasks||[]).forEach(function(t){ if(t&&t.name!=null) oldByName[String(t.name)]=t; });
            /* 部分更新：提交里的键覆盖旧值，没提交的键沿用旧值。 */
            const mergeTask=function(raw){
              const r=(raw&&typeof raw==="object")?raw:{};
              const key=String(r.name!=null?r.name:"");
              const base=oldByName[key]||{};
              return normTask(Object.assign({},base,r));
            };
            const newTasks=n.tasks.map(mergeTask);
            /* 清库令牌：面板的"保存并生效"会带；其余来源带不出来。 */
            const doingClear=(n.confirmClear==="REBUILD");
            let cleared=0;
            let changedN=0;
            const keep=[];
            hits.forEach(function(h){
              const oldT=oldByName[String(h.task)];
              const nw=newTasks.find(function(t){ return t.name===h.task; });
              if(!nw){
                /* 任务被删掉/改名：记录属于已经不存在的条件 */
                changedN++;
                if(doingClear){ cleared++; return; }
                keep.push(h); return;
              }
              if(oldT){
                let oldSig;
                try{ oldSig=SIGF(normTask(oldT)); }catch(e){ oldSig=SIGF(oldT); }
                if(oldSig!==SIGF(nw)){
                  /* 条件真的变了（关键词/价格/地区/排序/标签/屏蔽词） */
                  changedN++;
                  if(doingClear){ cleared++; return; }
                  keep.push(h); return;
                }
              }
              /* 旧配置里找不到同名任务（老数据/手工改过 config.json）→ 没法比，按"没变"处理 */
              keep.push(h);
            });
            if(cleared){
              /* 清库前留一份快照：万一还是判错了，能手工捞回来 */
              try{ if(fs.existsSync(HITSF)) fs.copyFileSync(HITSF,path.join(DATA,"hits.before-clear-"+Date.now()+".json")); }catch(e){}
              hits=keep; writeJSON(HITSF,hits); log("条件已变更，清掉 "+cleared+" 条旧命中记录");
              /* 【优化#1】名单 hidden 里的也一起清 —— 否则下次解屏会把旧条件的货（含外省货）全回灌 */
              const hc1=sellerBlockClearHidden();
              if(hc1.sellers) log("   同步清掉屏蔽名单里囤的 "+hc1.items+" 条旧记录（"+hc1.sellers+" 个卖家）");
            } else if(changedN){
              /* 条件变了但没带令牌：只改配置，不动数据，把这件事记进日志让用户能看到。 */
              log("⚠ 条件变更未清库：缺 confirmClear 令牌，"+changedN+" 条旧记录保留（面板保存会自动带令牌）");
            }
            cfg.tasks=newTasks;
            if(cleared){ setTimeout(function(){ rebaselineNow("条件变更后重建基线").catch(function(e){ log("重建基线失败: "+e.message); }); },600); }
          }
          /* 只 merge 这几个顶层键。面板「保存并生效」只会提交它认识的字段，
             没列进来的键一律保留原值 —— 所以想把某个键做成界面可调，必须加在这里。
             autoBlock* 是商贩自动识别的参数：不在这里的话，面板改了也存不下来。
             注意它们都不进 sigOfTask，所以调整阈值不会触发清库 + 重翻 50 页。
             autoBlockByName = 信号 C（昵称像商家），默认开；
             autoBlockByDeals / autoBlockMinDeals = 信号 B（评价数），默认关；
             autoBlockByShop / autoBlockMinItems = 信号 D（卖家主页在售件数/简介），默认开。 */
          ["intervalSeconds","jitterSeconds","notify","publishTimeOffsetHours","seedMaxAgeHours","startMode",
           /* 这三个是「命中覆盖面」的新参数，都不进 sigOfTask，所以调整它们不会清库、不会重翻 50 页：
              incrementalPages   = 常规轮翻几页（默认 3）
              freshMaxAgeHours   = 新命中的发布时效闸门（默认 24 小时，0=关闭）
              placeholderPriceMax= 占位价阈值（默认 10 元，0=关闭） */
           /* maxDescPerPush = 每次推送最多现读几次商品详情（缓存命中不计数，默认 8）。
              它只影响推送阶段，不进 sigOfTask，所以调整它不会清库、不会重翻页。 */
           "incrementalPages","freshMaxAgeHours","placeholderPriceMax","storageStrict",
            "maxDescPerPush",
            "catchupMinGapHours","catchupMaxPages","catchupSilent","catchupPageGapMs","catchupMaxGapHours",
            /* 重启第一轮闸门（条数上限/积压时效）：只影响推送阶段，不进 sigOfTask，改它不会清库 */
            "bootPushMaxAgeHours","bootPushMaxCount","resumeMinGapSec",
           /* 【2026-11-04 补】这 7 个原来只能手动改 config.json，面板完全没有入口。
              其中 deep* 四个是「限流节奏」——用户 11/3 被挤爆就是因为 deepPagesPerRound=10
              而面板改不了、也没提示。现在全部可改：
                deepSweep         = 是否启用全量基线（关掉只扫新上架，不往回翻历史）
                deepPagesPerRound = 基线每轮翻几页（代码钳 1~20，面板钳 1~10）
                deepPageGapMs     = 基线页间隔毫秒（代码钳 >=1200）
                deepMaxPages      = 基线总页数（代码硬钳 50）
              这三个都不进 sigOfTask，改完只影响下一轮，不会清库、不会重翻：
                autoOpen          = 启动时自动打开面板页面
                maxDescPerRound   = 每轮最多抓几条简介（控制额外请求量）
                showExistingOnFirstRun = 首次/改条件时是否把当前在售全推一遍（高风险，面板有二次确认） */
           "deepSweep","deepPagesPerRound","deepPageGapMs","deepMaxPages",
           "autoOpen","maxDescPerRound","showExistingOnFirstRun",
           "autoBlockSellers","autoBlockMinCount","autoBlockWindowDays",
           "autoBlockByName","autoBlockByDeals","autoBlockMinDeals",
           "autoBlockByShop","autoBlockMinItems","autoBlockMaxProbePerRound",
            "remoteStatusUrl"].forEach(k=>{
             /* notify 单独处理：面板不回显明文凭据，直接赋值会把已填的 key 覆盖成空。
                见 mergeNotifyConfig 的注释。 */
             if(k==="notify"){ if(n.notify!==undefined) cfg.notify=mergeNotifyConfig(n.notify, cfg.notify); return; }
             if(n[k]!==undefined) cfg[k]=n[k];
           });
          writeJSON(CFGF,cfg);
          /* 商贩识别的参数（阈值/窗口/昵称/评价数）本来只影响"下一轮"的候选计算，
             但用户点了"保存并生效"后如果面板上候选没变，会以为设置没生效。
             这里立刻重算一次，让勾选框当场反映结果。 */
          updateSellerSuspects();
          cfg.startMode=(String(cfg.startMode||"")==="auto")?"auto":"hold";
          log("筛选条件已更新（"+cfg.tasks.length+" 个任务）");
          res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
          return res.end(JSON.stringify({ok:true,tasks:cfg.tasks}));
        }catch(e){
          res.writeHead(400,{"content-type":"application/json; charset=utf-8"});
          return res.end(JSON.stringify({ok:false,error:e.message}));
        }
      }
      res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
      /* GET 必须一起返回 autoBlock 全部键，否则面板重进筛选页时读不到当前值，
         会一直显示旧的默认值 —— 改了也看不出改没改。
         另外把卖家名单条数一起带上，面板可以据此显示"已屏蔽 N 个"。 */
      return res.end(JSON.stringify({
        tasks:cfg.tasks,
        intervalSeconds:cfg.intervalSeconds,
        /* 启动待命：面板要能读到当前值，并据此渲染「▶ 开始监控 / ⏸ 暂停扫描」 */
        startMode:(String(cfg.startMode||"" )==="auto")?"auto":"hold",
        /* 连点保护间隔（秒）：面板/调试要能读到当前值 */
        resumeMinGapSec:Number(cfg.resumeMinGapSec!=null?cfg.resumeMinGapSec:180),
        publishTimeOffsetHours:cfg.publishTimeOffsetHours,
        /* 基线补货时效闸门（小时）：面板要能读到当前值，否则改了看不出有没有生效 */
        seedMaxAgeHours:Number(cfg.seedMaxAgeHours==null?24:cfg.seedMaxAgeHours),
        /* 命中覆盖面的三个新参数：同样必须回传，否则面板重进筛选页读不到、改了看不出生效 */
        incrementalPages:Math.max(1,Math.min(10,Number(cfg.incrementalPages)||3)),
        freshMaxAgeHours:Number(cfg.freshMaxAgeHours==null?24:cfg.freshMaxAgeHours),
        placeholderPriceMax:Number(cfg.placeholderPriceMax==null?10:cfg.placeholderPriceMax),
        /* 容量严格模式：false=标题/标签都没写容量时放行（默认），true=看不出就丢 */
        storageStrict:!!cfg.storageStrict,
        catchupMinGapHours:Number(cfg.catchupMinGapHours==null?2:cfg.catchupMinGapHours),
        catchupMaxPages:Math.max(2,Math.min(30,Number(cfg.catchupMaxPages)||4)),
        catchupSilent:cfg.catchupSilent!==false,
        catchupPageGapMs:Math.max(1500,Math.min(15000,Number(cfg.catchupPageGapMs)||3500)),
        catchupMaxGapHours:Math.max(0,Math.min(720,Number(cfg.catchupMaxGapHours==null?24:cfg.catchupMaxGapHours))),
        bootPushMaxAgeHours:Math.max(0,Number(cfg.bootPushMaxAgeHours==null?2:cfg.bootPushMaxAgeHours)),
        bootPushMaxCount:Math.max(0,Math.min(50,Number(cfg.bootPushMaxCount==null?15:cfg.bootPushMaxCount))),
        autoBlockSellers:cfg.autoBlockSellers!==false,
        autoBlockMinCount:Math.max(2,Number(cfg.autoBlockMinCount||5)),
        autoBlockWindowDays:Math.max(1,Number(cfg.autoBlockWindowDays||7)),
        autoBlockByName:cfg.autoBlockByName!==false,
        autoBlockByDeals:!!cfg.autoBlockByDeals,
        autoBlockMinDeals:Math.max(1,Number(cfg.autoBlockMinDeals||100)),
        autoBlockByShop:cfg.autoBlockByShop!==false,
        autoBlockMinItems:Math.max(1,Number(cfg.autoBlockMinItems||40)),
        autoBlockMaxProbePerRound:Math.max(0,Math.min(40,Number(cfg.autoBlockMaxProbePerRound!=null?cfg.autoBlockMaxProbePerRound:15))),
        /* 【2026-11-04 补】这 7 个键原来 GET 不回传，面板就算加了控件也读不到当前值，
           重进筛选页会一直显示默认值 —— 改了也看不出改没改。 */
        deepSweep:cfg.deepSweep!==false,
        deepPagesPerRound:Math.max(1,Math.min(20,Number(cfg.deepPagesPerRound)||3)),
        deepPageGapMs:Math.max(1200,Number(cfg.deepPageGapMs)||4000),
        deepMaxPages:Math.max(1,Math.min(50,Number(cfg.deepMaxPages)||50)),
        autoOpen:cfg.autoOpen!==false,
        maxDescPerRound:Math.max(0,Number(cfg.maxDescPerRound==null?15:cfg.maxDescPerRound)),
        showExistingOnFirstRun:cfg.showExistingOnFirstRun!==false,
        remoteStatusUrl:(typeof cfg.remoteStatusUrl==="string"?cfg.remoteStatusUrl:""),
        shopProbed:Object.keys(sellerProfiles).length,
        /* 推送配置原样回传：面板要能显示当前填了哪些渠道。
           密钥类字段（sendkey/token/secret/webhook）**只回传"是否已填"**，
           不回传明文 —— 面板是本地 127.0.0.1，但没必要让凭据在页面上裸奔，
           前端留空表示"不修改"，服务端 merge 时保留旧值。 */
        notify:notifyConfigForPanel(cfg.notify),
        notifyStats:notifyLayer.getStats(),
        priceMemoryCount:priceMemory.count()
      }));
    }
    if(u.startsWith("/__scan/read")){
      try{
        const body=await readBody(req);
        const req2=body?JSON.parse(body):{};
        const nowMs=Date.now();
        let n=0;
        if(req2.all){
          hits.forEach(function(h){ if(!h.read){ h.read=true; h.readAt=nowMs; n++; } });
        } else if(req2.itemId){
          hits.forEach(function(h){ if(h.itemId===req2.itemId&&!h.read){ h.read=true; h.readAt=nowMs; n++; } });
        }
        scheduleHitsWrite();
        res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:true,marked:n}));
      }catch(e){
        res.writeHead(400,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:false,error:e.message}));
      }
    }
    if(u.startsWith("/__scan/unread")){
      /* 误点「标记看过」后恢复：把 read 标记清掉（readAt 一并清），商品会回到"没看过的"列表 */
      try{
        const body=await readBody(req);
        const req2=body?JSON.parse(body):{};
        const ids=(req2.itemId?[req2.itemId]:(Array.isArray(req2.ids)?req2.ids:[])).map(String);
        let n=0;
        if(ids.length){
          hits.forEach(function(h){
            if(ids.indexOf(String(h.itemId))>=0&&h.read){ h.read=false; delete h.readAt; n++; }
          });
        }
        scheduleHitsWrite();
        res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:true,restored:n}));
      }catch(e){
        res.writeHead(400,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:false,error:e.message}));
      }
    }
    if(u.startsWith("/__scan/hide")){
      /* 「点开→置灰」与「标记看过→消失」是两个动作，不能共用 read 一个布尔。
         hidden 独立于 read：read=true 只是置灰沉底（点开链接自动标），
         hidden=true 才从列表里真正消失（用户手动点「标记看过/移除」）。 */
      try{
        const body=await readBody(req);
        const req2=body?JSON.parse(body):{};
        const nowMs=Date.now();
        let n=0;
        if(req2.itemId){
          hits.forEach(function(h){ if(h.itemId===req2.itemId&&!h.hidden){ h.hidden=true; h.hiddenAt=nowMs; h.read=true; h.readAt=nowMs; n++; } });
        }
        scheduleHitsWrite();
        res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:true,hidden:n}));
      }catch(e){
        res.writeHead(400,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:false,error:e.message}));
      }
    }
    if(u.startsWith("/__scan/unhide")){
      /* 撤销「标记看过」：把 hidden 清掉，商品回到列表（read 一并清回未看）。 */
      try{
        const body=await readBody(req);
        const req2=body?JSON.parse(body):{};
        const ids=(req2.itemId?[req2.itemId]:(Array.isArray(req2.ids)?req2.ids:[])).map(String);
        let n=0;
        if(ids.length){
          hits.forEach(function(h){
            if(ids.indexOf(String(h.itemId))>=0&&h.hidden){ h.hidden=false; delete h.hiddenAt; h.read=false; delete h.readAt; n++; }
          });
        }
        scheduleHitsWrite();
        res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:true,restored:n}));
      }catch(e){
        res.writeHead(400,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:false,error:e.message}));
      }
    }
    if(u.startsWith("/__scan/clear")){
      /* 【修 BUG-E：/__scan/clear 无任何确认，一次 POST 就清空全库】
         实测：POST 空 body → 200 {"ok":true,"cleared":738}，738 条命中当场没了，
         而 writeJSON 是覆盖写、没有备份 → 不可恢复。
         浏览器里任何页面都能 fetch 到 127.0.0.1 的这个接口（CSRF 面），
         面板误触、脚本手滑是同一个后果。
         现在要求：① 必须 POST；② body 必须带 confirm:"CLEAR-HITS"；
                   ③ 清之前先把 hits.json 复制成 hits.before-clear-<时间戳>.json。 */
      try{
        if(req.method!=="POST"){
          res.writeHead(405,{"content-type":"application/json; charset=utf-8"});
          return res.end(JSON.stringify({ok:false,error:"需要 POST"}));
        }
        const cb=await readBody(req);
        let cj={}; try{ cj=JSON.parse(cb||"{}"); }catch(e){ cj={}; }
        if(cj.confirm!=="CLEAR-HITS"){
          res.writeHead(400,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
          return res.end(JSON.stringify({ok:false,error:"缺少 confirm 令牌",hint:'body 需要 {"confirm":"CLEAR-HITS"}'}));
        }
        const n=hits.length;
        try{ if(fs.existsSync(HITSF)&&fs.statSync(HITSF).size>2) fs.copyFileSync(HITSF,path.join(DATA,"hits.before-clear-"+Date.now()+".json")); }catch(e){}
        /* 【优化#1】先清名单 hidden 再清 hits —— 两边必须同时清，
           只清 hits 的话，下次「解除屏蔽」会把屏蔽期间囤下的记录（含外省货）全部回灌。 */
        const hc2=sellerBlockClearHidden();
        if(hc2.sellers) log("   同步清掉屏蔽名单里囤的 "+hc2.items+" 条旧记录（"+hc2.sellers+" 个卖家）");
        hits=[];
        writeJSON(HITSF,hits);
        log("已清空 "+n+" 条命中记录（清空前快照已留存在 data 目录）");
        rebaselineNow("清空记录后").catch(function(e){ log("重建基线异常: "+e.message); });
        res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:true,cleared:n}));
      }catch(e){
        res.writeHead(400,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:false,error:e.message}));
      }
    }
    if(u.startsWith("/__scan/qr")){
      /* 面板内扫码登录的三个接口：
           GET  /__scan/qr        → 直接吐 PNG 二维码（<img src="/__scan/qr?t=...">）
           GET  /__scan/qrstatus  → {ok, logged, unb, err, age}，面板轮询用
           POST /__scan/qrclose   → 关掉后台登录页（用户点"取消"）
         全部不重启监控、不弹窗口。已经在登录态时直接返回已登录，不出二维码。 */
      const q=u.split("?")[0];
      if(q==="/__scan/qr"){
        /* 已经登录了就不用出码了：给一张很小的占位 PNG，面板那边会先查 qrstatus */
        if(loginOkAt&&Date.now()-loginOkAt<300000&&freshInfo.loginBad!==true){
          const body=JSON.stringify({ok:true,logged:true});
          res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
          return res.end(body);
        }
        try{
          const png=await loginSessQr(/[?&]new=1/.test(u));
          res.writeHead(200,{"content-type":"image/png","content-length":png.length,"cache-control":"no-store"});
          return res.end(png);
        }catch(e){
          const body=JSON.stringify({ok:false,error:String(e.message).slice(0,160)});
          res.writeHead(500,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
          return res.end(body);
        }
      }
      if(q==="/__scan/qrstatus"){
        let out={ok:true,logged:false,unb:null,err:"",age:0,injected:0};
        /* 【修 BUG-K：面板"已登录"判断和实际扫描身份脱节】
           这里原来只看 loginSess（面板扫码专用的那个会话），完全不看主监控自己的 cookie 登录态。
           实测：主监控登录完全正常（unb 有值，havana 3/5），接口却返回 logged:false, unb:null
           → 面板显示未登录，用户反复去扫码；而扫码用的是另一个持久化 profile，
           跟主监控正在用的 cookie 根本不是一回事，扫完还是一样。
           现在：主监控登录态（freshInfo.loginUnb 且没被判 loginBad）也算已登录，
           并用 sessLogged / mainLogged 分开告知来源，面板可以按需展示。 */
        const __sessOk=!!(loginSess&&loginSess.ctx);
        const __mainOk=!!(freshInfo.loginUnb&&freshInfo.loginBad!==true);
        out.logged=__sessOk||__mainOk;
        /* 【2026-11-05】sessLogged 必须表示"这次扫码真的扫到了新账号"，
           不能等于 __sessOk（那只表示后台登录页开着）。
           否则面板一打开二维码就收到 sessLogged:true → 判定成功 → 自动收起。 */
        out.sessLogged=false;
        out.mainLogged=__mainOk;
        if(__mainOk&&!out.unb) out.unb=freshInfo.loginUnb;
        if(loginSess&&loginSess.ctx){
          loginSess.lastHit=Date.now();
          out.age=Math.round((Date.now()-(loginSess.at||Date.now()))/1000);
          try{
            const r=await loginSessFinish();
            if(r&&r.logged){ out.logged=true; out.sessLogged=true; out.unb=r.unb; out.injected=r.injected||0; }
          }catch(e){ out.err=String(e.message).slice(0,120); }
        }else if(loginSess&&loginSess.err){
          out.err=loginSess.err;
        }
        /* 上面的 loginSessFinish 分支只会把 logged 置 true，不会置 false；
           这里再兜一次，保证主监控已登录时不会被改成未登录。 */
        if(!out.logged&&__mainOk){ out.logged=true; out.unb=out.unb||freshInfo.loginUnb; }
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify(out));
      }
      if(q==="/__scan/qrclose"){
        loginSessClose();
        log("面板扫码登录：已取消（后台登录页已关闭）");
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify({ok:true}));
      }
    }
    if(u.startsWith("/__scan/relogin")){
      /* 面板上的【立即重新登录】：
         登录必须独占 data\browser-profile，所以顺序只能是
           先退出本监控（释放配置锁） → 再跑 login-manual.cjs → 再重启监控。
         这里只负责"先回执、再退出、并把整个流程交给 3-重新登录并恢复.cmd"，
         不要在监控进程里自己去开登录窗口 —— 配置锁还在自己手上，必冲突。 */
      const body=JSON.stringify({ok:true,msg:"监控即将停止，登录窗口会弹出；登录完成后监控自动重启"});
      res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Content-Length":Buffer.byteLength(body)});
      res.end(body);
      log("收到面板【立即重新登录】指令 → 启动登录流程（本监控将退出，登录完成后自动重启）。");
      setTimeout(function(){
        try{
          const cp=require("child_process");
          const cmdFile=path.join(ROOT,"3-重新登录并恢复.cmd");
          if(fs.existsSync(cmdFile)){
            /* 【BUG 修复 2026-11-05】这里原来写的是
                 cp.spawn("cmd",["/c","start","","\\""+cmdFile+"\\""],…)
               但 Node 给参数包引号时会把空标题 "" 破坏成 "\"\""，start 认不出标题，
               整条命令静默失效（子进程 exit=0、什么都不执行）—— 表现就是点「用浏览器窗口登录」
               后监控停了、登录窗口却不出现。
               改用 windowsVerbatimArguments，把命令串原样交给 cmd.exe，
               等价于手敲：cmd /c start "" "D:\…\3-重新登录并恢复.cmd" */
            cp.spawn("cmd.exe",["/c","start","\"\"","\""+cmdFile+"\""],{detached:true,stdio:"ignore",windowsHide:false,cwd:ROOT,windowsVerbatimArguments:true}).unref();
          }else{
            /* 脚本被删了：至少把登录程序本身拉起来，别让按钮变成死键。
               login-manual.cjs 跟 monitor.cjs 用同一个 node.exe（就是当前进程自己），
               所以不用重新探测运行时路径。 */
            log("警告：找不到 3-重新登录并恢复.cmd，改为直接启动 login-manual.cjs。");
            try{
              cp.spawn(process.execPath,["login-manual.cjs"],{detached:true,stdio:"ignore",windowsHide:false,cwd:ROOT}).unref();
            }catch(e2){ log("直接启动登录程序也失败了: "+e2.message+" —— 请手动双击【0-首次扫码登录.cmd】。"); }
          }
        }catch(e){ log("启动登录流程失败: "+e.message); }
        shutdown(0,"relogin");
      },900);
      return;
    }
    if(u.startsWith("/__scan/resume")){
      /* 解除「启动待命」：点一下立刻开始扫。登录态在启动时已经还原好了，这里不发任何请求。 */
      holdSet(false,"面板/托盘");
      /* 【连点保护】距上一轮开始不足 resumeMinGapSec 秒时不立刻开跑，顺延到 lastRoundAt+间隔。
         用「取较大值」累积：连点十次目标时间不动，仍然只跑一轮。 */
      const __gap=Math.max(0,Math.min(3600,Number(cfg.resumeMinGapSec!=null?cfg.resumeMinGapSec:180)))*1000;
      const __since=lastRoundAt>0?(Date.now()-lastRoundAt):1e9;
      if(__gap>0&&lastRoundAt>0&&__since<__gap){
        const __to=lastRoundAt+__gap;
        if(__to>resumeNotBefore) resumeNotBefore=__to;
      }else{
        resumeNotBefore=0;
      }
      const __waitSec=Math.max(0,Math.ceil((resumeNotBefore-Date.now())/1000));
      res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
      return res.end(JSON.stringify({ok:true,hold:false,throttleLeft:Math.max(0,(throttle.until||0)-Date.now()),waitSec:__waitSec,at:new Date().toISOString()}));
    }
    if(u.startsWith("/__scan/hold")){
      /* 主动暂停：不退出进程、不关浏览器，只是不再发请求。 */
      holdSet(true,"面板/托盘");
      res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
      return res.end(JSON.stringify({ok:true,hold:true,at:new Date().toISOString()}));
    }
    if(u.startsWith("/__scan/stop")){
      /* 【只认 POST 2026-11-04】这个路由原来不判 method —— 在浏览器地址栏敲一下
         /__scan/stop 或者被别的东西 GET 一下，监控就真停了（我自己的探针就误停过一次）。
         托盘 Stop-All 用的是 POST，所以收紧成只认 POST 不影响任何正常路径。 */
      if(req.method!=="POST"){
        res.writeHead(405,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","allow":"POST"});
        return res.end(JSON.stringify({ok:false,error:"method not allowed; use POST"}));
      }
      /* 面板上的【停止监控】：先回执，再走正常收尾（关浏览器、清临时进程）后退出。
         等价于关掉那个黑色命令行窗口。 */
      const body=JSON.stringify({ok:true,msg:"监控已停止，重新双击 闲鱼扫货监控.exe（或托盘菜单「启动监控」）即可继续"});
      res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Content-Length":Buffer.byteLength(body)});
      res.end(body);
      log("收到面板【停止监控】指令 → 3 秒后退出（已命中记录都已落盘）。");
      setTimeout(function(){ shutdown(0,"stop"); },500); /* 2026-11-05 退出卡顿优化：回执同步发出，500ms 足够，无需等 3 秒 */
      return;
    }

    /* ===== 体检 GET /__scan/selfcheck =====
       【为什么要有它】用户问"程序现在正常吗"时，以前只能翻 data\monitor.log、看面板横幅、
       再手工查几个 JSON。这个端点把"判断程序是否健康"需要的量一次性算好返回，
       面板上那个「体检」按钮就是打它。
       原则：**只读**。不扫页、不写 hits/seen、不推送、不改任何状态文件。
       （/__scan/diag 会真的翻页，慢且会扰动风控；体检不能那样。）
       返回 rank 字段：ok / warn / bad，面板按最差的那条决定横幅颜色。 */
    if(u.startsWith("/__scan/selfcheck")){
      try{
        const now=Date.now();
        const mins=function(ms){ return (ms==null||!isFinite(ms))?null:Math.round(ms/60000); };
        /* 【启动预热期 2026-10-29】刚起来的头一分钟里 checkLogin() 还没跑、lastRoundAt 还是 0，
           登录项会被判成 bad —— 托盘一启动就亮红灯，用户会对红色脱敏。
           这里把"还没开始检查"和"检查过且确实坏了"分开：一轮都没跑完时登录项最多给 warn；
           跑完一轮之后照旧按真实判据走。 */
        const warmingUp=!lastRoundAt;
        const ago=function(t){ return (t&&t>0)?Math.max(0,Math.round((now-t)/1000)):null; };
        const items=[];
        const add=function(rank,key,label,detail,hint){
          items.push({rank:rank,key:key,label:label,detail:detail||"",hint:hint||""});
        };

        /* ① 登录态：unb + havana 标记数。跟面板顶部徽标同一套判据，不另起炉灶。 */
        const unb=freshInfo.loginUnb||null;
        const strong=Number(freshInfo.loginStrong||0);
        const loginBad=!!freshInfo.loginBad;
        if(!unb&&warmingUp) add("warn","login","登录","正在启动，还没做第一次登录检查（还没跑完一轮）","等 1~2 分钟再看；如果一直这样，点面板「体检」重查");
        else if(!unb) add("bad","login","登录","没有读到登录身份（unb 为空）","点面板「扫码登录」或双击 3-重新登录并恢复.cmd");
        else if(loginBad) add("bad","login","登录","unb="+unb+"，但"+String(freshInfo.loginWhy||"登录凭证不完整")+"，平台按游客给旧数据","点面板「登录 / 换号」重新扫一次；在此之前抓到的商品都是旧的");
        else if(String(freshInfo.loginLevel||"")==="warn") add("warn","login","登录","unb="+unb+"（sgcookie+tfstk 齐全，但"+String(freshInfo.loginWhy||"会话级 cookie 暂缺")+"）","通常下一轮自动恢复，不影响抓取");
        else add("ok","login","登录","unb="+unb+"（sgcookie + tfstk 齐全）");

        /* ② 最近一轮扫描：多久之前、有没有报错。这是"程序还活着吗"最直接的证据。 */
        /* 【启动待命 2026-11-04】待命期间「一轮都没跑」是预期行为，不是故障。 */
        if(holdOn){
          const hm=holdSince?Math.max(0,Math.round((now-holdSince)/60000)):0;
          add("ok","hold","启动待命","待命中 "+hm+" 分钟，本次启动还没有发出任何搜索请求","点面板「▶ 开始监控」或托盘「开始监控」开始扫；脚本里可以先改好筛选条件再点");
        }
        else if(!lastRoundAt) add("warn","round","扫描进度","还没跑完过一轮（刚启动？）","等 1~2 分钟再看");
        else{
          const gapSec=Math.round((now-(lastRoundDoneAt||lastRoundAt))/1000);
          const expect=Math.round((Number(cfg.intervalSeconds)||90)+(Number(cfg.jitterSeconds)||30));
          const detail="最后一轮 "+mins(now-lastRoundAt)+" 分钟前结束，本轮新命中 "+lastRoundFresh+" 条；"
            +"计划间隔 "+expect+" 秒，实际已过 "+gapSec+" 秒";
          if(lastRoundErr) add("bad","round","扫描进度",detail+"；本轮报错："+lastRoundErr,"把这段报错原文发出来，多半是闲鱼接口或字段改了");
          else if(gapSec>expect*3+120) add("warn","round","扫描进度",detail,"比计划慢很多，看看是不是在限流冷却或人工验证中");
          else add("ok","round","扫描进度",detail);
        }

        /* ③ 接口健康：token 连续失败 / 签名被拒 / 限流，三件事各有各的处理办法，别混在一起说。 */
        if(tokenWarn||tokenFail>=2) add("bad","token","接口鉴权","连续 "+tokenFail+" 轮接口失败（大概率 _m_h5_tk 签名 token 过期）","双击 3-重新登录并恢复.cmd 重新扫码");
        else if(signFailRounds>0) add("warn","token","接口鉴权","签名被拒 "+signFailRounds+" 轮（FAIL_SYS_ILLEGAL_ACCESS）","通常下一轮会自愈；连续出现就重新扫码");
        /* 【网络类错误分级 2026-11-04】断网单独一条，别混进「接口鉴权」 */
        if(netErrRounds>0) add("warn","net","网络","已经连续 "+netErrRounds+" 轮连不上网（断网/睡眠/切网）","网络恢复后会自动继续，不用重新登录");
        else add("ok","token","接口鉴权","token 正常，签名未被拒");

        const thrLeft=Math.max(0,(throttle.until||0)-now);
        if(thrLeft>0) add("warn","throttle","平台限流","冷却中，还要等 "+Math.round(thrLeft/1000)+" 秒（第 "+throttle.level+" 级退避："+(throttle.reason||"")+"）","别重启、别手动刷新，等它自己退避到 0");
        else if(freshInfo.throttled) add("warn","throttle","平台限流","最近一轮被判限流","把 intervalSeconds 从 "+(cfg.intervalSeconds||240)+" 调到 480 再看几轮");
        else add("ok","throttle","平台限流","没有被限流");

        /* ④ 少返（服务端说 N 条、实际只给几条）：这是"接口还通但被降级"的信号，比报错更隐蔽。 */
        if(freshInfo.degraded) add("warn","degraded","数据质量",
          "疑似被风控降级："+(freshInfo.note||"服务端少返")
            +(sessionRebuilds>0?"（本次运行已自动重建会话 "+sessionRebuilds+" 次）":""),
          sessionRebuilds>0
            ? "已自动重建 "+sessionRebuilds+" 次仍在给旧数据 —— 多半是平台侧缓存，等十几分钟再看；别急着重登"
            : "下一轮起若连续旧数据会自动重建会话，不用手动处理");
        else{
          const meta=lastSearchMeta||{};
          if(meta.rows!=null&&meta.requested&&meta.declared!=null&&meta.rows<Math.floor(meta.requested/2)&&meta.declared>meta.rows)
            add("warn","degraded","数据质量","最后一页要 "+meta.requested+" 条只给了 "+meta.rows+" 条（服务端自报 "+meta.declared+" 条）","可能是限流前兆，观察下一轮");
          else add("ok","degraded","数据质量","没有少返，数据量正常");
        }

        /* ⑤ 浏览器内核：只报版本，不联网检查。Chromium 钉在 browsers.json 的 revision 上，
           不会自己升级；这里列出来是为了"哪天闲鱼改了前端、怀疑内核太老"时有个明确数字。 */
        let chromiumVer="未知";
        try{ const pc=require(path.join(PW,"package.json")); chromiumVer="chromium "+(pc.version||"?")+" (playwright)"; }catch(e){ chromiumVer="读不到 playwright 版本"; }
        let chromeExe="";
        try{
          const bj=JSON.parse(fs.readFileSync(path.join(PW,"browsers.json"),"utf8"));
          const cb=(bj.browsers||[]).filter(function(x){ return x&&x.name==="chromium"; })[0];
          if(cb) chromiumVer="Chromium "+(cb.browserVersion||"?")+"（playwright "+((function(){ try{ return require(path.join(PW,"package.json")).version; }catch(e){ return "?"; } })())+"，revision "+cb.revision+"）";
        }catch(e){}
        try{
          const lp=path.join(DATA,"browser-profile");
          if(fs.existsSync(lp)) chromeExe="浏览器目录已就绪";
          else chromeExe="浏览器目录还没建（第一次启动会自己建）";
        }catch(e){}
        add("ok","engine","浏览器内核",chromiumVer+"；"+chromeExe,"内核不会自己升级（Playwright 按写死的 revision 找目录），现状能跑就一直能跑");

        /* ⑥ 数据文件：能不能读、多少条。损坏的价格记忆会让"综合分"全变成 0，
           以前解析失败只写一行警告，用户完全看不到，这里直接标红。 */
        try{
          const pmBroken=(typeof priceMemory.isBroken==="function")?!!priceMemory.isBroken():false;
          if(pmBroken) add("bad","data","数据文件","price-memory.json 解析失败，价格历史等于清零","备份后删掉 data\\price-memory.json，程序会重建（会丢价格记忆）");
          else add("ok","data","数据文件","价格记忆 "+priceMemory.count()+" 条 · 命中 "+hits.length+" 条 · 已见 "+Object.keys(seen).length+" 键 · 描述缓存 "+Object.keys(descCache).length+" 条 · 卖家档案 "+Object.keys(sellerProfiles).length+" 条");
        }catch(e){ add("warn","data","数据文件","读取统计失败："+String(e.message||e).slice(0,120)); }

        /* ⑦ 基线：改筛选条件后要重建的 50 页。这时"一条都不推"是设计如此，必须明说，
           否则用户会以为坏了。 */
        try{
          const pend=Object.keys(__seedPending||{}).filter(function(k){ return (cfg.tasks||[]).some(function(t){ return t&&t.name===k; }); });
          const doing=(cfg.tasks||[]).filter(function(t){ return t&&t.enabled!==false&&deepState[t.name]!==sigOfTask(t); });
          if(doing.length) add("warn","baseline","基线重建",doing.map(function(t){ return t.name; }).join("、")+" 正在重建基线，期间历史在售不推送（新上架照常推）","等它走完 50 页，通常 20~40 分钟");
          else if(pend.length) add("warn","baseline","基线重建",pend.join("、")+" 待续翻","等它走完");
          else add("ok","baseline","基线重建","基线已完成，按正常节奏抓新");
        }catch(e){}

        /* ⑧ 推送：没配渠道等于"扫到了也不告警"，这是个常见误配置。 */
        try{
          const nc=notifyLayer.normalizeConfig(cfg.notify||{});
          const on=notifyLayer.buildEnabled(nc).filter(function(t){ return t.def&&t.def.key!=="log"; });
          const st=(typeof notifyLayer.getStats==="function")?notifyLayer.getStats():null;
          const statTxt=st?("累计成功 "+(st.sent||0)+" / 失败 "+(st.failed||0)):"";
          const rq=(function(){ try{ const a=notifyRetryLoad(); return a.length; }catch(e){ return 0; } })();
          if(!nc.enabled) add("warn","notify","推送","总开关是关的，命中不会推手机","在面板「筛选设置」底部把推送总开关打开");
          else if(!on.length) add("warn","notify","推送","一个渠道都没启用（只剩本地日志）","在面板「消息推送」里选一个渠道填好并勾上");
          else add("ok","notify","推送","已启用 "+on.map(function(t){ return t.def.label||t.def.key; }).join("、")+"；"+statTxt+(rq?("；待补发 "+rq+" 条"):""));
        }catch(e){ add("warn","notify","推送","读取推送配置失败："+String(e.message||e).slice(0,120)); }

        /* ⑨ 守护进程：它不在同一个进程里。guard 活着的时候，每轮探通都会调 gsave(false)，
           而 gsave 非 force 时限流 10 分钟 —— 所以 guard-state.json 的 mtime 最多滞后 10 分钟，
           是"守护还在盯"最可靠的活证据。guard.log 只在有事件时才写（可能几小时不动），
           单独拿它判断会误报"守护没在跑"（实测踩过：一台正常运行的机器被判成 29887968 分钟没动静）。 */
        try{
          const sf=path.join(DATA,"guard-state.json");
          const lf=path.join(DATA,"guard.log");
          let bestMs=0, bestName="";
          if(fs.existsSync(sf)){ const t=fs.statSync(sf).mtimeMs; if(t>bestMs){ bestMs=t; bestName="guard-state.json"; } }
          if(fs.existsSync(lf)){ const t=fs.statSync(lf).mtimeMs; if(t>bestMs){ bestMs=t; bestName="guard.log"; } }
          if(!bestMs) add("warn","guard","守护进程","没有任何守护痕迹（没有 guard-state.json / guard.log），说明从没用守护启动过","想要「死了自动重启 + 推告警」，双击 闲鱼扫货监控.exe（托盘会拉起守护）");
          else{
            const idleMin=mins(now-bestMs);
            if(idleMin<=20) add("ok","guard","守护进程","守护正在运行（"+bestName+" 最近 "+idleMin+" 分钟内有更新）");
            else add("warn","guard","守护进程","守护进程可能没在跑："+bestName+" 已经 "+idleMin+" 分钟没更新","托盘菜单点「重启监控」即可把守护一起叫起来（不影响当前监控）");
          }
        }catch(e){}

        const rank=(items.some(function(x){ return x.rank==="bad"; }))?"bad":(items.some(function(x){ return x.rank==="warn"; })?"warn":"ok");
        const summary={ok:"一切正常",warn:"能用，但有 " + items.filter(function(x){ return x.rank==="warn"; }).length + " 项要留意",bad:"有 " + items.filter(function(x){ return x.rank==="bad"; }).length + " 项需要处理"}[rank];
        const out={
          ok:true, rank:rank, summary:summary, at:new Date().toISOString(),
          uptimeSec:Math.round((now-bootAt)/1000),
          roundNo:roundNo, items:items,
          raw:{ loginUnb:unb, loginStrong:strong, loginBad:loginBad, tokenFail:tokenFail, tokenWarn:tokenWarn,
                signFailRounds:signFailRounds, loginLevel:freshInfo.loginLevel||null, loginWhy:freshInfo.loginWhy||"",
                loginSessMarks:(freshInfo.loginSessMarks!=null?freshInfo.loginSessMarks:null),
                throttle:{level:throttle.level,until:throttle.until,reason:throttle.reason},
                lastRoundAt:lastRoundAt?new Date(lastRoundAt).toISOString():null,
                lastRoundDoneAt:lastRoundDoneAt?new Date(lastRoundDoneAt).toISOString():null,
                lastRoundErr:lastRoundErr, lastRoundFresh:lastRoundFresh, lastRoundSeeded:lastRoundSeeded,
                degraded:!!freshInfo.degraded, note:freshInfo.note||"", nextScanAt:nextScanAt,
                staleRounds:staleRounds, sessionRebuilds:sessionRebuilds,
                hits:hits.length, seen:Object.keys(seen).length, priceMem:priceMemory.count(),
                chromium:chromiumVer }
        };
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify(out));
      }catch(e){
        res.writeHead(500,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify({ok:false,error:String((e&&e.message)||e).slice(0,300)}));
      }
    }
        if(u.startsWith("/__scan/diag")){
      /* 【只读诊断】逐条回答「为什么池子里有十几分钟前的新货，面板却停在几小时前」。
         做法：按当前任务把 1..incrementalPages 页真实拉一遍，每条都过一遍 localFilter，
         把「发布时间 / 价格 / 地区 / 标题 / 是否通过 / 被哪条规则挡掉 / 是否已在 seen」全部列出来，
         只读、不写 hits/seen/word-hits，不推送。
         为什么要它：以前只能从「筛后 23 条」这种聚合数字反推，用户看到「最新一条发布于 12 分钟前」
         和自己的面板对不上，只能怀疑程序算错时间 —— 实际是聚合数字把「池子里有」和「过滤后还在」混在了一起。 */
      try{
        const dq=new URLSearchParams((u.split("?")[1]||""));
        const task=Object.assign({},(cfg.tasks||[]).find(t=>t.enabled!==false)||(cfg.tasks||[])[0]||{keyword:""});
        if(dq.has("keyword")) task.keyword=dq.get("keyword");
        if(dq.has("prov")) task.province=dq.get("prov");
        if(dq.has("city")) task.city=dq.get("city");
        if(dq.has("area")) task.area=dq.get("area");
        if(dq.has("maxPrice")) task.maxPrice=(dq.get("maxPrice")==="")?null:Number(dq.get("maxPrice"));
        if(dq.has("minPrice")) task.minPrice=(dq.get("minPrice")==="")?null:Number(dq.get("minPrice"));
        if(dq.get("noStorage")==="1") task.storages=[];
        if(dq.get("noPrice")==="1"){ task.maxPrice=null; task.minPrice=null; }
        if(holdOn){
          res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
          return res.end(JSON.stringify({ok:false,hold:true,
            msg:"程序处于待命状态，不会发出搜索请求。点【▶ 开始监控】后再诊断。"}));
        }
        const wsave=JSON.stringify(wordHits);
        const rows=[];
        const seenFlag={};
        const maxP=Math.max(1,Math.min(10,Number(dq.get("pages")||cfg.incrementalPages)||3));
        for(let pg=1; pg<=maxP; pg++){
          if(pg>1) await nap(1200);
          let list=[];
          try{ list=await callSearch(task,pg); }
          catch(e){ rows.push({page:pg,error:String(e.message).slice(0,160)}); continue; }
          for(const it of list){
            if(seenFlag[it.itemId]) continue;
            seenFlag[it.itemId]=1;
            sellerBlockLogSilent=false;
            dropStats={};
            let ok=false;
            try{ ok=localFilter(task,it); }catch(e){ rows.push({page:pg,itemId:it.itemId,filtErr:String(e.message).slice(0,80)}); continue; }
            const dl=dropStatsLine();
            rows.push({page:pg,itemId:it.itemId,publishTime:Number(it.publishTime||0),
              publishAt:it.publishAt,ageMin:it.ageMinutes,price:it.price,area:it.area,
              tags:(it.tags||[]).slice(0,3),title:String(it.title||"").slice(0,70),
              pass:ok,dropReason:ok?"":dl,inSeen:!!seen[it.itemId]});
          }
        }
        /* wordHits 还原：localFilter 里的 noteWordHit 会累加计数，诊断不该留痕 */
        try{ for(const k in wordHits) delete wordHits[k]; Object.assign(wordHits,JSON.parse(wsave)); }catch(e){}
        const good=rows.filter(r=>!r.error&&!r.filtErr);
        good.sort((a,b)=>(b.publishTime||0)-(a.publishTime||0));
        const passed=good.filter(r=>r.pass);
        const dropped=good.filter(r=>!r.pass);
        const byReason={};
        dropped.forEach(r=>{ const k=String(r.dropReason||"其他").split(" ")[0]||"其他"; byReason[k]=(byReason[k]||0)+1; });
        const out={
          ok:true,
          at:new Date().toISOString(),
          task:task.name||task.keyword,
          cond:{keyword:task.keyword,province:task.province,city:task.city,area:task.area,
            maxPrice:task.maxPrice,minPrice:task.minPrice,storages:task.storages,
            brands:task.brands,excludeWords:task.excludeWords,publishDays:task.publishDays},
          pagesTried:maxP,
          override:{keyword:task.keyword,prov:task.province,city:task.city,area:task.area,maxPrice:task.maxPrice,minPrice:task.minPrice,storages:task.storages},
          poolTotal:good.length,
          passedCount:passed.length,
          droppedCount:dropped.length,
          dropReasons:byReason,
          newestInPool:good.length?{publishAt:good[0].publishAt,ageMin:good[0].ageMin,price:good[0].price,title:good[0].title}:null,
          newestPassed:passed.length?{publishAt:passed[0].publishAt,ageMin:passed[0].ageMin,price:passed[0].price,title:passed[0].title,inSeen:passed[0].inSeen}:null,
          /* 前 25 条按发布时间倒序，带判定 —— 用户直接能看出「最新的一批为什么没进面板」 */
          top:good.slice(0,25),
          byPage:(function(){
            const m={};
            good.forEach(function(r){ const k="p"+r.page; if(!m[k]) m[k]={page:r.page,count:0,newest:"",oldest:""}; m[k].count++; if(!m[k].newest||r.publishTime>m[k].newestT){ m[k].newestT=r.publishTime; m[k].newest=r.publishAt; } if(!m[k].oldest||r.publishTime<m[k].oldestT){ m[k].oldestT=r.publishTime; m[k].oldest=r.publishAt; } });
            return Object.keys(m).sort(function(a,b){return m[a].page-m[b].page;}).map(function(k){ var o=m[k]; delete o.newestT; delete o.oldestT; return o; });
          })(),
          errors:rows.filter(r=>r.error||r.filtErr)
        };
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
        return res.end(JSON.stringify(out));
      }catch(e){
        res.writeHead(500,{"content-type":"application/json; charset=utf-8"});
        return res.end(JSON.stringify({ok:false,error:String(e.message||e)}));
      }
    }

    if(u.startsWith("/__scan/hits.json")){
      /* 增量 + 缓存协商（2026-10-21 补丁）：
         ① ?since=<毫秒时间戳> → items 只回 foundAt 比它新的记录。面板轮询不必每次拉 3000 条全量；
            count 永远给全量命中数，所以面板上的"共 N 条"不会因为这个参数跳变。
         ② ETag 取 count + 最大 foundAt（**不含 lastUpdate**，否则每轮都变，304 永远打不中）。
            浏览器/脚本带 If-None-Match 命中就直接 304 空体，省带宽也省前端 JSON.parse。
         故意不把 since 写进 ETag：同一个资源表示，只是请求方要的切片不同，混进去会让缓存互相踢。 */
      const qs=new URLSearchParams((u.split("?")[1]||""));
      const sinceRaw=qs.get("since");
      const sinceNum=(sinceRaw==null||sinceRaw==="")?NaN:Number(sinceRaw);
      const useSince=isFinite(sinceNum)&&sinceNum>0;
      const full=hits.slice(0,3000);
      const items=useSince?full.filter(function(h){ return hitFoundMs(h)>sinceNum; }):full;
      /* ETag 用 count + 最大 foundAt + 最新一条的 itemId 组成。
         加 itemId 是为了兜住"删一条又进一条、count 与时间戳恰好不变"的情况。 */
      let maxFoundAt=0;
      for(let i=0;i<hits.length;i++){ const v=hitFoundMs(hits[i]); if(v>maxFoundAt) maxFoundAt=v; }
      const etag='W/"h'+hits.length+"-"+maxFoundAt+"-"+(hits[0]&&hits[0].itemId?hits[0].itemId:"")+'"';
      const hdr={"content-type":"application/json; charset=utf-8","cache-control":"no-store","etag":etag};
      if(String(req.headers["if-none-match"]||"")===etag){
        res.writeHead(304,hdr);
        return res.end();
      }
      res.writeHead(200,hdr);
      return res.end(JSON.stringify({updatedAt:lastUpdate,interval:cfg.intervalSeconds,nextScanAt:nextScanAt,serverNow:new Date().toISOString(),
        count:hits.length,since:useSince?sinceNum:null,items:items,about:ABOUT,fresh:freshInfo,
          remote:remoteStatus,
          hold:{on:!!holdOn,since:holdSince||0,resumedAt:holdResumedAt||0,bootAt:bootAt||0,mode:String(cfg.startMode||"hold")}}));
    }

    /* ===== 独立界面（v2026-10-20）=====
       以前这里把所有非 /__scan/* 请求反向代理到 59188（Ydisks闲鱼助手），
       再把返回的 HTML 塞一行 <script src="/__scan/inject.js">。
       现在改成：根路径直接返回自己的 panel\index.html，彻底不再依赖宿主程序。
       端口不变（还是 59288），所以原来的书签/手机访问地址都不用改。
       /__scan/* 全部在前面自己处理，走不到这里。 */
    if(u==="/"||u==="/index.html"||u.startsWith("/?")){
      let html="";
      try{ html=fs.readFileSync(path.join(ROOT,"panel","index.html"),"utf8"); }
      catch(e){ html="<h3>找不到 panel\\index.html</h3><p>"+String(e.message)+"</p>"; }
      res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
      return res.end(html);
    }
    /* 其余路径给个明确的 404，不再代理出去 —— 独立程序没有别的页面。
       （favicon 已经在上面单独处理，走不到这里。） */
    res.writeHead(404,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
    return res.end("<!DOCTYPE html><meta charset=\"utf-8\"><title>404</title>"
      +"<body style=\"font-family:system-ui;padding:40px;color:#334155\">"
      +"<h3 style=\"margin:0 0 10px\">404</h3>"
      +"<p style=\"color:#64748b\">只有一个界面：<a href=\"/\" style=\"color:#0071e3\">打开扫货监控 →</a></p></body>");
  });
  /* WebSocket 反代是给宿主程序前端用的（socket.io 之类），独立后没有宿主，整段删掉。
     留着它的唯一后果是多一个没人用的升级通道，还要处理错误，不如直接不给。 */

  /* 单实例保护：同时开两个监控 = 同一账号双倍请求 = 平台限流，
     表现就是"同条件拿到的商品比官方少很多"，所以这里直接拒绝第二个实例。 */
  srv.on("error",e=>{
    if(e&&e.code==="EADDRINUSE"){
      log("× 端口 "+port+" 已被占用：已经有一个监控在运行了。");
      log("  同时开两个监控会让同一个闲鱼账号被平台限流（表现：同一条件拿到的商品比官方少很多）。");
      log("  请关掉另一个监控窗口，只保留一个。");
      log("  已有界面: http://127.0.0.1:"+port+"/");
      /* 不在这里 spawn 浏览器：调用链上已经有一个实例开好界面了，
         再 spawn 只会让用户每双击一次图标就多叠一个标签页。 */
      setTimeout(()=>process.exit(2),1500);
      resolvePort(false);          /* 告诉调用方：别开浏览器了，本实例马上退 */
      return;
    }
    log("界面端口占用("+port+"): "+e.message);
    resolvePort(true);             /* 其他错误不阻塞后续流程，行为与旧版一致 */
  });
  srv.listen(port,"127.0.0.1",()=>{
    log("界面入口: http://127.0.0.1:"+port+"/");
    if(cfg.autoOpen!==false){
      try{ require("child_process").spawn("cmd",["/c","start","","http://127.0.0.1:"+port+"/"],{detached:true,stdio:"ignore",windowsHide:true}).unref(); log("已自动打开浏览器"); }catch(e){}
    }
    resolvePort(true);
  });
  });
}

/* 启动自检：如果上一次运行的日志末尾还在被限流，先静默 5 分钟再试探。
   原因：限流是"滑动窗口"，冷却期内每试探一次就把窗口往后推，越试越久。 */
function seedThrottleFromLog(){
  try{
    const lines=fs.readFileSync(LOGF,"utf8").trim().split(/\r?\n/).slice(-60);
    let lastPunishAt=0;
    for(const l of lines){
      if(!/RGV587|被挤爆|被平台限流/.test(l)) continue;
      /* 【修 BUG-M：端口占用提示被当成"正在被限流"】
         单实例保护那句提示（EADDRINUSE 分支）写的是
         「同时开两个监控会让同一个闲鱼账号被平台限流（表现：…少很多）」，
         里面有"被平台限流"四个字，正好命中上面的正则。
         后果：只要上一次运行是因为端口被占而退出的（用户双击两次图标、或换了新版本旧进程没退干净），
         下次正常启动就会读到这一行，判定「上次限流发生在 0 分钟前」→ 静默 300 秒才扫第一轮，
         用户看到的就是"程序启动后一直不扫，等五分钟才动"。
         这两类行必须排除：端口占用、以及限流相关的说明性文案（不是实际命中）。 */
      if(/已被占用|同时开两个监控|请关掉另一个监控窗口/.test(l)) continue;
      const m=l.match(/^\[(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})\]/);
      if(m){ const t=new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]).getTime(); if(t>lastPunishAt) lastPunishAt=t; }
    }
    if(!lastPunishAt) return;
    const ageMin=(Date.now()-lastPunishAt)/60000;
    /* 刚被限流（10 分钟内）→ 静默 5 分钟；已经静了一会儿 → 只静默 60 秒就可以试探一次 */
    const quietSec=ageMin<10?300:60;
    throttle.level=1; throttle.until=Date.now()+quietSec*1000;
    throttle.reason="上次运行末尾仍被限流（RGV587）"; throttle.at=new Date().toISOString();
    log("启动自检：上次限流发生在 "+ageMin.toFixed(0)+" 分钟前 → 先静默 "+quietSec+" 秒再试探（连打会把冷却窗口一直续上）。");
  }catch(e){}
}

/* 页面上是不是正弹着验证（滑块 / "请依次连出" 点选 / 安全验证弹窗）？
   只读 DOM innerText，不发请求、不点击 —— 用来判断"能不能人工去点验证"。
   注意：manualVerify / manualVerifyAt 已在文件上方（ensurePage 之前）声明，此处不再重复声明。 */
async function pageLooksChallenged(){
  try{
    if(!page||page.isClosed()) return false;
    return await page.evaluate(()=>{
      const t=((document.body&&document.body.innerText)||"");
      if(/请依次连出|拖动滑块|安全验证|点击完成验证|验证失败|滑块验证/.test(t)) return true;
      return !!(document.querySelector('.nc-container,.nc_iconfont,.nc_wrapper,#baxia-dialog-content,iframe[src*="punish"],iframe[src*="captcha"]'));
    });
  }catch(e){ return false; }
}

(async()=>{
  fs.mkdirSync(DATA,{recursive:true});
  log("=== 闲鱼扫货监控启动 ===");
  filterTreeLoad();
  try{ const _n=Object.keys(filterTreeCache).length; if(_n) log("筛选项缓存：已载入 "+_n+" 个关键词的官方筛选项"); }catch(e){}
  cleanStaleOnStart();
  seedThrottleFromLog();
  log("任务数: "+(cfg.tasks||[]).length+" | 间隔: "+cfg.intervalSeconds+"s(±"+cfg.jitterSeconds+"s)");
  if(!(cfg.tasks||[]).length){
    log("⚠ 当前没有配置任何搜索任务，程序不会抓取任何商品。请在面板「搜索设置 → ① 扫什么」里添加一个任务（搜索关键词/地区/价格）。");
  }
  /* 远程停用公告：启动时立刻查一次（fire-and-forget，内部自带 try/catch，绝不影响启动主链） */
  checkRemoteStatus(true);
  /* 先把界面端口抢下来，抢不到说明已经有实例在跑 —— 这时连浏览器都不碰，
     避免把自己刚拉起的 chromium 和共享的 data\browser-profile 配置锁搞坏。 */
  if(!(await startProxy())){
    log("本实例不启动浏览器：已有监控在运行，1.5 秒后退出。");
    return;
  }
  try{ await ensurePage(); }catch(e){ log("预热失败(稍后重试): "+e.message); }
  /* 【启动待命 2026-11-04】默认不立刻开扫：浏览器和登录态已经准备好了，但一个搜索请求都不发。
     想恢复老行为（启动即扫）把 config.json 里 startMode 改成 "auto"。 */
  if(cfg.startMode==="auto"){
    holdOn=false; holdSince=0; holdResumedAt=Date.now(); holdSave();
    log("   启动模式：自动开始（startMode=auto）");
  }else{
    holdSet(true,"boot");
    log("   启动模式：待命（startMode=hold）—— 已还原登录态，但本轮不会发任何搜索请求。");
    log("   点面板右上角「▶ 开始监控」，或托盘菜单「开始监控」开始扫。");
  }
  /* ---- 深度探针：node monitor.cjs --probe-depth ----
     回答"深翻页到底能不能超过 25 页、闲鱼给的上限在哪"。
     必须走 callSearch 本身，因为请求要靠页面拦下来的 baxia 风控令牌重签，
     自己拼签名一律 FAIL_SYS_ILLEGAL_ACCESS（已验证）。
     只读：不写 hits/seen/deep-state，只打日志 + 落 data\probe-depth.json。 */
  if(process.argv.indexOf("--probe-depth")>=0){
    const t0=(cfg.tasks||[]).find(t=>t.enabled!==false)||(cfg.tasks||[])[0]||{keyword:""};
    const PAGES=[1,2,3,5,10,20,24,25,26,27,28,30,35,40,45,50];
    const out=[];
    log("=== 深度探针开始：关键词「"+t0.keyword+"」，抽查 "+PAGES.length+" 个页码 ===");
    for(let i=0;i<PAGES.length;i++){
      const pg=PAGES[i];
      if(i) await nap(2500);
      let rows=-1,declared=null,hasNext=null,err="";
      try{
        const list=await callSearch(t0,pg);
        rows=list.length;
        declared=(pageMeta&&pageMeta.declared!=null)?pageMeta.declared:null;
        hasNext=(pageMeta&&pageMeta.hasNextPage!=null)?pageMeta.hasNextPage:null;
      }catch(e){ err=String(e&&e.message).slice(0,90); }
      out.push({pg:pg,rows:rows,declared:declared,hasNext:hasNext,err:err});
      log("  第"+String(pg).padStart(2)+"页: 拿到 "+String(rows).padStart(3)+" 条 | 服务端自报 "+declared+" | 还有下页="+hasNext+(err?(" | 错误="+err):""));
    }
    try{ writeJSON(path.join(DATA,"probe-depth.json"),{at:new Date().toISOString(),task:t0.name,keyword:t0.keyword,pages:out}); }catch(e){}
    const got=out.filter(x=>x.rows>0).length;
    const empty=out.filter(x=>x.rows===0).map(x=>x.pg);
    log("=== 探针结论：有数据的页 "+got+"/"+out.length+"；空页 "+JSON.stringify(empty)+" ===");
    log("=== 若 26 页以后仍有 30 条，说明 deepMaxPages 可提到 50 走满 1500 条硬上限 ===");
    try{ await ctx.close(); }catch(e){}
    process.exit(0);
  }
  let round=0;  while(!stop){
    /* 【远程停用公告 2026-11-05】每隔几小时检查一次开发者状态文件（内部自带时间节流，
       不会每轮都请求）。放最前面：即使处于待命/停用，也能检测到开发者已恢复为 ok。 */
    try{ await checkRemoteStatus(false); }catch(e){}
    /* 【启动待命 2026-11-04】待命期间绝不动网：不发搜索、不探卖家主页、不推手机。
       每秒醒一次检查状态，所以点「开始监控」会【立刻】开始，不用等 nap 走完。 */
    if(holdOn){
      if(nextScanAt!==null) nextScanAt=null;
      await nap(1000);
      continue;
    }
    /* 【连点保护 2026-11-04】刚扫过就被点「开始监控」时，在这里先等够间隔再开跑，
       期间不发任何搜索请求。若中途又被点「暂停」，循环立刻退出（holdOn 变 true）。 */
    if(resumeNotBefore){
      const __l0=resumeNotBefore-Date.now();
      if(__l0>0){
        log("⏳ 连点保护：刚扫过，顺延 "+Math.ceil(__l0/1000)+" 秒再开始本轮（这段时间不会发出任何搜索请求）");
        while(!stop&&!holdOn&&(resumeNotBefore-Date.now())>0){
          nextScanAt=new Date(resumeNotBefore).toISOString();
          await nap(Math.min(1000,Math.max(50,resumeNotBefore-Date.now())));
        }
      }
      resumeNotBefore=0;
      nextScanAt=null;
      if(holdOn) continue;   /* 顺延等待期间又被点「暂停」→ 回顶部继续待命，这一轮不开跑 */
    }
    round++;
    roundNo=round;
    /* 每 60 轮（约 4 小时）顺手看一眼 Code Cache 是否又涨过阈值 */
    if(round%60===0){ try{ sweepCodeCache("第 "+round+" 轮"); }catch(e){} }
    /* 同时收一次 data 里的过期归档快照和 .bak（只删 7 天前的、只留最新 1 份归档） */
    if(round%60===0){ try{ sweepDataJunk("第 "+round+" 轮"); }catch(e){} }
    /* 人工验证等待：页面正弹着验证时，绝不导航/刷新/点击 —— 否则用户永远验证不过去。
       改进（v2026-10-19）：
       ① 每轮检查间隔仍为 60s，但单次等待最少给足 120s（用户点滑块需要时间，旧版几秒就跳走）
       ② 验证通过后【延迟 60s 再发请求】：刚过验证立刻扫等于立刻又触发风控
       ③ 全程不退出进程 —— 旧版这里会 continue 到轮末，若 meanwhile 抛错就整个没了 */
    if(manualVerify){
      /* 至少让用户有 120s 的操作窗口，再判断验证是否通过 */
      const elapsed=Date.now()-(manualVerifyAt||Date.now());
      if(elapsed<120000&&(await pageLooksChallenged())){
        const left=Math.ceil((120000-elapsed)/1000);
        log("人工验证等待中：请在浏览器窗口完成验证（还需等待最多 "+left+"s 后自动检测）…");
        nextScanAt=new Date(Date.now()+30000).toISOString();
        await nap(30000);
        if(stop) break;
        continue;
      }
      if(!(await pageLooksChallenged())){
        manualVerify=false;
        log("验证页已消失 → 验证通过。为避免刚过验证又触发风控，静默 60s 后恢复扫描。");
        /* 之前为了过验证切成了可见窗口，这里自动收起，回到无窗口模式 */
        if(VISIBLE_OVERRIDE){
          VISIBLE_OVERRIDE=false;
          try{ await saveCookies(); }catch(e){}
          try{ await ctx.close(); }catch(e){}
          ctx=null; page=null;
          log("         已收回可见窗口，恢复无窗口模式（下一轮自动重开）。");
        }
        /* 验证刚通过就立刻请求 = 立刻又被挤爆。必须冷却一段。 */
        throttle.until=Math.max(throttle.until||0,Date.now()+60000);
        throttle.reason="验证刚通过，冷却 60s";
        nextScanAt=new Date(Date.now()+60000).toISOString();
        await nap(60000);
        if(stop) break;
        continue;
      }else{
        const mins=Math.max(1,Math.round((Date.now()-manualVerifyAt)/60000));
        log("人工验证仍未完成（已 "+mins+" 分钟）：本轮不扫描、不刷新页面 —— 请在浏览器窗口里完成验证。");
        nextScanAt=new Date(Date.now()+60000).toISOString();
        await nap(60000);
        if(stop) break;
        continue;
      }
    }
    /* 冷却期没到就先等，别去试探：限流是滑动窗口，冷却期内每试探一次都会把窗口往后推 */
    const preCool=(throttle.until||0)-Date.now();
    if(preCool>0){
      log("限流冷却中：第 "+round+" 轮先静默 "+(preCool/1000).toFixed(0)+"s（第 "+throttle.level+" 级退避）");
      nextScanAt=new Date(Date.now()+preCool).toISOString();
      const __pc=await napBreakable(preCool);
      if(__pc==="stop") break;
      if(__pc==="hold") continue;
    }
    log("--- 第 "+round+" 轮（"+(process.env.SCAN_MODE_TAG||((cfg.noWindow!==false&&VISIBLE_OVERRIDE===false)?"无窗口":"有头"))+"）---");
    /* 把本轮结果记下来给「体检」用：成功/异常都要留痕，否则面板只能显示"最后一轮很久以前"，
       分不清是"卡住了"还是"每轮都报错"。 */
    lastRoundAt=Date.now();
    try{
      const r=await scanOnce();
      lastRoundErr="";
      lastRoundFresh=(r&&Number(r.fresh))||0;
      lastRoundSeeded=(r&&Number(r.seeded))||0;
    }catch(e){
      lastRoundErr=String((e&&e.message)||e).slice(0,300);
      log("本轮异常: "+e.message);
    }
    lastRoundDoneAt=Date.now();
    /* 【2026-11-05 自动重建会话】一轮扫完之后判一次"是不是只拿到旧数据"。
       触发条件全部满足才动手：
         · 有新数据口径（newestAgoMinutes）可用，且 >= 5 小时
         · 没在限流退避里（throttle.level 0 且冷却已过）——风控期重建只会更糟
         · 登录态没掉（loginBad 为假）——掉了是另一条路径，该重登不是重建
         · 没被判少返（throttled 为假）
         · 本次运行重建次数没到上限
       任意一条不满足就只累计/清零，不动浏览器。 */
    if(!stop&&!manualVerify){
      /* 注意：newestAgoMinutes 可能是 null（本轮所有任务都失败/没拿到数据）。
         Number(null)=0 是有限数，会被下面的 isFinite 判成"新鲜"，从而把陈旧计数误清零。
         所以先判空再转数字，拿不到就当作"无结论"，既不累计也不清零。 */
      const __agoRaw=freshInfo.newestAgoMinutes;
      const __ago=(__agoRaw==null||__agoRaw==="")?NaN:Number(__agoRaw);
      const __coolLeft=Math.max(0,(throttle.until||0)-Date.now());
      const __canRebuild=(__coolLeft<=0&&Number(throttle.level||0)===0
        &&freshInfo.loginBad!==true&&!freshInfo.throttled
        &&sessionRebuilds<SESSION_REBUILD_MAX);
      if(isFinite(__ago)&&__ago>=STALE_MIN_AGO){
        staleRounds++;
        log("   数据陈旧判定：连续 "+staleRounds+"/"+STALE_ROUNDS_TO_REBUILD+" 轮（接口最新 "+__ago+" 分钟前）"
          +(__canRebuild?"":" · 本轮不重建（限流中或登录态异常或已达上限）"));
        if(staleRounds>=STALE_ROUNDS_TO_REBUILD&&__canRebuild){
          try{ await hardRebuildSession(__ago+" 分钟前"); }catch(e){ log("   → 重建会话异常: "+String(e&&e.message||e).slice(0,80)); }
        }
      }else if(isFinite(__ago)&&staleRounds>0){
        log("   ✔ 数据已恢复新鲜（接口最新 "+__ago+" 分钟前），陈旧计数归零");
        staleRounds=0;
      }
    }
    /* 扫完之后补查卖家主页（第三路商贩信号）。
       放在这里而不是 scanOnce 里面，是因为它要单独占 page、不能被扫描的等待打断；
       而且它自带限速和连败退避，出问题也只会跳过，不影响主流程。
       限流冷却期内不查 —— 那会儿本来就跟风控贴着，别再去加码。 */
    if(!stop&&!manualVerify&&!((throttle.until||0)>Date.now())){
      try{ await probeSellerProfilesRound(); }catch(e){ log("   [主页信号] 跳过: "+String(e&&e.message).slice(0,80)); }
    }
    const base=(cfg.intervalSeconds||90)*1000;
    const jit=Math.round(((cfg.jitterSeconds||30)*1000)*(Math.random()*2-1));
    let wait=Math.max(15000,base+jit);
    /* 被限流时退避：这一轮剩下的时间不扫，等风控冷却 */
    const cool=(throttle.until||0)-Date.now();
    if(cool>0){
      wait=Math.max(wait,cool);
      log("限流冷却中：本轮改为等待 "+(wait/1000).toFixed(0)+"s（第 "+throttle.level+" 级退避）");
    }
    nextScanAt=new Date(Date.now()+wait).toISOString();
    log("等待 "+(wait/1000).toFixed(0)+"s 后下一轮");
    const __wait=await napBreakable(wait);
    if(__wait==="stop") break;
    if(__wait==="hold") continue;   /* 等待期间点了暂停 → 回顶部进待命，立刻生效 */
  }
})().catch(e=>{ log("FATAL "+(e&&e.message)); process.exit(1); });
/* ===== 快速关闭（修复关窗口卡顿） ===== */
/* ===== 浏览器进程清理（全部非阻塞，避免关闭卡顿） ===== */
const {spawn:spawnAsync,execSync}=require("child_process");

/* 快速判断有没有残留（tasklist 约 96ms，没有就秒回） */
function hasStaleBrowsers(){
  try{
    const out=execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH /FO CSV',{windowsHide:true,encoding:"utf8",timeout:4000});
    return /chrome\.exe/i.test(out);
  }catch(e){ return false; }
}

/* 后台异步清理：不等待，不影响退出速度 */
function killByProfileAsync(){
  try{
    /* browser-profile 是取数浏览器；login-profile 是面板扫码登录用的那个独立 profile。
       两个都要清，否则退出后会留在后台占内存。 */
    const ps="Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'chrome*' -and $_.CommandLine -and ($_.CommandLine.Contains('browser-profile') -or $_.CommandLine.Contains('login-profile')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    const b64=Buffer.from(ps,"utf16le").toString("base64");
    spawnAsync("powershell",["-NoProfile","-WindowStyle","Hidden","-EncodedCommand",b64],
      {detached:true,stdio:"ignore",windowsHide:true}).unref();
  }catch(e){}
}

/* 启动时清理残留（仅当确实有残留才做重操作） */
/* 【定期清理浏览器缓存】--disk-cache-size=268435456 只管 Default\Cache，
   管不了 Default\Code Cache（V8 编译缓存，另一套淘汰策略）。
   实测跑到 333.6 MB + 60.5 MB = 394 MB 不回落，而 Code Cache 纯属可再生的编译产物，
   删掉只会让下一轮首屏慢一两秒。这里只删 Code Cache 下的文件、不删目录
   （目录被浏览器持有句柄，删目录会让 Chromium 下次启动报错）。
   触发时机：启动时一次 + 每 60 轮一次（约 4 小时），且只在超过阈值时才动手。 */
function sweepCodeCache(why){
  /* ※ 阈值常量必须写在函数体内，不能提到模块顶层 ——
     顶层 const 在 IIFE 调用 cleanStaleOnStart()（第 4477 行）时还处于 TDZ：
     函数声明会被提升、能正常调用，但函数体里一读那个顶层 const 就抛 ReferenceError，
     再被上层 catch(e){} 静静吞掉。实测：启动那次清理从来没真的跑过，
     Code Cache 一直涨到 333 MB 都没人删。放函数内即可根治。 */
  const LIMIT=80*1024*1024;
  const cc=path.join(DATA,"browser-profile","Default","Code Cache");
  let total=0, files=[];
  (function walk(d){
    let es; try{ es=fs.readdirSync(d); }catch(e){ return; }
    for(const e of es){
      const f=path.join(d,e);
      let s; try{ s=fs.lstatSync(f); }catch(err){ continue; }
      if(s.isDirectory()){ walk(f); }
      else { total+=s.size; files.push(f); }
    }
  })(cc);
  if(total<LIMIT) return 0;
  let n=0, bytes=0;
  for(const f of files){
    try{ const s=fs.statSync(f); fs.unlinkSync(f); n++; bytes+=s.size; }catch(e){}
  }
  if(n) log("🧹 Code Cache 清理（"+why+"）：删掉 "+n+" 个文件 / "+(bytes/1048576).toFixed(1)+" MB（原 "+(total/1048576).toFixed(1)+" MB）");
  return n;
}

/* 【data 目录垃圾清理 2026-10-29】
   实测 data\ 里有两类只增不减的东西：
   ① hits.before-clear-<时间戳>.json / hits.before-regionprune-<时间戳>.json ——
      每次「清空列表」「改条件清库」都 copyFileSync 一份。实测堆了 8 份 / 5.85 MB，
      其中最新一份 2.1 MB。这 8 份合计 3715 条、去重 3092 个 itemId，
      只有 95 个还在当前列表里 —— 97% 是早就清掉的旧货，全文件没有任何代码读它们。
   ② *.bak —— writeJSON 每次写盘前都复制一份，永久留着。
      这些是「这次写坏了还能退回上一次」的保险，但只对最近一次写有意义；
      实测堆了 18 个 / 3.00 MB，最老的已经好几天。
   策略：
   · 归档快照只留最新 1 份（后悔药），其余删掉；
   · .bak 只删 7 天以上没动过的，且绝不删 seller-blocklist.json.bak
     （那份存着 162 个手动拉黑的卖家，而当前 seller-blocklist.json 是空的），
     也不碰手工命名的 *.bak-<日期> 备份。
   跑两次：启动时一次（此时没有并发写盘），之后每 60 轮一次。 */
function sweepDataJunk(why){
  /* ※※ 关键：本函数在第 4477 行的启动 IIFE 里就会被调用，
     而上面这三个 const 定义在同一行号之后 —— 那时它们还处于 TDZ（暂时性死区）。
     JS 的函数声明会被提升、能正常调用，但函数体里一读那些顶层 const 就抛
     ReferenceError，再被 cleanStaleOnStart 的 catch(e){} 静静吞掉，
     表现就是「代码明明写了、日志一句没有、文件一个没删」。
     第一次上线就是这么翻车的。所以函数体内一律先用字面量兜底，绝不在初始化前读外层 const。 */
  const KEEP=1;
  const BAK_DAYS=7;
  const NEVER=["seller-blocklist.json.bak"];
  let nFiles=0, bytes=0;
  /* ① 归档快照：按修改时间倒序，留最新 KEEP 份 */
  try{
    const arcs=fs.readdirSync(DATA).filter(function(n){ return /^hits\.before-.*\.json$/.test(n); });
    if(arcs.length>KEEP){
      const list=arcs.map(function(n){
        const f=path.join(DATA,n);
        let t=0, s=0;
        try{ const st=fs.statSync(f); t=st.mtimeMs; s=st.size; }catch(e){ return null; }
        return { f:f, n:n, t:t, s:s };
      }).filter(Boolean).sort(function(a,b){ return b.t-a.t; });
      for(let i=KEEP;i<list.length;i++){
        try{ fs.unlinkSync(list[i].f); nFiles++; bytes+=list[i].s; }catch(e){}
      }
    }
  }catch(e){}
  /* ② 过期 .bak */
  try{
    const cut=Date.now()-BAK_DAYS*86400000;
    for(const n of fs.readdirSync(DATA)){
      if(!/\.bak$/.test(n)) continue;                        /* 只认严格的 .bak，不碰 .bak-20261028 这类手工备份 */
      if(NEVER.indexOf(n)>=0) continue;
      const f=path.join(DATA,n);
      let st; try{ st=fs.statSync(f); }catch(e){ continue; }
      if(!st.isFile()||st.mtimeMs>=cut) continue;
      try{ fs.unlinkSync(f); nFiles++; bytes+=st.size; }catch(e){}
    }
  }catch(e){}
  if(nFiles) log("🧹 data 目录清理（"+why+"）：删掉 "+nFiles+" 个过期文件 / "+(bytes/1048576).toFixed(2)+" MB（归档快照只留最新 "+KEEP+" 份，"+BAK_DAYS+" 天前的 .bak 清掉）");
  return nFiles;
}

function cleanStaleOnStart(){
  try{
    /* 启动先扫一次缓存（此时浏览器还没起来，文件句柄全是空闲的，删得最干净） */
    try{ sweepCodeCache("启动"); }catch(e){}
    try{ sweepDataJunk("启动"); }catch(e){}
    if(!hasStaleBrowsers()) return;
    log("检测到上次残留的浏览器进程，正在清理...");
    killByProfileAsync();
  }catch(e){}
}

/* 退出：先等浏览器干净关闭（实测约 60ms），再兜底清理，然后退出 */
let shuttingDown=false;
async function shutdown(code,reason){
  if(shuttingDown) return; shuttingDown=true; stop=true;
  /* 只在"用户主动停"时才写退出标记；崩溃走的是 process 级异常，根本到不了这里，
     所以 guard.cjs 看不到标记 = 意外死亡 = 该推告警。 */
  try{ if(reason) writeExitMark(reason); }catch(e){}
  loginSessClose();
  try{
    if(ctx){ const _c=ctx; ctx=null; _c.close().catch(function(){}); }
  }catch(e){}
  /* 不 await ctx.close()：Chromium 8~11 个子进程时 close 会阻塞 1~3 秒，
     端口迟迟不放，托盘「退出程序」干等。改成 fire-and-forget，
     配合 killByProfileAsync（独立 PowerShell 兜底收 Chromium）立刻放端口。 */
  killByProfileAsync();
  process.exit(code||0);
}
/* 控制台关闭时收尾：仅在真控制台(TTY)下启用 */
try{
  if(process.stdin.isTTY){
    process.stdin.on("end",function(){ shutdown(0,"window"); });
    process.stdin.on("close",function(){ shutdown(0,"window"); });
    process.stdin.resume();
  }
}catch(e){}

/* ===== 【全局异常兜底 2026-11-03】 =====
   为什么加：本文件此前 **一个 process.on 都没有**（guard.cjs 四个都有）。
   Node 24 遇到没人接的 Promise 异常，默认行为是【直接杀进程且不写日志】——
   表现就是监控突然没了，monitor.log 里最后一行还是上一轮的「等待 N s 后下一轮」，
   什么线索都没有，只能看 guard.log 才知道「哦，它死了」。
   分两类对待：
     · unhandledRejection：单个异步调用漏了 await 之类，进程状态本身没问题
       → 只记日志 + 推一条告警，【不退出】，下一轮照常扫。这是最常见的。
     · uncaughtException：同步代码抛到顶层，状态可能已经脏了
       → 记日志后走 shutdown(1,"crash")，让 guard 干净地拉一个新的。
   注意 reason 不能传 "stop"/"window"/"parent"/"relogin" ——
   那几个在 guard.cjs 的「用户主动停」白名单里，传了就不会告警、也不拉起来。 */
let __rejCount=0;
process.on("unhandledRejection",function(reason){
  __rejCount++;
  const msg=String((reason&&(reason.stack||reason.message))||reason).slice(0,500);
  try{ log("⚠ 未捕获的异步异常（第 "+__rejCount+" 次，已忽略并继续运行）: "+msg); }catch(e){}
  /* 只在前 3 次推手机，避免某个每轮都失败的点把人吵死 */
  if(__rejCount<=3){
    try{ sendAlert("程序内部出现未捕获异常但仍在运行",
      "这是第 "+__rejCount+" 次。监控没有退出，扫描会继续。\n\n"+msg.slice(0,300)+"\n\n如果反复出现，把这行日志发给开发者。"); }catch(e){}
  }
});
process.on("uncaughtException",function(err){
  const msg=String((err&&(err.stack||err.message))||err).slice(0,500);
  try{ log("✖ 未捕获的同步异常，准备重启: "+msg); }catch(e){}
  try{ sendAlert("程序崩溃，正在自动重启", String((err&&err.message)||err).slice(0,300)); }catch(e){}
  /* 给日志和告警 1.5 秒落地时间，再走正常收尾流程（不写退出标记 → guard 会拉起来） */
  setTimeout(function(){ try{ shutdown(1,"crash"); }catch(e){ process.exit(1); } },1500);
});
process.on("SIGINT",function(){ try{ log("收到 SIGINT（Ctrl+C），准备退出"); }catch(e){} shutdown(0,"signal"); });
process.on("SIGTERM",function(){ try{ log("收到 SIGTERM（被要求结束进程），准备退出"); }catch(e){} shutdown(0,"signal"); });
/* ===== 父进程守护（解决关窗口卡顿的关键） =====
   Windows 关闭控制台窗口时，node 常常收不到信号，
   导致上层 cmd/powershell 一直等它（最长 5 秒宽限期）——这就是"卡"。
   这里每 400ms 检查父进程是否还在，一旦消失立刻收尾。
   ※ 后台/无人值守启动（比如从别的程序里拉起来）时，把环境变量 SCAN_KEEP_ALIVE 设为 1，
     就跳过这个守护 —— 否则上层短暂的 shell 一退出，监控会跟着退出。 */
try{
  /* 【修 BUG-O：父进程守护过于激进】
     ① process.ppid 在模块顶层求值。若监控是被计划任务 / 服务管理器 / 某个启动器拉起来的，
        而那个父进程自己很快就退出了，这里 250ms 内就判定"上层窗口已关闭"→ shutdown(0)，
        程序启动即退，用户完全看不出原因（日志里只有一句"上层窗口已关闭，正在退出..."）。
     ② 旧逻辑只要 process.kill 抛异常就算死。权限不足（EPERM）也会抛 —— 那并不代表父进程没了。
     修法：延迟 5 秒再开始守护（给父进程链留出退出/交接时间），并且只认 ESRCH（真正不存在）。 */
  /* 【修 BUG-P：被启动器拉起时必自杀】——这是"点了【立即重新登录】之后程序再也起不来"的真正原因。
     `3-重新登录并恢复.cmd` 末尾曾经是 `start "" cmd /c "1-启动监控.cmd"`（该脚本已废弃，现在直接起 monitor），
     那个 cmd 只是个一次性中转，它跑完就退；而它自己没有设 SCAN_KEEP_ALIVE，
     于是新起的 monitor 的 process.ppid 正是这个短命 cmd → 5 秒后 ESRCH → 自己退出。
     表现为：登录窗口关掉、监控窗口一闪就没、面板打不开，用户只看到"启动不了 / 没登录"。

     判定改成看"我是不是在真控制台里被前台运行"：
       · process.stdin.isTTY === true  → 用户双击 .cmd 得到的前台黑窗口，守护有意义（关窗口要收尾）
       · 否则（start / Start-Process / spawn / 计划任务 / .vbs / 任何 launcher）
         → 父进程只是中转，跟本进程的存活无关，一律不守护
     环境变量 SCAN_KEEP_ALIVE 现在只用于"TTY 下也强制不守护"（双向都成立）。 */
  const PARENT_PID=process.ppid;
  const interactiveConsole=(function(){ try{ return !!process.stdin.isTTY; }catch(e){ return false; } })();
  if(process.env.SCAN_KEEP_ALIVE==="1"){
    log("后台模式：已跳过父进程守护（SCAN_KEEP_ALIVE=1），关闭上层窗口不会影响监控。");
  }else if(!interactiveConsole){
    log("已跳过父进程守护（非前台控制台启动，父进程只是启动器，它的退出与本进程无关）。");
  }else if(PARENT_PID&&PARENT_PID>0){
    let guard=null;
    const arm=setTimeout(function(){
      guard=setInterval(function(){
        let dead=false;
        try{ process.kill(PARENT_PID,0); }
        catch(e){ if(e&&e.code==="ESRCH") dead=true; }   /* 只有"进程不存在"才算退出 */
        if(dead){
          clearInterval(guard);
          log("上层窗口已关闭，正在退出...");
          shutdown(0,"parent");
        }
      },250);
      if(guard.unref) guard.unref();
    },5000);
    if(arm.unref) arm.unref();
  }
}catch(e){}
