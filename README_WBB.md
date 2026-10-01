# WBB — Minecraft AI 伙伴（整合包版）

基于 [kolbytn/mindcraft](https://github.com/kolbytn/mindcraft) + DeepSeek，让 AI 伙伴通过 **FML3 握手进入 Forge 1.20.1 整合包服务端**，并实现**游戏内语音双工**（能听你说，也能用 3D 语音回你）。

> 本仓库是我们在 Mindcraft 上游之上做的全部改动与踩坑记录，供开源/复用。

## 能力一览

| 能力 | 实现 |
| --- | --- |
| 进入 Forge 整合包服务器 | mineflayer + FML3 握手伪装 mod 客户端（registry 快照透传） |
| 对话/干活 | DeepSeek API（OpenAI 兼容），自动模式：打猎/自卫/解卡/物品拾取 |
| 游戏内 3D 语音（TTS） | Simple Voice Chat mod + edge-tts（Python CLI）+ opus 编码 |
| 语音识别（STT） | faster-whisper（CPU int8，按玩家分离音频流 + 静音切片） |
| 外网联机 | SakuraFrp 内网穿透（TCP 游戏 + UDP 语音两条隧道） |

## 目录结构

```
mindcraft/          Mindcraft 主程序（含全部魔改）
  src/agent/voice.js        语音双工核心（TTS 队列 + STT 音频流处理）
  src/utils/mcdata.js       FML3 握手挂载点（autoVersionForge）
  src/utils/forge/          node-minecraft-protocol Forge 分支源码（改 .cjs）
  stt_server.py             whisper 常驻识别服务（stdin/stdout JSON 行协议）
  opusWrapper.cjs           opusscript 兼容层（替代 @discordjs/opus）
  settings.js               配置（forge_server: true / port / version: auto）
  wb.json                   bot 人格文件
  _test_fml3.mjs            FML3 裸连接测试脚本
  patches/                  上游自带补丁
server/             Forge 服务端配置样例
  server.properties         offline-mode / 端口 25565
  voicechat-server.properties   voice_host=frp-boy.com:32594（穿透时必改）
  mods_list.txt             服务端 38 mod 清单
  modrinth.index.json       整合包定义
docs/logs/          全程工作日志（含每个坑的根因分析）
```

## 快速开始

### 0. 前置
- Node.js 22+ / Python 3.10+ / Java 17
- Forge 1.20.1 服务端（推荐 47.4.x）
- DeepSeek API Key

### 1. Mindcraft 端
```bash
# 1) 按 mindcraft 上游 README 安装依赖，然后：
npm install mineflayer-simplevoice opusscript edge-tts --ignore-scripts
# 2) pip install faster-whisper "av==14.2.0" edge-tts（Python venv 内，走清华源更快）
# 3) keys.json 填入 DEEPSEEK_API_KEY（参考 keys.example.json）
# 4) settings.js 关键项：
#    "minecraft_version": "auto", "port": 25565, "forge_server": true
# 5) opusWrapper.cjs 放到 node_modules/mineflayer-simplevoice/lib/ 下，
#    并把该目录 VoiceChatClient.js 的 require("@discordjs/opus") 改为 require("./opusWrapper.cjs")
# 6) 启动 whisper 服务 + 主程序：
python stt_server.py &
node main.js
```

### 2. 服务端
- mods 按列表装，**Simple Voice Chat 必须用 2.5.x**（协议版本 18，与 mineflayer-simplevoice 匹配，版本映射见下）
- `online-mode=false`（bot 用离线 UUID）；局域网直连 `内网IP:25565`
- 外网联机：SakuraFrp 两条隧道（TCP→25565，UDP→24454），并在
  `config/voicechat/voicechat-server.properties` 设 `voice_host=<穿透域名>:<UDP远程端口>`

### 3. 玩家使用
- 打字：`T` 直接说，或 `/msg bbb ...` 私聊
- 语音：按 `V` 说话，停顿 1.5 秒 → bot 理解并用 3D 语音回复

## 血泪坑（重要！）

1. **SVC 协议版本映射**：2.4.x→17，2.5.x→18，2.6.x→20。服务端与插件版本号不一致会被拒绝连接。插件原生 18，锁 2.5.x 最稳。
2. **FML3 握手**：registry 快照/配方包/命令树在 minecraft-data 里不可解析 → protocol.json 中改为 `restBuffer` 裸透传（不能写成 `['restBuffer', {...}]`）；chat.js 跳过 validateCommandTree；应答包 messageId 必须等于请求 index。
3. **@discordjs/opus 在 Node 22 无预编译包**（GitHub 被污染/SNI 阻断 + 无 VS 编译环境）→ opusscript 纯 JS 替代：`new OpusScript(rate, ch, Application.VOIP)`，`decode` 不带 frameSize。
4. **JS 版 edge-tts 已被微软 DRM 掐死**（403，补 Sec-MS-GEC + Client Hints 均无效）→ 用 Python edge-tts 7.x CLI（社区持续跟进）。
5. **faster-whisper**：av 必须降到 14.2.0（19.0 报 metadata_errors）；hf-mirror 下载需 `HF_HUB_DISABLE_XET=1`；缺 CUDA DLL 就老实 CPU int8（一句 2-5s，零显存）。
6. **ESM 环境**：mcdata.js 里 `createRequire` 必须 `import { createRequire } from 'module'`。
7. **长驻进程**：bash `(cmd &)` 分离启动的 java 会被会话回收，必须用受管理的后台任务。
8. **wbb 掉线不会自动重连**，停服后要重启 Mindcraft 主程序。

## 开源前检查清单

- [x] 密钥不进仓库：keys.json 已排除，仅保留 keys.example.json（.gitignore 兜底）
- [x] 工作日志已复查，无 API Key / 访问密钥
- [ ] 大文件不入库：whisper_models/（460MB）、node_modules/、服务端 world/ 与 libraries/ 均未复制，发布时保持排除
- [ ] 公开仓库前把个人路径（D:/AI/...、E:/w我的世界/...）按需泛化
- [ ] 补充开源协议：上游 Mindcraft 为 MIT，本仓库改动建议沿用 MIT 并注明上游

## 致谢

- [kolbytn/mindcraft](https://github.com/kolbytn/mindcraft)
- [Mykola1453/node-minecraft-protocol-forge](https://github.com/Mykola1453/node-minecraft-protocol-forge)（FML3 支持）
- [Simple Voice Chat](https://modrinth.com/mod/simple-voice-chat) / mineflayer-simplevoice
- OpenAI faster-whisper / Microsoft edge-tts（社区 Python 实现）
