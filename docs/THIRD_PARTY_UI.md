# 第三方 UI 设计来源

Minebot 的界面仍由原生 HTML、CSS 和 JavaScript 实现。本项目没有把下列 React 库加入运行依赖；仅在许可证允许的范围内，参考或重写组件的信息结构、状态表达与交互规律。

## 采用的免费来源

| 来源 | 免费范围 | Minebot 采用内容 |
| --- | --- | --- |
| [BoardUI](https://github.com/BoardUI/boardui) | 免费公开仓库，MIT License | 分段选择、状态圆点、标签、通知、步骤与任务状态结构 |
| [Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) | 公开组件包，MIT License | 条件式思考圆点和活动边缘的状态表达 |
| [Watermelon UI](https://github.com/WatermelonCorp/watermelon-platform) | 公开平台与组件，MIT License | 标签、对话框、折叠、进度和 Dashboard 信息层级 |

MIT 许可证要求在复制或构成实质部分的代码中保留版权与许可证声明。Minebot 的共享组件层是针对本项目原生重写的实现；上表仍保留来源与许可证说明，避免把公开设计误称为 Minebot 独创。

## 明确未使用的内容

- **BoardUI Pro**：未使用付费组件、模板、令牌或私有注册表内容。
- **Libraries.dev Pro / Studio**：未使用付费预设、Studio 导出、Pro Skill 或受限模型文件。
- **Bencho**：免费页面用于交互观摩；未复制需要 Pro 才能取得完整源码的 Block、声音或资源。
- **HeroUI Pro**：属于付费产品；未获取、复制或移植任何 Pro 源码、模板、Figma 文件、令牌或资源。

## 实现边界

- 不加载远程样式、字体、图像或脚本。
- 不向第三方发送界面状态、用户设置、账号、存档或日志。
- 不要求用户安装 Node、React、Tailwind、Motion 或额外 UI 运行环境。
- 所有动态效果都必须提供文字或图标状态，并尊重系统的减少动态和高对比设置。
