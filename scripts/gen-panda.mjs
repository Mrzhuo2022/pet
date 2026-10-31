/**
 * 生成"上香熊猫"分层皮肤包：
 *   - 身体层：从高清图标重绘去香的身体（scripts/assets/panda-body.png）
 *   - 香束层：程序化绘制的三支香 + 烟缕 + 香头暖光（独立图层，可在点击时抬起/倾斜）
 * 输出：body-sheet.png / incense-sheet.png / sounds/bell.wav，并把 parts 元数据写回 petpack.json。
 *
 * 用法：node scripts/gen-panda.mjs [--preview]
 *
 * 帧表（6 列 × 4 行，身体表每帧 608x832；香束表按内容自动裁切）：
 *   0-5   idle     呼吸 + 香烟袅袅
 *   6-8   walk     左右摇摆
 *   9-10  drag     吊挂摆动
 *   11-15 click    躬身 + 香束独立倾斜/举香 + 祈福爱心
 *   16-17 thinking 侧头 + 思考气泡
 *   18-19 speaking 轻声说话气泡
 *   20-21 done     庆祝闪光
 *   22-23 failed   灰心 + 汗滴
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BODY_PATH = join(HERE, 'assets', 'panda-body.png');
const OUT_DIR = join(ROOT, 'public', 'petskins', 'panda');
const PREVIEW = process.argv.includes('--preview');

// ---------- 布局 ----------
// 设计稿按 380x520 排版，按 FS 倍率放大贴图：桌宠逻辑尺寸不变，高 DPI 下更清晰
const FS = 1.6;
const SRC_W = 892;
const SRC_H = 1084;
const FRAME_W = Math.round(380 * FS);
const FRAME_H = Math.round(520 * FS);
const COLS = 6;
const ROWS = 4;
const SS = 2; // 超采样倍率
const CW = FRAME_W * SS;
const CH = FRAME_H * SS;
const CONTENT_W = 330 * FS;
const SRC_SCALE = CONTENT_W / SRC_W;
const SRC_ANCHOR_X = 446;
const SRC_ANCHOR_Y = 1060;
const ANCHOR_X = FRAME_W / 2;
// 底边留 20（设计稿）px：旋转/下蹲动作时脚底不会碰出画布
const ANCHOR_Y = 500 * FS;
// 香束局部运动的支点（源图坐标，握住香的爪位）
const PIVOT = { x: 444, y: 575 };

/** 三支香（源图坐标）：上端、下端、上下宽度、香头高度 */
const STICKS = [
  { top: [352, 214], bottom: [366, 554], wTop: 46, wBottom: 40, ember: 30, drift: -1 },
  { top: [444, 176], bottom: [444, 584], wTop: 46, wBottom: 42, ember: 30, drift: 0 },
  { top: [536, 214], bottom: [521, 556], wTop: 46, wBottom: 40, ember: 30, drift: 1 },
];
const TIPS = STICKS.map((s) => ({ x: s.top[0], y: s.top[1], drift: s.drift }));

// ---------- 数值工具 ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const rad = (deg) => (deg * Math.PI) / 180;

