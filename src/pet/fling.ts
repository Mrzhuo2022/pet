/**
 * 拖拽抛掷：松手时把拖拽末速度转成窗口惯性，rAF 循环里推进位置、
 * 指数摩擦衰减、撞工作区边缘轻反弹，速度衰减到阈值以下自然停下。
 * 纯函数 flingStep 与控制器分离，便于单测物理。
 */

export interface Vec {
  x: number;
  y: number;
}

export interface Velocity {
  vx: number;
  vy: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 每秒速度保留率：0.06 → 1 秒后剩 6%，滑行 1–1.5s 自然停下 */
export const FRICTION_PER_SEC = 0.06;
/** 反弹恢复系数：撞边保留 45% 的法向速度 */
export const RESTITUTION = 0.45;
/** 低于该速度（物理 px/s）视为停下 */
export const STOP_SPEED = 45;
/** 重力加速度（物理 px/s²）：任务栏模式抛掷启用，约 0.55s 落 500px */
export const GRAVITY_PER_S2 = 3000;
/** 落地反弹低于该速度直接贴地静止（防无限微弹跳） */
export const BOUNCE_STOP_SPEED = 120;

/**
 * 纯函数：单步积分（物理 px 坐标系）。
 * pos/vel 就地换算成新值返回；撞边时位置 clamp 进工作区、法向速度取反乘恢复系数。
 * gravity > 0 时（任务栏模式）抛体受重力下坠：落到下边界先弹跳，弱撞击直接
 * 贴地静止（vy=0），否则重力每帧重新加速会永远停不下来；gravity = 0（默认）
 * 行为与旧版完全一致。
 */
export function flingStep(
  pos: Vec,
  vel: Velocity,
  dtMs: number,
  bounds: Rect,
  winW: number,
  winH: number,
  opts: {
    friction?: number;
    restitution?: number;
    stopSpeed?: number;
    gravity?: number;
    bounceStop?: number;
  } = {},
): { pos: Vec; vel: Velocity; stopped: boolean; grounded: boolean } {
  const friction = opts.friction ?? FRICTION_PER_SEC;
  const restitution = opts.restitution ?? RESTITUTION;
  const stopSpeed = opts.stopSpeed ?? STOP_SPEED;
  const gravity = opts.gravity ?? 0;
  const bounceStop = opts.bounceStop ?? BOUNCE_STOP_SPEED;
  const dt = Math.min(Math.max(dtMs, 1), 50) / 1000;
  const decay = Math.pow(friction, dt);

  const vyInt = vel.vy + gravity * dt;
  let x = pos.x + vel.vx * dt;
  let y = pos.y + vyInt * dt;
  let vx = vel.vx * decay;
  let vy = vyInt * decay;

  const minX = bounds.x;
  const maxX = Math.max(bounds.x, bounds.x + bounds.width - winW);
  const minY = bounds.y;
  const maxY = Math.max(bounds.y, bounds.y + bounds.height - winH);
  if (x < minX) {
    x = minX;
    vx = Math.abs(vx) * restitution;
  } else if (x > maxX) {
    x = maxX;
    vx = -Math.abs(vx) * restitution;
  }
  if (y < minY) {
    y = minY;
    vy = Math.abs(vy) * restitution;
  } else if (y > maxY) {
    y = maxY;
    if (gravity > 0) {
      const bounce = Math.abs(vy) * restitution;
      vy = bounce < bounceStop ? 0 : -bounce;
    } else {
      vy = -Math.abs(vy) * restitution;
    }
  }

  return {
    pos: { x, y },
    vel: { vx, vy },
    stopped: Math.hypot(vx, vy) < stopSpeed,
    /** 这一步是否处在下边界（落地/贴地）——任务栏模式首次触地时回调台词用 */
    grounded: y >= maxY,
  };
}

/**
 * 抛掷控制器：PetApp 在拖拽结束（且末速度足够）时 start，rAF 每帧积分一次、
 * 至多一次 setPosition IPC；自然停下或外部 stop（再次按下/被隐藏/上锁）后结束。
 */
export class FlingController {
  private rafId: number | null = null;
  private lastT = 0;
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private pos: Vec = { x: 0, y: 0 };
  private vel: Velocity = { vx: 0, vy: 0 };
  private bounds: Rect | null = null;
  private winW = 0;
  private winH = 0;
  private stepOpts: { gravity?: number; bounceStop?: number; restitution?: number } = {};
  private groundNotified = false;
  private readonly apply: (x: number, y: number) => void;
  private readonly onStop: () => void;
  private readonly onGround?: () => void;

  // 不用 TS 参数属性（constructor(private apply: ...)）：node --test 的
  // strip-only 模式不解这种语法，而这个模块被 fling 单测直接加载
  constructor(apply: (x: number, y: number) => void, onStop: () => void, onGround?: () => void) {
    this.apply = apply;
    this.onStop = onStop;
    this.onGround = onGround;
  }

  get active(): boolean {
    return this.rafId !== null;
  }

  start(
    pos: Vec,
    vel: Velocity,
    bounds: Rect,
    winSize: { w: number; h: number },
    opts: { gravity?: number; bounceStop?: number; restitution?: number } = {},
  ): void {
    this.pos = { ...pos };
    this.vel = { ...vel };
    this.bounds = bounds;
    this.winW = winSize.w;
    this.winH = winSize.h;
    this.stepOpts = opts;
    this.groundNotified = false;
    this.lastT = performance.now();
    this.lastX = Number.NaN;
    this.lastY = Number.NaN;
    if (this.rafId === null) this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private frame = (ts: number): void => {
    this.rafId = null;
    const bounds = this.bounds;
    if (!bounds) return;
    const dt = ts - this.lastT;
    this.lastT = ts;
    const r = flingStep(this.pos, this.vel, dt, bounds, this.winW, this.winH, this.stepOpts);
    this.pos = r.pos;
    this.vel = r.vel;
    const rx = Math.round(this.pos.x);
    const ry = Math.round(this.pos.y);
    if ((rx !== this.lastX || ry !== this.lastY) && !Number.isNaN(rx)) {
      this.lastX = rx;
      this.lastY = ry;
      this.apply(rx, ry);
    }
    // 首次触地只通知一次（落地弹跳时机由宿主决定，例如显示松手台词）
    if (r.grounded && !this.groundNotified) {
      this.groundNotified = true;
      this.onGround?.();
    }
    if (r.stopped) {
      this.onStop();
      return;
    }
    this.rafId = requestAnimationFrame(this.frame);
  };
}
