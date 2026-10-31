import { currentMonitor, type Window } from '@tauri-apps/api/window';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import type { PetStage } from './PetStage';
import type { PetStateMachine } from './stateMachine';
import type { PetState, WalkFreq } from './types';

const FREQ_PRESETS: Record<WalkFreq, { idle: [number, number]; stroll: number }> = {
  quiet: { idle: [40_000, 90_000], stroll: 0.1 },
  normal: { idle: [15_000, 40_000], stroll: 0.25 },
  lively: { idle: [6_000, 15_000], stroll: 0.45 },
};
const WALK_MIN_MS = 2_000;
const WALK_MAX_MS = 6_000;
const STROLL_GAP_MS = [800, 1_600] as const;
const EDGE_CSS = 4;
const rand = (min: number, max: number): number => min + Math.random() * (max - min);

export class WanderController {
  private enabled: boolean;
  private locked: boolean;
  /** 被更高优先级的移动行为（跟随鼠标）压制：完全停摆，解除后恢复 */
  private suppressed = false;
  private freq: WalkFreq;
  private speedCss: number;
  private walking = false;
  private soon = false;
  private idleTimer: number | null = null;
  private rafId: number | null = null;
  private busy = false;
  private unwatch: () => void = () => {};
  private startX = 0;
  private y = 0;
  private dir: 1 | -1 = 1;
  private speed = 0;
  private minX = 0;
  private maxX = 0;
  private t0 = 0;
  private endAt = 0;
  private lastX = Number.NaN;

  constructor(
    private machine: PetStateMachine,
    private stage: PetStage,
    private win: Window,
    opts: { enabled?: boolean; locked?: boolean; freq?: WalkFreq; speed?: number } = {},
  ) {
    this.enabled = opts.enabled ?? true;
    this.locked = opts.locked ?? false;
    this.freq = opts.freq ?? 'normal';
    this.speedCss = Math.min(200, Math.max(20, opts.speed ?? 55));
  }

  start(): void {
    this.unwatch = this.machine.onChange(this.onState);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (this.machine.state === 'idle') this.schedule();
  }

  stop(): void {
    this.unwatch();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.cancelSchedule();
    this.stopWalk();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.updateActive();
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.updateActive();
  }

  setSuppressed(on: boolean): void {
    if (this.suppressed === on) return;
    this.suppressed = on;
    this.updateActive();
  }

  setConfig(cfg: { freq?: WalkFreq; speed?: number }): void {
    if (cfg.freq) this.freq = cfg.freq;
    if (typeof cfg.speed === 'number') this.speedCss = Math.min(200, Math.max(20, cfg.speed));
    this.updateActive();
  }

  interrupt(): void {
    this.updateActive();
  }

  private onState = (next: PetState): void => {
    if (next === 'walk') return;
    this.cancelSchedule();
    if (this.walking) this.stopWalk();
    if (next === 'idle') this.schedule();
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      this.cancelSchedule();
      this.stopWalk();
    } else if (this.machine.state === 'idle') {
      this.schedule();
    }
  };

  private active(): boolean {
    return this.enabled && !this.locked && !this.suppressed && !document.hidden;
  }

  private updateActive(): void {
    if (!this.active()) {
      this.cancelSchedule();
      this.stopWalk();
      return;
    }
    if (this.machine.state === 'idle') this.schedule();
  }

  private schedule(): void {
    this.cancelSchedule();
    if (!this.active() || this.machine.state !== 'idle') return;
    const [min, max] = FREQ_PRESETS[this.freq].idle;
    const delay = this.soon ? rand(STROLL_GAP_MS[0], STROLL_GAP_MS[1]) : rand(min, max);
    this.soon = false;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      if (this.active() && this.machine.state === 'idle') void this.startWalk();
    }, delay);
  }

  private cancelSchedule(): void {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async startWalk(): Promise<void> {
    if (!this.active() || this.machine.state !== 'idle') return;
    const monitor = await currentMonitor();
    if (!monitor) return;
    const sf = await this.win.scaleFactor();
    const pos = await this.win.outerPosition();
    const size = await this.win.outerSize();
    // 三次 IPC 等待期间用户可能已点击/拖拽：不再抢状态（walk 会覆盖 click 的反应动作）
    if (!this.active() || this.machine.state !== 'idle') return;
    const area = monitor.workArea;
    this.minX = area.position.x + Math.round(EDGE_CSS * sf);
    this.maxX = area.position.x + area.size.width - size.width - Math.round(EDGE_CSS * sf);
    if (this.maxX <= this.minX) return;
    this.startX = pos.x;
    this.y = pos.y;
    this.dir = Math.random() < 0.5 ? -1 : 1;
    if (this.startX <= this.minX) this.dir = 1;
    if (this.startX >= this.maxX) this.dir = -1;
    this.speed = this.speedCss * sf;
    this.t0 = performance.now();
    this.endAt = this.t0 + rand(WALK_MIN_MS, WALK_MAX_MS);
    this.lastX = Number.NaN;
    this.walking = true;
    this.stage.setFacing(this.dir);
    this.machine.set('walk');
    this.rafId = requestAnimationFrame(this.frame);
  }

  private frame = (ts: number): void => {
    this.rafId = null;
    if (!this.walking) return;
    let x = this.startX + ((ts - this.t0) / 1000) * this.speed * this.dir;
    if (x <= this.minX) {
      x = this.minX;
      this.finishWalk();
    } else if (x >= this.maxX) {
      x = this.maxX;
      this.finishWalk();
    } else if (ts >= this.endAt) {
      this.finishWalk();
    }
    const rx = Math.round(x);
    if (rx !== this.lastX && !this.busy) {
      this.lastX = rx;
      this.busy = true;
      void this.win.setPosition(new PhysicalPosition(rx, this.y)).finally(() => {
        this.busy = false;
      });
    }
    if (this.walking && this.rafId === null) this.rafId = requestAnimationFrame(this.frame);
  };

  private finishWalk(): void {
    if (!this.walking) return;
    this.soon = Math.random() < FREQ_PRESETS[this.freq].stroll;
    this.stopWalk();
  }

  private stopWalk(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (!this.walking) return;
    this.walking = false;
    this.machine.set('idle');
  }
}
