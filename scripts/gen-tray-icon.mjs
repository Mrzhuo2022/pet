/**
 * 生成托盘图标 tray.png（64x64 透明底粉色史莱姆）。
 * 设计与设置窗口标题栏的内联 SVG 同款：粉身/深描边/左上高光弧/圆角竖眼/小微笑。
 * 复用 gen-slime.mjs 的碗形公式与手写 PNG 编码，纯 Node 无外部依赖。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = 64; // 图标边长（Windows 托盘会自行缩放，高分屏下 64 更清晰）

// ---------- 极简 PNG 编码（与 gen-slime.mjs 相同） ----------
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
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 调色板（与 gen-slime / 设置主题同族） ----------
const PINK = [240, 138, 180];
const OUTLINE = [178, 74, 122];
const HIGHLIGHT = [255, 217, 234];
const INK = [44, 32, 48];

const px = Buffer.alloc(S * S * 4);
function set(x, y, [r, g, b, a = 255]) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

// 身体：底部更宽的碗形（与 gen-slime 同公式），cx 底部中心，rx/ry 半径
const cx = S / 2;
const baseY = 58;
const rx = 21;
const ry = 27;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const dx = (x - cx) / rx;
    const dy = (baseY - y) / ry;
    if (dy < 0 || dy > 1) continue;
    const bowl = dy * dy * (1 - dy * 0.55);
    const edge = dx * dx + bowl;
    if (edge <= 1.001) {
      // 描边：左上边缘一段用浅色（对应 SVG 里贴着轮廓的高光弧）
      const hl = edge > 0.82 && dy > 0.78 && dx < -0.05;
      set(x, y, hl ? HIGHLIGHT : edge > 0.82 ? OUTLINE : PINK);
    }
  }
}



// 圆角竖眼 ×2（对应 SVG 的 rx=0.95 圆角矩形）
function pill(cx0, cy0, w, h, c) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 圆角：四角内收 1px
      const corner =
        ((x === 0 || x === w - 1) && (y === 0 || y === h - 1)) ||
        ((x === 1 || x === w - 2) && y === 0) ||
        ((x === 1 || x === w - 2) && y === h - 1) ||
        ((y === 1 || y === h - 2) && x === 0) ||
        ((y === 1 || y === h - 2) && x === w - 1);
      if (!corner) set(cx0 + x, cy0 + y, c);
    }
  }
}
const eyeY = 34;
pill(23, eyeY, 5, 8, INK);
pill(37, eyeY, 5, 8, INK);

// 微笑：五点弧线（对应 SVG 的 path）
const my = 47;
set(cx - 3, my, INK);
set(cx - 2, my + 1, INK);
set(cx - 1, my + 2, INK);
set(cx, my + 2.5, INK);
set(cx + 1, my + 2, INK);
set(cx + 2, my + 1, INK);
set(cx + 3, my, INK);

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, '..', 'src-tauri', 'icons', 'tray.png'), encodePng(px, S, S));
console.log('已生成 src-tauri/icons/tray.png');
