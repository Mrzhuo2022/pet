import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFocus } from '../src/pet/engines/types.ts';

// 模型原始空间：宽 200 高 600，中心 (100, 300)，半径 r = 300
const W = 200;
const H = 600;

test('normalizeFocus: 鼠标在模型中心 → 眼神回正', () => {
  const { fx, fy } = normalizeFocus(100, 300, W, H);
  assert.equal(Math.abs(fx), 0); // abs：容许 -0（pixi 取反产生，数值等价）
  assert.equal(Math.abs(fy), 0);
});

test('normalizeFocus: 近处按比例线性偏转（不丢距离信息）', () => {
  // 水平偏 75（< 半径 300）→ fx = 75/300 = 0.25，不满偏
  const a = normalizeFocus(175, 300, W, H);
  assert.equal(a.fx, 0.25);
  assert.equal(Math.abs(a.fy), 0);
  // 垂直：鼠标在模型上方 150 → fy = +0.5（向上看，正值）
  const b = normalizeFocus(100, 150, W, H);
  assert.equal(Math.abs(b.fx), 0);
  assert.equal(b.fy, 0.5);
  // 鼠标在模型下方 150 → fy = -0.5（向下看）
  const c = normalizeFocus(100, 450, W, H);
  assert.equal(c.fy, -0.5);
});

test('normalizeFocus: 远处 clamp 满偏，且不再随距离变化', () => {
  // 鼠标水平距离 1000 与 5000（都在窗口外很远）→ 同样满偏 1
  const near = normalizeFocus(1100, 300, W, H);
  const far = normalizeFocus(5100, 300, W, H);
  assert.equal(near.fx, 1);
  assert.equal(far.fx, 1);
  // 下方极远 → 满偏向下
  const down = normalizeFocus(100, 5000, W, H);
  assert.equal(down.fy, -1);
});

test('normalizeFocus: 库旧实现的病灶不复现 —— 非轴向位置不满偏', () => {
  // 旧实现 atan2+cos/sin：任何非中心位置眼神模长恒为 1（两轴同时接近满偏）。
  // 线性归一化后：右上方 100/150 → (0.33, 0.5)，模长 < 1，按真实距离偏转
  const { fx, fy } = normalizeFocus(200, 150, W, H);
  assert.equal(fx, 100 / 300);
  assert.equal(fy, 0.5);
  assert.ok(Math.hypot(fx, fy) < 1);
});

test('normalizeFocus: 非法尺寸返回 0（防御）', () => {
  assert.deepEqual(normalizeFocus(10, 10, 0, 600), { fx: 0, fy: 0 });
  assert.deepEqual(normalizeFocus(10, 10, 200, -1), { fx: 0, fy: 0 });
});
