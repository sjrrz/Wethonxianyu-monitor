# 闲鱼扫货监控（便携版）

一个跑在 Windows 上的闲鱼（goofish）商品监控：定时翻搜索页 → 按关键词/地区/价格/官方筛选项/屏蔽词过滤 → 算综合分 → 有新命中就推到手机，自带本地网页面板。

- **零 npm 依赖**：Node 和 Chromium 都内置在 `runtime\` 里，无需安装任何环境。
- **双击即用**：解压后双击 `闲鱼扫货监控.exe`，右下角常驻托盘，右键启停。
- **支持动态筛选**：搜什么关键词，就自动出现闲鱼官方对应的筛选项（搜「苹果」出品牌/内存/容量，搜「相机」出品牌/传感器/像素）。
- **多推送渠道**：Bark（iOS）、Server酱、企业微信群机器人、飞书群机器人、Gotify、自定义 Webhook。

---

## 作者与协议

- 作者：**Wethon**
- 协议：[MIT](./LICENSE)（保留版权与作者署名）
- 版本：v1.0.0

---

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11（Windows 7 未验证） |
| .NET | 4.x（Windows 10/11 自带） |
| Node / Chrome | 无需安装，全部内置在 `runtime\` |
| 首次使用 | 需要手机闲鱼 App 扫码登录一次 |

---

## 快速开始

1. 下载 **Releases 里的完整包**（含 `runtime\`，约 1 GB），解压到任意目录（建议不含中文和空格，例如 `D:\xianyu-monitor`）。
2. 双击 `闲鱼扫货监控.exe`，右下角出现托盘图标。
3. 右键托盘 → `重新扫码登录`（或首次双击 `0-首次扫码登录.cmd`），用手机闲鱼扫码。
4. 右键托盘 → `打开监控界面`，浏览器打开 `http://127.0.0.1:59288/`。
5. 在「搜索设置」里加一个任务：填搜索关键词、地区、价格，保存。
6. 点右上角 `▶ 开始监控` 开始扫描；新命中会进列表，并按你的推送配置推到手机。

> 默认 `startMode=hold`（启动后待命，不发搜索请求），想「启动即扫」可在面板「启动与节奏」改成「自动开始」。

---

## 这个仓库里有什么

