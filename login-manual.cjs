const path=require("path"),fs=require("fs");
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
/* 浏览器目录从 PW 反推，别指望 .cmd 帮忙 export —— 这个脚本会被
   3-重新登录并恢复.cmd 直接拉起，也可能被面板按钮间接拉起，不一定有 cmd 设变量。 */
if(!process.env.PLAYWRIGHT_BROWSERS_PATH){
  try{
    const b=path.join(path.dirname(path.dirname(PW)),"playwright-browsers");
    if(fs.existsSync(b)) process.env.PLAYWRIGHT_BROWSERS_PATH=b;
  }catch(e){}
}
const {chromium}=require(PW);
const ROOT=path.resolve(__dirname);
const DATA=path.join(ROOT,"data");
const LOGF=path.join(DATA,"login-manual.log");
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const T0=Date.now();
const log=(...a)=>{const l="["+((Date.now()-T0)/1000).toFixed(1)+"s] "+a.join(" ");console.log(l);try{fs.appendFileSync(LOGF,l+"\r\n")}catch(e){}};

async function state(ctx,page){
  const all=await ctx.cookies();
  const have=new Set(all.map(c=>c.name));
  const unb=(all.find(c=>c.name==="unb")||{}).value||"";
  const strong=["havana_lgc2_77","_hvn_lgc_","csg","aui","cnaui"].filter(k=>have.has(k));
  let nick="";
  try{
    nick=await page.evaluate(()=>{
      const sels=['[class*="user-name"]','[class*="userName"]','[class*="nick"]','[class*="userInfo"]','[class*="user-info"]'];
      for(const s of sels){ for(const e of document.querySelectorAll(s)){ const t=(e.textContent||"").trim(); if(t&&t.length<=24) return t; } }
      return "";
    });
  }catch(e){}
  return {unb,strong,nick,count:all.length,uiLogged:!!nick&&nick.indexOf("登录")<0};
}

/* 登录成功后在同一个浏览器会话里立刻验证：用"最新发布 + 价格 1000-2000"请求，
   看接口能给到多新的商品。这一步必须在登录态还活着的时候做，否则结论无效。 */
const crypto=require("crypto"),APPKEY="34839810";
const md5=s=>crypto.createHash("md5").update(String(s)).digest("hex");
async function probeFreshness(ctx,page){
  const WANT={pageNumber:1,keyword:"苹果15",fromFilter:true,rowsPerPage:30,sortValue:"desc",sortField:"create",
    customDistance:"",gps:"",propValueStr:{searchFilter:"priceRange:1000,2000;"},customGps:"",
    searchReqFromPage:"pcSearch",extraFilterValue:"{}",userPositionJson:"{}"};
  const raw=await new Promise(resolve=>{
    let settled=false;
    const done=v=>{if(!settled){settled=true;try{page.off("response",onResp)}catch(e){}try{page.unroute("**/*idlemtopsearch*",onRoute)}catch(e){}resolve(v);}};
    const onRoute=async route=>{
      const r=route.request(),u=new URL(r.url()),pd=r.postData()||"",m=/data=([^&]*)/.exec(pd);
      if(m&&u.pathname.indexOf("idlemtopsearch.pc.search/1.0")>=0){
        try{
          const obj=JSON.parse(decodeURIComponent(m[1]));
          Object.keys(WANT).forEach(k=>{obj[k]=WANT[k];});
          const nd=JSON.stringify(obj),t=u.searchParams.get("t");
          /* 【修 BUG-Q】按域取 goofish 的 _m_h5_tk：同一个 ctx 里 .taobao.com 也有一份同名 cookie，
             find() 抓第一个可能抓到淘宝那份，sign 必错 → FAIL_SYS_ILLEGAL_ACCESS。 */
          const token=(function(list){
            const tk=(Array.isArray(list)?list:[]).filter(c=>c&&c.name==="_m_h5_tk");
            if(!tk.length) return "";
            tk.sort(function(a,b){
              const sc=c=>{const d=String(c.domain||"").toLowerCase();
                if(d==="www.goofish.com") return 0;
                if(d==="goofish.com"||d===".goofish.com") return 1;
                if(d.indexOf("goofish")>=0) return 2;
                if(d.indexOf("taobao")>=0||d.indexOf("tmall")>=0) return 9;
                return 5;};
              return sc(a)-sc(b);
            });
            return String(tk[0].value||"").split("_")[0];
          })(await ctx.cookies());
          u.searchParams.set("sign",md5(token+"&"+t+"&"+APPKEY+"&"+nd));
          const keep=String(pd).split("&").map(sg=>sg.slice(0,5)==="data="?"data="+encodeURIComponent(nd):sg).join("&");
          return route.continue({url:u.toString(),postData:keep});
        }catch(e){}
      }
      return route.continue();
    };
    const onResp=async r=>{if(r.url().indexOf("idlemtopsearch.pc.search/1.0")<0)return;try{done(await r.text());}catch(e){}};
    page.route("**/*idlemtopsearch*",onRoute).then(()=>{
      page.on("response",onResp);
      page.goto("https://www.goofish.com/search?q="+encodeURIComponent("苹果15")+"&__z="+Date.now(),{waitUntil:"domcontentloaded",timeout:45000}).catch(()=>done(""));
    });
    setTimeout(()=>done(""),35000);
  });
  let j;try{j=JSON.parse(raw);}catch(e){return {err:"响应非JSON: "+String(raw).slice(0,80)};}
  const list=(j.data&&j.data.resultList)||[];
  const rows=[];
  for(const it of list){
    const a=((((it.data||{}).item||{}).main||{}).clickParam||{}).args||{};
    const v=Number(a.publishTime||0); if(!v)continue;
    rows.push({t:v,p:a.price||"?",ttl:(a.title||"").slice(0,24)});
  }
  rows.sort((a,b)=>b.t-a.t);
  const m=rows[0]?Math.round((Date.now()-rows[0].t)/60000):null;
  return {ret:(j.ret||[]).join("|").slice(0,40),n:list.length,newestMin:m,
    newestTxt:m===null?"无":(m<1?"刚刚发布":(m<60?m+" 分钟前":(m/60).toFixed(2)+" 小时前")),top:rows.slice(0,5)};
}

