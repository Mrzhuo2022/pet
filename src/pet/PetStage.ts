import * as PIXI from 'pixi.js';
import { Live2DEngine } from './engines/live2d';
import { SpriteEngine } from './engines/sprite';
import type { MotionPlayOpts, PetEngine } from './engines/types';
import { fetchManifest, type PackEntry, type PetpackAnimation, type PetpackManifest } from './petpack';
import type { MotionFeedback } from './motionText';
import type { SemanticAction } from './types';

/** 帧率策略：交互 60 / 动作播放中 30 / Live2D 待机 30 / 精灵待机 12 / 深度待机 10 */
const FPS_ACTIVE = 60;
const FPS_ANIMATING = 30;
const FPS_IDLE_LIVE2D = 30;
const FPS_IDLE_SPRITE = 12;
const FPS_DEEP = 10;
const DEEP_IDLE_MS = 120_000;

/** alpha 命中检测的离屏渲染降采样倍率（1/4 分辨率，2px 精度，读回开销可忽略） */
const ALPHA_SCALE = 4;
/** alpha 缓存刷新间隔：动作播放期轮廓变化快，用短间隔；静止期呼吸只微动轮廓，长间隔即可 */
const ALPHA_REFRESH_ACTIVE_MS = 400;
const ALPHA_REFRESH_IDLE_MS = 1200;
/** play() 后认为动作在播的窗口（覆盖典型 2–8s 的动作+语音） */
const MOTION_ALPHA_MS = 8_000;
const ALPHA_THRESHOLD = 32;
/** 内容区与窗口边缘的透明余量（CSS 像素）：布局内缩，任何动画帧不被裁切 */
export const PAD_X = 16;
export const PAD_BOTTOM = 16;
/** 自然尺寸的参考窗口（scale=1 的基准） */
const REF_W = 360;
const REF_H = 480;

/**
 * 桌宠舞台：Pixi 应用 + 引擎适配层编排 + 帧率治理 + 逐像素命中缓存。
 * 不关心具体渲染引擎（Live2D / 精灵图），通过 loadPack 切换皮肤包。
 */
export class PetStage {
  private app!: PIXI.Application;
  private engine?: PetEngine;
  private packId = '';
  /** 当前皮肤包上下文（ baseUrl + 清单），供交互反馈（音效/文本）读取 */
  private packCtx: { baseUrl: string; manifest: PetpackManifest } | null = null;
  private alphaRt?: PIXI.RenderTexture;
  private alphaCache: Uint8Array | null = null;
  private alphaW = 0;
  private alphaH = 0;
  private alphaTimer: number | null = null;
  private governTimer: number | null = null;
  private lastActivity = performance.now();
  private pointerInside = false;
  /** 动作/走动中：不低于 FPS_ANIMATING，避免持给走动/播动作时掉到待机帧率 */
  private animating = false;
  /** play() 后的动作窗口：alpha 缓存期间用短间隔刷新 */
  private motionUntil = 0;
  private destroyed = false;
  private resizeObserver?: ResizeObserver;
  private facing: 1 | -1 = 1;
  private paused = false;
  /** 休眠中（行为层置位）：眼神跟随暂停 */
  sleeping = false;
  /** 视角跟随开关（行为层同步设置）：关闭时眼神不跟随鼠标 */
  gazeEnabled = true;
  /** 当前皮肤待机帧率：Live2D 30 / 精灵 12 */
  private idleFps = FPS_IDLE_LIVE2D;
  /** 拖拽中：跳过 alpha 刷新（此时命中状态已知，省掉离屏渲染开销） */
  dragging = false;
  /** 快速移动期间（抛掷飞行）抑制命中穿透切换：状态高频翻转，
   * 每次 WS_EX_TRANSPARENT 切换都会让分层窗口闪一下；落地后由轮询自行纠正 */
  suppressHitToggle = false;
  /**
   * 皮肤自然尺寸：scale=1 时内容的显示尺寸（参考窗口下测量）。
   * 由 loadPack 测量一次；缩放设置以它为基准（绝对语义，无反馈环）。
   */
  natural: { w: number; h: number } = { w: REF_W, h: REF_H };

  get ready(): boolean {
    return !!this.engine;
  }

  get suspended(): boolean {
    return this.paused;
  }

  get currentPackId(): string {
    return this.packId;
  }

  get packContext(): { baseUrl: string; manifest: PetpackManifest } | null {
    return this.packCtx;
  }

