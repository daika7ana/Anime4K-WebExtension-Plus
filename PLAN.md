# Performance Improvement Plan

> Generated from multi-model council analysis. Priorities: 🔴 Critical → 🟠 High → 🟡 Medium → ⚪ Low

---

## 🔴 Critical — Highest Impact

### 1. Batch GPU Warmup in `buildPipelines()`

**File:** `src/core/renderer.ts` (lines 313–321, 349–356)

**Problem:** Each effect runs `await device.queue.onSubmittedWorkDone()` after warmup. Ultra mode with 7+ effects = 7+ full GPU drains + `setTimeout` yields between each. Minimum init time: 1–5 seconds.

**Fix:** Batch all warmup submissions into a single command encoder, single sync point:

```typescript
// Current: per-effect sync (N syncs)
for (const pipeline of pipelines) {
  const encoder = device.createCommandEncoder();
  pipeline.pass(encoder);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone(); // ← bottleneck
}

// Proposed: batched sync (1 sync)
const warmupEncoder = device.createCommandEncoder();
for (const pipeline of pipelines) {
  pipeline.pass(warmupEncoder);
}
device.queue.submit([warmupEncoder.finish()]);
await device.queue.onSubmittedWorkDone();
```

**Impact:** 70–90% faster pipeline initialization.

---

### 2. Fix Render Loop Frame Drops

**File:** `src/core/renderer.ts` (lines 498–571, 615–643)

**Problem:** `processFrame()` is async and awaited. If GPU hasn't finished when next `requestVideoFrameCallback` fires, frames cascade-drop. Async serialization caps throughput at ~30fps on 60fps video.

**Fix:** Add frame-in-flight guard to prevent overlapping submissions:

```typescript
private frameInFlight = false;

private renderLoop = async (): Promise<void> => {
  if (this.destroyed) return;
  if (this.frameInFlight) {
    this.animationFrameId = this.video.requestVideoFrameCallback(this.renderLoop);
    return;
  }
  this.frameInFlight = true;
  try {
    if (await this.processFrame()) {
      this.fixAttempted = false;
      this.lastError = null;
    }
  } finally {
    this.frameInFlight = false;
  }
  if (!this.destroyed) {
    this.animationFrameId = this.video.requestVideoFrameCallback(this.renderLoop);
  }
};
```

**Impact:** ~2× frame throughput, eliminates cascading drops.

---

### 3. Debounce MutationObserver Callbacks

**File:** `src/core/video-manager.ts` (line 165)

**Problem:** `MutationObserver` on `document.body` with `{ subtree: true }` fires for every DOM insertion — React re-renders, ads, chat messages. Each callback runs `querySelectorAll('video')` on every added subtree.

**Fix:** Debounce mutations and add fast-exit guards:

```typescript
let pendingMutations: MutationRecord[] = [];
let mutationTimer: number | null = null;

const handleMutations = (mutations: MutationRecord[]) => {
  pendingMutations.push(...mutations);
  if (mutationTimer !== null) return;
  mutationTimer = window.setTimeout(() => {
    const batch = pendingMutations;
    pendingMutations = [];
    mutationTimer = null;
    processMutations(batch);
  }, 100);
};

// In processMutations, fast-check before deep scanning:
for (const node of mutation.addedNodes) {
  if (node.nodeType !== Node.ELEMENT_NODE) continue;
  const el = node as Element;
  if (el.tagName === 'VIDEO' || el.querySelector('video') || el.shadowRoot) {
    // Only then process
  }
}
```

**Impact:** Significant CPU savings on dynamic pages (YouTube, Twitch, Twitter).

---

### 4. Fix Layout Thrashing in `updatePosition()`

**File:** `src/core/overlay-manager.ts` (lines 89–151)

**Problem:** Both `ResizeObserver` and `MutationObserver` on `style`/`class` trigger `updatePosition()`, which calls `window.getComputedStyle()` — forces synchronous style recalculation. Also creates a `setTimeout` on every call for button hide.

**Fix:** Debounce with `requestAnimationFrame`, replace timer with CSS:

```typescript
private updatePositionRafId: number | null = null;

private scheduleUpdatePosition(): void {
  if (this.updatePositionRafId !== null) return;
  this.updatePositionRafId = requestAnimationFrame(() => {
    this.updatePositionRafId = null;
    this.updatePosition();
  });
}
```

```css
/* Replace JS-based show/hide with CSS hover */
:host(:hover) .anime4k-button { opacity: 1; }
```

**Impact:** Eliminates jank during video resize/animations.

---

### 5. Fix `bitmap.close()` Race Condition

**File:** `src/core/renderer.ts` (line 522)

**Problem:** On ImageBitmap fallback path, `bitmap.close()` runs before `device.queue.submit()`. Spec allows deferred copy → corrupt/black frames.

