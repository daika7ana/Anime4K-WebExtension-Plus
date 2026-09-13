# Anime4K WebExtension Plus

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![GitHub Release](https://img.shields.io/github/v/release/daika7ana/Anime4K-WebExtension-Plus?style=flat-square)](https://github.com/daika7ana/Anime4K-WebExtension-Plus/releases/latest)
[![GitHub Stars](https://img.shields.io/github/stars/daika7ana/Anime4K-WebExtension-Plus?style=flat-square)](https://github.com/daika7ana/Anime4K-WebExtension-Plus/stargazers)
[![License](https://img.shields.io/github/license/daika7ana/Anime4K-WebExtension-Plus?style=flat-square)](./LICENSE)

English | [中文](./README.zh.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

Significantly improve the image quality of anime videos with the Anime4K real-time super-resolution algorithm, delivering a clearer and sharper visual experience frame by frame!

## Features

- 🚀 **Real-time Super-Resolution:** Leverage advanced WebGPU technology to achieve low-latency, high-performance real-time video super-resolution enhancement directly in the browser.
- ⚡ **Multiple Performance Tiers:** Offers four preset modes: Fast/Balanced/Quality/Ultra, and supports Custom Modes to flexibly balance image quality improvement and hardware load.
- 📊 **Hardware Performance Evaluation:** Built-in GPU benchmark test to recommend the best super-resolution tier for your hardware.
- 📏 **Flexible Resolution Control:** Supports 2x/4x/8x upscaling factors, or can lock to target resolutions like 2K/4K to meet diverse viewing needs.
- ✨ **One-Click Enhance:** A purple "✨ Enhance" button automatically appears on the video player for one-click image quality boost.
- 🛡️ **Broad Compatibility:** Adapts to Shadow DOM, iframes, and cross-origin video sources, breaking through technical limitations to cover the vast majority of video websites.
- 📋 **On-Demand Activation Mechanism:** Supports precise Whitelist strategy, effective only on specified sites to avoid resource waste and page interference.
- 🌈 **Modern UI Design:** Follows Material Design guidelines, adapting to Light/Dark/System themes for a comfortable and smooth visual experience.
- 🌐 **Internationalization Support:** Supports multiple languages including Chinese, English, Japanese, and Russian to serve global users.

> [!WARNING]
> This extension does not work on video websites with Encrypted Media Extensions (EME) or DRM protection, such as Netflix.

## User Guide

### Install the Extension

#### Using Pre-built Packages

1. Go to [GitHub Releases](https://github.com/daika7ana/Anime4K-WebExtension-Plus/releases/latest)
2. Under "Assets", download the latest `anime4k-webextension-plus.zip`
3. Unzip the downloaded file
4. Load the unzipped directory in your browser:
   - Chrome: Open extensions page (`chrome://extensions`) → Enable "Developer mode" → "Load unpacked" → Select the unzipped directory
   - Edge: Open extensions page (`edge://extensions`) → Enable "Developer mode" → "Load unpacked" → Select the unzipped directory

#### From Source Code

1. Clone this repository
2. Run `pnpm install` to install dependencies
3. Run `pnpm build` to build the project
4. Load the built extension in your browser:
   - Chrome: Open extensions page (`chrome://extensions`) → Enable "Developer mode" → "Load unpacked" → Select the `dist` directory in the project
   - Edge: Open extensions page (`edge://extensions`) → Enable "Developer mode" → "Load unpacked" → Select the `dist` directory in the project

### I. First Run (Onboarding)

After installing the extension, an onboarding page will automatically open. For the best experience, please follow the guide to complete the setup:

1.  **GPU Benchmark**: The extension will run a short benchmark (Target: 1080p -> 4K 24fps) to evaluate your graphics card performance.
2.  **Recommended Tier**: Based on the results, the extension will automatically recommend a suitable Performance Tier:
    *   🚀 **Performance**: Best for integrated graphics or older devices, prioritizing smoothness.
    *   ⚖️ **Balanced**: Balances quality and performance, suitable for most mid-range devices.
    *   🎨 **Quality**: Provides better image detail, suitable for discrete graphics cards.
    *   🔬 **Ultra**: Maximum quality, requires strong graphics card performance.
3.  **Apply**: You can accept the recommendation or manually select another tier.

### II. Daily Use

1.  **Enable Enhancement**: Play a video on a supported website (e.g., Bilibili, YouTube). A purple **"✨ Enhance"** button will appear on the left side of the video player when you hover over it.
2.  **Click to Toggle**: Click the button to enable real-time super-resolution. The button state will change from "⏳ Starting..." to "❌ Cancel".
3.  **Auto-hide**: The button will automatically hide when the mouse is moved away to maintain a clean viewing experience.

### III. Popup Panel Settings

Click the Anime4K extension icon in the browser toolbar to open the quick settings panel:

*   **Performance Tier**: Quickly switch between four presets.
    *   *Note: When a "Custom Mode" is selected, the Performance Tier is unavailable because custom modes are defined by their specific shader combinations.*
*   **Enhancement Mode**:
    *   **Built-in Modes**: Classic Anime4K presets like Mode A, Mode B, Mode C.
    *   **Custom Modes**: Advanced modes created or imported by you.
*   **Resolution**: Set the target output resolution (x2 scaling or fixed 1080p/4K, etc.).
*   **Whitelist**:
    *   Quickly add the current page, domain, or parent path to the whitelist.
    *   Enable/disable the global whitelist feature.

### IV. Advanced Options

Click the **"Settings"** button at the bottom of the panel to access the detailed settings page:

#### 1. General Settings
*   **Appearance**: Switch between Light/Dark themes.
*   **Compatibility**: Enable **"Cross-Origin Compatibility Mode"** to fix videos that fail to enhance due to browser security policies (common with nested third-party players).

#### 2. Performance Settings
*   **GPU Benchmark**: Re-run the benchmark at any time to update your performance score.
*   **Current Tier**: View the currently active performance configuration.

#### 3. Enhancement Modes
*   **Visual Editor**: Create brand new custom modes.
*   **Drag & Drop Sorting**: Adjust the order of applied shaders or the mode list itself.
*   **Share Config**: Import/Export your custom mode configurations (JSON format).

#### 4. Whitelist Management
*   **Rule Management**: View, edit, or delete added URL rules.
*   **Wildcard Support**: Use `*` to match multiple pages (e.g., `*.bilibili.com/*`).

## Choosing a Mode & Target Resolution

Pick a mode by the **type of degradation** in the source, not by resolution alone — a sharp 720p master and a blurry 1080p re-encode want different modes. As a starting point, the upstream quick-start labels are **Mode A ≈ 1080p, Mode B ≈ 720p, Mode C ≈ 480p**; the source-type guidance below is derived from the official "Optimized for" descriptions, which are more precise than resolution alone.

| Mode | Recommended source | Notes |
| --- | --- | --- |
| Mode A | Most 1080p anime; some older 720p; old/blurry SD; heavy blur, compression smearing or many resampling artifacts | Best perceptual quality; can amplify ringing/banding already present in the source |
| Mode B | Most 720p; 1080p→720p downscales; low blur with downsampling ringing/aliasing | Uses the "Soft" restore trained for downsampling artifacts |
| Mode C | Clean sources with no degradation: digital art/wallpapers, 1080p→480p downscales, rarely high-quality 1080p animation | Highest PSNR but lowest perceptual sharpness; can amplify ringing/resampling artifacts |
| Mode A+A | Same source class as A, but you want extra perceptual detail | Adds a second restore pass |
| Mode B+B | Same source class as B, with extra perceptual detail | Adds a second restore pass |
| Mode C+A | Same clean-source class as C, when plain C looks too soft | Adds a restore pass for more perceived detail without mode A's ringing-prone restore |

### The 2× Rule

The doubled modes (A+A / B+B / C+A) should only be used when the target/source ratio is **at least 2×** (for example 720p→1440p or 1080p→4K). At a 1:1 or native target they oversharpen and can degrade the image — use a single mode there (or restore-only). Upstream wording:

> These modes should only be used on upscaling ratios of x2 or higher. If you have a 1080p screen, using mode A on 1080p anime will improve image quality, but mode A+A will most likely oversharpen and degrade the image.

### Mode C+A

Mode C+A is for a **clean, undegraded source (C-class)** when the ratio is **≥2×**. It adds a restore pass for slightly higher perceptual quality than plain C. Do not use it for compressed/blurry video (that is A / A+A) or for downsampling ringing (that is B / B+B).

### Performance Tiers

The four performance tiers (Fast / Balanced / Quality / Ultra) are a **GPU budget, not a resolution**: they select CNN variant sizes, and the onboarding benchmark recommends one for your hardware. Higher tiers are not "for higher resolutions".

### Target Resolution

The default target is the `x2` multiplier. `Match Display` is an option you can select: it sizes the chain to your monitor at the device-pixel ratio (capped at 8K). Fixed targets (720p / 1080p / 2K / 4K), other multipliers (x4 / x8) and a `Native` target are available when you want to force a specific output size.

### Optional Effects & Notes

*   Every built-in mode already starts with **Clamp Highlights** (prevents ringing); it is on by default.
*   **Debanding** helps sources that already show banding; **Denoise** helps noisy/compressed sources but can blur textures. Note: upstream Anime4K ships no deband shader — debanding here is an extension-provided helper, so treat any deband advice as a practical suggestion rather than upstream guidance.
*   The built-in modes use the CNN ×2 upscalers only. GAN shaders (Restore GAN, Upscale GAN x3/x4) are available only in **Custom Modes** and are much heavier; they are experimental upstream.
*   There is no automatic mode selection — choose it yourself per source.

This guidance is derived from [bloc97/Anime4K](https://github.com/bloc97/Anime4K)'s [`md/GLSL_Instructions_Advanced.md`](https://github.com/bloc97/Anime4K/blob/master/md/GLSL_Instructions_Advanced.md): the **A = 1080p / B = 720p / C = 480p** labels are official, while the finer source-type mapping is derived from it.

## Acknowledgments

- [chenmozhijin/Anime4K-WebExtension](https://github.com/chenmozhijin/Anime4K-WebExtension) — Original repository this project is forked from
- [bloc97/Anime4K](https://github.com/bloc97/Anime4K)
- [Anime4K-WebGPU-Async](https://github.com/daika7ana/Anime4K-WebGPU-Async)
