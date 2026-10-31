import test from 'node:test';
import assert from 'node:assert/strict';
import {
  intersectsRect,
  isVisibleOnWorkAreas,
  recoverWindowPosition,
} from '../src/pet/windowGeometry.ts';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: -2560, y: 120, width: 2560, height: 1440 };

test('窗口与工作区相交即保留，包括负坐标副屏', () => {
  assert.equal(intersectsRect(-300, 200, 203, 256, secondary), true);
  assert.equal(isVisibleOnWorkAreas(-300, 200, 203, 256, [primary, secondary]), true);
  assert.deepEqual(recoverWindowPosition(-300, 200, 203, 256, [primary, secondary]), {
    x: -300,
    y: 200,
    changed: false,
  });
});

test('完全离屏的位置拉回主屏工作区并限制窗口尺寸', () => {
  assert.deepEqual(recoverWindowPosition(2400, 1300, 203, 256, [primary, secondary]), {
    x: 1717,
    y: 784,
    changed: true,
  });
  assert.deepEqual(recoverWindowPosition(-9000, -500, 203, 256, [primary, secondary]), {
    x: 0,
    y: 0,
    changed: true,
  });
});

test('工作区不可用时保留原位置，空窗口不会误判可见', () => {
  assert.deepEqual(recoverWindowPosition(4000, 5000, 203, 256, []), {
    x: 4000,
    y: 5000,
    changed: false,
  });
  assert.equal(isVisibleOnWorkAreas(1920, 0, 203, 256, [primary]), false);
});