**Fix:** Keep bitmap alive until next frame:

```typescript
// At class level
private pendingBitmap: ImageBitmap | null = null;

// In processFrame():
if (this.pendingBitmap) {
  this.pendingBitmap.close();
  this.pendingBitmap = null;
}
this.pendingBitmap = await createImageBitmap(this.video);
this.device.queue.copyExternalImageToTexture(
  { source: this.pendingBitmap },
  { texture: this.videoFrameTexture },
  [this.video.videoWidth, this.video.videoHeight]
);
// Don't close yet — close on next frame entry
```

---

### 6. Add `context.unconfigure()` to Device Recovery

**File:** `src/core/renderer.ts` (line 747)

**Problem:** After device loss, canvas context must be unconfigured before reconfiguring. Missing call causes silent recovery failure.

**Fix:**

```typescript
// In recoverFromDeviceLoss(), before context.configure():
this.context.unconfigure();
this.context.configure({
  device: this.device,
  format: this.presentationFormat,
  alphaMode: 'premultiplied',
});
```

---

## 🟠 High — Significant Gains

### 7. Eliminate Redundant GPU Device in Feature Detection

**File:** `src/core/renderer.ts` (lines 388–448)

**Problem:** `detectWebGPUFeatures()` creates a separate `requestAdapter()` → `requestDevice()` just to test `copyExternalImageToTexture`. 50–200ms wasted. Also leaks device on failure path.

**Fix:** Move detection into `initialize()`, reuse the already-created device. Fix leak with `device?.destroy()` in catch block.

---

### 8. Cache Settings

**Files:** `src/utils/settings.ts`, `src/core/video-enhancer.ts`

**Problem:** `getSettings()` calls `chrome.storage.sync.get()` on every invocation (~1–5ms IPC). A single `toggleEnhancement()` can invoke 3 storage reads.

**Fix:** TTL-based cache with `chrome.storage.onChanged` invalidation:

```typescript
let cachedSettings: Anime4KWebExtSettings | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 2000; // ms

chrome.storage.onChanged.addListener(() => {
  cachedSettings = null;
});

export async function getSettings(): Promise<Anime4KWebExtSettings> {
  if (cachedSettings && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    return cachedSettings;
  }
  // ... existing fetch logic ...
  cachedSettings = result;
  cacheTimestamp = Date.now();
  return result;
}
```

Also pass already-fetched settings to `initRenderer()` instead of re-fetching.

---

### 9. Parallelize Settings Updates Across Videos

**File:** `src/core/video-manager.ts` (lines 180–211)

**Problem:** `handleSettingsUpdate()` awaits each video's `updateSettings()` sequentially. 3 videos × 4 effects = 12 sequential GPU syncs.

**Fix:**

```typescript
const results = await Promise.allSettled(
  videos.map(async (videoElement) => {
    const enhancer = EnhancerMap.getEnhancer(videoElement);
    if (enhancer && videoElement.getAttribute(ANIME4K_APPLIED_ATTR) === 'true') {
      await enhancer.updateSettings(newSettings);
    }
  })
);
```

---

### 10. Optimize Content Script Loading

**File:** `manifest.json` (lines 19–29)

**Problem:** `<all_urls>` + `all_frames: true` loads content script in every iframe. 20 iframes = 20 copies.

**Fix:** If iframe video isn't core, set `all_frames: false`. Otherwise, add early-exit:

```typescript
if (window !== window.top && !document.querySelector('video')) {
  // Child frame with no videos — skip heavy initialization
}
```

Consider using `scripting` API for on-demand injection on whitelisted pages.

---

### 11. Add Code Splitting

**File:** `webpack.config.js`

**Problem:** Single `content.js` bundles everything — UI, benchmark, anime4k-webgpu library.

**Fix:**

```javascript
optimization: {
  minimize: !isDevelopment,
  usedExports: true,
  splitChunks: { chunks: 'async' },
}
```

Move benchmark code to a separate entry loaded only from options page.

---

## 🟡 Medium — Incremental Improvements

### 12. Use `rgba8unorm` for Video Input Texture

**File:** `src/core/renderer.ts` (line 239)

**Problem:** `rgba16float` (8 bytes/pixel) for 8-bit video input. 4K frame = 66.4 MB. Doubles bandwidth for no quality gain.

**Fix:** Use `rgba8unorm`. Verify anime4k-webgpu accepts it (if effects need float, first effect can convert).

---

### 13. Replace `JSON.stringify` Effect Comparison

**File:** `src/core/renderer.ts` (line 669)

**Problem:** `JSON.stringify(this.effects) !== JSON.stringify(effects)` is fragile (property order), creates GC pressure.

**Fix:**

```typescript
const effectsChanged = this.effects.length !== effects.length ||
  this.effects.some((e, i) => e.id !== effects[i].id);
```

