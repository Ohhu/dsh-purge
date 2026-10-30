# AGENTS.md

本文件只描述仓库结构与每个文件的职责，供在本仓库里干活的人和智能体先定位再动手。
运行时产物都落在 `$DSH_HOME`（`prompt-inject.md`、`rules/`、`skills/`、`net-scope-allow.txt`、`redteam/`），不属于本仓库。

## 维护要求

1. **结构变动必须同步本文件。** 新增、删除、重命名、移动任何文件或目录（含构建产物、脚本生成的 docs、随包技能），在同一次改动里更新下面的结构树，不留到下一次。
2. **注释跟着职责走。** 只改实现不动结构时不必改树；文件职责变了就连同那一行注释一起改。
3. **新增条目按所在层级插入**，注释一句话说清「它是什么 / 谁生成」，构建产物标「勿手改」并写出源文件。
4. **提交前自查**：树里出现的路径都得真实存在，磁盘上的文件都得在树里有一行。

```
dsh-purge/
├─ bin/
│  └─ dsh-purge.js                 命令行入口：--status/--apply/--revert/--uninstall/--edit
├─ lib/                            补丁与宿主适配（Node 侧）
│  ├─ index.js                     Cordis 插件壳：面板服务、/purge 与 /rules /skills 命令、purge_* 工具、新会话权限（按补丁档钉死/归位）
│  ├─ core.js                      核心：补丁表、应用/回滚、DSH_HOME 探测、状态计算（最大的单个模块）
│  ├─ host.js                      宿主适配器选择（web / desktop）与重启调度
│  ├─ surface.js                   宿主面探测：web / desktop，gui / tui 仅识别
│  ├─ web.js                       官方 dsh web（npm 全局 / 便携）适配
│  ├─ desktop.js                   官方桌面 EXE 适配：解包、打补丁、重启
│  ├─ host-clean.js                判定宿主系统提示词是否已洗净（重启前的门禁）
│  ├─ identity.js                  提示词组装：注入段、能力段、自有服务器说明
│  ├─ capability-protocol.js       能力选用协议（先读 skill/MCP 目录再选工具）的文案段
│  ├─ rules.js                     规则库：多套 AGENTS.md / CLAUDE.md 的读写、启用、删除
│  ├─ skills.js                    技能导入/创建/删除（zip 或目录 → $DSH_HOME/skills）
│  ├─ rewind.js                    /rewind 与「回退一次」：session.fork 裁剪、草稿回填
│  ├─ continue-retry.js            自动续跑与请求错误重试的配置、判定
│  ├─ net-scope.js                 网段范围：大陆/港/澳禁止 + 自有服务器白名单
│  ├─ hooks-deny.js                hooks deny / ask 旁路开关与状态回写
│  ├─ patch-mode.js                补丁档（core / full）：按宿主面记录档位、按档过滤补丁
│  ├─ drill-grant.js               演练台授权记录（每个 DSH_HOME 一份，卸载时清）
│  ├─ update.js                    更新：GitHub 拉取、正式版/测试版切换、写回 profile
│  ├─ official-update.js           官方客户端升级后补丁回写的标记
│  ├─ official-update.wscript      升级后重启用的 WSH 脚本模板
│  ├─ reapply.js                   启动时重放已装补丁
│  ├─ reapply-cli.js               它的命令行薄壳
│  ├─ uninstall.js                 卸载：先还原，再删注入文件、规则库、插件
│  ├─ uninstall-restart.js         卸载后的重启
│  ├─ restart-web.js               dsh web 重启
│  ├─ restart-desktop.js           桌面端重启
│  ├─ settle-policy.js             启动 settle 时序：延迟多久、能不能解包/重启
│  ├─ phase1-keep.js               把官方 phase-1 白名单放宽到 dsh-purge* / dshpg-*
│  ├─ extract-asar.js              asar 归档与真实磁盘 fs、解包
│  ├─ hide-console.js              Windows 隐藏控制台窗口（shim / 启动路径）
│  ├─ child-process-hide.mjs       child_process 包装：Windows 不弹窗
│  ├─ zip-extract.js               跨平台 zip 解压（内置 + 系统工具兜底）
│  ├─ table-key.js                 资产表密钥派生与密封
│  ├─ table-read.js                资产表解密读取
│  ├─ asset-table.js               加密的默认提示词片段（由 embed-default-prompt 生成，勿手改）
│  └─ redteam/                     演练台（资产库 + 面板 + 工具）
│     ├─ store-core.js             资产库核心：靶标工作区、SQLite 事实库、提示词与技能文件
│     ├─ store.js                  Cordis 宿主壳，把资产库发布为进程级 ctx.redteam
│     ├─ schema.js                 SQLite 表结构与增量迁移
│     ├─ score-rules.js            计分规则的唯一实现（封顶、去重、总分口径）
│     ├─ tools.js                  模型可见工具：redteam_*
│     ├─ ui.js                     面板 HTTP 桥接 POST /redteam/api
│     ├─ client.js                 面板浏览器半侧源码（构建时嵌进根 client.js）
│     ├─ index.js                  演练台自举：预置与随包技能落到 $DSH_HOME
│     ├─ preset-composition.js     读 presets/redteam 的 agent.cordis.yml / preset.yml
│     ├─ platform-config.js        平台适配配置 redteam/config.json：工具路径、FOFA 等
│     ├─ skill-availability.js     技能可用性自检（缺环境变量/工具/占位符）
│     ├─ skill-fixes.js            不可用技能的中文修复步骤
│     ├─ role-section.js           子会话角色稿注入（redteamRole）
│     ├─ report-replay.js          报告复现：得分项转成可重放报文与命令
│     ├─ settings.js               插件设置：并发智能体上限
│     ├─ validate.js               写库前校验与规范化（路径穿越、非法枚举）
│     └─ ip-utils.js               IP / 文本归一化纯函数
├─ presets/redteam/                红队预设（首次运行复制到 $DSH_HOME/.agent-presets）
│  ├─ agent.cordis.yml             红队指挥智能体的 agent 平面编排
│  ├─ anchor-gate.mjs              锚点门：首段思考锚住才放开步数与输出上限
│  └─ preset.yml                   预设元信息：名称、描述、排序
├─ skills/redteam/                 随包红队技能（DSH 原生 skill 体系加载）
│  ├─ recon-pipeline.md            信息收集流水线：subfinder→dnsx→naabu→httpx→katana
│  ├─ passive-recon.md             被动收集：不接触目标，只用公开数据源
│  ├─ active-scan.md               主动端口与服务扫描（nmap / masscan）
│  ├─ fofa-recon.md                FOFA API 批量测绘，内置限速与退避
│  ├─ asset-correlation.md         资产关联：域名↔IP↔C 段↔证书↔服务
│  ├─ web-fingerprint.md           Web 指纹：框架、中间件、CMS、组件版本
│  ├─ dir-bruteforce.md            目录与文件爆破（ffuf / feroxbuster / dirsearch / gobuster）
│  ├─ nuclei-scan.md               nuclei 模板化漏洞扫描
│  ├─ unauth-exploit.md            未授权访问与信息泄露利用链
│  ├─ credential-attack.md         在线弱口令爆破与离线哈希破解（hydra / hashcat / john）
│  ├─ lateral-movement.md          内网横向与提权（Impacket / enum4linux / smbclient）
│  ├─ fscan-intranet.md            fscan 内网综合扫描
│  ├─ gogo-intranet.md             gogo 内网扫描引擎
│  ├─ shell-handler.md             反弹 Shell 与载荷投递（MSF / nc / socat）
│  ├─ vps-reverse-shell.md         用自建 VPS 落地与中转反弹 Shell
│  ├─ frp-tunnel.md                frp 内网穿透
│  ├─ chisel-tunnel.md             chisel 隧道
│  ├─ suo5-tunnel.md               suo5 经 WebShell 建 SOCKS5 隧道
│  ├─ webshell-toolkit.md          冰蝎 / 哥斯拉 / 蚁剑 用法
│  ├─ cn-proxy-pool.md             国内免费代理池：抓取、验活、轮换
│  ├─ browser-automation.md        无依赖驱动 Chrome/Chromium 抓页面、截图、抓接口
│  ├─ kimi-webbridge.md            用 Kimi 浏览器扩展驱动真实 Chrome
│  └─ redteam-setup.md             首次使用引导：FOFA_KEY、VPS 登录、降级口径
├─ scripts/                        构建与辅助脚本
│  ├─ build-client.mjs             把 lib/redteam/client.js 嵌进根 client.js
│  ├─ patch-client-dock.mjs        把 client.js 改成右侧双页签并嵌入演练台 UI
│  ├─ embed-default-prompt.mjs     生成加密默认提示词 lib/asset-table.js
│  ├─ build-patch-dashboard.mjs    从 lib/core.js 补丁表 + lib/patch-mode.js 档位生成 docs/patch-dashboard.html（纯静态，不读安装状态）
│  ├─ export-engagement-report.mjs 导出靶标得分报告交付包（含截图）
│  └─ redteam-setup.sh             红队环境一键铺设：工具箱、技能、FOFA、VPS
├─ docs/
│  ├─ banner.svg                   README 顶部横幅
│  ├─ drill-auth-legal.html        演练台授权声明页
│  ├─ patch-dashboard.html         补丁看板（脚本生成，勿手改）
│  ├─ redteam-upstream-LICENSE     红队部分参考的上游项目许可
│  ├─ redteam-upstream-DISCLOSURE  上游来源与改动说明
│  └─ preview/                     README 用的界面截图
│     ├─ dock-clean.png            清洗页
│     ├─ dock-auth.png             演练台授权页
│     ├─ dock-drill.png            演练台
│     ├─ settings.png              补丁分组
│     ├─ rules.png                 规则集
│     ├─ own-servers.png           自己的服务器
│     └─ patch-dashboard.png       补丁看板截图
├─ .github/workflows/release.yml   推 master 自动打包发布
├─ client.js                       右侧栏 dock（演练台片段由 scripts/build-client.mjs 生成；清洗页等其余部分直接手改）
├─ cordis.patch.yml                插件 bundle 配置：patch 入口与默认 config
├─ screenshots.json                README 截图清单
├─ release-notes.md                版本变更说明
├─ package.json                    包元信息、files 清单、dsh 安装方式
├─ README.md                       中文说明（唯一一份）
├─ AGENTS.md                       本文件：仓库树与各文件职责
├─ LICENSE                         MIT
├─ .gitignore
└─ .npmignore
```
