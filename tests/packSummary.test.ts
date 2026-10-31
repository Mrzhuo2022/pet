import test from 'node:test';
import assert from 'node:assert/strict';
import { animText, summarizeManifest } from '../src/pet/packSummary.ts';
import type { PetpackManifest } from '../src/pet/petpack.ts';
import type { MotionDef } from '../src/pet/motionText.ts';

const M3 = {
  FileReferences: {
    Motions: {
      Idle: [{ File: 'i1.json' }, { Name: '空组条目' }],
      TapBody: [{ File: 't1.json', Name: '哥哥，欢迎回来~', Sound: 'v1.wav' }, { File: 't2.json' }],
    },
    Expressions: [{ Name: 'smile' }, { Name: 'angry' }],
    HitAreas: [{ Name: 'voice' }, { Name: 'HitArea2' }],
  },
};

const LIVE2D: PetpackManifest = {
  id: 'jiya',
  name: '吉雅',
  engine: 'live2d',
  entry: 'model0.json',
  animations: {
    idle: { motion: 'Idle' },
    click: { motion: 'TapBody', index: 0 },
    hover: { expression: 'smile' },
  },
  hitReactions: { voice: { motion: 'TapBody', index: 0 } },
  timeGreetings: { morning: { motion: 'TapBody' } },
  interactions: { clickTexts: ['a', 'b'], clickSounds: ['s1.wav', 's2.wav', 's3.wav', 's4.wav'] },
};

test('summarizeManifest: live2d 计数与绑定摘要', () => {
  const s = summarizeManifest(LIVE2D, M3);
  assert.equal(s.engine, 'live2d');
  assert.deepEqual(
    s.motionGroups.map((g) => `${g.name} ${g.playable}/${g.total}`),
    ['Idle 1/2', 'TapBody 2/2'],
  );
  assert.deepEqual(s.expressions, ['smile', 'angry']);
  assert.deepEqual(s.hitAreas, ['voice', 'HitArea2']);
  assert.deepEqual(s.bindings.map((b) => `${b.action}: ${b.text}`), [
    'idle: Idle · 随机',
    'click: TapBody · 第 0 条 · 哥哥，欢迎回来~',
    'hover: 表情 smile',
  ]);
  assert.deepEqual(s.hitReactions, [{ key: 'voice', text: 'TapBody · 第 0 条 · 哥哥，欢迎回来~' }]);
  assert.deepEqual(s.timeGreetings, [{ key: '早上（5–10点）', text: 'TapBody · 随机' }]);
  assert.equal(s.clickTexts, 2);
  assert.equal(s.clickSounds.length, 4);
  assert.equal(s.frames, null);
});

test('summarizeManifest: sprite 与 m3 缺失降级', () => {
  const sprite: PetpackManifest = {
    id: 'slime',
    name: '史莱姆',
    engine: 'sprite',
    sprite: { sheet: 'sheet.png', frameW: 64, frameH: 64, cols: 4 },
    animations: { idle: { frames: [0, 1, 2, 3], fps: 6, loop: true } },
  };
  const s = summarizeManifest(sprite);
  assert.equal(s.frames, 4);
  assert.deepEqual(s.bindings, [{ action: 'idle', text: '4 帧 · 6fps · 循环' }]);
  assert.equal(s.motionGroups.length, 0);
  assert.equal(s.expressions.length, 0);
  // live2d 但 model3 抓取失败：组规模为空、绑定仍有动作组名
  const s2 = summarizeManifest(LIVE2D);
  assert.equal(s2.motionGroups.length, 0);
  assert.ok(s2.bindings.some((b) => b.action === 'click' && b.text.startsWith('TapBody')));
});

test('animText: 边界分支', () => {
  const defs: Record<string, MotionDef[]> = { Idle: [{ File: 'a.json' }] };
  assert.equal(animText('live2d', undefined, defs), '—');
  assert.equal(animText('live2d', { motion: 'Idle', index: 5, expression: 'x' }, defs), 'Idle · 第 5 条 · 表情 x');
  assert.equal(animText('sprite', { frames: [] }, undefined), '—');
  assert.equal(animText('sprite', { frames: [1], loop: false }, undefined), '1 帧 · 单次');
});
