import test from 'node:test';
import assert from 'node:assert/strict';
import { flingStep, STOP_SPEED, GRAVITY_PER_S2 } from '../src/pet/fling.ts';
import type { Rect } from '../src/pet/fling.ts';

const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

test('flingStep: 位置按速度推进并指数衰减', () => {
  const r = flingStep({ x: 100, y: 100 }, { vx: 1000, vy: 0 }, 16, AREA, 200, 300);
  assert.ok(r.pos.x > 100 && r.pos.x < 120, `16ms 位移应约 16px，实际 ${r.pos.x - 100}`);
  const r2 = flingStep({ x: 100, y: 100 }, { vx: 1000, vy: 0 }, 16, AREA, 200, 300);
  // 相同输入结果确定（无随机性）
  assert.equal(r2.pos.x, r.pos.x);
  assert.ok(r.vel.vx < 1000);
});

test('flingStep: 撞右边缘反弹并 clamp 进工作区', () => {
  // 窗口 200 宽，右界 1720；一步 500px 位移直接越界
  const r = flingStep({ x: 1690, y: 0 }, { vx: 30000, vy: 0 }, 16, AREA, 200, 300);
  assert.equal(r.pos.x, 1720);
  assert.ok(r.vel.vx < 0, '反弹后速度反向');
  assert.ok(Math.abs(r.vel.vx) < 30000);
});

test('flingStep: 撞左/上/下边缘同样反弹', () => {
  const left = flingStep({ x: 50, y: 0 }, { vx: -30000, vy: 0 }, 16, AREA, 200, 300);
  assert.equal(left.pos.x, 0);
  assert.ok(left.vel.vx > 0);
  const top = flingStep({ x: 0, y: -10 }, { vx: 0, vy: -30000 }, 16, AREA, 200, 300);
  assert.equal(top.pos.y, 0);
  assert.ok(top.vel.vy > 0);
  const bottom = flingStep({ x: 0, y: 1030 }, { vx: 0, vy: 30000 }, 16, AREA, 200, 300);
  assert.equal(bottom.pos.y, 1040 - 300);
  assert.ok(bottom.vel.vy < 0);
});

test('flingStep: 速度衰减到阈值以下报告停止', () => {
  let pos = { x: 0, y: 0 };
  let vel = { vx: 1500, vy: 0 };
  let steps = 0;
  for (;;) {
    const r = flingStep(pos, vel, 16, AREA, 200, 300);
    pos = r.pos;
    vel = r.vel;
    steps += 1;
    if (r.stopped) break;
    assert.ok(steps < 600, '应在一秒内（60fps×若干）停下而不是永不收敛');
  }
  assert.ok(Math.hypot(vel.vx, vel.vy) < STOP_SPEED + 1e-9);
  assert.ok(steps > 5, '1500px/s 初速不应第一步就停');
});

test('flingStep: dt 被钳制，后台标签页回来不会瞬移', () => {
  const r = flingStep({ x: 100, y: 100 }, { vx: 3000, vy: 0 }, 5000, AREA, 200, 300);
  // 位移按 50ms 计算（3000*0.05=150），而不是 15000px
  assert.ok(r.pos.x < 260);
});

// ---- 任务栏模式的重力抛掷 ----

const GROUND = AREA.height - 300; // 窗口 300 高，maxY = 740

test('flingStep: 重力在积分前生效，抛体加速下坠', () => {
  // friction=1 去掉衰减，纯重力：dt=40ms → vy 增 120，位移 4.8px（dt 上限 50ms 内）
  const r = flingStep(
    { x: 0, y: 0 },
    { vx: 0, vy: 0 },
    40,
    AREA,
    200,
    300,
    { friction: 1, gravity: GRAVITY_PER_S2 },
  );
  assert.equal(r.pos.y, GRAVITY_PER_S2 * 0.04 * 0.04);
  assert.equal(r.vel.vy, GRAVITY_PER_S2 * 0.04);
});

test('flingStep: 落地重撞弹起、弱撞贴地静止', () => {
  // 重撞：落在地面线后向上弹（vy 为负），能量按恢复系数衰减
  const hard = flingStep(
    { x: 0, y: GROUND + 100 },
    { vx: 0, vy: 3000 },
    16,
    AREA,
    200,
    300,
    { friction: 1, gravity: GRAVITY_PER_S2 },
  );
  assert.equal(hard.pos.y, GROUND);
  assert.ok(hard.vel.vy < 0, '重撞应向上弹起');
  assert.ok(Math.abs(hard.vel.vy) < 3000);
  // 弱撞：反弹速度低于 bounceStop → vy=0 贴地静止（否则重力每帧重新加速永不收敛）
  const soft = flingStep(
    { x: 0, y: GROUND + 2 },
    { vx: 0, vy: 100 },
    16,
    AREA,
    200,
    300,
    { friction: 1, gravity: GRAVITY_PER_S2 },
  );
  assert.equal(soft.pos.y, GROUND);
  assert.equal(soft.vel.vy, 0);
  assert.ok(soft.stopped);
});

test('flingStep: 无重力时落地行为与旧版一致（直接反弹）', () => {
  const r = flingStep({ x: 0, y: GROUND + 50 }, { vx: 0, vy: 3000 }, 16, AREA, 200, 300, {
    friction: 1,
  });
  assert.equal(r.pos.y, GROUND);
  assert.ok(r.vel.vy < 0);
  assert.equal(r.vel.vy, -3000 * 0.45);
});

test('flingStep: 触底下边界报告 grounded，空中飞行不报告', () => {
  // 撞地：y 越过下边界被钳回
  const hit = flingStep({ x: 0, y: GROUND + 2 }, { vx: 0, vy: 100 }, 16, AREA, 200, 300, {
    friction: 1,
    gravity: GRAVITY_PER_S2,
  });
  assert.equal(hit.grounded, true);
  // 空中：尚未落到下边界
  const air = flingStep({ x: 0, y: 0 }, { vx: 0, vy: 100 }, 16, AREA, 200, 300, {
    friction: 1,
    gravity: GRAVITY_PER_S2,
  });
  assert.equal(air.grounded, false);
});

test('flingStep: 重力抛掷在有限步内停在地面线上', () => {
  // 贴地近处横向抛出：落地弱弹即静止，之后纯滑动衰减，最终停在线上
  let pos = { x: 100, y: GROUND - 10 };
  let vel = { vx: 600, vy: 0 };
  let steps = 0;
  for (;;) {
    const r = flingStep(pos, vel, 16, AREA, 200, 300, { gravity: GRAVITY_PER_S2 });
    pos = r.pos;
    vel = r.vel;
    steps += 1;
    if (r.stopped) break;
    assert.ok(steps < 600, '重力模式也应收敛停下');
  }
  assert.equal(pos.y, GROUND);
  assert.equal(vel.vy, 0);
  assert.ok(pos.x > 100 && pos.x < AREA.width, '沿地面向右滑行一段');
});
