# Anime4K WebExtension Plus

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![GitHub Release](https://img.shields.io/github/v/release/daika7ana/Anime4K-WebExtension-Plus?style=flat-square)](https://github.com/daika7ana/Anime4K-WebExtension-Plus/releases/latest)
[![GitHub Stars](https://img.shields.io/github/stars/daika7ana/Anime4K-WebExtension-Plus?style=flat-square)](https://github.com/daika7ana/Anime4K-WebExtension-Plus/stargazers)
[![License](https://img.shields.io/github/license/daika7ana/Anime4K-WebExtension-Plus?style=flat-square)](./LICENSE)

[English](./README.md) | 中文 | [日本語](./README.ja.md) | [Русский](./README.ru.md)

利用Anime4K实时超分辨率算法显著提升动漫视频画质，逐帧呈现更清晰锐利的视觉体验！

## 功能特性

- 🚀 WebGPU 实时超分: 依托先进的 WebGPU 技术，在浏览器端实现低延迟、高性能的视频实时超分辨率增强。
- ⚡ 多档性能预设: 提供 快速/均衡/质量/极致 四种预设模式，并支持自定义模式，灵活平衡画质提升与硬件负载。
- 📊 硬件性能评估: 内置 GPU 基准测试，为您推荐最适合您的硬件的超分档位。
- 📏 灵活分辨率控制: 支持 2x/4x/8x 倍率放大，亦可锁定 2K/4K 等目标分辨率，满足多样化观影需求。
- ✨ 一键增强: 视频播放器自动浮现紫色「✨ 超分」按钮，一键开启画质飞跃。
- 🛡️ 广泛兼容: 适配 Shadow DOM、iframe 及跨域视频源，突破技术限制，覆盖绝大多数视频网站。
- 📋 按需启用机制: 支持精准白名单策略，仅在指定站点生效，避免资源浪费与页面干扰。
- 🌈 现代化 UI 设计: 遵循 Material Design 规范，自适应 浅色/深色/跟随系统 主题，视觉体验舒适流畅。
- 🌐 国际化支持: 支持中、英、日、俄等多国语言，服务全球用户。

> [!WARNING]
> 此拓展无法作用于有Encrypted Media Extensions (EME) 或 DRM 保护的视频网站，如Netflix。

## 使用指南

### 安装扩展

#### 使用预构建包

1. 前往[GitHub Releases](https://github.com/daika7ana/Anime4K-WebExtension-Plus/releases/latest)页面
2. 在"Assets"部分下载最新构建的 `anime4k-webextension-plus.zip`
3. 解压zip文件
4. 在浏览器中加载解压后的目录：
   - Chrome: 打开拓展页面(`chrome://extensions`) → 启用"开发者模式" → "加载已解压的扩展程序" → 选择解压后的目录
   - Edge: 打开拓展页面(`edge://extensions`) → 启用"开发人员模式" → "加载解压缩的扩展" → 选择解压后的目录

#### 从源码安装

1. 克隆本仓库
2. 运行 `npm install` 安装依赖
3. 运行 `npm run build` 构建项目
4. 在浏览器中加载构建好的扩展：
   - Chrome: 打开拓展页面(`chrome://extensions`) → 启用"开发者模式" → "加载已解压的扩展程序" → 选择项目中的 `dist` 目录
   - Edge: 打开拓展页面(`edge://extensions`) → 启用"开发人员模式" → "加载解压缩的扩展" → 选择项目中的 `dist` 目录

### 一、初次设置 (Onboarding)

安装扩展后，会自动打开引导页面。为了获得最佳体验，请跟随指引完成设置：

1.  **GPU 性能基准测试**：扩展会运行一段简短的基准测试 (目标: 1080p -> 4K 24fps)，评估您的显卡性能。
2.  **推荐档位**：根据测试结果，扩展会自动为您推荐合适的性能档位 (Performance Tier)：
    *   🚀 **流畅**: 适合集成显卡或老旧设备，优先保证流畅度。
    *   ⚖️ **均衡**: 平衡画质与性能，适合大多数中端设备。
    *   🎨 **画质**: 提供更好的画面细节，适合独立显卡用户。
    *   🔬 **极致**: 最高画质，需要较强的显卡性能支持。
3.  **确认应用**：您可以接受推荐，也可以手动选择其他档位。

### 二、日常使用

1.  **启用增强**：在支持的视频网站（如 Bilibili, YouTube 等）播放视频。
2.  **点击开关**：将鼠标悬停在视频播放器上，左侧会浮现一个 **「✨ 超分」** 按钮。
    *   点击按钮启用增强，按钮状态会依次显示为 “⏳ 启动中...” → “❌ 取消”。
    *   按钮在鼠标移开后会自动半透明或隐藏，以免遮挡画面。

### 三、快捷设置面板

点击浏览器工具栏中的 Anime4K 扩展图标，打开弹出面板：

*   **性能档位 (Performance Tier)**: 快速切换四个预设档位。
    *   *注意：当选择了“自定义模式”时，性能档位将不可用，因为自定义模式由具体的着色器组合决定。*
*   **增强模式 (Enhancement Mode)**:
    *   **内置模式**: 如 Mode A, Mode B, Mode C 等经典 Anime4K 预设。
    *   **自定义模式**: 您自己创建或导入的高级模式。
*   **分辨率 (Resolution)**: 设置输出分辨率目标（x2 倍率或固定 1080p/4K 等）。
*   **白名单 (Whitelist)**:
    *   快速将当前页面、域名或父路径加入白名单。
    *   启用/禁用全局白名单功能。

### 四、高级选项

点击面板底部的 **“设置”** 按钮进入详细设置页面：

#### 1. 常规设置 (General)
*   **外观**: 切换 浅色/深色 主题。
*   **兼容性**: 开启 **"跨域兼容模式"** (Cross-Origin Mode)，用于修复因浏览器安全策略导致无法增强的视频（常见于嵌套的第三方播放器）。

#### 2. 性能设置 (Performance)
*   **GPU 测试**: 随时重新运行基准测试，更新您的性能评分。
*   **当前档位**: 查看当前生效的性能配置。

#### 3. 增强模式 (Enhancement Modes)
*   **可视化编辑器**: 创建全新的自定义模式。
*   **拖拽排序**: 调整着色器 (Shader) 的应用顺序，或调整模式列表顺序。
*   **分享配置**: 导入/导出您的自定义模式配置 (JSON 格式)。

#### 4. 白名单管理 (Whitelist)
*   **规则管理**: 查看、编辑或删除已添加的网址规则。
*   **支持通配符**: 使用 `*` 匹配多个页面（如 `*.bilibili.com/*`）。

## 致谢

- [chenmozhijin/Anime4K-WebExtension](https://github.com/chenmozhijin/Anime4K-WebExtension) — 本项目 fork 自此仓库
- [bloc97/Anime4K](https://github.com/bloc97/Anime4K)
- [Anime4K-WebGPU-Async](https://github.com/daika7ana/Anime4K-WebGPU-Async)