  /** 指针当前是否悬停在桌宠上（待机闲聊等行为避让用） */
  get hovered(): boolean {
    return this.pointerInside;
  }

  /** 深度待机：长时间无交互、无动画（休眠判断用；交互/hover/动作播放都会刷新计时） */
  get deepIdle(): boolean {
    return (
      !this.pointerInside &&
      !this.animating &&
      performance.now() - this.lastActivity > DEEP_IDLE_MS
    );
  }

  async init(container: HTMLElement): Promise<void> {
    this.app = new PIXI.Application({
      resizeTo: container,
      backgroundAlpha: 0,
      // MSAA 对 Live2D 网格渲染收益微小，却是透明窗口里最贵的 GPU 开销之一
      antialias: false,
      powerPreference: 'high-performance',
      autoStart: false,
      sharedTicker: true,
      // 按 DPI 渲染（否则画面被浏览器拉伸发虚，命中坐标也随之偏移）
      resolution: Math.min(window.devicePixelRatio || 1, 3),
      autoDensity: true,
    });
    this.app.ticker.start();
    container.appendChild(this.app.view as HTMLCanvasElement);

    // 低频刷新 alpha 缓存，供点击穿透做逐像素命中（间隔随动作状态动态调整）
    this.scheduleAlpha();
    // 每秒评估一次深待机降档
    this.governTimer = window.setInterval(() => this.governFrameRate(), 1_000);
    // 容器尺寸变化（缩放设置/窗口调整）时重新贴合布局
    this.resizeObserver = new ResizeObserver(() => {
      this.refit();
    });
    this.resizeObserver.observe(container);
  }

  /** 加载/切换皮肤包（先加载新引擎成功后再销毁旧的） */
  async loadPack(pack: PackEntry): Promise<void> {
    const manifest = await fetchManifest(pack.baseUrl);
    const engine: PetEngine =
      manifest.engine === 'live2d' ? new Live2DEngine() : new SpriteEngine();
    await engine.load(pack.baseUrl, manifest);
    if (this.destroyed) {
      engine.destroy();
      return;
    }
    const old = this.engine;
    this.engine = engine;
    this.packId = pack.id;
    this.packCtx = { baseUrl: pack.baseUrl, manifest };
    engine.setFacing(this.facing); // 换肤保持朝向
    this.currentKeyReset(engine);
    this.idleFps = manifest.engine === 'sprite' ? FPS_IDLE_SPRITE : FPS_IDLE_LIVE2D;
    this.app.stage.addChild(engine.root);
    old?.destroy();
    // 自然尺寸：引擎几何确定性计算（scale=1 基准），不依赖渲染时序
    this.natural = engine.naturalSize(REF_W, REF_H);
    this.refit();
    this.play('idle');
    this.governFrameRate();
  }

  /** 引擎切换后清空循环动画去重状态（各引擎内部维护，此处无需处理） */
  private currentKeyReset(_engine: PetEngine): void {
    // 预留：如果以后去重逻辑上移到舞台层
  }

  layout(): void {
    if (!this.app || !this.engine) return;
    const w = this.app.renderer.width / this.app.renderer.resolution;
    const h = this.app.renderer.height / this.app.renderer.resolution;
    this.engine.layout(w, h);
  }

  /**
   * 布局：内容区域内缩 PAD 后铺满（余量成为布局的一部分，
   * 任何动画帧不被窗口边缘裁切）。
   * 注意：这里绝不请求窗口尺寸——窗口大小的唯一所有者是缩放设置，
   * 否则会形成 refit ↔ 窗口尺寸的正反馈循环（滑杆失效的根因）。
   */
  refit(): void {
    if (!this.app || !this.engine) return;
    const w = this.app.renderer.width / this.app.renderer.resolution;
    const h = this.app.renderer.height / this.app.renderer.resolution;
    this.engine.root.position.set(PAD_X, 0);
    this.engine.layout(w - PAD_X * 2, h - PAD_BOTTOM);
    this.refreshAlpha();
  }

  /** 播放语义动作，转发给当前引擎；返回实际播放的动作反馈（台词/语音联动用） */
  play(action: SemanticAction, opts?: MotionPlayOpts): MotionFeedback | undefined {
    // 动作播放期：轮廓变化快 → alpha 缓存切短间隔；动画本身也计为活动
    this.motionUntil = performance.now() + MOTION_ALPHA_MS;
    this.lastActivity = performance.now();
    this.governFrameRate();
    return this.engine?.play(action, opts);
  }