---

### 14. Use `crypto.getRandomValues()` in Benchmark

**File:** `src/core/gpu-benchmark.ts` (lines 117–122)

**Problem:** 6.2M calls to `Math.random()`.

**Fix:**

```typescript
const testData = new Uint8Array(TEST_WIDTH * TEST_HEIGHT * 4);
crypto.getRandomValues(testData);
for (let j = 3; j < testData.length; j += 4) testData[j] = 255;
```

---

### 15. Singleton Error Notification

**File:** `src/core/video-enhancer.ts` (lines 371–403)

**Problem:** `showErrorModal()` creates fresh DOM elements with inline styles on every error.

**Fix:** Reuse a singleton notification element, update content instead of recreating.

---

### 16. Cap Maximum Resolution

**File:** `src/core/video-enhancer.ts` (lines 267–282)

**Problem:** 4K × x8 = 30720×17280 = ~4.25 GB texture. Will OOM crash.

**Fix:** Cap at 8K (7680×4320) with proportional scaling.

---

### 17. Add Render Loop Backpressure

**File:** `src/core/renderer.ts` (lines 615–643)

**Problem:** No mechanism to skip frames when GPU is overloaded.

**Fix:** Track frame timing:

```typescript
private lastFrameTime = 0;
private renderLoop = async (): Promise<void> => {
  const now = performance.now();
  if (now - this.lastFrameTime < 8 && this.lastFrameTime > 0) {
    this.animationFrameId = this.video.requestVideoFrameCallback(this.renderLoop);
    return; // Skip — running behind
  }
  this.lastFrameTime = now;
  // ... process frame ...
};
```

---

### 18. Strip Console Logs in Production

**Files:** All source files (~40+ calls)

**Problem:** Template literals evaluated even with DevTools closed.

**Fix:** Webpack `DefinePlugin` or conditional logger:

```typescript
const DEBUG = process.env.NODE_ENV === 'development';
export const log = DEBUG ? console.log.bind(console) : () => {};
```

---

## ⚪ Low — Nice to Have

### 19. Fix `updateVideoSource()` Order

**File:** `src/core/renderer.ts` (lines 697–704)

**Problem:** Checks dimensions against old video reference, creates resources for wrong size.

**Fix:** Update `this.video = newVideo` before dimension check.

---

### 20. Use Map for Enhancer Stash

**File:** `src/core/enhancer-stash.ts` (lines 35–52)

**Problem:** `findIndex` on array is O(n).

**Fix:** Use `Map<string, StashedEnhancer>` keyed by `videoSrc`.

---

### 21. Cache Feature Detection Result

**File:** `src/core/renderer.ts` (lines 388–448)

**Problem:** Re-runs on every page load.

**Fix:** Persist result in `chrome.storage.local` with driver version key.

---

### 22. Use `addEventListener` for `onloadeddata`

**File:** `src/core/renderer.ts` (line 156)

**Problem:** Overwrites `video.onloadeddata` instead of using `addEventListener`.

**Fix:** `this.video.addEventListener('loadeddata', resolve, { once: true })`.

---

## Architecture Notes

| Concern | Recommendation |
|---------|----------------|
| Single frame failure destroys entire renderer | Add retry logic before destroying |
| No frame skipping under GPU load | Implement backpressure (#17) |
| Rapid settings changes trigger repeated rebuilds | Debounce `updateConfiguration()` |
| Full pipeline rebuild on resolution change | Only rebuild textures, not pipelines |
| 3 videos = 3 GPU devices | Consider sharing device via adapter |
| Cross-origin fix reloads video | User-visible interruption; document clearly |

---

## Execution Order

Recommended implementation sequence (dependencies considered):

```
Phase 1 — Render Pipeline (Critical path)
  #1  Batch GPU warmup
  #2  Fix render loop frame drops
  #5  Fix bitmap.close() race
  #6  Add context.unconfigure() to recovery
  #7  Eliminate redundant GPU device

Phase 2 — DOM & UI Performance
  #3  Debounce MutationObserver
  #4  Fix layout thrashing
  #15 Singleton error notification

Phase 3 — Data & Settings
  #8  Cache settings
  #9  Parallelize settings updates
  #13 Replace JSON.stringify comparison

Phase 4 — Build & Bundle
  #10 Optimize content script loading
  #11 Add code splitting
  #18 Strip console logs

Phase 5 — Texture & Memory
  #12 rgba8unorm for input texture
  #16 Cap maximum resolution
  #17 Add render loop backpressure

Phase 6 — Polish
  #14 Faster benchmark data generation
  #19 Fix updateVideoSource order
  #20 Map for enhancer stash
  #21 Cache feature detection
  #22 addEventListener for onloadeddata
```
