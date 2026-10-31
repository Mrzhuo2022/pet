/**
 * 皮肤封面：列表/切换条/编辑器共用的角色形象图。
 * 优先读已落盘的封面文件（用户包 .cover.png / 内置包 appData/covers/<id>.png），
 * 没有则现场渲染生成并异步落盘，生成失败回退旧缩略图方案（packThumb）。
 * 生成走离屏 PIXI Application（Live2D 静置一帧渲染），并发限流最多 2 个。
 */
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';
import { fetchManifest, packThumb, resolveUrl, type PackEntry, type PetpackManifest } from './petpack';

/** 封面长边（像素） */
const LONG_EDGE = 256;
/** 封面文件大小上限（与 Rust decode_cover 的 200KB 一致） */
const MAX_BYTES = 200 * 1024;
/** 同时生成封面的上限（Live2D 模型加载重，避免拖垮设置窗口） */
const MAX_CONCURRENT = 2;

/** 会话内缓存：packId → 封面 URL（dataURL 或 asset:// 路径） */
const memCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

let active = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  while (active >= MAX_CONCURRENT) {
    await new Promise<void>((res) => waiters.push(res));
  }
  active += 1;
}

function releaseSlot(): void {
  active -= 1;
  waiters.shift()?.();
}

/** 皮肤包删除/重导入后清掉会话缓存，避免残留旧封面 */
export function invalidateCover(id: string): void {
  memCache.delete(id);
  inflight.delete(id);
}

/**
 * 把画布当前帧保存为皮肤封面（编辑器"设为封面"用）。
 * 成功后会话内缓存同步更新，列表立即可见新封面。
 */
export async function saveCoverFromCanvas(
  packId: string,
  source: HTMLCanvasElement,
): Promise<boolean> {
  const dataUrl = fitDataUrl(source, MAX_BYTES);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  try {
    await invoke('write_pack_cover', { id: packId, base64Data: base64 });
    memCache.set(packId, dataUrl);
    return true;
  } catch {
    return false;
  }
}

/** 获取皮肤封面 URL（带缓存与生成限流）；失败返回 null */
export function coverFor(pack: PackEntry): Promise<string | null> {
  const cached = memCache.get(pack.id);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(pack.id);
  if (running) return running;
  const task = (async () => {
    await acquireSlot();
    try {
      return await resolveCover(pack);
    } finally {
      releaseSlot();
      inflight.delete(pack.id);
    }
  })();
  inflight.set(pack.id, task);
  return task;
}

async function resolveCover(pack: PackEntry): Promise<string | null> {
  // 1. 已落盘的封面文件：跨会话直接复用，不重复渲染。
  //    内置包的缓存键带包版本（id@version）：改皮肤资源并升版本后自动重新生成，
  //    否则旧封面文件会一直被复用（比如史莱姆换色后列表还是绿图）。
  let coverKey = pack.id;
  if (pack.source === 'builtin') {
    try {
      const v = (await fetchManifest(pack.baseUrl)).version;
      if (v) coverKey = `${pack.id}@${v}`;
    } catch {
      // 版本拿不到就退回无版本键（旧行为）
    }
  }
  try {
    const path = await invoke<string | null>('pack_cover_path', { id: coverKey });
    if (path) {
      const url = convertFileSrc(path);
      memCache.set(pack.id, url);
      return url;
    }
  } catch {
    // Rust 侧不可用（浏览器调试）→ 直接现场生成
  }
  // 2. 现场生成；失败回退旧缩略图方案（Live2D 纹理 / sprite 首帧合成）
  const dataUrl = await generateCover(pack).catch(() => packThumb(pack).catch(() => null));
  if (!dataUrl) return null;
  memCache.set(pack.id, dataUrl);
  // 3. 异步落盘（不阻塞返回；超限等失败静默，下次会话重新生成）
  if (dataUrl.startsWith('data:')) {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    void invoke('write_pack_cover', { id: coverKey, base64Data: base64 }).catch(() => {});
  }
  return dataUrl;
}

/** 渲染生成封面 dataURL：Live2D → 模型静置一帧；sprite → 首帧合成图 */
export async function generateCover(pack: PackEntry): Promise<string | null> {
  const m = await fetchManifest(pack.baseUrl);
  if (m.engine === 'live2d' && m.entry) {
    return renderLive2dCover(m, pack.baseUrl);
  }
  return packThumb(pack);
}

/**
 * 离屏渲染 Live2D 模型静置首帧为封面：底边居中、长边 LONG_EDGE、透明底 PNG。
 * 不自动更新 ticker，手动推进两帧让模型产生有效姿态；用完即销毁
 * （Application 持有 WebGL 上下文，浏览器有约 16 个的上限）。
 */
async function renderLive2dCover(m: PetpackManifest, baseUrl: string): Promise<string> {
  // pixi-live2d-display 运行时从 window.PIXI 取 Ticker/Texture
  (window as unknown as { PIXI?: typeof PIXI }).PIXI ??= PIXI;
  const app = new PIXI.Application({
    width: LONG_EDGE,
    height: LONG_EDGE,
    backgroundAlpha: 0,
    antialias: false,
    autoStart: false,
    sharedTicker: false,
  });
  let model: Live2DModel | undefined;
  try {
    model = await Live2DModel.from(resolveUrl(m.entry!, baseUrl), {
      autoInteract: false,
      autoUpdate: false,
    });
    app.stage.addChild(model);
    const ow = model.internalModel.originalWidth;
    const oh = model.internalModel.originalHeight;
    const s = Math.min(LONG_EDGE / ow, LONG_EDGE / oh) * 0.94;
    model.anchor.set(0.5, 1);
    model.scale.set(s);
    model.position.set(LONG_EDGE / 2, LONG_EDGE - 2);
    model.update(16);
    model.update(16);
    app.renderer.render(app.stage);
    const canvas = app.renderer.extract.canvas(app.stage) as unknown as HTMLCanvasElement;
    return fitDataUrl(canvas, MAX_BYTES);
  } finally {
    model?.destroy();
    app.destroy(false, { children: true });
  }
}

/** PNG dataURL 尺寸校验：超限就等比缩小重编码（封面约定 <200KB） */
function fitDataUrl(canvas: HTMLCanvasElement, maxBytes: number): string {
  const url = canvas.toDataURL('image/png');
  if (dataUrlBytes(url) <= maxBytes) return url;
  for (const scale of [0.75, 0.5, 0.35]) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * scale));
    c.height = Math.max(1, Math.round(canvas.height * scale));
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.drawImage(canvas, 0, 0, c.width, c.height);
    const next = c.toDataURL('image/png');
    if (dataUrlBytes(next) <= maxBytes) return next;
  }
  return url; // 实在压不下去就原样返回（Rust 落盘会拒绝，仅会话内可用）
}

/** base64 dataURL 的近似字节数（去掉前缀与 padding 误差） */
function dataUrlBytes(url: string): number {
  const i = url.indexOf(',');
  return i < 0 ? 0 : Math.floor(((url.length - i - 1) * 3) / 4);
}