(async()=>{
  fs.mkdirSync(DATA,{recursive:true}); fs.writeFileSync(LOGF,"");
  const ctx=await chromium.launchPersistentContext(path.join(DATA,"browser-profile"),{
    headless:false, userAgent:UA, locale:"zh-CN", viewport:{width:1180,height:860},
    args:["--ignore-certificate-errors","--no-sandbox","--disable-blink-features=AutomationControlled",
          "--window-position=80,40","--window-size=1220,920","--no-first-run","--no-default-browser-check",
          "--disk-cache-size=268435456"]
  });
  const page=ctx.pages()[0]||await ctx.newPage();
  page.setDefaultTimeout(30000);

  await page.goto("https://www.goofish.com/",{waitUntil:"domcontentloaded",timeout:60000});
  await sleep(6000);

  let st=await state(ctx,page);
  log("初始状态: unb="+(st.unb||"无")+" | cookie数="+st.count+" | 完整标记="+(st.strong.length?st.strong.join(","):"无")+" | 页面昵称="+(st.nick||"未识别"));

  if(st.uiLogged&&st.unb){
    log("已经登录好了: "+st.nick);
  } else {
    log("未登录 —— 正在弹出登录框，请在弹出的窗口里登录（手机扫码 或 密码登录都可以）");
    let clicked=false;
    for(let k=0;k<15&&!clicked;k++){
      try{
        const btn=await page.evaluate(()=>{
          const els=[...document.querySelectorAll("div,button,span,a")].filter(e=>e.offsetParent&&(e.textContent||"").trim()==="登录");
          if(!els.length) return null;
          const e=els.sort((a,b)=>a.getBoundingClientRect().width-b.getBoundingClientRect().width)[0];
          const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
        });
        if(btn){ await page.mouse.click(btn.x,btn.y); clicked=true; log("已点击页面上的【登录】按钮，登录框应该弹出来了"); }
        else await sleep(2000);
      }catch(e){ await sleep(2000); }
    }
    if(!clicked) log("没自动找到【登录】按钮，请自己在窗口里点右上角【登录】");
  }

  log("=== 请在弹出的浏览器窗口里完成登录，我在这里等你（最多 20 分钟）===");
  let lastMsg="";
  for(let i=0;i<240;i++){
    await sleep(5000);
    try{
      const cur=await state(ctx,page);
      if(cur.uiLogged&&cur.unb){
        log("登录成功 ✓ 页面显示: "+cur.nick+" | 完整标记: "+(cur.strong.join(",")||"无")+" | cookie数="+cur.count);
        try{
          const cs=await ctx.cookies();
          fs.writeFileSync(path.join(DATA,"cookies.json"),JSON.stringify(cs,null,1));
          const have=new Set(cs.map(c=>c.name));
          log("已把完整 cookie 存到 data\\cookies.json（含会话级 cookie："+["_l_g_","cookie17","_nk_","uc1","munb"].filter(k=>have.has(k)).join(",")+"）—— 这是关键，之前每次正常关闭浏览器都会把这些会话 cookie 丢掉，所以网站一直把我们当游客");
        }catch(e){ log("存 cookie 失败: "+String(e.message).slice(0,80)); }
        // 注意：不能用 ctx.close() 正常关闭，否则 Chromium 会删掉会话 cookie；
        // 这里先落盘再让监控启动时用 addCookies 还原。
        log("=== 立刻在同一个浏览器会话里验证数据新鲜度（最新发布 + 价格 1000-2000）===");
        const fr=await probeFreshness(ctx,page);
        if(fr.err){ log("验证失败: "+fr.err); }
        else{
          log("  ret="+fr.ret+" | 条数="+fr.n);
          log("  → 最新一条 = "+fr.newestTxt);
          for(const r of (fr.top||[])) log("     "+Math.round((Date.now()-r.t)/60000)+" 分钟前  ¥"+r.p+"  "+r.ttl);
          log("  → 结论："+((fr.newestMin!==null&&fr.newestMin<90)?"✅ 登录后能拿到【刚刚发布】级的最新数据（问题解决）":"❌ 即使真登录了，接口给的最新仍是 "+fr.newestTxt+"（说明登录态不是原因）"));
        }
        log("浏览器窗口 15 秒后自动关闭，登录态已保存，之后双击【1-启动监控.cmd】即可");
        await sleep(15000);
        try{ process.kill(ctx.browser().process().pid); }catch(e){ try{ await ctx.close(); }catch(_){} }
        return;
      }
      const tag=(cur.unb?"有unb":"无unb")+"/"+cur.count+"cookie/"+(cur.strong.length?cur.strong.join(","):"无标记")+"/昵称:"+(cur.nick||"无");
      if(tag!==lastMsg){ lastMsg=tag; log("  等待中... "+tag); }
      if(i%24===23) log("  已等待 "+((i+1)*5)+" 秒，仍在等你登录");
    }catch(e){}
  }
  log("等待超时，退出。请重新运行本程序。");
  await ctx.close();
})().catch(e=>{ console.error("FATAL",e&&e.message); try{fs.appendFileSync(LOGF,"FATAL "+e.message+"\r\n")}catch(_){} process.exit(1); });
