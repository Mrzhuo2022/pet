/**
 * 生成"像素史莱姆"皮肤包的精灵图 sheet.png（4x2 网格，每帧 64x64）。
 * 纯 Node 实现（zlib + 手写 PNG 编码），无外部依赖，可重复执行。
 *
 * 帧表：
 *  0 正常  1 微压  2 压扁  3 眨眼   （idle 呼吸循环）
 *  4 拍扁 >< 眼                      （click）
 *  5 拉长 惊讶脸                     （drag）
 *  6 星星眼 开心                     （done）
 *  7 无精打采                        （thinking / failed）
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAME = 64;
const COLS = 4;
const ROWS = 2;
const W = FRAME * COLS;
const H = FRAME * ROWS;

// ---------- 极简 PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 像素画布 ----------
class Canvas {
  constructor() {
    this.px = Buffer.alloc(FRAME * FRAME * 4); // 单帧画布
  }
  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= FRAME || y >= FRAME) return;
    const i = (y * FRAME + x) * 4;
    // 简单 alpha 合成（新像素覆盖）
    this.px[i] = r;
    this.px[i + 1] = g;
    this.px[i + 2] = b;
    this.px[i + 3] = a;
  }
  /** 绘制史莱姆身体：cx 底部中心，rx/ry 半径，squashY 纵向压缩 */
  slime(cx, baseY, rx, ry, color, outline) {
    for (let y = 0; y < FRAME; y++) {
      for (let x = 0; x < FRAME; x++) {
        const dx = (x - cx) / rx;
        const dy = (baseY - y) / ry; // 0 在底部，1 在顶部
        if (dy < 0 || dy > 1) continue;
        const bowl = dy * dy * (1 - dy * 0.55); // 底部更宽的碗形
        if (dx * dx <= 1 - bowl * 0.0 + 0 && dx * dx + bowl <= 1.001) {
          const edge = dx * dx + bowl;
          const isOutline = edge > 0.82;
          // 顶部高光
          const hi = dy > 0.6 && Math.abs(dx) < 0.3 && dy < 0.85;
          const c = isOutline ? outline : hi
            ? [Math.min(255, color[0] + 45), Math.min(255, color[1] + 45), Math.min(255, color[2] + 45)]
            : color;
          this.set(x, y, c);
        }
      }
    }
  }
  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  /** 眼睛：mode = open | blink | x | star | sad */
  eye(x, y, mode) {
    const BLACK = [30, 30, 40];
    const WHITE = [245, 245, 248];
    if (mode === 'open') {
      this.rect(x - 2, y - 3, 5, 7, WHITE);
      this.rect(x - 1, y - 1, 3, 4, BLACK);
      this.set(x - 1, y - 2, WHITE);
    } else if (mode === 'blink' || mode === 'sad') {
      this.rect(x - 2, y, 5, 2, BLACK);
    } else if (mode === 'x') {
      this.rect(x - 1, y - 1, 2, 2, BLACK);
      this.set(x - 2, y - 2, BLACK);
      this.set(x + 2, y + 2, BLACK);
      this.set(x + 2, y - 2, BLACK);
      this.set(x - 2, y + 2, BLACK);
    } else if (mode === 'star') {
      this.rect(x, y - 2, 1, 5, BLACK);
      this.rect(x - 2, y, 5, 1, BLACK);
      this.set(x - 1, y - 1, BLACK);
      this.set(x + 1, y + 1, BLACK);
      this.set(x + 1, y - 1, BLACK);
      this.set(x - 1, y + 1, BLACK);
    }
  }
  mouth(mode) {
    const BLACK = [30, 30, 40];
    const mx = FRAME / 2;
    const my = 40;
    if (mode === 'smile') {
      this.set(mx - 2, my, BLACK);
      this.set(mx - 1, my + 1, BLACK);
      this.set(mx, my + 2, BLACK);
      this.set(mx + 1, my + 1, BLACK);
      this.set(mx + 2, my, BLACK);
    } else if (mode === 'o') {
      this.rect(mx - 1, my, 3, 3, BLACK);
    } else if (mode === 'flat') {
      this.rect(mx - 2, my + 1, 5, 1, BLACK);
    } else if (mode === 'droop') {
      this.set(mx - 2, my + 1, BLACK);
      this.set(mx - 1, my, BLACK);
      this.set(mx, my, BLACK);
      this.set(mx + 1, my, BLACK);
      this.set(mx + 2, my + 1, BLACK);
    }
  }
  shadow() {
    for (let x = 18; x < 46; x += 2) this.set(x, 60, [20, 20, 30, 90]);
  }
}

