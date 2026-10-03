# WBB — Minecraft AI 伙伴（整合包版）

基于 [kolbytn/mindcraft](https://github.com/kolbytn/mindcraft) + DeepSeek，让 AI 伙伴通过 **FML3 握手进入 Forge 1.20.1 整合包服务端**，并实现**游戏内语音双工**（能听你说，也能用 3D 语音回你）。

> 本仓库是我们在 Mindcraft 上游之上做的全部改动与踩坑记录，供开源/复用。
>
> 📌 **要动手搭一套，请先读 [`docs/BUILD_NOTES.md`](docs/BUILD_NOTES.md)** —— 版本矩阵、RCON 使用规约、坐标铁律、进程托管、故障速查表都在里面，能省掉大部分弯路。
> 让 AI Agent 帮你操作的话，把 [`AGENTS.md`](AGENTS.md) 一起丢给它。

## 能力一览

| 能力 | 实现 |
| --- | --- |
| 进入 Forge 整合包服务器 | mineflayer + FML3 握手伪装 mod 客户端（registry 快照透传） |
| 对话/干活 | DeepSeek API（OpenAI 兼容），自动模式：自卫/解卡/物品拾取/保持距离 |
| 游戏内 3D 语音（TTS） | Simple Voice Chat mod + edge-tts（Python 常驻 worker）+ opus 编码 |
| 语音识别（STT） | faster-whisper（CPU int8，按玩家分离音频流 + 静音切片） |
| 形象（人格 + 皮肤） | 可自定义人格文件 `wb.json`（本项目用「蓝色大肥鲸」人设）；皮肤见 `assets/skin/` |
| 外网联机 | SakuraFrp 内网穿透（TCP 游戏 + UDP 语音两条隧道） |

## 目录结构

```
mindcraft/          Mindcraft 主程序（含全部魔改）
  src/agent/voice.js        语音双工核心（TTS 队列 + STT 音频流处理）
  src/utils/mcdata.js       FML3 握手挂载点（autoVersionForge）
  src/utils/forge/          node-minecraft-protocol Forge 分支源码（改 .cjs）
  stt_server.py             whisper 常驻识别服务（stdin/stdout JSON 行协议）
  tts_worker.py             edge-tts 常驻合成进程（省去每次冷启动 ~1s）
  opusWrapper.cjs           opusscript 兼容层（替代 @discordjs/opus）
  settings.js               配置（forge_server: true / port / version: auto）
  wb.json                   bot 人格文件（本项目为「蓝色大肥鲸」人设）
  profiles/deepseek.json    模型 profile（temperature 0.5）
  _test_fml3.mjs            FML3 裸连接测试脚本
  patches/                  上游自带补丁
server/             Forge 服务端配置样例
  server.properties         offline-mode / 端口 25565
  voicechat-server.properties   Simple Voice Chat 服务端配置（外网联机时填 voice_host）
  user_jvm_args.txt         服务端 JVM 参数样例
  mods_list.txt             服务端 mod 清单
assets/skin/        自绘皮肤与生成脚本（见「形象」一节）
docs/BUILD_NOTES.md  ★ 构建注意事项（版本矩阵 / RCON 规约 / 坐标铁律 / 故障速查表 / Agent 协作规约）
docs/logs/          全程工作日志（含每个坑的根因分析）
AGENTS.md           给 AI Agent 的硬规则与索引（人和 agent 都可读）
```

## 快速开始

### 0. 前置
- Node.js 22+ / Python 3.10+ / Java 17
- Forge 1.20.1 服务端（推荐 47.4.x）
- DeepSeek API Key

### 1. Mindcraft 端：装依赖
```bash
cd mindcraft
npm install                    # 会自动跑 patch-package 应用 patches/ 下的补丁
npm install opusscript --ignore-scripts   # 语音用（替代 @discordjs/opus）
# 语音识别 / 合成（可选，建议在 Python venv 内，走清华源更快）
pip install faster-whisper "av==14.2.0" edge-tts
```

### 2. 配置
- **API Key**：复制 `keys.example.json` 为 `keys.json`，填入 `DEEPSEEK_API_KEY`。
- **`settings.js` 关键项**：
  - `"minecraft_version": "1.20.1"`
  - `"forge_server": true`（连 Forge 服务端走 FML3 握手；**原版服务器必须保持 false**）
  - `"host": "<服务器IP>"`、`"port": 25565`、`"auth": "offline"`
  - `"forge_mods": []`（一般不填；如服务端校验严格，需与 `server/mods_list.txt` 一致）
- **语音后端**：`voice.js` 默认取 `PATH` 中的 `edge-tts` / `python` / `ffmpeg`，可用环境变量覆盖：
  `EDGE_TTS_EXE`、`PYTHON_EXE`、`FFMPEG_PATH`。
- **opus 兼容层**：把 `opusWrapper.cjs` 放到 `node_modules/mineflayer-simplevoice/lib/` 下，并把该目录 `VoiceChatClient.js` 里的 `require("@discordjs/opus")` 改为 `require("./opusWrapper.cjs")`。

### 3. 启动
```bash
python stt_server.py &    # 可选：常驻语音识别
python tts_worker.py &    # 可选：常驻语音合成（省冷启动）
node main.js              # 主程序；启动后浏览器自动打开控制台 localhost:8080
```

### 2. 服务端
- mods 按列表装，**Simple Voice Chat 必须用 2.5.x**（协议版本 18，与 mineflayer-simplevoice 匹配，版本映射见下）
- `online-mode=false`（bot 用离线 UUID）；局域网直连 `内网IP:25565`
- 外网联机：SakuraFrp 两条隧道（TCP→25565，UDP→24454），并在
  `config/voicechat/voicechat-server.properties` 设 `voice_host=<穿透域名>:<UDP远程端口>`

### 3. 玩家使用
- 打字：`T` 直接说，或 `/msg bbb ...` 私聊
- 语音：按 `V` 说话，停顿 1 秒（静音判据）→ bot 理解并用 3D 语音回复

## 形象（人格 + 皮肤）

- **人格（"形象"）**：写在 `mindcraft/wb.json` 的 `conversing` 字段。本项目为「蓝色大肥鲸」人设（自称"本鲸"、咕噜噜、呆萌但干活利落），并用 `modes` 控制自动行为（自保 / 解卡 / 自卫 / 捡物 / 插火把 / 保持距离）。
- **皮肤（"模型"）**：`assets/skin/` 提供两版**自绘**皮肤与可复现的生成脚本：
  - `bbb_skin_v1_pixelwhale.png` — 像素风蓝鲸（`gen_whale_skin.py`）
  - `bbb_skin_v3_whalemaid.png` — 鲸鱼娘女仆（`gen_whalegirl_skin.py` / `gen_whalemaid_skin.py`）
  - 安装：放进 `CustomSkinLoader/LocalSkin/skins/<玩家名>.png`（客户端需装 CSL / 万用皮肤补丁）
- ⚠️ **版权说明**：仓库内只收录上述自绘素材。项目实际使用的最终皮肤（"Space Whale Girl with Stitch hoodie"，作者 DobbTheSnail，来源 minecraftskins.com）属**第三方作品，未纳入本仓库**；如需使用请自行下载并遵守原作者许可。

## 血泪坑（重要！）

1. **SVC 协议版本映射**：2.4.x→17，2.5.x→18，2.6.x→20。服务端与插件版本号不一致会被拒绝连接。插件原生 18，锁 2.5.x 最稳。
2. **FML3 握手**：registry 快照/配方包/命令树在 minecraft-data 里不可解析 → protocol.json 中改为 `restBuffer` 裸透传（不能写成 `['restBuffer', {...}]`）；chat.js 跳过 validateCommandTree；应答包 messageId 必须等于请求 index。
3. **@discordjs/opus 在 Node 22 无预编译包**（GitHub 被污染/SNI 阻断 + 无 VS 编译环境）→ opusscript 纯 JS 替代：`new OpusScript(rate, ch, Application.VOIP)`，`decode` 不带 frameSize。
4. **JS 版 edge-tts 已被微软 DRM 掐死**（403，补 Sec-MS-GEC + Client Hints 均无效）→ 用 Python edge-tts 7.x（`tts_worker.py` 常驻进程，省冷启动）。
5. **faster-whisper**：av 必须降到 14.2.0（19.0 报 metadata_errors）；hf-mirror 下载需 `HF_HUB_DISABLE_XET=1`；缺 CUDA DLL 就老实 CPU int8（一句 2-5s，零显存）。
6. **ESM 环境**：mcdata.js 里 `createRequire` 必须 `import { createRequire } from 'module'`。
7. **长驻进程**：bash `(cmd &)` 分离启动的 java 会被会话回收，必须用受管理的后台任务。
8. **掉线不会自动重连**，停服后要重启 Mindcraft 主程序。
9. **改 mode 默认值要改两处**：`modes.js` 里的 `on` 只是初始默认，启动时会被 `wb.json` 的 `modes` 字段覆盖，两处都改才生效。

> 以上只是最刺眼的几条。**完整版（含服务端搭建、RCON 规约、进程托管、坐标与 NBT 铁律、模组版本检查、备份策略、故障速查表）见 [`docs/BUILD_NOTES.md`](docs/BUILD_NOTES.md)。**

## 开源前检查清单（已全部完成）

- [x] 密钥不进仓库：`keys.json` 已排除，仅保留 `keys.example.json`（`.gitignore` 兜底）
- [x] **无隐私信息**：全仓库无 API Key / 访问密钥 / 真实服务器地址 / 个人绝对路径 / 游戏 ID（2026-10-03 全量复查）
- [x] 大文件不入库：`whisper_models/`（460MB）、`node_modules/`、服务端 `world/` 与 `libraries/` 均未复制（`.gitignore` 兜底）
- [x] **个人路径已泛化**：`voice.js` 的外部可执行文件改为「环境变量 → PATH → 按平台」；皮肤脚本输出路径改为当前目录；服务端样例配置里的穿透域名改为占位
- [x] 示例配置齐全：`keys.example.json` + `server/` 目录样例可直接参照
- [x] 补充开源协议：`LICENSE`（MIT 双署名：保留上游 Kolby Nottingham 版权声明 + 本仓库改动 sasika-bottt）
- [x] 第三方皮肤未入库（见「形象」一节版权说明）

## 致谢

- [kolbytn/mindcraft](https://github.com/kolbytn/mindcraft)
- [Mykola1453/node-minecraft-protocol-forge](https://github.com/Mykola1453/node-minecraft-protocol-forge)（FML3 支持）
- [Simple Voice Chat](https://modrinth.com/mod/simple-voice-chat) / mineflayer-simplevoice
- OpenAI faster-whisper / Microsoft edge-tts（社区 Python 实现）
