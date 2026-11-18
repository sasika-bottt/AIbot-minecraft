# minebot 1.0.3-beta.3：21 项依赖告警修复报告

日期：2026-10-31（北京时间）

## 结论

beta.2 中报告的 21 项中危依赖告警（两个底层漏洞及其依赖链）已处理。当前伙伴运行时和桌面主程序分别执行 `npm audit --omit=dev` 均返回 0 项漏洞。没有设置审计忽略项，没有关闭审计。

报告文件：`runtime-audit-beta3.json`、`desktop-audit-beta3.json`。历史 `runtime-audit-2026-10-31.json` 对应 beta.2，保留供核对。

## 实际修改

- uuid 使用官方修复版 11.1.1，并锁定所有嵌套 uuid 依赖。验证 v4 标识生成，以及 v3/v5/v6 对错误缓冲区的拒绝行为。
- minimatch 使用官方修复版 11.0.1。升级 ESLint 到 10.14.0，移除旧版 eslintrc 依赖，并测试文件筛选和代码检查。
- 直接覆盖 minimatch 时，回归测试发现旧 glob 7 使用其已移除的内部接口。最终方案移除这条旧 glob 链，而非放任接口错误。
- @discordjs/node-pre-gyp 的 rimraf 调用仅清理明确的模块/构建目录。新增约 1.5 KB 的 MIT 本地适配包，使用 Node 原生 fs.rm/fs.rmSync 实现所需回调和同步接口，拒绝通配符、根目录和当前工作目录。原始 Opus 编解码及安装工具其他逻辑保持不变。
- 适配包源代码与 npm tarball 一并保存在 `runtime/mindcraft-final/vendor/`；使用 tarball 安装，不生成指回项目目录的链接。测试比对已安装代码和仓库源文件一致。
- 发现原建造代码校验依赖工作目录中并未随包提供的 ESLint 配置。改为内置明确配置，拒绝加载用户工作目录中的可执行配置，验证有效代码通过、语法错误及未定义变量被拦截。
- CI 生产依赖审计改为 `--audit-level=low`，任何严重级别均阻止继续发布。
- 打包前只在内置 Node 内容变化时复制可执行文件，避免 Windows 因相同文件正在被测试使用而报 EBUSY。

## 验证结果

1. `npm run check` 通过，`npm test` 共 17 组通过。
2. 新增的依赖兼容测试覆盖 UUID 边界检查、原生目录清理、Opus 编码/解码、ESLint 文件筛选和实际 Coder 校验入口。
3. 在没有 node_modules 的独立目录，从 package.json、锁文件和 vendor 执行 `npm ci --omit=dev` 成功，审计 0 项；该新安装目录的兼容测试也通过。此为本机干净依赖安装测试，不等同于另一台电脑或 GitHub 云端构建。
4. 使用干净安装的伙伴运行文件进行真实 Forge 1.20.1 / 47.4.23 联调，伙伴进入、管理员授权/撤销、安全停服通过。使用临时服务器副本和独立测试端口，不写回用户单人存档。
5. Windows 原生语音生成管线通过；这是本机语音文件生成及接口交接，不能替代远程双向麦克风实测。
6. 最终打包目录纯净性、应用源码一致性、伙伴 Coder/校验模块一致性检查通过。对打包后依赖再次运行同一兼容测试通过。

## 边界

- 0 项指本轮生产依赖与审计数据库中的已知漏洞，不是全项目、开发工具或未知漏洞不存在的证明。
- 依赖安装仍有部分上游弃用提示，属于维护提示，未表述为“所有控制台提示消失”。
- 任意模组/版本兼容、完整自动生存建造、远程双向语音等原有测试版边界没有变化。
- 没有开启正版身份验证，没有自动覆盖本机安装，也没有上传或替换 GitHub Release。

## 上游资料

- uuid 官方补丁：https://github.com/uuidjs/uuid/releases/tag/v11.1.1
- minimatch 公告：https://github.com/advisories/GHSA-g3hv-75wg-m249
- ESLint 10 迁移说明：https://eslint.org/docs/latest/use/migrate-to-10.0.0
- 本地清理适配层范围：`runtime/mindcraft-final/vendor/README.md`

安装包构建成功：dist/minebot-setup-1.0.3-beta.3.exe（200314529 字节）。SHA-256：2D236D39BFFC1302E37994FEDDB7491CEA60709CFF2FCE4258F43CC355D280B2。
