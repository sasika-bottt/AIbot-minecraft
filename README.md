# minebot

minebot 是一款用于配置 Minecraft AI 伙伴的 Windows 桌面应用。用户可以基于自己的游戏实例、整合包和世界存档准备服务器，并配置一个 AI 伙伴。

## 功能

- 选择 WorkBuddy 积分通道或 OpenAI 兼容模型 API；费用和可用性取决于相应服务。
- 识别用户已有的 PCL2 游戏版本，或选择本地整合包、目录和世界存档；尝试匹配已有 Java。
- 自定义伙伴人设和皮肤；可选使用 Simple Voice Chat，语音模组由用户自行安装。
- 自检环境、创建独立服务器副本、查看日志和管理服务器及伙伴；提供玩家管理员名单和行为选项。
- 管家模式提供建造需求沟通、方案规划及受控执行功能；不同版本和场景需要实际测试。
- 本地或局域网连接；可检测已有 SakuraFrp 隧道状态。公网联机和语音端口需要用户自行准备。

## 开始使用

1. 在 Windows 上安装 minebot，安装并登录 WorkBuddy，然后在第一步选择积分通道和可用模型；也可以选择自己的兼容 API。
2. 选择自己已有的客户端游戏实例或整合包，并选择世界存档。准备与游戏版本一致的 Forge 专用服务端；如果服务端与游戏分开，请在「专用服务器目录」中选择它，目录需要包含 `libraries` 和 Forge 的 `win_args.txt`。
3. 按需设置语音、人设、皮肤与联机方式，完成自检后在监管中心构建并启动服务器。
4. 服务器就绪后，根据界面显示的地址在 Minecraft 多人游戏中加入；公网玩家需要自行准备可用的公网映射。建议先备份自己的世界。

当前服务器准备流程面向 Forge 专用服务端，不能保证所有整合包都兼容；不提供游戏或模组的自动下载与安装。

不同 Minecraft 版本、模组及服务端组合可能不兼容；并非所有选项都已完成端到端验证。原世界的日常同步会在安全停服时进行，使用前请自行备份重要存档。不要公开 API Key、账号令牌或公网地址。

## 运行与开发

本仓库发布应用源码及修改过的 Mindcraft 伙伴源码，不包含个人存档、账户或密钥，也不直接提交第三方依赖与游戏服务端。开发需要 Windows x64、Node.js 22 和 npm。最终安装包会包含 Node、AI 伙伴依赖和 WorkBuddy 通道组件，用户无需另行安装 Node 或 Python。

```powershell
npm ci
npm --prefix runtime/mindcraft-final ci
npm run check
npm test
npm start
```

WorkBuddy 积分通道当前复用本机 WorkBuddy 客户端的登录状态，用户需要安装并登录 WorkBuddy；无法保证独立登录或绕开客户端。服务可用性和费用取决于 WorkBuddy。运行时还需用户提供兼容的游戏实例、Java 和专用服务器文件。

在完成上述两次依赖安装后，运行 `npm run dist` 构建 Windows 安装包；构建脚本使用当前 Node 可执行文件作为内置运行时。安装包不附带 Minecraft 服务端及其修改版，用户需提供兼容的专用服务器文件。当前服务端启动实现主要面向 Forge，具体支持范围应以自检和实际测试结果为准。

## 许可与上游

本项目自有源码采用 MIT 许可证，详见 [LICENSE](LICENSE)。伙伴运行时代码基于 [Mindcraft](https://github.com/kolbytn/mindcraft)，其版权声明和 MIT 许可证保留在 [runtime/mindcraft-final/LICENSE](runtime/mindcraft-final/LICENSE)。第三方依赖、游戏、模组与模型服务各自适用其许可证和条款。
