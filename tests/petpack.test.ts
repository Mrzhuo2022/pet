import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve as urlResolve } from 'node:url';
import { filterSortPacks, normalizeSettings, resolveUrl, timeSlot, userPackBaseUrl, validateManifest } from '../src/pet/petpack.ts';
import type { PackEntry } from '../src/pet/petpack.ts';

test('normalizeSettings: 缺省值安全', () => {
  const base = {
    pets: [],
    volume: 0.6,
    bubbleMs: 2600,
    gravity: 3000,
    bounceRestitution: 0.45,
    flingMinSpeed: 220,
    ambientIntervalSec: 40,
    alwaysOnTop: true,
  };
  assert.deepEqual(normalizeSettings(null), base);
  assert.deepEqual(normalizeSettings(undefined), base);
});

test('normalizeSettings: 物理与闲聊参数越界收敛', () => {
  const s = normalizeSettings({
    gravity: 99,
    bounceRestitution: 2,
    flingMinSpeed: 1,
    ambientIntervalSec: 9999,
  });
  assert.equal(s.gravity, 1000);
  assert.equal(s.bounceRestitution, 0.8);
  assert.equal(s.flingMinSpeed, 100);
  assert.equal(s.ambientIntervalSec, 180);
});

test('normalizeSettings: ambientEnabled 缺省开启、显式关闭保持', () => {
  const s = normalizeSettings({
    pets: [
      { id: 'pet-1' }, // 缺字段 → 默认开
      { id: 'pet-2', ambientEnabled: false }, // 显式关
      { id: 'pet-3', ambientEnabled: true },
    ],
  });
  assert.equal(s.pets[0]!.ambientEnabled, true);
  assert.equal(s.pets[1]!.ambientEnabled, false);
  assert.equal(s.pets[2]!.ambientEnabled, true);
});

test('normalizeSettings: groundEnabled 缺省开启、显式关闭保持', () => {
  const s = normalizeSettings({
    pets: [
      { id: 'pet-1' }, // 缺字段 → 默认开（任务栏模式）
      { id: 'pet-2', groundEnabled: false }, // 显式关
    ],
  });
  assert.equal(s.pets[0]!.groundEnabled, true);
  assert.equal(s.pets[1]!.groundEnabled, false);
});

test('normalizeSettings: 字段映射与越界收敛', () => {
  const s = normalizeSettings({
    volume: 2,
    bubbleMs: 10,
    pets: [
      {
        id: 'pet-1',
        petpack: 'panda.incense',
        x: 120,
        y: null,
        scale: 9,
        lockPosition: true,
        roamEnabled: false,
        soundEnabled: false,
        bubbleEnabled: false,
        flingEnabled: false,
        gazeEnabled: false,
        followEnabled: true,
        alwaysOnTop: false,
        walkFreq: 'lively',
        walkSpeed: 999,
      },
    ],
  });
  assert.equal(s.volume, 1);
  assert.equal(s.bubbleMs, 500);
  const p = s.pets[0]!;
  assert.equal(p.id, 'pet-1');
  assert.equal(p.petpack, 'panda.incense');
  assert.equal(p.x, 120);
  assert.equal(p.y, null);
  assert.equal(p.scale, 3);
  assert.equal(p.lockPosition, true);
  assert.equal(p.roamEnabled, false);
  assert.equal(p.soundEnabled, false);
  assert.equal(p.bubbleEnabled, false);
  assert.equal(p.flingEnabled, false);
  assert.equal(p.gazeEnabled, false);
  assert.equal(p.followEnabled, true);
  assert.equal(p.alwaysOnTop, false);
  assert.equal(p.walkFreq, 'lively');
  assert.equal(p.walkSpeed, 200);
});

test('normalizeSettings: 非法/缺失字段回退默认', () => {
  const p = normalizeSettings({
    volume: Number.NaN,
    bubbleMs: -5,
    pets: [{ id: 'p', x: 'oops', y: Number.POSITIVE_INFINITY, scale: -1, walkFreq: 'dance', walkSpeed: 'fast' }],
  }).pets[0]!;
  assert.equal(p.x, null);
  assert.equal(p.y, null);
  assert.equal(p.scale, 0.2);
  assert.equal(p.walkFreq, 'normal');
  assert.equal(p.walkSpeed, 55);
  assert.equal(p.roamEnabled, true);
  assert.equal(p.soundEnabled, true);
  assert.equal(p.bubbleEnabled, true);
  assert.equal(p.flingEnabled, true);
  assert.equal(p.gazeEnabled, true, '缺失时视角跟随默认开');
  assert.equal(p.followEnabled, false, '缺失时跟随鼠标默认关');
  assert.equal(p.alwaysOnTop, true);
  assert.equal(normalizeSettings({ volume: Number.NaN }).volume, 0.6);
  assert.equal(normalizeSettings({ bubbleMs: -5 }).bubbleMs, 500);
});