  /** 播放一条显式绑定（命中区域反应/时段问候用）；引擎不支持时返回 undefined */
  playBinding(
    binding: PetpackAnimation,
    action?: SemanticAction,
    opts?: MotionPlayOpts,
  ): MotionFeedback | undefined {
    this.motionUntil = performance.now() + MOTION_ALPHA_MS;
    this.lastActivity = performance.now();
    this.governFrameRate();
    return this.engine?.playBinding?.(binding, action, opts);
  }

  /** 主表是否正在播单次（非循环）动作：回 idle 时行为层据此不立刻重播截断它 */
  playingOneShot(): boolean {
    return this.engine?.playingOneShot?.() ?? false;
  }

  /** 命中区域检测（窗口内 CSS 坐标）：返回命中的 HitArea 区域名（仅 Live2D） */
  hitAreasAt(x: number, y: number): string[] {
    return this.engine?.hitAreas?.(x, y) ?? [];
  }

  /**
   * 切换服装：index 0 = 模型默认，i = manifest.outfits[i-1]。
   * 皮肤包未配置 outfits 或索引越界时回默认装。
   */
  setOutfit(index: number): void {
    const list = this.packContext?.manifest.outfits;
    const outfit = index > 0 && list ? list[index - 1] : undefined;
    this.engine?.setOutfit?.(outfit ?? null);
  }

  /** 行为层告知非闲置状态（走动/拖拽等）：帧率不低于 FPS_ANIMATING */
  setAnimating(on: boolean): void {
    if (this.animating === on) return;
    this.animating = on;
    this.governFrameRate();
  }

  /** 朝向翻转（1 朝右 / -1 朝左），换肤后保持 */
  setFacing(dir: 1 | -1): void {
    this.facing = dir;
    this.engine?.setFacing(dir);
  }

  /** 眼神跟随（窗口内 CSS 坐标），引擎不支持时忽略；休眠中不跟 */
  focus(x: number, y: number): void {
    if (this.sleeping) return;
    this.engine?.focus?.(x, y);
  }

  /** 眼神回正到默认朝向（光标静止超时后调用，避免一直保持盯着某处的姿态） */
  focusCenter(): void {
    if (this.sleeping) return;
    this.engine?.focusCenter?.();
  }

  /** 复位表情到默认（悬停表情离开时用） */
  resetExpression(): void {
    this.engine?.resetExpression?.();
  }

