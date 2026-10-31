import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlayableIndex,
  motionFeedback,
  pickPlayableMotion,
  type MotionDef,
} from '../src/pet/motionText.ts';

/** 伪随机注入：固定序列便于断言（Math.random 换成确定性实现） */
function withSeededRandom<T>(seq: number[], fn: () => T): T {
  const orig = Math.random;
  let i = 0;
  Math.random = () => seq[Math.min(i++, seq.length - 1)]!;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

test('pickPlayableMotion: 只在含 File 的条目里随机', () => {
  const defs: MotionDef[] = [
    { Name: 'Running OFF', VarFloats: ' ' }, // 空条目（无 File）
    { File: 'Motions_Tap_0_File_0.json', Sound: 'a.wav', Text: '你好' },
    { Sound: 'only_sound.wav' }, // 纯语音条目不可作为动作播放
    { File: 'Motions_Tap_1_File_0.json' },
  ];
  const picked = withSeededRandom([0.99], () => pickPlayableMotion(defs))!;
  // [0,1) * 2 个可播条目 → 0.99 选到最后一个可播的（index 3）
  assert.equal(picked.index, 3);
  assert.equal(picked.def.File, 'Motions_Tap_1_File_0.json');
});

test('pickPlayableMotion: 空组/全空组返回 null', () => {
  assert.equal(pickPlayableMotion(undefined), null);
  assert.equal(pickPlayableMotion([]), null);
  assert.equal(
    pickPlayableMotion([{ Name: 'x' }, { Sound: 's.wav' }]),
    null,
  );
});

test('pickPlayableMotion: excludeIndex 避免连续重复', () => {
  const defs: MotionDef[] = [
    { File: 'a.json' },
    { File: 'b.json' },
    { File: 'c.json' },
  ];
  // 无论随机到什么，都不应返回被排除的索引 1
  for (let i = 0; i < 30; i++) {
    const picked = pickPlayableMotion(defs, 1)!;
    assert.notEqual(picked.index, 1);
  }
  // 只有唯一可播案目时：排除它也照样返回（不能无动作可播）
  const single: MotionDef[] = [{ Name: 'x' }, { File: 'only.json' }];
  const picked = pickPlayableMotion(single, 1)!;
  assert.equal(picked.index, 1);
});

test('isPlayableIndex: 索引指向含 File 的案目才算可播', () => {
  const defs: MotionDef[] = [{ Name: 'x' }, { File: 'ok.json' }];
  assert.equal(isPlayableIndex(defs, 1), true);
  assert.equal(isPlayableIndex(defs, 0), false); // 无 File
  assert.equal(isPlayableIndex(defs, 9), false); // 越界
  assert.equal(isPlayableIndex(undefined, 0), false);
});

test('motionFeedback: 台词/语音/时长提取与非字符串字段防御', () => {
  const fb = motionFeedback('click', 'Tap', {
    index: 1,
    def: {
      File: 'Motions_Tap_1_File_0.json',
      Sound: 'Motions_Tap_1_Sound_0.wav',
      Text: '  哥哥，欢迎回来~  ',
      TextDuration: 2000,
    },
  });
  assert.equal(fb.action, 'click');
  assert.equal(fb.group, 'Tap');
  assert.equal(fb.index, 1);
  assert.equal(fb.text, '哥哥，欢迎回来~'); // 去空白
  assert.equal(fb.sound, 'Motions_Tap_1_Sound_0.wav');
  assert.equal(fb.durationMs, 2000);
});

test('motionFeedback: 缺字段与非法类型的回退', () => {
  const fb = motionFeedback('drag', 'Tap', {
    index: 0,
    def: { File: 'f.json', Text: '   ', TextDuration: -5, Sound: '' },
  });
  assert.equal(fb.text, undefined); // 空白台词视为无
  assert.equal(fb.sound, undefined); // 空串语音视为无
  assert.equal(fb.durationMs, undefined); // 非正时长视为无
  const weird = motionFeedback('idle', 'Idle', {
    index: 0,
    def: { File: 'f.json', Text: 123, TextDuration: 'long' },
  });
  assert.equal(weird.text, undefined); // 非字符串 Text
  assert.equal(weird.durationMs, undefined); // 非数字 TextDuration
});

test('pickPlayableMotion: weights 加权，权重 0 的条目不会被选中', () => {
  const defs: MotionDef[] = [{ File: 'a.json' }, { File: 'b.json' }];
  for (let i = 0; i < 100; i++) {
    const picked = pickPlayableMotion(defs, undefined, { '0': 0, '1': 5 });
    assert.equal(picked?.index, 1, '权重 0 的条目不应被选中');
  }
});

test('pickPlayableMotion: 无 weights 时可播条目都可能被选中', () => {
  const defs: MotionDef[] = [{ File: 'a.json' }, { File: 'b.json' }];
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const picked = pickPlayableMotion(defs);
    if (picked) seen.add(picked.index);
  }
  assert.deepEqual([...seen].sort(), [0, 1]);
});