// ---------- 八帧绘制 ----------
// 樱花配色的粉史莱姆（与设置主题 --accent #ee85b1 同族）
const PINK = [240, 138, 180];
const OUTLINE = [178, 74, 122];

function drawFrame(idx, kind) {
  const c = new Canvas();
  c.shadow();
  const cx = FRAME / 2;
  const baseY = 58;
  let eyeMode = 'open';
  let mouthMode = 'smile';
  switch (kind) {
    case 'idle0': c.slime(cx, baseY, 16, 24, PINK, OUTLINE); break;
    case 'idle1': c.slime(cx, baseY, 17, 22, PINK, OUTLINE); break;
    case 'idle2': c.slime(cx, baseY, 19, 20, PINK, OUTLINE); break;
    case 'blink': c.slime(cx, baseY, 16, 24, PINK, OUTLINE); eyeMode = 'blink'; break;
    case 'click':
      c.slime(cx, baseY, 23, 12, PINK, OUTLINE);
      eyeMode = 'x'; mouthMode = 'flat'; break;
    case 'drag':
      c.slime(cx, baseY, 13, 30, PINK, OUTLINE);
      eyeMode = 'open'; mouthMode = 'o'; break;
    case 'done':
      c.slime(cx, baseY, 17, 23, PINK, OUTLINE);
      eyeMode = 'star'; mouthMode = 'smile'; break;
    case 'sad':
      c.slime(cx, 54, 18, 16, [212, 158, 184], [148, 98, 124]); // 灰粉蔫史莱姆
      eyeMode = 'sad'; mouthMode = 'droop'; break;
  }
  const eyeY = kind === 'click' ? 44 : kind === 'drag' ? 30 : 36;
  c.eye(25, eyeY, eyeMode);
  c.eye(39, eyeY, eyeMode);
  c.mouth(mouthMode);
  return c.px;
}

const kinds = ['idle0', 'idle1', 'idle2', 'blink', 'click', 'drag', 'done', 'sad'];
const sheet = Buffer.alloc(W * H * 4);
kinds.forEach((kind, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const frame = drawFrame(i, kind);
  for (let y = 0; y < FRAME; y++) {
    frame.copy(sheet, ((row * FRAME + y) * W + col * FRAME) * 4, y * FRAME * 4, (y + 1) * FRAME * 4);
  }
});

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'petskins', 'slime');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'sheet.png'), encodePng(sheet, W, H));

// ---------- 点击音效 pop.wav（下滑正弦 + 衰减包络，纯代码合成） ----------
function makePopWav() {
  const sr = 22050;
  const dur = 0.13;
  const n = Math.floor(sr * dur);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 560 + 420 * (1 - t / dur); // 向下滑音
    const env = Math.pow(1 - t / dur, 1.6);
    const v = Math.sin(2 * Math.PI * f * t) * env * 0.55;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); // PCM
  hdr.writeUInt16LE(1, 22); // mono
  hdr.writeUInt32LE(sr, 24);
  hdr.writeUInt32LE(sr * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}
mkdirSync(join(outDir, 'sounds'), { recursive: true });
writeFileSync(join(outDir, 'sounds', 'pop.wav'), makePopWav());
console.log(`sheet.png written: ${W}x${H} (8 frames @${FRAME}px); sounds/pop.wav written`);