  /**
   * 记录交互活动；hover 表示指针当前是否悬停在桌宠上。
   * 只有真实交互/悬停才刷新 lastActivity，否则深度待机永远不会触发。
   */
  noteActivity(hover = false): void {
    if (hover) this.lastActivity = performance.now();
    this.pointerInside = hover;
    this.governFrameRate();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!this.app) return;
    if (paused) this.app.ticker.stop();
    else {
      this.app.ticker.start();
      this.refreshAlpha();
    }
  }

  /** 帧率治理：悬停 60 / 动作与走动 30 / 待机（Live2D 30、精灵 12）/ 深度待机 10 */
  governFrameRate(): void {
    if (this.paused) return;
    const idleMs = performance.now() - this.lastActivity;
    const fps = this.pointerInside
      ? FPS_ACTIVE
      : this.animating || performance.now() < this.motionUntil
        ? FPS_ANIMATING
        : idleMs > DEEP_IDLE_MS
          ? FPS_DEEP
          : this.idleFps;
    const ticker = this.app?.ticker;
    if (ticker && ticker.maxFPS !== fps) ticker.maxFPS = fps;
  }

  /** 逐像素命中检测：读取低分辨率 alpha 缓存（1 alpha 像素 = ALPHA_SCALE CSS 像素）。
   * threshold 可调：调用方做施密特触发（进入阈值高、退出阈值低），
   * 避免光标停在轮廓边缘时待机动画的 alpha 噪声反复切换穿透状态 */
  hitTest(cssX: number, cssY: number, threshold: number = ALPHA_THRESHOLD): boolean {
    if (!this.alphaCache) return false;
    const x = Math.floor(cssX / ALPHA_SCALE);
    const y = Math.floor(cssY / ALPHA_SCALE);
    if (x < 0 || y < 0 || x >= this.alphaW || y >= this.alphaH) return false;
    return this.alphaCache[(y * this.alphaW + x) * 4 + 3] > threshold;
  }

  /**
   * 角色可见内容的最高点（窗口内 CSS 像素），供气泡窗贴着头顶定位。
   * 无缓存或全空时返回 null。
   */
  visibleTop(): number | null {
    if (!this.alphaCache) return null;
    for (let y = 0; y < this.alphaH; y++) {
      const row = y * this.alphaW * 4 + 3;
      for (let x = 0; x < this.alphaW; x++) {
        if (this.alphaCache[row + x * 4] > ALPHA_THRESHOLD) {
          return y * ALPHA_SCALE;
        }
      }
    }
    return null;
  }

  /**
   * 角色可见内容的最低点（窗口内 CSS 像素），任务栏模式贴地用：
   * 脚底（而非模型画布自带的脚下留白/固定内边距）踩在任务栏上沿。
   * 返回值偏保守（向上取整到 alpha 粒度）：贴地宁可靠进任务栏 1–4px 也不悬空。
   * 无缓存或全空时返回 null。
   */
  visibleBottom(): number | null {
    if (!this.alphaCache) return null;
    for (let y = this.alphaH - 1; y >= 0; y--) {
      const row = y * this.alphaW * 4 + 3;
      for (let x = 0; x < this.alphaW; x++) {
        if (this.alphaCache[row + x * 4] > ALPHA_THRESHOLD) {
          return (y + 1) * ALPHA_SCALE;
        }
      }
    }
    return null;
  }

  /**
   * 自适应调度的 alpha 刷新：动作播放期每 400ms，静止期每 1200ms。
   * 每次刷新都要把整个舞台重渲染到离屏 RT（Live2D 是全置 draw call），
   * 固定短间隔会在静止期造成周期性卡顿，固定长间隔又跟不住动作轮廓。
   */
  private scheduleAlpha(): void {
    if (this.destroyed) return;
    // 动作播放中或走动/跟随移动中：轮廓变化快，用短间隔；静止期长间隔
    const active = performance.now() < this.motionUntil || this.animating;
    const delay = active ? ALPHA_REFRESH_ACTIVE_MS : ALPHA_REFRESH_IDLE_MS;
    this.alphaTimer = window.setTimeout(() => {
      this.refreshAlpha();
      this.scheduleAlpha();
    }, delay);
  }

  /**
   * 把舞台渲染到 1/8 分辨率的离屏纹理并读回 alpha 通道。
   * 相比全尺寸 extract（整场景重渲染 + 全量 GPU 回读），这里便宜 64 倍，
   * 消除了每 500ms 一次的周期性掉帧。
   */
  private refreshAlpha(): void {
    if (!this.app || this.destroyed || this.dragging || this.paused || document.hidden) return;
    const res = this.app.renderer.resolution;
    const wCss = Math.floor(this.app.renderer.width / res);
    const hCss = Math.floor(this.app.renderer.height / res);
    const aw = Math.max(1, Math.ceil(wCss / ALPHA_SCALE));
    const ah = Math.max(1, Math.ceil(hCss / ALPHA_SCALE));
    if (!this.alphaRt || this.alphaRt.width !== aw || this.alphaRt.height !== ah) {
      this.alphaRt?.destroy(true);
      this.alphaRt = PIXI.RenderTexture.create({
        width: aw,
        height: ah,
        scaleMode: PIXI.SCALE_MODES.LINEAR,
      });
    }
    try {
      // 关键：渲染到自定义 RT 时投影按 RT 尺寸计算，
      // 必须传入缩放矩阵把舞台坐标系（CSS 像素）压到 RT 尺寸，
      // 否则内容在 RT 可见区之外，得到全空纹理。
      const m = new PIXI.Matrix().scale(1 / ALPHA_SCALE, 1 / ALPHA_SCALE);
      this.app.renderer.render(this.app.stage, {
        renderTexture: this.alphaRt,
        transform: m,
      });
      const pixels = this.app.renderer.extract.pixels(this.alphaRt) as Uint8Array;
      this.alphaCache = pixels;
      this.alphaW = aw;
      this.alphaH = ah;
    } catch {
      // 窗口隐藏等场景下渲染/读取可能失败，静默跳过本次
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    if (this.alphaTimer !== null) window.clearTimeout(this.alphaTimer);
    if (this.governTimer !== null) window.clearInterval(this.governTimer);
    this.engine?.destroy();
    this.alphaRt?.destroy(true);
    this.app?.destroy(false, { children: true });
    // 同页热重载/组件重建时，旧 Application 会把共享 ticker 停掉；
    // 这里恢复它，避免新舞台 created 后一直空白。
    PIXI.Ticker.shared.start();
  }
}