test('normalizeSettings: displayName 保留非空、空白与缺失回退 null', () => {
  const s = normalizeSettings({
    pets: [{ id: 'a', displayName: ' 小白 ' }, { id: 'b', displayName: '   ' }, { id: 'c' }],
  });
  assert.equal(s.pets[0]!.displayName, '小白');
  assert.equal(s.pets[1]!.displayName, null);
  assert.equal(s.pets[2]!.displayName, null);
});

test('resolveUrl 字符串拼接（asset:// 路径不能被 URL 解析改写）', () => {
  assert.equal(resolveUrl('sheet.png', '/petskins/panda/'), '/petskins/panda/sheet.png');
  assert.equal(
    resolveUrl('sounds/bell.wav', 'asset://localhost/C%3A%2Fpetskins%2Fpanda%2F'),
    'asset://localhost/C%3A%2Fpetskins%2Fpanda%2Fsounds/bell.wav',
  );
});

test('validateManifest: sprite parts 合法/缺失字段', () => {
  const base = {
    id: 'panda.incense',
    engine: 'sprite' as const,
    animations: { idle: { frames: [0], loop: true } },
    sprite: {
      sheet: 'body-sheet.png',
      frameW: 608,
      frameH: 832,
      cols: 6,
      parts: [
        { sheet: 'incense-sheet.png', frameW: 265, frameH: 528, cols: 6, offsetX: 166, offsetY: 37 },
      ],
    },
  };
  const ok = validateManifest(base as never);
  assert.equal(ok.sprite!.parts![0]!.offsetX, 166);
  assert.throws(() =>
    validateManifest({
      ...base,
      sprite: { ...base.sprite, parts: [{ sheet: 'x.png' }] },
    } as never),
  );
  assert.throws(() =>
    validateManifest({ id: 'x', engine: 'sprite', animations: { idle: { frames: [0] } } } as never),
  );
  assert.throws(() =>
    validateManifest({
      ...base,
      sprite: { ...base.sprite, parts: [{ ...base.sprite.parts[0], offsetX: undefined }] },
    } as never),
  );
});

test('validateManifest: sprite 主帧尺寸必须为正整数', () => {
  const base = {
    id: 'slime.pixel',
    engine: 'sprite' as const,
    animations: { idle: { frames: [0], loop: true } },
    sprite: { sheet: 'sheet.png', frameW: 64, frameH: 64, cols: 4 },
  };
  assert.equal(validateManifest(base as never).sprite!.frameW, 64);
  for (const bad of [0, -64, 32.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const key of ['frameW', 'frameH', 'cols'] as const) {
      assert.throws(
        () => validateManifest({ ...base, sprite: { ...base.sprite, [key]: bad } } as never),
        `sprite.${key}=${bad} 应被拒绝`,
      );
    }
  }
});

test('validateManifest: displayScale 必须为 (0, 4] 内的数值', () => {
  const base = {
    id: 'panda.incense',
    engine: 'sprite' as const,
    animations: { idle: { frames: [0], loop: true } },
    sprite: { sheet: 'sheet.png', frameW: 64, frameH: 64, cols: 4 },
  };
  for (const ok of [undefined, 1, 0.65, 4]) {
    validateManifest({ ...base, displayScale: ok } as never);
  }
  for (const bad of [0, -0.65, 4.01, Number.NaN, Number.POSITIVE_INFINITY, 'big']) {
    assert.throws(
      () => validateManifest({ ...base, displayScale: bad } as never),
      `displayScale=${bad} 应被拒绝`,
    );
  }
});

