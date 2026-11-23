# Antigravity QQ Bridge

独立构建的跨端 AI 伴侣桥接系统，直接复用本机 **Google Antigravity**（`agy acp --stdio` 持久化会话）与本机 **GPT-SoVITS v5**，零商业 API 订阅依赖，内置可视化管控台 **Antigravity Hub**。

## 核心功能一览

- **持久化 ACP 双通道大脑 (`agy acp --stdio`)**：双进程零冷启动长连接，支持**双模型分流**（私聊主人工作区模型 + 群聊 `--sandbox` 沙盒模型），私聊、各群聊彼此独立上下文。
- **256K 上下文预算与无感记忆压缩接力（方案 A）**：单会话默认 `256,000` tokens 预算；达标后在回复发出后的后台静默整理《前情记忆交接单》（归档至 `data/session-summaries/` 并持久化防重启丢失），连同最近 6 轮原话无缝接力进清爽新会话（支持 Hub 进度条查看、切换方案 B/C 及手动 `/压缩`）。
- **三层查梗与活体世界书 (`data/lorebook.db` + `data/memes.db`)**：
  - **L1 活体世界书**（最高优先）：群友黑话、个人设定与魔改热梗，兼容 SillyTavern 🔵蓝灯常驻 / 🟢绿灯关键词 / 次级过滤 / 优先级 / 会话冷却去重、分群作用域隔离与 ST World Info JSON 双向导入/导出；
  - **L2 只读公共梗百科**（可选，6,792+ 词条，源自 [dsh-memewiki](https://github.com/thawline/dsh-memewiki) / `cnmeme.wiki`，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）：内存检索 `<1ms`、优先注入「怎么用/怎么接」方便直接入戏玩梗，支持 Hub 内检索、**一键复制到 L1 魔改**、**0-Token 增量同步**（[scripts/sync-cnmeme.mjs](scripts/sync-cnmeme.mjs)），并配备 **0–100「串子程度」** 玩梗尺度滑杆；
  - **L3 联网兜底回流**：L1/L2 都未命中时按需联网搜索（`search_web`），查完自动通过隐藏 `[词条:...]` 无感收录进 L1。
- **全场景原生视觉识图、合并转发与 B 站卡片解析**：
  - QQ 私聊/群聊发图、引用图、以及潜水期间刚发出的近期旁听图自动喂入模型原生多模态通道；
  - 动态 GIF 自动用 FFmpeg 拼成带序号的 `2×1`/`3×1`/`2×2`/`3×2` 时序分镜连环画（不丢动作演变与结尾反转，表情库仍存原始动图）；
  - 收到 QQ **合并转发聊天记录**（直发、引用或 90 秒内旁听转发）自动经 `get_forward_msg` 安全展开多条文字、图片/动图与 B 站链接；
  - 收到 QQ 分享卡片 / B 站小程序或 `b23.tv`/BV 链接时，自动解析封面图、真实 UP 主、完整简介、标签数据、UP 主置顶与高赞热评（纯只读接口 + 严格防 SSRF 与提示词注入过滤）。
- **OneBot v11 协议适配 & 防风控**：适配 **NapCatQQ**，同时支持 **Forward WS**（默认 `ws://127.0.0.1:13001`）与 **Reverse WS**；内置 `2.5s` 智能防抖合流窗口、`0.45s` 长文分段拟人延时、`90s` 重复去重、友商 AI 防互刷与称呼避让、连续静默自动退窗与风控自动退避。
- **Owner Guard 4 层权限隔离**：`ownerUsers` 白名单私聊可放行本机 Antigravity 工具能力；群聊强制走 `--sandbox` 独立空目录子进程 + `session/request_permission` 硬拦截（仅放行只读表情包手册与公共世界书目录，及安全只读联网搜索 `search_web`）。
- **GPT-SoVITS v5 情感声线与文字秒发/语音异步补发**：独立运行于 `19880` 端口（配置模板见 [tts_infer_v5dev.example.yaml](tts_infer_v5dev.example.yaml)），完整透传 13 项 v5 推理参数，上线/切权重自动预热 CUDA；双轨模式下**文字与表情秒发，语音后台串行合成后无感补发**，配合 `SHA-256` 秒回缓存。
- **5 维表情包卡片库 (`data/stickers.db`)**：支持自动同步机器人 QQ 收藏表情、Gemini 视觉鉴图收藏、5 维梗图卡片建档与按需只读手册 `data/sticker-catalog.md`（平时 0 上下文占用）、以及 `2-gram` 兜底检索。
- **Antigravity Hub 可视化管控台 & 侧边栏插件**：涵盖模型与人格工坊、声线试听与 13 参数调优、权限开关矩阵、Token 吞吐与 256K 压缩进度监控、表情包仓库、世界书与梗库管理、以及免连 QQ 端到端联调演练场；附带 Antigravity 侧边栏插件源码 [plugins/agyqq-hub](plugins/agyqq-hub/README.md)。

---

## 环境要求与快速上手

- **Node.js `>= 22.13.0`**（使用内置 `node:sqlite`，仅 1 个外部运行依赖 `ws`）
- 本机已安装并登录 **Google Antigravity CLI (`agy`)**
- OneBot v11 协议端（推荐 [NapCatQQ](https://github.com/NapNeko/NapCatQQ)，可放置于项目 `napcat/` 目录）
- 可选：**FFmpeg**（用于 GIF 动态分镜，配置 `vision.ffmpegPath` 或加入系统 `PATH`）
- 可选：**GPT-SoVITS v5**（用于 6 情感真人语音合成）

### 安装与初始化

```powershell
# 1. 安装依赖
npm install

# 2. 复制并按需编辑主配置（不会提交进 Git）
Copy-Item config.example.json config.json

# 3. 如启用 GPT-SoVITS v5，复制推理配置模板并填入你本机的底模路径，
#    再将 6 情感参考音频放到 audio_clip/ 目录（平静/温柔/开心/调皮/委屈/疑问.wav）
Copy-Item tts_infer_v5dev.example.yaml tts_infer_v5dev.yaml
```

> **可选 · 启用 L2 6,792+ 离线梗百科**：
> 本仓库不含 16MB 二进制词库文件。从 [dsh-memewiki](https://github.com/thawline/dsh-memewiki) 获取 `data/memes.db` 放入本项目 `data/memes.db` 后即自动启用，后续可在 Hub 面板内一键增量同步或运行 `node scripts/sync-cnmeme.mjs --no-existing`。

### 启动服务

- **仅启动桥接核心**：运行 `npm start` 或双击 [start.bat](start.bat)
- **一键联合启动（NapCatQQ + GPT-SoVITS v5 + Bridge + 自动打开控制台）**：
  双击 [start-all.bat](start-all.bat) 或运行 `.\start-agyqq.ps1 -WithNapCat -WithSovits -OpenHub`
- 启动后从终端输出或 `data/hub-token.txt` 获取一次性访问令牌，打开 `http://127.0.0.1:3200/?token=<你的Token>` 进入 **Antigravity Hub**，在 **群聊与权限防护** 页填入 `ownerUsers` 与测试群白名单即可开始使用。

---

## 常用 QQ 指令

- `/new` 或 `/reset`：彻底清空当前会话的 ACP 上下文记忆
- `/压缩` 或 `/compact`：手动整理《前情记忆交接单》并切入清爽新会话（不断片）
- `/安静`（或 `/闭麦`、`/潜水`）：立即结束当前群聊的活跃跟聊窗口，恢复待机潜水
- `/status`：查看通道模式、当前模型、ACP 延迟、上下文预算进度、语音缓存、表情库与世界书/梗百科数量
- `/记梗 关键词1,关键词2 | 释义`（或 `/记黑话`、`/记词条`）：手动收录词条进 L1 世界书
- `/查书 [关键词]`（或 `/世界书`）：查询公共及当前聊天作用域的世界书词条
- `/删词条 #ID`：删除指定编号的世界书词条
- `/存表情 标签1 标签2`：附带图片或引用图片消息入库（自动 SHA-256 去重与 2-gram 索引）
- `/表情库 [搜索词]`：查询表情包库
- `/救大命`：无视冷却立刻发一张应急斗图表情
- `/语音 [情绪] 台词`：调用 GPT-SoVITS v5 合成并发送语音条

---

## 测试与诊断命令

```powershell
npm test           # 运行全部 43 项单元测试（安全隔离与防互刷 / 防风控合流 / 表情库 / L1世界书 / L2梗百科与串子尺度 / 256K压缩 / TTS缓存与异步补发 / B站卡片解析 / 合并转发与旁听补图 / GIF分镜 / OneBot / Hub API）
npm run test:e2e   # 运行真实 agy acp --stdio 端到端集成测试
npm run probe:acp  # 单测本机 agy acp 握手与多模态
npm run probe:tts  # 单测本机 GPT-SoVITS v5 连通性与 SHA-256 缓存
```

## 开源许可与第三方致谢

本项目基于 [MIT License](LICENSE) 开源；第三方项目与公共词库归属声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
