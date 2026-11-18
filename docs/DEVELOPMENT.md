# 开发与构建

[返回主页](../README.md)

## 本地运行

使用 Windows x64、Node.js 22 和 npm。在仓库根目录执行：

```powershell
npm ci
npm --prefix runtime/mindcraft-final ci --omit=dev
npm run check
npm test
npm start
```

## 构建安装包

```powershell
npm run dist -- --publish never
node tests/release-purity-smoke.cjs
```

产物位于 `dist/`。构建准备会检查目录链接，复制当前 Node 可执行文件作为内置伙伴运行时；不将个人配置、世界、游戏服务端或开发缓存打包。不要使用系统 Node 的不同大版本随意重建原生依赖。

## 自动化与发布

GitHub Actions 在 `main` 和发布分支运行依赖安装、语法、回归、依赖审计、Windows 打包与纯净检查。手动执行发布工作流并启用 `publish` 后，会在检查通过后创建草稿 Release；核对文件和结果后再发布正式版本。

版本号来自根目录 `package.json`，需同时更新锁文件和 `docs/release-notes.md`。稳定版本不带预发布后缀；历史安装包不覆盖，安装器只放 Releases，不提交进 Git。

## 测试边界

`npm test` 使用隔离临时目录与可控测试输入。`tests/live-*.cjs` / `.mjs` 仅在显式提供测试配置并检查端口、进程及世界副本后运行，不能指向用户正在使用的世界。真实测试与模拟结果要分开报告。

## 源码与归档

- `src/services/`：配置、导入、模型通道、运行资源、服务器和伙伴生命周期。
- `src/renderer/`：简体中文配置向导与监管界面。
- `runtime/mindcraft-final/`：基于 Mindcraft 的单 Agent 运行时及上游许可证。
- `archive/reports/`：旧版阶段性报告，仅作为历史参考。

保留第三方版权。不要提交账号、令牌、世界、日志、私有皮肤或包含这些内容的压缩包。