// ---------- PNG 编解码（8bit，非隔行） ----------
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
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

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('不是 PNG 文件');
  }
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (depth !== 8 || interlace !== 0 || !channels) {
    throw new Error(`不支持的 PNG 格式：depth=${depth} colorType=${colorType} interlace=${interlace}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(stride * h);
  let pos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      switch (filter) {
        case 0:
          break;
        case 1:
          v = (v + a) & 255;
          break;
        case 2:
          v = (v + b) & 255;
          break;
        case 3:
          v = (v + ((a + b) >> 1)) & 255;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
        default:
          throw new Error(`未知 PNG 滤镜 ${filter}`);
      }
      cur[i] = v;
    }
    prev = cur;
  }
  return { w, h, ch: channels, data: out };
}

// ---------- 仿射变换 ----------
/** x' = a*x + b*y + tx; y' = c*x + d*y + ty */
const affine = (a, b, c, d, tx, ty) => ({ a, b, c, d, tx, ty });
const mulAffine = (A, B) =>
  affine(
    A.a * B.a + A.b * B.c,
    A.a * B.b + A.b * B.d,
    A.c * B.a + A.d * B.c,
    A.c * B.b + A.d * B.d,
    A.a * B.tx + A.b * B.ty + A.tx,
    A.c * B.tx + A.d * B.ty + A.ty,
  );
const invAffine = (A) => {
  const det = A.a * A.d - A.b * A.c || 1e-6;
  const ia = A.d / det;
  const ib = -A.b / det;
  const ic = -A.c / det;
  const id = A.a / det;
  return affine(ia, ib, ic, id, -(ia * A.tx + ib * A.ty), -(ic * A.tx + id * A.ty));
};
const mapPoint = (A, x, y) => ({ x: A.a * x + A.b * y + A.tx, y: A.c * x + A.d * y + A.ty });

/** 身体：源图 → 画布（含姿态/位移） */
function bodyAffine(tr) {
  const S = SRC_SCALE * SS;
  const cos = Math.cos(tr.rot);
  const sin = Math.sin(tr.rot);
  const a = cos * tr.sx * S;
  const b = -sin * tr.sy * S;
  const c = sin * tr.sx * S;
  const d = cos * tr.sy * S;
  const tx = (ANCHOR_X + tr.dx * FS) * SS;
  const ty = (ANCHOR_Y + tr.dy * FS) * SS;
  return affine(
    a,
    b,
    c,
    d,
    tx - (a * SRC_ANCHOR_X + b * SRC_ANCHOR_Y),
    ty - (c * SRC_ANCHOR_X + d * SRC_ANCHOR_Y),
  );
}

/** 香束局部运动（围绕握香点旋转/缩放）叠加到身体变换上 */
function incenseAffine(B, loc) {
  if (!loc || (!loc.rot && !loc.scale)) return B;
  const P = mapPoint(B, PIVOT.x, PIVOT.y);
  const r = loc.rot ?? 0;
  const s = loc.scale ?? 1;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const a = cos * s;
  const b = -sin * s;
  const c = sin * s;
  const d = cos * s;
  const L = affine(a, b, c, d, P.x - (a * P.x + b * P.y), P.y - (c * P.x + d * P.y));
  return mulAffine(L, B);
}

// ---------- 画布（预乘 RGBA，Float 0..1） ----------
const canvas = new Float32Array(CW * CH * 4);
const maskA = new Float32Array(CW * CH);
const maskB = new Float32Array(CW * CH);
const maskTmp = new Float32Array(CW * CH);

function clearCanvas() {
  canvas.fill(0);
}

function compositeStraight(idx, r, g, b, a) {
  if (a <= 0.002) return;
  const ia = 1 - a;
  canvas[idx] = (r / 255) * a + canvas[idx] * ia;
  canvas[idx + 1] = (g / 255) * a + canvas[idx + 1] * ia;
  canvas[idx + 2] = (b / 255) * a + canvas[idx + 2] * ia;
  canvas[idx + 3] = a + canvas[idx + 3] * ia;
}

function softDisc(cx, cy, radPx, color, alpha) {
  const x0 = Math.max(0, Math.floor(cx - radPx));
  const x1 = Math.min(CW - 1, Math.ceil(cx + radPx));
  const y0 = Math.max(0, Math.floor(cy - radPx));
  const y1 = Math.min(CH - 1, Math.ceil(cy + radPx));
  const r2 = radPx * radPx;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = 1 - Math.sqrt(d2) / radPx;
      compositeStraight((y * CW + x) * 4, color[0], color[1], color[2], alpha * smoothstep(0, 1, t * 1.8));
    }
  }
}

function discMask(mask, cx, cy, radPx, value = 1) {
  const x0 = Math.max(0, Math.floor(cx - radPx - 2));
  const x1 = Math.min(CW - 1, Math.ceil(cx + radPx + 2));
  const y0 = Math.max(0, Math.floor(cy - radPx - 2));
  const y1 = Math.min(CH - 1, Math.ceil(cy + radPx + 2));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d = Math.sqrt(dx * dx + dy * dy);
      const v = clamp((radPx - d) / 1.4, 0, 1) * value;
      const i = y * CW + x;
      if (v > mask[i]) mask[i] = v;
    }
  }
}

function triMask(mask, ax, ay, bx, by, cx, cy, value = 1) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const x1 = Math.min(CW - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const y1 = Math.min(CH - 1, Math.ceil(Math.max(ay, by, cy)));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const f0 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      const f1 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
      const f2 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
      const inside = (f0 >= 0 && f1 >= 0 && f2 >= 0) || (f0 <= 0 && f1 <= 0 && f2 <= 0);
      if (!inside) continue;
      const i = y * CW + x;
      if (value > mask[i]) mask[i] = value;
    }
  }
}

function roundedRectMask(mask, x, y, w, h, r, value = 1) {
  const x0 = Math.max(0, Math.floor(x));
  const x1 = Math.min(CW - 1, Math.ceil(x + w));
  const y0 = Math.max(0, Math.floor(y));
  const y1 = Math.min(CH - 1, Math.ceil(y + h));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = Math.max(x + r - px, 0, px - (x + w - r));
      const dy = Math.max(y + r - py, 0, py - (y + h - r));
      const d = Math.sqrt(dx * dx + dy * dy);
      const v = clamp((r - d) / 1.4, 0, 1) * value;
      if (v <= 0) continue;
      const i = py * CW + px;
      if (v > mask[i]) mask[i] = v;
    }
  }
}

function dilateMask(mask, r = 2) {
  if (r <= 0) return;
  // 可分离最大值膨胀；源快照必须与目标分离，否则会沿行/列无限拖影
  for (let pass = 0; pass < r; pass++) {
    maskTmp.set(mask);
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        let v = maskTmp[y * CW + x];
        if (x > 0) v = Math.max(v, maskTmp[y * CW + x - 1]);
        if (x < CW - 1) v = Math.max(v, maskTmp[y * CW + x + 1]);
        mask[y * CW + x] = v;
      }
    }
    maskTmp.set(mask);
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        let v = maskTmp[y * CW + x];
        if (y > 0) v = Math.max(v, maskTmp[(y - 1) * CW + x]);
        if (y < CH - 1) v = Math.max(v, maskTmp[(y + 1) * CW + x]);
        mask[y * CW + x] = v;
      }
    }
  }
}

function compositeMask(mask, color, alphaScale) {
  for (let i = 0, n = CW * CH; i < n; i++) {
    const m = mask[i];
    if (m <= 0.004) continue;
    const a = m * alphaScale;
    if (a <= 0.003) continue;
    compositeStraight(i * 4, color[0], color[1], color[2], a);
  }
}

// ---------- 图层资产 ----------
/** 读取带 alpha 的 PNG → 预乘浮点图层 */
function loadLayer(path) {
  const img = decodePng(readFileSync(path));
  if (img.ch !== 4) throw new Error(`${path} 必须是 RGBA PNG`);
  const { w, h, data } = img;
  const prem = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    if (a <= 0) continue;
    prem[i * 4] = (data[i * 4] / 255) * a;
    prem[i * 4 + 1] = (data[i * 4 + 1] / 255) * a;
    prem[i * 4 + 2] = (data[i * 4 + 2] / 255) * a;
    prem[i * 4 + 3] = a;
  }
  return { w, h, prem };
}

/** 程序化绘制香束图层（源图分辨率，2x 超采样），返回预乘图层 */
function buildIncenseLayer() {
  const S2 = 2;
  const W = SRC_W * S2;
  const H = SRC_H * S2;
  const buf = new Float32Array(W * H * 4); // 直通 alpha：r,g,b,a
  const put = (i, r, g, b, a) => {
    if (a <= 0.002) return;
    const o = i * 4;
    const ia = 1 - a;
    buf[o] = r + buf[o] * ia;
    buf[o + 1] = g + buf[o + 1] * ia;
    buf[o + 2] = b + buf[o + 2] * ia;
    buf[o + 3] = a + buf[o + 3] * ia;
  };

  // 柔和香火外发光
  for (const s of STICKS) {
    const [tx, ty] = s.top;
    const [bx, by] = s.bottom;
    const glow = 7;
    const y0 = Math.max(0, Math.floor((ty - glow) * S2));
    const y1 = Math.min(H - 1, Math.ceil((by + glow) * S2));
    for (let y = y0; y <= y1; y++) {
      const sy = y / S2;
      const t = clamp((sy - ty) / (by - ty), 0, 1);
      const cxc = (tx + (bx - tx) * t) * S2;
      const half = ((s.wTop + (s.wBottom - s.wTop) * t) / 2) * S2;
      const x0 = Math.max(0, Math.floor(cxc - half - glow * S2));
      const x1 = Math.min(W - 1, Math.ceil(cxc + half + glow * S2));
      for (let x = x0; x <= x1; x++) {
        const d = Math.abs(x - cxc) - half;
        if (d <= 0 || d >= glow * S2) continue;
        const a = 0.16 * (1 - d / (glow * S2)) ** 2;
        put(y * W + x, 0.94, 0.9, 0.45, a);
      }
    }
  }

  // 香体（梯形）+ 香头
  for (const s of STICKS) {
    const [tx, ty] = s.top;
    const [bx, by] = s.bottom;
    const y0 = Math.floor(ty * S2);
    const y1 = Math.ceil(by * S2);
    for (let y = y0; y <= y1; y++) {
      const sy = y / S2;
      if (sy < ty || sy > by) continue;
      const t = (sy - ty) / (by - ty);
      const cxc = (tx + (bx - tx) * t) * S2;
      const half = ((s.wTop + (s.wBottom - s.wTop) * t) / 2) * S2;
      const x0 = Math.max(0, Math.floor(cxc - half));
      const x1 = Math.min(W - 1, Math.ceil(cxc + half));
      for (let x = x0; x <= x1; x++) {
        const u = (x - cxc) / half;
        if (Math.abs(u) > 1) continue;
        // 2x 超采样 + 盒式降采样自带边缘抗锯齿
        let r;
        let g;
        let b;
        if (sy < ty + s.ember) {
          const e = (sy - ty) / s.ember;
          r = 238 + (184 - 238) * e;
          g = 104 + (56 - 104) * e;
          b = 40 + (16 - 40) * e;
        } else {
          const edge = 1 - Math.abs(u);
          const k = clamp(edge * 1.4, 0, 1);
          r = 222 + (242 - 222) * k;
          g = 224 + (243 - 224) * k;
          b = 108 + (168 - 108) * k;
          const hi = 0.18 * (1 - Math.abs(u)) ** 2;
          r += (247 - r) * hi;
          g += (247 - g) * hi;
          b += (190 - b) * hi;
        }
        put(y * W + x, r / 255, g / 255, b / 255, 1);
      }
    }
  }

  // 2x 盒式降采样 → 预乘
  const prem = new Float32Array(SRC_W * SRC_H * 4);
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < S2; sy++) {
        for (let sx = 0; sx < S2; sx++) {
          const i = ((y * S2 + sy) * W + x * S2 + sx) * 4;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
          a += buf[i + 3];
        }
      }
      const n = S2 * S2;
      r /= n;
      g /= n;
      b /= n;
      a /= n;
      const o = (y * SRC_W + x) * 4;
      prem[o] = r * a;
      prem[o + 1] = g * a;
      prem[o + 2] = b * a;
      prem[o + 3] = a;
    }
  }
  return { w: SRC_W, h: SRC_H, prem };
}

// ---------- 采样绘制 ----------
function drawLayer(matte, A, opts = {}) {
  const { prem, w, h } = matte;
  const inv = invAffine(A);
  const desat = opts.desat ?? 0;
  const bright = opts.bright ?? 1;
  const corners = [mapPoint(A, 0, 0), mapPoint(A, w, 0), mapPoint(A, 0, h), mapPoint(A, w, h)];
  const bx0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x))) - 2);
  const bx1 = Math.min(CW - 1, Math.ceil(Math.max(...corners.map((p) => p.x))) + 2);
  const by0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y))) - 2);
  const by1 = Math.min(CH - 1, Math.ceil(Math.max(...corners.map((p) => p.y))) + 2);

  for (let fy = by0; fy <= by1; fy++) {
    for (let fx = bx0; fx <= bx1; fx++) {
      const sx = inv.a * (fx + 0.5) + inv.b * (fy + 0.5) + inv.tx;
      const sy = inv.c * (fx + 0.5) + inv.d * (fy + 0.5) + inv.ty;
      const px = Math.floor(sx);
      const py = Math.floor(sy);
      if (px < 0 || py < 0 || px >= w - 1 || py >= h - 1) continue;
      const fxw = sx - px;
      const fyw = sy - py;
      const i00 = (py * w + px) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + w * 4;
      const i11 = i01 + 4;
      const w00 = (1 - fxw) * (1 - fyw);
      const w10 = fxw * (1 - fyw);
      const w01 = (1 - fxw) * fyw;
      const w11 = fxw * fyw;
      let r = prem[i00] * w00 + prem[i10] * w10 + prem[i01] * w01 + prem[i11] * w11;
      let g = prem[i00 + 1] * w00 + prem[i10 + 1] * w10 + prem[i01 + 1] * w01 + prem[i11 + 1] * w11;
      let b = prem[i00 + 2] * w00 + prem[i10 + 2] * w10 + prem[i01 + 2] * w01 + prem[i11 + 2] * w11;
      let a = prem[i00 + 3] * w00 + prem[i10 + 3] * w10 + prem[i01 + 3] * w01 + prem[i11 + 3] * w11;
      if (a <= 0.002) continue;
      if (desat > 0) {
        const sr = r / a;
        const sg = g / a;
        const sb = b / a;
        const lum = 0.299 * sr + 0.587 * sg + 0.114 * sb;
        r = (sr + (lum - sr) * desat) * a * bright;
        g = (sg + (lum - sg) * desat) * a * bright;
        b = (sb + (lum - sb) * desat) * a * bright;
      }
      const dst = (fy * CW + fx) * 4;
      const ia = 1 - a;
      canvas[dst] = r + canvas[dst] * ia;
      canvas[dst + 1] = g + canvas[dst + 1] * ia;
      canvas[dst + 2] = b + canvas[dst + 2] * ia;
      canvas[dst + 3] = a + canvas[dst + 3] * ia;
    }
  }
}

// ---------- 特效 ----------
function drawEmberGlow(A, phase, boost) {
  for (let s = 0; s < TIPS.length; s++) {
    const tip = TIPS[s];
    const p = mapPoint(A, tip.x, tip.y - 2);
    const pulse = 0.5 + 0.5 * Math.sin((phase + s * 0.23) * Math.PI * 2);
    softDisc(p.x, p.y, (5.5 + 2 * pulse) * FS * SS, [255, 118, 36], (0.22 + 0.12 * pulse) * (1 + boost * 0.6));
  }
}

function drawSmoke(A, phase, boost) {
  maskA.fill(0);
  const steps = 64;
  for (let s = 0; s < TIPS.length; s++) {
    const tip = TIPS[s];
    const o = mapPoint(A, tip.x, tip.y - 2);
    const ph = phase * Math.PI * 2 + s * 2.1;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const y = o.y - t * 134 * FS * SS;
      const sway =
        (Math.sin(t * 3.6 + s * 1.6) * 20 + Math.sin(t * 7.7 + s * 0.9 + ph * 0.35) * 6) *
        Math.pow(t, 0.95) *
        FS;
      const x = o.x + (sway + tip.drift * 15 * FS * t) * SS;
      const lump = 0.72 + 0.5 * Math.sin(t * 6.4 + s * 2.4 + ph * 0.3);
      const r = (2.0 + t * 5.6) * FS * lump * SS;
      const base = smoothstep(0, 0.02, t) * (1 - smoothstep(0.72, 1, t));
      const wave = 0.5 + 0.5 * Math.sin(t * Math.PI * 5.5 - ph);
      const micro = 0.75 + 0.25 * Math.sin(t * 23 + s * 4.1 - ph * 2);
      const a = clamp(base * wave * 1.9 * micro, 0, 0.95) * (1 + boost * 0.8);
      if (a <= 0.012) continue;
      discMask(maskA, x, y, r, a);
    }
  }
  compositeMask(maskA, [136, 150, 170], 0.58);
  compositeMask(maskA, [220, 229, 242], 0.2);
}

function drawHeart(cx, cy, size, alpha) {
  if (alpha <= 0.01) return;
  maskA.fill(0);
  const X = cx * SS;
  const Y = cy * SS;
  const s = size * SS;
  discMask(maskA, X - 0.34 * s, Y - 0.14 * s, 0.42 * s);
  discMask(maskA, X + 0.34 * s, Y - 0.14 * s, 0.42 * s);
  triMask(maskA, X - 0.8 * s, Y - 0.02 * s, X + 0.8 * s, Y - 0.02 * s, X, Y + 1.02 * s);
  maskB.set(maskA);
  dilateMask(maskB, 2);
  compositeMask(maskB, [206, 70, 112], 0.92 * alpha);
  compositeMask(maskA, [255, 124, 164], alpha);
  softDisc(X - 0.24 * s, Y - 0.34 * s, 0.17 * s, [255, 226, 236], 0.55 * alpha);
}

function drawStar(cx, cy, size, alpha) {
  if (alpha <= 0.01) return;
  maskA.fill(0);
  const X = cx * SS;
  const Y = cy * SS;
  const R = size * SS;
  const x0 = Math.max(0, Math.floor(X - R - 2));
  const x1 = Math.min(CW - 1, Math.ceil(X + R + 2));
  const y0 = Math.max(0, Math.floor(Y - R - 2));
  const y1 = Math.min(CH - 1, Math.ceil(Y + R + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = Math.abs(x + 0.5 - X) / R;
      const dy = Math.abs(y + 0.5 - Y) / R;
      if (Math.pow(dx, 0.55) + Math.pow(dy, 0.55) <= 1) maskA[y * CW + x] = 1;
    }
  }
  softDisc(X, Y, R * 1.5, [255, 205, 110], 0.22 * alpha);
  maskB.set(maskA);
  dilateMask(maskB, 1);
  compositeMask(maskB, [226, 160, 40], 0.9 * alpha);
  compositeMask(maskA, [255, 214, 112], alpha);
}

function drawThinking(alpha, pulse) {
  const dots = [
    [298, 150, 11],
    [315, 126, 8],
    [327, 106, 5.5],
  ].map(([x, y, r]) => [x * FS, y * FS, r * FS]);
  for (const [x, y, r] of dots) {
    discMask(maskA, x * SS, y * SS, (r + 1.3 * FS) * SS * (1 + pulse * 0.06));
  }
  compositeMask(maskA, [126, 140, 160], 0.9 * alpha);
  maskA.fill(0);
  for (const [x, y, r] of dots) {
    discMask(maskA, x * SS, y * SS, r * SS * (1 + pulse * 0.06));
  }
  compositeMask(maskA, [252, 253, 255], alpha);
}

function drawSpeech(alpha, blink) {
  const x = 250 * FS;
  const y = 116 * FS;
  const w = 100 * FS;
  const h = 50 * FS;
  const r = 15 * FS;
  maskA.fill(0);
  roundedRectMask(maskA, x * SS, y * SS, w * SS, h * SS, r * SS);
  triMask(
    maskA,
    (x + 18 * FS) * SS,
    (y + h - 4 * FS) * SS,
    (x + 40 * FS) * SS,
    (y + h + 22 * FS) * SS,
    (x + 50 * FS) * SS,
    (y + h - 4 * FS) * SS,
  );
  compositeMask(maskA, [122, 136, 156], 0.9 * alpha);
  maskA.fill(0);
  const t = 1.3 * FS;
  roundedRectMask(
    maskA,
    (x + t) * SS,
    (y + t) * SS,
    (w - 2 * t) * SS,
    (h - 2 * t) * SS,
    (r - t) * SS,
  );
  triMask(
    maskA,
    (x + 19.5 * FS) * SS,
    (y + h - 4 * FS) * SS,
    (x + 39 * FS) * SS,
    (y + h + 16 * FS) * SS,
    (x + 47 * FS) * SS,
    (y + h - 4 * FS) * SS,
  );
  compositeMask(maskA, [253, 254, 255], alpha);
  maskA.fill(0);
  for (let i = 0; i < 3; i++) {
    const a = alpha * (i === 1 ? 0.45 + blink * 0.55 : 1);
    discMask(maskA, (x + (30 + i * 20) * FS) * SS, (y + h / 2) * SS, 3.6 * FS * SS);
    compositeMask(maskA, [84, 98, 118], a);
    maskA.fill(0);
  }
}

function drawSweat(cx, cy, size, alpha) {
  maskA.fill(0);
  const X = cx * SS;
  const Y = cy * SS;
  const s = size * SS;
  discMask(maskA, X, Y, 0.58 * s);
  triMask(maskA, X - 0.42 * s, Y - 0.08 * s, X + 0.42 * s, Y - 0.08 * s, X, Y - 1.25 * s);
  maskB.set(maskA);
  dilateMask(maskB, 2);
  compositeMask(maskB, [74, 132, 178], 0.85 * alpha);
  compositeMask(maskA, [150, 207, 240], alpha);
  softDisc(X - 0.18 * s, Y - 0.05 * s, 0.16 * s, [240, 250, 255], 0.75 * alpha);
}

// ---------- 帧定义 ----------
const FRAME_SPECS = [];

// idle：呼吸 + 香烟循环（6 帧刚好一个烟雾周期）
{
  const breathe = [0, 0.005, 0.0085, 0.006, 0.001, -0.0035];
  const tilt = [-0.006, -0.002, 0.006, 0.004, 0, -0.004];
  for (let i = 0; i < 6; i++) {
    FRAME_SPECS.push({
      action: 'idle',
      tr: { rot: tilt[i], sx: 1 - breathe[i] * 0.6, sy: 1 + breathe[i] * 1.4, dx: 0, dy: 0 },
      smoke: i / 6,
      smokeBoost: 0,
    });
  }
}

// walk：左右摇摆，中间帧抬身
{
  const steps = [
    { rot: rad(-3.2), sx: 1.008, sy: 0.992, dx: -3, dy: 0 },
    { rot: rad(0.6), sx: 0.994, sy: 1.022, dx: 0, dy: -6 },
    { rot: rad(3.2), sx: 1.008, sy: 0.992, dx: 3, dy: 0 },
  ];
  for (const tr of steps) FRAME_SPECS.push({ action: 'walk', tr, smoke: 0.28, smokeBoost: 0 });
}

// drag：吊挂摆动
{
  const frames = [
    { rot: rad(-4.5), sx: 1.012, sy: 1.045, dx: 2, dy: -5 },
    { rot: rad(3.5), sx: 1.0, sy: 0.985, dx: -2, dy: 2 },
  ];
  for (const tr of frames) FRAME_SPECS.push({ action: 'drag', tr, smoke: 0.55, smokeBoost: 0 });
}

// click：躬身拜香 + 香束独立倾斜/举香 + 祈福爱心上浮
{
  const frames = [
    { rot: rad(0.3), sx: 1.0, sy: 1.012, dx: 0, dy: -2 },
    { rot: rad(1.4), sx: 1.02, sy: 0.952, dx: 1, dy: 6 },
    { rot: rad(1.9), sx: 1.03, sy: 0.925, dx: 2, dy: 10 },
    { rot: rad(0.8), sx: 1.0, sy: 0.96, dx: 0, dy: 4 },
    { rot: rad(-0.2), sx: 1.0, sy: 0.995, dx: 0, dy: 0 },
  ];
  const incenseLocal = [
    null,
    { rot: rad(-1.0), scale: 1.008 },
    { rot: rad(3.2), scale: 1.038 },
    { rot: rad(1.4), scale: 1.018 },
    null,
  ];
  const heartY = [116, 100, 84, 68, 54];
  const heartA = [0.35, 0.65, 0.85, 0.6, 0.25];
  const boost = [0.15, 0.5, 0.72, 0.4, 0.1];
  for (let i = 0; i < frames.length; i++) {
    FRAME_SPECS.push({
      action: 'click',
      tr: frames[i],
      incense: incenseLocal[i],
      smoke: 0.08 + i * 0.11,
      smokeBoost: boost[i],
      heart: {
        x: (254 + i * 3) * FS,
        y: heartY[i] * FS,
        size: (13 + i * 1.2) * FS,
        alpha: heartA[i],
      },
    });
  }
}

// thinking：侧头 + 思考气泡
{
  const frames = [
    { rot: rad(1.8), sx: 0.998, sy: 0.995, dx: 0, dy: 1 },
    { rot: rad(1.5), sx: 1.0, sy: 1.0, dx: 1, dy: 0 },
  ];
  for (let i = 0; i < 2; i++) {
    FRAME_SPECS.push({
      action: 'thinking',
      tr: frames[i],
      smoke: 0.42,
      smokeBoost: 0.05,
      thinking: { alpha: 0.9, pulse: i },
    });
  }
}

// speaking：轻晃 + 说话气泡
{
  const frames = [
    { rot: rad(-0.7), sx: 1.004, sy: 1.004, dx: 0, dy: 0 },
    { rot: rad(0.35), sx: 0.998, sy: 0.997, dx: 0, dy: 1 },
  ];
  for (let i = 0; i < 2; i++) {
    FRAME_SPECS.push({
      action: 'speaking',
      tr: frames[i],
      smoke: 0.22,
      smokeBoost: 0.08,
      speech: { alpha: 0.92, blink: i },
    });
  }
}

// done：庆祝闪光（两套星位交替）
{
  const frames = [
    { rot: 0, sx: 1.004, sy: 1.018, dx: 0, dy: -4 },
    { rot: rad(-1.1), sx: 1.0, sy: 0.997, dx: 0, dy: 0 },
  ];
  const starsA = [
    [120, 168, 10, 0.9],
    [286, 130, 12, 0.95],
    [316, 224, 8, 0.8],
    [92, 250, 7, 0.7],
  ];
  const starsB = [
    [104, 188, 7, 0.7],
    [262, 150, 9, 0.85],
    [304, 200, 11, 0.9],
    [138, 132, 8, 0.8],
  ];
  for (let i = 0; i < 2; i++) {
    FRAME_SPECS.push({
      action: 'done',
      tr: frames[i],
      smoke: 0.3,
      smokeBoost: 0.12,
      stars: (i === 0 ? starsA : starsB).map(([x, y, s, a]) => [x * FS, y * FS, s * FS, a]),
    });
  }
}

// failed：灰心 + 汗滴
{
  const frames = [
    { rot: rad(-1.2), sx: 1.0, sy: 0.985, dx: 0, dy: 2 },
    { rot: rad(1.2), sx: 1.0, sy: 0.978, dx: -1, dy: 3 },
  ];
  for (let i = 0; i < 2; i++) {
    FRAME_SPECS.push({
      action: 'failed',
      tr: frames[i],
      smoke: 0.6,
      smokeBoost: 0,
      desat: 0.8,
      bright: 0.9,
      sweat: {
        x: (296 - i * 2) * FS,
        y: (196 + i * 7) * FS,
        size: (15 + i) * FS,
        alpha: 0.9,
      },
    });
  }
}

// ---------- 渲染 ----------
function downsampleFrame() {
  const out = Buffer.alloc(FRAME_W * FRAME_H * 4);
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * CW + x * SS + sx) * 4;
          r += canvas[i];
          g += canvas[i + 1];
          b += canvas[i + 2];
          a += canvas[i + 3];
        }
      }
      const n = SS * SS;
      r /= n;
      g /= n;
      b /= n;
      a /= n;
      const o = (y * FRAME_W + x) * 4;
      if (a > 0.002) {
        out[o] = Math.round(clamp(r / a, 0, 1) * 255);
        out[o + 1] = Math.round(clamp(g / a, 0, 1) * 255);
        out[o + 2] = Math.round(clamp(b / a, 0, 1) * 255);
        out[o + 3] = Math.round(clamp(a, 0, 1) * 255);
      }
    }
  }
  return out;
}

function renderBodyFrame(spec, bodyLayer) {
  const B = bodyAffine(spec.tr);
  clearCanvas();
  drawLayer(bodyLayer, B, { desat: spec.desat ?? 0, bright: spec.bright ?? 1 });
  if (spec.heart) drawHeart(spec.heart.x, spec.heart.y, spec.heart.size, spec.heart.alpha);
  if (spec.stars) for (const [x, y, s, a] of spec.stars) drawStar(x, y, s, a);
  if (spec.thinking) drawThinking(spec.thinking.alpha, spec.thinking.pulse);
  if (spec.speech) drawSpeech(spec.speech.alpha, spec.speech.blink);
  if (spec.sweat) drawSweat(spec.sweat.x, spec.sweat.y, spec.sweat.size, spec.sweat.alpha);
  return downsampleFrame();
}

function renderIncenseFrame(spec, incenseLayer) {
  const B = bodyAffine(spec.tr);
  const C = incenseAffine(B, spec.incense);
  clearCanvas();
  drawLayer(incenseLayer, C, { desat: spec.desat ?? 0, bright: spec.bright ?? 1 });
  drawEmberGlow(C, spec.smoke ?? 0, spec.smokeBoost ?? 0);
  drawSmoke(C, spec.smoke ?? 0, spec.smokeBoost ?? 0);
  return downsampleFrame();
}

/** 香束帧内容包围盒（用于裁切部件表与写回 manifest） */
function contentBBox(frames) {
  let x0 = FRAME_W;
  let y0 = FRAME_H;
  let x1 = -1;
  let y1 = -1;
  for (const f of frames) {
    for (let y = 0; y < FRAME_H; y++) {
      for (let x = 0; x < FRAME_W; x++) {
        if (f[(y * FRAME_W + x) * 4 + 3] > 3) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
  }
  if (x1 < x0 || y1 < y0) throw new Error('香束图层为空');
  const pad = 4;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(FRAME_W - 1, x1 + pad);
  y1 = Math.min(FRAME_H - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function cropFrame(frame, rect) {
  const out = Buffer.alloc(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) {
    frame.copy(
      out,
      y * rect.w * 4,
      ((rect.y + y) * FRAME_W + rect.x) * 4,
      ((rect.y + y) * FRAME_W + rect.x + rect.w) * 4,
    );
  }
  return out;
}

function blitFrame(sheet, sheetW, frame, fw, fh, dx, dy) {
  for (let y = 0; y < fh; y++) {
    frame.copy(sheet, ((dy + y) * sheetW + dx) * 4, y * fw * 4, (y + 1) * fw * 4);
  }
}

// ---------- 铃音 ----------
function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(clamp(samples[i], -1, 1) * 32767), 44 + i * 2);
  }
  return buf;
}

function makeBell() {
  const sr = 22050;
  const dur = 1.15;
  const n = Math.floor(sr * dur);
  const samples = new Float32Array(n);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  const partials = [
    [880, 0.55, 3.6, 0],
    [1174.7, 0.3, 4.4, 0.2],
    [1760, 0.16, 5.8, 0.6],
    [2637, 0.08, 8.2, 1.1],
  ];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (const [f, amp, decay, ph] of partials) {
      v += amp * Math.sin(2 * Math.PI * f * t + ph) * Math.exp(-t * decay);
    }
    if (t < 0.018) v += noise() * 0.22 * (1 - t / 0.018);
    const attack = 1 - Math.exp(-t * 220);
    const tail = Math.min(1, (dur - t) / 0.08);
    samples[i] = clamp(v * attack * tail * 0.62, -1, 1);
  }
  return encodeWav(samples, sr);
}

// ---------- 预览 ----------
function checker(w, h, size = 8) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = ((x / size) | 0) + ((y / size) | 0);
      const v = on % 2 ? 205 : 238;
      const o = (y * w + x) * 4;
      buf[o] = v;
      buf[o + 1] = v;
      buf[o + 2] = v;
      buf[o + 3] = 255;
    }
  }
  return buf;
}

function overChecker(frame, w, h, size = 8) {
  const bg = checker(w, h, size);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const a = frame[o + 3] / 255;
    if (!a) continue;
    const ia = 1 - a;
    bg[o] = Math.round(frame[o] * a + bg[o] * ia);
    bg[o + 1] = Math.round(frame[o + 1] * a + bg[o + 1] * ia);
    bg[o + 2] = Math.round(frame[o + 2] * a + bg[o + 2] * ia);
  }
  return bg;
}

function composePreview(body, part, rect) {
  const out = Buffer.from(body);
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const po = (y * rect.w + x) * 4;
      const a = part[po + 3] / 255;
      if (!a) continue;
      const bo = ((rect.y + y) * FRAME_W + rect.x + x) * 4;
      const ia = 1 - a;
      out[bo] = Math.round(part[po] * a + out[bo] * ia);
      out[bo + 1] = Math.round(part[po + 1] * a + out[bo + 1] * ia);
      out[bo + 2] = Math.round(part[po + 2] * a + out[bo + 2] * ia);
      out[bo + 3] = Math.round(Math.min(255, part[po + 3] + out[bo + 3] * ia));
    }
  }
  return out;
}

function writePreview(bodyFrames, partFrames, rect) {
  const dir = join(tmpdir(), 'pet-panda-preview');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < bodyFrames.length; i++) {
    writeFileSync(join(dir, `body-${String(i).padStart(2, '0')}.png`), encodePng(bodyFrames[i], FRAME_W, FRAME_H));
    writeFileSync(join(dir, `incense-${String(i).padStart(2, '0')}.png`), encodePng(partFrames[i], rect.w, rect.h));
    writeFileSync(
      join(dir, `comp-${String(i).padStart(2, '0')}.png`),
      encodePng(composePreview(bodyFrames[i], partFrames[i], rect), FRAME_W, FRAME_H),
    );
  }
  const sheetW = FRAME_W * COLS;
  const sheetH = FRAME_H * ROWS;
  const sheet = Buffer.alloc(sheetW * sheetH * 4);
  bodyFrames.forEach((f, i) => blitFrame(sheet, sheetW, f, FRAME_W, FRAME_H, (i % COLS) * FRAME_W, ((i / COLS) | 0) * FRAME_H));
  writeFileSync(join(dir, 'body-sheet-checker.png'), encodePng(overChecker(sheet, sheetW, sheetH, 12), sheetW, sheetH));
  const compSheet = Buffer.alloc(sheetW * sheetH * 4);
  bodyFrames.forEach((f, i) => {
    const c = composePreview(f, partFrames[i], rect);
    blitFrame(compSheet, sheetW, c, FRAME_W, FRAME_H, (i % COLS) * FRAME_W, ((i / COLS) | 0) * FRAME_H);
  });
  writeFileSync(join(dir, 'comp-sheet-checker.png'), encodePng(overChecker(compSheet, sheetW, sheetH, 12), sheetW, sheetH));
  console.log(`预览已写入 ${dir}`);
}

// ---------- 主流程 ----------
function main() {
  const bodyLayer = loadLayer(BODY_PATH);
  if (bodyLayer.w !== SRC_W || bodyLayer.h !== SRC_H) {
    throw new Error(`身体层尺寸应为 ${SRC_W}x${SRC_H}，实际 ${bodyLayer.w}x${bodyLayer.h}`);
  }
  console.log('绘制香束独立图层…');
  const incenseLayer = buildIncenseLayer();

  console.log(`渲染 ${FRAME_SPECS.length} 帧（${FRAME_W}x${FRAME_H}，${SS}x 超采样）…`);
  const bodyFrames = [];
  const fullIncenseFrames = [];
  for (const spec of FRAME_SPECS) {
    bodyFrames.push(renderBodyFrame(spec, bodyLayer));
    fullIncenseFrames.push(renderIncenseFrame(spec, incenseLayer));
  }

  // 身体帧不得触边；香束按内容裁切
  for (let i = 0; i < bodyFrames.length; i++) {
    const f = bodyFrames[i];
    const edge = Math.max(f[3], f[(FRAME_H - 1) * FRAME_W * 4 + 3], f[(FRAME_W - 1) * 4 + 3], f[(FRAME_H * FRAME_W - 1) * 4 + 3]);
    if (edge > 0) throw new Error(`第 ${i} 帧身体触边，需加大留白`);
  }
  const rect = contentBBox(fullIncenseFrames);
  const partFrames = fullIncenseFrames.map((f) => cropFrame(f, rect));
  console.log(`香束部件尺寸 ${rect.w}x${rect.h} @ (${rect.x},${rect.y})`);

  const bodySheetW = FRAME_W * COLS;
  const bodySheetH = FRAME_H * ROWS;
  const bodySheet = Buffer.alloc(bodySheetW * bodySheetH * 4);
  bodyFrames.forEach((f, i) => blitFrame(bodySheet, bodySheetW, f, FRAME_W, FRAME_H, (i % COLS) * FRAME_W, ((i / COLS) | 0) * FRAME_H));

  const partSheetW = rect.w * COLS;
  const partSheetH = rect.h * ROWS;
  if (partSheetW > 4096 || partSheetH > 4096) throw new Error('香束部件表超过 4096');
  const partSheet = Buffer.alloc(partSheetW * partSheetH * 4);
  partFrames.forEach((f, i) => blitFrame(partSheet, partSheetW, f, rect.w, rect.h, (i % COLS) * rect.w, ((i / COLS) | 0) * rect.h));

  mkdirSync(join(OUT_DIR, 'sounds'), { recursive: true });
  writeFileSync(join(OUT_DIR, 'body-sheet.png'), encodePng(bodySheet, bodySheetW, bodySheetH));
  writeFileSync(join(OUT_DIR, 'incense-sheet.png'), encodePng(partSheet, partSheetW, partSheetH));
  writeFileSync(join(OUT_DIR, 'sounds', 'bell.wav'), makeBell());
  const oldSheet = join(OUT_DIR, 'sheet.png');
  if (existsSync(oldSheet)) unlinkSync(oldSheet);
  console.log(`已生成 ${join(OUT_DIR, 'body-sheet.png')}（${bodySheetW}x${bodySheetH}）`);
  console.log(`已生成 ${join(OUT_DIR, 'incense-sheet.png')}（${partSheetW}x${partSheetH}）`);
  console.log(`已生成 ${join(OUT_DIR, 'sounds', 'bell.wav')}`);

  // 把派生出的贴图尺寸写回清单（其余字段保留），避免帧/裁切漂移
  const manifestPath = join(OUT_DIR, 'petpack.json');
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.sprite = {
      ...m.sprite,
      sheet: 'body-sheet.png',
      frameW: FRAME_W,
      frameH: FRAME_H,
      cols: COLS,
      parts: [
        {
          sheet: 'incense-sheet.png',
          frameW: rect.w,
          frameH: rect.h,
          cols: COLS,
          offsetX: rect.x,
          offsetY: rect.y,
        },
      ],
    };
    let maxFrame = -1;
    for (const anim of Object.values(m.animations ?? {})) {
      for (const f of anim?.frames ?? []) maxFrame = Math.max(maxFrame, f);
    }
    if (maxFrame >= bodyFrames.length) {
      throw new Error(`petpack.json 引用了第 ${maxFrame} 帧，但只生成了 ${bodyFrames.length} 帧`);
    }
    writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
    console.log(`清单已更新：${Object.keys(m.animations ?? {}).length} 个动作，香束 parts 1 层`);
  }

  if (PREVIEW) writePreview(bodyFrames, partFrames, rect);
}

main();
