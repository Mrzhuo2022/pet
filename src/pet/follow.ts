/**
 * 跟随鼠标：桌宠以恒定步速慢慢走向光标（窗口中心对准光标），
 * 光标移动时每帧用最新光标位置重算目标 → 路径实时跟着变；
 * 进入死区停步回 idle（带滞回防抖），拖拽/抛掷/休眠/隐藏/锁定时让位。
 * 纯函数 followStep 与控制器分离，便于单测。
 * 注意：本模块不能有任何模块级导入（node --test 的 strip-only 模式
 * 解析不了包依赖）——平台能力（光标/窗口信息、落位回调）全部由 deps 注入，
 * 且类字段用显式声明（不用 constructor 参数属性）。
 */

export interface Vec {
  x: number;
  y: number;
}

/** 跟随运动学的一帧上下文（物理 px）：工作区内窗口左上角允许范围 + 窗口尺寸 + 当前位置 */
export interface FollowFrame {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  w: number;
  h: number;
  x: number;
  y: number;
}

/**
 * 纯函数：单步追踪（物理 px 坐标系）。
 * 目标 = 光标位置减去半个窗口（窗口中心对准光标），clamp 进工作区；
 * 距目标 ≤ deadzone 时原地不动（moving=false），否则沿方向走 speed*dt（不超过剩余距离）。
 */
export function followStep(
  pos: Vec,
  cursor: Vec,
  frame: FollowFrame,
  speed: number,
  dtMs: number,
  deadzone: number,
): { x: number; y: number; dx: number; dist: number; moving: boolean } {
  const dt = Math.min(Math.max(dtMs, 1), 50) / 1000;
  const maxX = Math.max(frame.minX, frame.maxX);
  const maxY = Math.max(frame.minY, frame.maxY);
  const tx = Math.min(Math.max(cursor.x - frame.w / 2, frame.minX), maxX);
  const ty = Math.min(Math.max(cursor.y - frame.h / 2, frame.minY), maxY);
  const dx = tx - pos.x;
  const dy = ty - pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= deadzone) {
    return { x: pos.x, y: pos.y, dx, dist, moving: false };
  }
  const ratio = Math.min(1, (speed * dt) / dist);
  return { x: pos.x + dx * ratio, y: pos.y + dy * ratio, dx, dist, moving: true };
}

export interface FollowDeps {
  /** 本帧是否允许移动（宿主判断：开关/锁定/按压/抛掷/休眠/可见性） */
  canRun(): boolean;
  /** 光标物理坐标；暂时拿不到（窗口关闭中）返回 null */
  getCursor(): Promise<Vec | null>;
  /** 工作区 + 窗口尺寸 + 当前位置（宿主定期刷新，控制 IPC 频率） */
  getFrame(): Promise<FollowFrame | null>;
  apply(x: number, y: number): void;
  /** 开始移动或转向：设置朝向并进入 walk 状态 */
  onMoveStart(dir: 1 | -1): void;
  /** 停步：回到 idle（位置记忆由状态机 walk→idle 的既有钩子完成） */
  onMoveStop(): void;
  /** 光标明显移动（宿主用于休眠唤醒） */
  onCursorMoved(): void;
}

/** 工作区/窗口尺寸缓存刷新周期 */
const FRAME_REFRESH_MS = 2000;
/** 光标位移超过该值（物理 px）视为"动了" */
const CURSOR_MOVE_EPS = 2;
/** 停止阈值相对启动死区的收缩系数（滞回，避免在死区边缘反复启停） */
const STOP_RATIO = 0.75;

/**
 * 跟随控制器：rAF 每帧至多一次光标 IPC + 至多一次 setPosition IPC；
 * canRun 为假的帧只做布尔判断，不做任何 IPC。
 */
export class FollowController {
  private deps: FollowDeps;
  private enabled: boolean;
  private speed = 0;
  private deadzone = 0;
  private rafId: number | null = null;
  private lastT = 0;
  private busy = false;
  private moving = false;
  private facing: 1 | -1 = 1;
  private pos: Vec | null = null;
  private frameCtx: FollowFrame | null = null;
  private frameAt = 0;
  private lastCursor: Vec | null = null;

  constructor(deps: FollowDeps, opts: { enabled?: boolean; speed?: number } = {}) {
    this.deps = deps;
    this.enabled = opts.enabled ?? false;
    this.speed = opts.speed ?? 55;
  }

  start(): void {
    this.lastT = performance.now();
    if (this.rafId === null) this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.stopMove();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.stopMove();
      return;
    }
    // 从关闭中恢复：tick 在 disabled 时直接返回、rAF 链已断，
    // 必须在这里重启循环，否则设置页关→开后跟随永远失效
    if (this.rafId === null) {
      this.lastT = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  /** 物理像素运动参数（速度/死区，随 DPI 由宿主换算） */
  setMotion(speedPhys: number, deadzonePhys: number): void {
    this.speed = speedPhys;
    this.deadzone = deadzonePhys;
  }

  /** 外部改动了窗口位置（重置位置/拖拽/抛掷后）：丢弃缓存帧，下一帧重新定位 */
  invalidateFrame(): void {
    this.frameCtx = null;
  }

  private stopMove(): void {
    if (!this.moving) return;
    this.moving = false;
    this.deps.onMoveStop();
  }

  private tick = async (ts: number): Promise<void> => {
    this.rafId = null;
    if (!this.enabled) return;
    const dt = ts - this.lastT;
    this.lastT = ts;
    if (!this.busy) {
      this.busy = true;
      try {
        if (!this.deps.canRun()) {
          this.stopMove();
        } else {
          const cursor = await this.deps.getCursor();
          if (cursor) {
            if (
              this.lastCursor &&
              Math.hypot(cursor.x - this.lastCursor.x, cursor.y - this.lastCursor.y) > CURSOR_MOVE_EPS
            ) {
              this.deps.onCursorMoved();
            }
            this.lastCursor = cursor;
            // 工作区/窗口位置低频刷新（失败也退避一个周期再试）
            if (!this.frameCtx || ts - this.frameAt > FRAME_REFRESH_MS) {
              this.frameCtx = await this.deps.getFrame();
              this.frameAt = ts;
              if (this.frameCtx) this.pos = { x: this.frameCtx.x, y: this.frameCtx.y };
            }
            // IPC 等待期间开关条件可能已变（按下/松手收尾/抛掷开始）：
            // apply 前再查一次，丢弃在途的过期帧——否则会把窗口拽向旧光标位置，
            // 与抛掷/落地互相抢位（甩动失败、起跳闪跳的来源之一）
            if (!this.deps.canRun()) {
              this.stopMove();
            } else {
              const f = this.frameCtx;
              if (f && this.pos) {
                const r = followStep(
                  this.pos,
                  cursor,
                  f,
                  this.speed,
                  dt,
                  this.deadzone * (this.moving ? STOP_RATIO : 1),
                );
                if (r.moving) {
                  const dir: 1 | -1 = Math.abs(r.dx) < 4 ? this.facing : r.dx > 0 ? 1 : -1;
                  if (!this.moving || dir !== this.facing) {
                    this.moving = true;
                    this.facing = dir;
                    this.deps.onMoveStart(dir);
                  }
                  this.pos = { x: r.x, y: r.y };
                  this.deps.apply(Math.round(r.x), Math.round(r.y));
                } else {
                  this.stopMove();
                }
              }
            }
          }
        }
      } catch {
        // 单帧失败（窗口临时不可用等）下一帧重试
      } finally {
        this.busy = false;
      }
    }
    if (this.enabled && this.rafId === null) this.rafId = requestAnimationFrame(this.tick);
  };
}