test('userPackBaseUrl: 字面斜杠结尾，库内 url.resolve 不丢目录（asset 协议）', () => {
  // convertFileSrc 的真实行为：整段 encodeURIComponent，'/' 也会变 %2F
  const fakeConvert = (p: string) => 'http://asset.localhost/' + encodeURIComponent(p);
  const base = userPackBaseUrl(
    'C:\\Users\\evarle\\AppData\\Roaming\\com.evarle.pet\\petskins\\吉雅',
    fakeConvert,
  );
  // 必须以字面 '/' 结尾：结尾若是 %2F，模型 URL 无任何字面 '/'，
  // url.resolve 会把整个编码路径当单个 segment 替换掉（目录丢失 → 全部 404）
  assert.ok(base.endsWith('/'));
  assert.ok(!base.endsWith('%2F'));
  const modelUrl = base + 'model0.json';
  for (const ref of ['Moc_0.moc3', 'Textures_0_0.png', 'Motions_Tap_0_File_0.json', 'Motions_Tap_0_Sound_0.wav']) {
    assert.ok(
      urlResolve(modelUrl, ref).startsWith(base),
      `相对引用 ${ref} 解析后丢失目录`,
    );
  }
  // 子目录入口（如 SoulTide 的 char/skin 布局）同样不能丢前缀
  const nested = base + 'skin1/model0.json';
  assert.ok(urlResolve(nested, 'Moc_0.moc3').startsWith(base + 'skin1/'));
});

test('userPackBaseUrl: 尾部斜杠/反斜杠归一', () => {
  const fakeConvert = (p: string) => 'http://asset.localhost/' + encodeURIComponent(p);
  assert.equal(
    userPackBaseUrl('C:\\a\\b\\', fakeConvert),
    userPackBaseUrl('C:\\a\\b', fakeConvert),
  );
  assert.equal(
    userPackBaseUrl('C:/a/b//', fakeConvert),
    userPackBaseUrl('C:\\a\\b', fakeConvert),
  );
});

// ---- 皮肤列表过滤与排序（filterSortPacks）----
// 排序用 ASCII 名称保证跨 ICU 版本确定性；中文仅用于过滤断言

const pack = (id: string, name: string, engine: 'live2d' | 'sprite', importedAt?: number | null): PackEntry => ({
  id,
  name,
  engine,
  source: importedAt ? 'user' : 'builtin',
  baseUrl: `/petskins/${id}/`,
  importedAt: importedAt ?? null,
});

const SAMPLE: PackEntry[] = [
  pack('gamma', 'gamma-pack', 'sprite', 300),
  pack('alpha', 'alpha-pack', 'live2d'),
  pack('beta', 'beta-pack', 'sprite', 200),
  pack('delta', 'delta-pack', 'live2d', 100),
];

test('filterSortPacks: 关键字匹配名称与 id，大小写不敏感，空串不过滤', () => {
  assert.equal(filterSortPacks(SAMPLE, '', 'name').length, 4);
  assert.deepEqual(filterSortPacks(SAMPLE, 'ALPHA', 'name').map((p) => p.id), ['alpha']);
  // id 也能搜到
  assert.deepEqual(filterSortPacks(SAMPLE, 'beta', 'name').map((p) => p.id), ['beta']);
  // 中文名称可搜
  const cjk = [pack('jiya', '吉雅', 'live2d')];
  assert.deepEqual(filterSortPacks(cjk, '吉雅', 'name').map((p) => p.id), ['jiya']);
  assert.deepEqual(filterSortPacks(SAMPLE, '不存在', 'name'), []);
});

test('filterSortPacks: 按名称排序（locale 不区分大小写）', () => {
  assert.deepEqual(
    filterSortPacks(SAMPLE, '', 'name').map((p) => p.id),
    ['alpha', 'beta', 'delta', 'gamma'],
  );
});

test('filterSortPacks: 按引擎排序（live2d 在前，组内按名称）', () => {
  assert.deepEqual(
    filterSortPacks(SAMPLE, '', 'engine').map((p) => p.id),
    ['alpha', 'delta', 'beta', 'gamma'],
  );
});

test('filterSortPacks: 按导入时间倒序，无导入时间（内置）排最后', () => {
  assert.deepEqual(
    filterSortPacks(SAMPLE, '', 'recent').map((p) => p.id),
    ['gamma', 'beta', 'delta', 'alpha'],
  );
});

test('filterSortPacks: 过滤与排序叠加', () => {
  const both = filterSortPacks(SAMPLE, 'beta', 'recent');
  assert.deepEqual(both.map((p) => p.id), ['beta']);
  const sprites = filterSortPacks(SAMPLE, '', 'recent').filter((p) => p.engine === 'sprite');
  assert.equal(sprites.length, 2);
});

test('timeSlot: 时段边界划分', () => {
  assert.equal(timeSlot(5), 'morning');
  assert.equal(timeSlot(10), 'morning');
  assert.equal(timeSlot(11), 'afternoon');
  assert.equal(timeSlot(16), 'afternoon');
  assert.equal(timeSlot(17), 'evening');
  assert.equal(timeSlot(22), 'evening');
  assert.equal(timeSlot(23), 'night');
  assert.equal(timeSlot(4), 'night');
  assert.equal(timeSlot(0), 'night');
});
