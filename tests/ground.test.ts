import test from 'node:test';
import assert from 'node:assert/strict';
import { groundY } from '../src/pet/ground.ts';

test('groundY: 窗口底边贴住工作区底沿', () => {
  // 任务栏在底部：workArea y=0 高 1040，窗口高 500 → 顶在 540
  assert.equal(groundY({ y: 0, height: 1040 }, 500), 540);
});

test('groundY: 工作区带顶部偏移（任务栏在顶部/有停靠条）', () => {
  assert.equal(groundY({ y: 48, height: 992 }, 500), 540);
});

test('groundY: 窗口高于工作区时贴住工作区顶沿不越界', () => {
  assert.equal(groundY({ y: 100, height: 400 }, 500), 100);
  assert.equal(groundY({ y: 100, height: 500 }, 500), 100);
});
