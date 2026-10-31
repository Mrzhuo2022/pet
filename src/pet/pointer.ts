import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import type { PetStage } from './PetStage';

interface HitContext {
  cursorX: number;
  cursorY: number;
  winX: number;
  winY: number;
  scale: number;
}

/** 视角跟随保持时长：光标停止移动超过该时长后眼神慢慢回正（否则会一直僵在盯人的姿态） */
const GAZE_HOLD_MS = 1800;
/** 穿透切换的施密特阈值：穿透中（判定是否进入拦截）用高阈值——轮廓要足够实体才拦鼠标；
 * 已拦截（判定是否放行）用低阈值——只要还有一点实体就保持可点。
 * 两阈值间的 alpha 噪声（待机动画在轮廓边缘的摆动）不会引发状态切换，
 * 否则光标停在桌宠边缘附近时 WS_EX_TRANSPARENT 反复切换、分层窗口闪烁 */
const HIT_ENTER_ALPHA = 64;
const HIT_EXIT_ALPHA = 16;

export class PointerManager {
  private mode: 'poll' | 'drag' = 'poll';
  /** 拖拽期是否跟随光标移动窗口（锁定位置时只按不拖，轮询暂停但不移动） */
  private following = true;
  /** 当前窗口是否处于点击穿透（与 Rust 建窗时的初始穿透状态一致） */
  private ignoring = true;
  /** 光标连续离开精灵的次数：放行穿透的去抖计数（见 poll 内注释） */
  private leaveStreak = 0;
  private timer: number | null = null;
  private busy = false;
  private grabPhysX = Number.NaN;
  private grabPhysY = Number.NaN;
  private rafId: number | null = null;
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  /** 拖拽期光标物理坐标样本（松手时算抛掷初速度用） */
  private samples: { t: number; x: number; y: number }[] = [];
  /** 速度样本窗口：只用最近这段毫秒内的光标位移 */
  private static SAMPLE_MS = 120;
  /** 光标位置与其最近一次移动时刻（眼神静止回正判定用） */
  private lastCursorX = Number.NaN;
  private lastCursorY = Number.NaN;
  private lastMoveAt = 0;

  constructor(
    private stage: PetStage,
    private pollMs = 50,
  ) {}

  start(): void {
    this.timer = window.setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.stopDragLoop();
  }

  get dragging(): boolean {
    return this.mode === 'drag';
  }

  /**
   * 进入按住状态：暂停命中轮询（按压中光标移出精灵时不至于把窗口切成
   * 点击穿透、丢掉 pointerup），follow=false 时只暂停轮询、不移动窗口。
   */
  beginDrag(follow = true): void {
    this.mode = 'drag';
    this.following = follow;
    this.grabPhysX = Number.NaN;
    this.grabPhysY = Number.NaN;
    this.lastX = Number.NaN;
    this.lastY = Number.NaN;
    this.samples = [];
    this.stage.dragging = true;
    // 只按不拖时不启动循环：轮询已由 mode='drag' 暂停，无逐帧工作可做
    if (follow && this.rafId === null) this.rafId = requestAnimationFrame(this.dragFrame);
  }

  endDrag(): void {
    this.mode = 'poll';
    this.stage.dragging = false;
    this.stopDragLoop();
  }

  /**
   * 拖拽末速度（物理 px/s）：最近 ~120ms 光标位移的平均速度。
   * 样本不足（点住不动 / 刚按下的首帧）时返回 0，不触发抛掷。
   */
  velocity(): { vx: number; vy: number } {
    const s = this.samples;
    if (s.length < 2) return { vx: 0, vy: 0 };
    const a = s[0]!;
    const b = s[s.length - 1]!;
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }

  private stopDragLoop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private async context(): Promise<HitContext> {
    return invoke<HitContext>('hit_context');
  }

  private async poll(): Promise<void> {
    if (this.mode !== 'poll' || this.busy || document.hidden || this.stage.suspended) return;
    this.busy = true;
    try {
      const ctx = await this.context();
      const x = (ctx.cursorX - ctx.winX) / ctx.scale;
      const y = (ctx.cursorY - ctx.winY) / ctx.scale;
      const inside = this.stage.hitTest(
        x,
        y,
        this.ignoring ? HIT_ENTER_ALPHA : HIT_EXIT_ALPHA,
      );
      this.stage.noteActivity(inside);
      if (this.stage.gazeEnabled) {
        const now = performance.now();
        if (ctx.cursorX !== this.lastCursorX || ctx.cursorY !== this.lastCursorY) {
          this.lastCursorX = ctx.cursorX;
          this.lastCursorY = ctx.cursorY;
          this.lastMoveAt = now;
        }
        // 光标移动时眼神跟随；停下一会儿后回正（focusController 内部缓动）
        if (now - this.lastMoveAt < GAZE_HOLD_MS) this.stage.focus(x, y);
        else this.stage.focusCenter();
      }
      // 抛掷等快速移动期间抑制穿透切换：飞行中命中区域严重滞后、状态高频翻转，
      // 每次切换都闪；落地后由下一轮轮询按施密特阈值自行纠正
      if (this.stage.suppressHitToggle) {
        this.leaveStreak = 0;
      } else if (inside === this.ignoring) {
        // 状态矛盾，需要切换穿透：
        // - 光标在精灵上但窗口仍穿透 → 立即解除（交互优先，不能等去抖）；
        // - 光标已离开但窗口仍拦截 → 连续两次轮询都离开才放行：行走中 alpha
        //   命中缓存每 400ms 才刷新一次，边界判定有噪声，来回切换
        //   WS_EX_TRANSPARENT 会让分层窗口闪烁
        if (inside || ++this.leaveStreak >= 2) {
          this.leaveStreak = 0;
          this.ignoring = !inside;
          await getCurrentWindow().setIgnoreCursorEvents(!inside);
        }
      } else {
        this.leaveStreak = 0;
      }
    } catch {
      // Hidden or closing windows can reject the IPC; retry on the next tick.
    } finally {
      this.busy = false;
    }
  }

  private dragFrame = async (): Promise<void> => {
    this.rafId = null;
    if (this.mode !== 'drag' || this.busy) {
      if (this.mode === 'drag') this.rafId = requestAnimationFrame(this.dragFrame);
      return;
    }
    this.busy = true;
    try {
      const ctx = await this.context();
      if (!this.following) return; // 只按不拖（锁定位置）：不采样、不移动窗口
      if (Number.isNaN(this.grabPhysX)) {
        this.grabPhysX = ctx.cursorX - ctx.winX;
        this.grabPhysY = ctx.cursorY - ctx.winY;
      }
      const now = performance.now();
      this.samples.push({ t: now, x: ctx.cursorX, y: ctx.cursorY });
      while (this.samples.length > 2 && now - this.samples[0]!.t > PointerManager.SAMPLE_MS) {
        this.samples.shift();
      }
      const x = Math.round(ctx.cursorX - this.grabPhysX);
      const y = Math.round(ctx.cursorY - this.grabPhysY);
      if (x !== this.lastX || y !== this.lastY) {
        this.lastX = x;
        this.lastY = y;
        await getCurrentWindow().setPosition(new PhysicalPosition(x, y));
      }
    } catch {
      // Keep the current position if the window is temporarily unavailable.
    } finally {
      this.busy = false;
      if (this.mode === 'drag') this.rafId = requestAnimationFrame(this.dragFrame);
    }
  };
}
