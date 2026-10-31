import test from 'node:test';
import assert from 'node:assert/strict';
import { diffManifest } from '../src/pet/manifestDiff.ts';
import type { PetpackManifest } from '../src/pet/petpack.ts';

const live2dBase = (): PetpackManifest => ({
  id: 'jiya',
  name: '吉雅',
  engine: 'live2d',
  entry: 'model0.json',
  animations: {
    idle: { motion: 'Idle' },
    click: { motion: 'TapBody', index: 2 },
  },
  interactions: { clickTexts: ['早上好', '晚安'], clickSounds: ['s1.wav'] },
});

test('diffManifest: 无改动返回空数组', () => {
  assert.deepEqual(diffManifest(live2dBase(), structuredClone(live2dBase())), []);
});

test('diffManifest: 动作条目/组/表情变化逐行报告', () => {
  const after = live2dBase();
  after.animations.click = { motion: 'TapBody', index: 5, expression: 'smile' };
  after.animations.drag = { motion: 'Hair' };
  delete after.animations.idle;
  const lines = diffManifest(live2dBase(), after);
  assert.ok(lines.includes('click: 条目 #2 → #5'));
  assert.ok(lines.includes('click: 表情 （无） → smile'));
  assert.ok(lines.includes('drag: 新增绑定'));
  assert.ok(lines.includes('idle: 移除绑定'));
  assert.equal(lines.length, 4);
});

test('diffManifest: 随机与指定条目互转', () => {
  const after = live2dBase();
  after.animations.click = { motion: 'TapBody' };
  const lines = diffManifest(live2dBase(), after);
  assert.ok(lines.includes('click: 条目 #2 → 随机'));
});

test('diffManifest: sprite 帧序列重排/数量/fps/循环', () => {
  const before: PetpackManifest = {
    id: 'slime',
    name: '史莱姆',
    engine: 'sprite',
    animations: { idle: { frames: [0, 1, 2], fps: 6, loop: true } },
  };
  // 纯重排：帧数不变但序列变更
  const reorder = structuredClone(before);
  reorder.animations.idle = { frames: [2, 0, 1], fps: 6, loop: true };
  const a = diffManifest(before, reorder);
  assert.ok(a.includes('idle: 帧序列变更（3 → 3 帧）'));
  assert.equal(a.length, 1);
  // fps + 循环关闭
  const misc = structuredClone(before);
  misc.animations.idle = { frames: [0, 1, 2], fps: 12, loop: false };
  const b = diffManifest(before, misc);
  assert.ok(b.includes('idle: fps 6 → 12'));
  assert.ok(b.includes('idle: 循环 开 → 关'));
});

test('diffManifest: 文案/音效/人设/气泡样式', () => {
  const after = live2dBase();
  after.interactions = { clickTexts: ['早上好'], clickSounds: ['s1.wav', 's2.wav'] };
  after.persona = { prompt: '她是看板娘' };
  after.bubble = { theme: 'dark' };
  const lines = diffManifest(live2dBase(), after);
  assert.ok(lines.includes('点击文本：2 → 1 条'));
  assert.ok(lines.includes('点击音效：1 → 2 个'));
  assert.ok(lines.includes('人设文案已设置'));
  assert.ok(lines.includes('气泡样式已调整'));
});

test('diffManifest: 命中区域与时段问候配置增删改', () => {
  const before = live2dBase();
  before.hitReactions = { voice: { motion: 'TapBody', index: 1 } };
  before.timeGreetings = { morning: { motion: 'Idle' } };
  const after = structuredClone(before);
  after.hitReactions = { voice: { motion: 'TapBody', index: 3 } };
  after.timeGreetings = {};
  after.hitReactions['HitArea2'] = { motion: 'Hair' };
  const lines = diffManifest(before, after);
  assert.ok(lines.includes('命中区域 voice: 已修改'));
  assert.ok(lines.includes('命中区域 HitArea2: 新增配置'));
  assert.ok(lines.includes('时段问候 morning: 移除配置'));
});
