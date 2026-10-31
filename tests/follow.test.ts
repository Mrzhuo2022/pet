import test from 'node:test';
import assert from 'node:assert/strict';
import { followStep } from '../src/pet/follow.ts';
import type { FollowFrame } from '../src/pet/follow.ts';

const FRAME: FollowFrame = { minX: 0, maxX: 1600, minY: 0, maxY: 900, w: 400, h: 500, x: 0, y: 0 };

test('followStep: 朝光标方向恒速推进（窗口中心对准光标）', () => {
  // 目标 = (1000 - 200, 500 - 250) = (800, 250)，从 (0,0) 出发 dist ≈ 838
  const dist0 = Math.hypot(800, 250);
  const r = followStep({ x: 0, y: 0 }, { x: 1000, y: 500 }, FRAME, 200, 40, 56);
  assert.ok(r.moving);
  // dt=40 → 步长 200*0.04 = 8px，按 8/dist0 比例分配到两轴
  const ratio = 8 / dist0;
  assert.ok(Math.abs(r.x - 800 * ratio) < 1e-9, `x=${r.x}`);
  assert.ok(Math.abs(r.y - 250 * ratio) < 1e-9, `y=${r.y}`);
  // dist 是移动前的距离；移动后的新位置应更接近目标
  const distAfter = Math.hypot(800 - r.x, 250 - r.y);
  assert.ok(distAfter < dist0 - 7, '距离在缩短（步长 8px，容差 1px）');
  assert.ok(r.dx > 0, '目标在右侧 dx>0');
});

test('followStep: 进入死区原地停步', () => {
  // cursor=(1000,500) 的目标恰为 (800,250)：pos 距目标 ~11.7px < 56 → 停
  const r = followStep({ x: 790, y: 244 }, { x: 1000, y: 500 }, FRAME, 200, 16, 56);
  assert.equal(r.moving, false);
  assert.equal(r.x, 790);
  assert.equal(r.y, 244);
});

test('followStep: 目标 clamp 进工作区，反复推进收敛到边缘附近', () => {
  // 光标 (-500, 2000)：tx = -700 → clamp 0；ty = 1750 → clamp 900
  let pos = { x: 400, y: 300 };
  for (let i = 0; i < 5000; i++) {
    const r = followStep(pos, { x: -500, y: 2000 }, FRAME, 500, 16, 56);
    if (!r.moving) break;
    pos = { x: r.x, y: r.y };
  }
  assert.ok(Math.abs(pos.x - 0) <= 56, `x 应收敛到左缘附近，实际 ${pos.x}`);
  assert.ok(Math.abs(pos.y - 900) <= 56, `y 应收敛到底缘附近，实际 ${pos.y}`);
});

test('followStep: dt 钳制，长时间挂起回来不会瞬移', () => {
  const r = followStep({ x: 0, y: 0 }, { x: 10000, y: 0 }, FRAME, 200, 5000, 56);
  // 位移按 50ms 计：200*0.05 = 10px
  assert.ok(Math.abs(r.x) <= 10.0001);
});

test('followStep: 一步就能到（ratio 上限 1，恰好落在目标上）', () => {
  const r = followStep({ x: 700, y: 250 }, { x: 1000, y: 500 }, FRAME, 100000, 16, 56);
  // dist ≈ 390 > 56 → moving；ratio=1 → x,y = 目标
  assert.ok(r.moving);
  assert.equal(r.x, 800);
  assert.equal(r.y, 250);
});

test('followStep: 窗口比工作区还宽时 maxX 收敛到 minX，不会反向越界', () => {
  const narrow: FollowFrame = { ...FRAME, minX: 100, maxX: 50, w: 4000 };
  let pos = { x: 0, y: 0 };
  for (let i = 0; i < 5000; i++) {
    const r = followStep(pos, { x: 99999, y: 0 }, narrow, 100, 16, 56);
    if (!r.moving) break;
    pos = { x: r.x, y: r.y };
  }
  assert.ok(Math.abs(pos.x - 100) <= 56, `x 应收敛到 minX 附近，实际 ${pos.x}`);
});