| 文件 | 作用 |
| --- | --- |
| `monitor.cjs` | 主程序：翻页、过滤、打分、推送、HTTP 面板接口 |
| `notify.cjs` | 推送层：多渠道、分片、限速、失败重试、历史记录 |
| `price-memory.cjs` | 价格记忆与综合分（价格 50 + 卖家 30 + 新鲜 20 + 降价加分） |
| `guard.cjs` | 守护进程：探活、崩溃自动拉起、异常告警 |
| `login-manual.cjs` | 扫码登录（独立 profile） |
| `regions.json` | 省/市/区县数据 |
| `panel/` | 面板前端（`index.html` + `inject.js`） |
| `托盘.ps1` + `闲鱼扫货监控.exe` | 托盘程序（exe 是启动器，调 `托盘.ps1`） |
| `lib-systemca.cjs` | 让 Node 信任 Windows 证书库（企业网/加速器自签根证书） |
| `publish-announce.cjs` | 发公告（把公告写到仓库根的 `STATUS.json`，仅开发者用） |
| `0-首次扫码登录.cmd` / `3-重新登录并恢复.cmd` | 首次登录、换号用的两个入口 |
| `assets\` | 图标（favicon、托盘四态 ico、网页 logo） |
| `docs\` | `使用说明.txt`、`推送配置说明.md`、`维护手册.md`、未来需求备忘 |
| `config.example.json` | 配置模板（**密钥已清空**） |
| `Launcher.cs` | 托盘 exe 的 C# 启动器源码 |

**不在仓库里**（见 `.gitignore`）：

- `runtime/` —— Node 运行时 + Playwright + Chromium（完整包走 Releases 附件）
- `data/` —— 登录 cookie、命中列表、价格记忆、日志，全是账号相关
- `config.json` —— 里面有你的 Bark 密钥等，用 `config.example.json` 复制改名
- 所有 `*.bak`、`*.log`

---

## 从本仓库重建（体积小，但要自己装运行时）

1. 装 Node 22+。
2. `npm i playwright-core`，并按约定把 Playwright 的 Chromium 放到 `runtime\playwright-browsers\`。
3. 复制 `config.example.json` 为 `config.json`，填上你自己的推送密钥。
4. `node monitor.cjs`。

> 完整包用户不用做这些，直接解压即用。

---

## 首次扫码登录（必读）

登录态是用 Windows DPAPI 加密的，**绑定当前 Windows 用户**。换机器、换 Windows 账号后，cookie 解不开，需要重新扫码一次——这是安全设计，不是 bug。

- 完整包里**不含** `data\browser-profile\` 和 `data\login-profile\`，新机器第一次启动会自动重建（浏览器指纹全新，更安全）。
- 登录失效时：面板顶部红色横幅会提示，点「立即重新登录并恢复」，或双击 `3-重新登录并恢复.cmd`。

---

## 远程公告（开发者发布通知用）

程序支持开发者发一条远程公告，所有用户的网页面板顶部会自动显示横幅。机制：

1. 开发者仓库根目录放一个 `STATUS.json`，内容三态之一：

```json
{ "status": "ok" }
```

```json
{ "status": "notice", "title": "今晚维护到 23 点", "detail": "期间可能抓不到新数据，属正常现象" }
```

```json
{ "status": "down", "title": "请暂停使用", "detail": "平台接口升级，本程序暂时抓不到新数据，请等新版本，不要反复重登。", "updatedAt": "2026-11-05T12:00:00Z" }
```

2. 用户 `config.json` 里把 `remoteStatusUrl` 填成该文件的 GitHub raw 地址：

```json
"remoteStatusUrl": "https://raw.githubusercontent.com/用户名/仓库名/main/STATUS.json"
```

- `notice` → 面板顶部弹横幅（提示，不停用）
- `down` → 面板红条 + 自动暂停扫描 + 推一条告警到手机
- 读不到 / 格式错 → 当正常，不误报

程序启动时查一次，之后每 3 小时查一次；fetch 失败静默。`remoteStatusUrl` 默认空 = 关闭，不发任何请求。

> 开发者自己发公告的入口在**托盘菜单「📢 发公告」**（仅当 `config.json` 里 `developerMode=true` 时显示；打包给用户的版本默认 `false`，没有这个入口）。

---

## 推送怎么配

面板 →「搜索设置」→「② 消息推送」：

1. 打开总开关
2. 选一个渠道（Bark / Server酱 / 企业微信 / 飞书 / Gotify / 自定义 Webhook）
3. 填地址 / 密钥，点「测试」确认手机收到
4. **点「保存并生效」**

详细字段、告警规则、数据文件作用见 `docs\推送配置说明.md`。

---

## 运行时产生的东西

第一次跑起来后会出现 `data\` 目录：

```
cookies.json            登录 cookie（敏感）
hits.json               命中列表（面板显示的就是它）
seen.json               见过的商品，防重复推送
price-memory.json       价格历史与综合分
desc-cache.json         商品描述缓存
seller-profile.json     卖家主页信息缓存
notify-*.json           推送统计 / 重试队列 / 历史
alert-state.json        异常告警状态
baseline-clock.json     基线重建起始时刻
guard-state.json        守护状态
monitor.log / guard.log 运行日志
browser-profile/         Chromium 用户目录（自动生成）
login-profile/           扫码登录独立目录（自动生成）
```

---

## 已知边界

- **只在 Windows 上验证过**，依赖 `cmd` / `vbs` / Windows 路径。
- **不防止系统睡眠**：机器睡了就不扫货；醒来后守护会拉起来并把停机空窗的新上架货补抓进列表。
- **重建基线期间不推历史老货**：改筛选条件会触发全量重扫，这期间历史在售只入库不推送，但「基线开始之后新上架的」照常推。
- **没有开机自启**（托盘里可手动勾选）。
- 综合分里价格维度需要设了 `minPrice` / `maxPrice` 才有意义，否则价格项恒为中性 0.5。
- 内置限速与错峰，避免高频请求；但任何抓取行为都请遵守平台规则。

---

## 免责声明

本项目**仅供个人学习研究使用**，已内置限速与错峰。使用前请自行确认符合闲鱼平台规则与当地法律；账号风险、频率限制、数据准确性均由使用者自行承担。不提供代抓、代运营或任何绕过平台限制的服务。
