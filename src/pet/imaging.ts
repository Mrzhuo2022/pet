/**
 * 图片处理工具：导入 PNG/GIF → 精灵图 sheet。
 * GIF 抽帧使用 WebView2 内置的 ImageDecoder API（Chromium 标准提案）。
 */

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export function dataUrlToBase64(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

export async function bitmapFromBytes(data: Uint8Array, mime: string): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([data as unknown as BlobPart], { type: mime }));
}

/** 解码 GIF 全部帧（上限 64 帧，避免超长 GIF 卡死） */
export async function decodeGifFrames(data: Uint8Array): Promise<ImageBitmap[]> {
  const dec = new ImageDecoder({ data, type: 'image/gif' });
  await dec.tracks.ready;
  const track = dec.tracks.selectedTrack;
  if (!track) throw new Error('GIF 中没有可用帧');
  const count = Math.min(track.frameCount ?? 1, 64);
  const out: ImageBitmap[] = [];
  for (let i = 0; i < count; i++) {
    const r = await dec.decode({ frameIndex: i });
    const bmp = await createImageBitmap(r.image);
    r.image.close();
    out.push(bmp);
  }
  if (out.length === 0) throw new Error('GIF 中没有可用帧');
  return out;
}

export interface Sheet {
  dataUrl: string;
  frameW: number;
  frameH: number;
  cols: number;
  frames: number;
}

/** 把若干帧拼成网格 sheet：每帧按底部中心对齐，尺寸取最大帧 */
export function buildSheet(frames: ImageBitmap[]): Sheet {
  if (frames.length === 0) throw new Error('没有可用帧');
  const fw = Math.max(...frames.map((f) => f.width), 8);
  const fh = Math.max(...frames.map((f) => f.height), 8);
  const cols = Math.max(1, Math.ceil(Math.sqrt(frames.length)));
  const rows = Math.ceil(frames.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = fw * cols;
  canvas.height = fh * rows;
  const g = canvas.getContext('2d')!;
  frames.forEach((f, i) => {
    g.drawImage(
      f,
      (i % cols) * fw + Math.round((fw - f.width) / 2),
      Math.floor(i / cols) * fh + (fh - f.height),
    );
  });
  return { dataUrl: canvas.toDataURL('image/png'), frameW: fw, frameH: fh, cols, frames: frames.length };
}

export function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    // asset:// 等跨源图源必须带 CORS 属性，否则画布被污染、toDataURL 抛 SecurityError
    im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(`图片加载失败: ${src}`));
    im.src = src;
  });
}
