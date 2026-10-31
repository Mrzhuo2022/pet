import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { SemanticAction, WalkFreq } from './types';

export type PetEngineKind = 'live2d' | 'sprite';

/** 语义动作在 petpack 里的绑定（live2d 用 motion + 可选 index/expression，sprite 用 frames） */
export interface PetpackAnimation {
  motion?: string;
  /** Live2D：指定动作条目索引（0 起）；缺省在组内随机（不连续重复） */
  index?: number;
  expression?: string;
  frames?: number[];
  fps?: number;
  loop?: boolean;
  /**
   * 组内按条目索引加权（默认 1）：让"常做的动作"更常出现。
   * 仅对组内随机（未指定 index）生效，主要供 idle 轮换使用；键是索引字符串。
   */
  weights?: Record<string, number>;
  /** 单次播放结束后回到的语义动作（默认 idle） */
  back?: SemanticAction;
}

export interface SpritePart {
  sheet: string;
  frameW: number;
  frameH: number;
  cols: number;
  /** 部件帧左上角在主帧坐标系里的位置（与主帧同像素密度） */
  offsetX: number;
  offsetY: number;
}

export interface SpriteMeta {
  sheet: string;
  frameW: number;
  frameH: number;
  cols: number;
  /** 可选分层：各部件复用主表的动作帧序列（帧号一一对应） */
  parts?: SpritePart[];
}

/**
 * 换装选项：一组模型参数注入（Live2D 服装开关参数，如 ATRI 的 Param9/10/17/18/36）。
 * 引擎在每帧渲染前把参数写回核心模型，覆盖任何动作残留；index 0（默认装）不注入。
 */
export interface PetpackOutfit {
  name: string;
  /** 参数 Id → 值（如 { "Param10": 30 }） */
  params?: Record<string, number>;
  /** 备选：用模型自带表情切换（与悬停等表情绑定互斥，慎用） */
  expression?: string;
}

export interface PetpackManifest {
  id: string;
  name: string;
  version?: string;
  author?: string;
  engine: PetEngineKind;
  /** live2d: 模型入口文件（相对皮肤包根） */
  entry?: string;
  /** sprite: 精灵图元数据 */
  sprite?: SpriteMeta;
  /**
   * 整体显示缩放系数（默认 1 = 画布适配 360×480 参考框）：画布内容偏大/留白多的
   * 皮肤用 <1 的值整体调小（如内置上香熊猫 0.65），所有缩放设置档位同比变小。
   */
  displayScale?: number;
  animations: Partial<Record<SemanticAction, PetpackAnimation>>;
  /**
   * Live2D 命中区域差异化反应：HitArea 区域名 → 动作绑定。
   * 点击命中配置过的区域时播对应绑定，未配置的区域回退 click 绑定（sprite 引擎无此概念）。
   */
  hitReactions?: Record<string, PetpackAnimation>;
  /**
   * 时段问候：待机闲聊按系统时段优先取对应条目（无配置的时段走 idle 绑定，行为不变）。
   * 划分见 timeSlot()：morning 5–10 / afternoon 11–16 / evening 17–22 / night 23–4。
   */
  timeGreetings?: Partial<Record<TimeSlot, PetpackAnimation>>;
  /**
   * 换装名单（Live2D）：UI 展示顺序 = [默认, outfits[0], outfits[1]…]，
   * Pet.outfitIndex 0 = 默认装，i = outfits[i-1]。
   */
  outfits?: PetpackOutfit[];
  /** 交互反馈素材：点击随机音效 / 点击随机气泡文本 */
  interactions?: {
    clickSounds?: string[];
    clickTexts?: string[];
    /** Live2D 动作自带台词时优先显示模型台词（与语音同条对应），默认 true */
    motionText?: boolean;
  };
  /** 气泡样式（随皮肤定制；缺省浅色） */
  bubble?: {
    theme?: 'light' | 'dark';
    /** 强调色（边框/尾巴，CSS 颜色字符串） */
    accent?: string;
  };
  /** 人设（阶段 3 LLM 聊天使用） */
  persona?: { prompt?: string; voice?: string };
}

/** 皮肤列表条目：内置包走前端静态资源，用户包走 asset 协议 */
export interface PackEntry {
  id: string;
  name: string;
  engine: PetEngineKind;
  source: 'builtin' | 'user';
  /** 以 / 结尾的基础 URL */
  baseUrl: string;
  /** 用户包的文件系统目录（内置包无）；用于"编辑配置" */
  dirPath?: string;
  /** 导入时自动生成的配置（可编辑精调） */
  generated?: boolean;
  /** 导入时间（epoch ms；内置包无） */
  importedAt?: number | null;
}

interface UserPackInfo {
  id: string;
  name: string;
  engine: string;
  path: string;
  generated: boolean;
  importedAt?: number | null;
}

/** 皮肤列表排序方式 */
export type PackSort = 'name' | 'engine' | 'recent';

/**
 * 纯函数：皮肤列表按关键字过滤 + 排序（便于单测）。
 * query 匹配名称或 id（大小写不敏感）；空串不过滤。
 */
export function filterSortPacks(packs: PackEntry[], query: string, sort: PackSort): PackEntry[] {
  const kw = query.trim().toLowerCase();
  const hit = packs.filter(
    (p) => !kw || p.name.toLowerCase().includes(kw) || p.id.toLowerCase().includes(kw),
  );
  const byName = (a: PackEntry, b: PackEntry) => a.name.localeCompare(b.name, 'zh-Hans-CN');
  const arr = [...hit];
  if (sort === 'engine') {
    arr.sort((a, b) => a.engine.localeCompare(b.engine) || byName(a, b));
  } else if (sort === 'recent') {
    // 无导入时间（内置包）排最后
    arr.sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0) || byName(a, b));
  } else {
    arr.sort(byName);
  }
  return arr;
}

/** 时段问候的时段划分（timeSlot 按小时归类） */
export type TimeSlot = 'morning' | 'afternoon' | 'evening' | 'night';

export const TIME_SLOTS: TimeSlot[] = ['morning', 'afternoon', 'evening', 'night'];

/** 纯函数：小时 → 时段（morning 5–10 / afternoon 11–16 / evening 17–22 / night 23–4） */
export function timeSlot(hour: number): TimeSlot {
  if (hour >= 5 && hour <= 10) return 'morning';
  if (hour >= 11 && hour <= 16) return 'afternoon';
  if (hour >= 17 && hour <= 22) return 'evening';
  return 'night';
}

/** 单只桌宠实例（与 Rust petpack::Pet 对应） */
export interface PetInfo {
  id: string;
  /** null = 使用皮肤列表第一项 */
  petpack: string | null;
  /** 自定义显示名；null 时回退「皮肤名 · 序号」 */
  displayName: string | null;
  x: number | null;
  y: number | null;
  scale: number | null;
  lockPosition: boolean;
  roamEnabled: boolean;
  soundEnabled: boolean;
  bubbleEnabled: boolean;
  /** 待机闲聊：空闲时每隔一阵随机播一条动作+语音+气泡 */
  ambientEnabled: boolean;
  /** 拖拽抛掷：松手带惯性滑行、撞屏幕边缘反弹 */
  flingEnabled: boolean;
  /** 视角跟随：眼神看向鼠标方向，静止后慢慢回正 */
  gazeEnabled: boolean;
  /** 跟随鼠标：空闲时慢慢走到鼠标位置，光标移动实时改路径 */
  followEnabled: boolean;
  /** 任务栏模式：贴在当前显示器工作区底沿（任务栏上沿）活动 */
  groundEnabled: boolean;
  /** 当前服装：0 = 模型默认，i = 皮肤包 manifest.outfits[i-1] */
  outfitIndex: number;
  alwaysOnTop: boolean;
  walkFreq: WalkFreq;
  walkSpeed: number;
}

/** 全局设置 + 全部桌宠实例 */
export interface AppSettings {
  pets: PetInfo[];
  /** 点击音效音量 0–1（全局） */
  volume: number;
  /** 气泡停留时长（毫秒，全局） */
  bubbleMs: number;
  /** 抛掷重力（物理 px/s²，任务栏模式落地手感） */
  gravity: number;
  /** 反弹恢复系数 0–0.8：撞墙/落地弹跳强度 */
  bounceRestitution: number;
  /** 触发抛掷的最低松手速度（物理 px/s） */
  flingMinSpeed: number;
  /** 待机闲聊最短间隔（秒，实际在 min–min×2.75 间随机） */
  ambientIntervalSec: number;
  /** 所有桌宠窗口共用置顶开关 */
  alwaysOnTop: boolean;
}

const WALK_FREQS: WalkFreq[] = ['quiet', 'normal', 'lively'];

const normWalkFreq = (v: unknown): WalkFreq =>
  WALK_FREQS.includes(v as WalkFreq) ? (v as WalkFreq) : 'normal';

/** Rust 返回的原始设置（字段可能缺失/来自旧版本），normalizeSettings 统一修复 */
export interface RawAppSettings {
  pets?: Array<Partial<Omit<PetInfo, 'walkFreq'>> & { walkFreq?: unknown }>;
  volume?: number;
  bubbleMs?: number;
  gravity?: number;
  bounceRestitution?: number;
  flingMinSpeed?: number;
  ambientIntervalSec?: number;
  alwaysOnTop?: boolean;
}

const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const numberOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** 纯函数：设置缺省/越界修复，便于冒烟测试 */
export function normalizeSettings(raw: RawAppSettings | null | undefined): AppSettings {
  const s = raw ?? {};
  return {
    pets: (s.pets ?? []).map((p) => ({
      id: p.id ?? '',
      petpack: p.petpack ?? null,
      displayName:
        typeof p.displayName === 'string' && p.displayName.trim()
          ? p.displayName.trim()
          : null,
      x: numberOrNull(p.x),
      y: numberOrNull(p.y),
      scale: Math.min(3, Math.max(0.2, finiteOr(p.scale, 1))),
      lockPosition: !!p.lockPosition,
      roamEnabled: p.roamEnabled !== false,
      soundEnabled: p.soundEnabled !== false,
      bubbleEnabled: p.bubbleEnabled !== false,
      ambientEnabled: p.ambientEnabled !== false,
      flingEnabled: p.flingEnabled !== false,
      gazeEnabled: p.gazeEnabled !== false,
      followEnabled: p.followEnabled === true,
      groundEnabled: p.groundEnabled !== false,
      outfitIndex: Math.max(0, Math.round(finiteOr(p.outfitIndex, 0))),
      alwaysOnTop: p.alwaysOnTop !== false,
      walkFreq: normWalkFreq(p.walkFreq),
      walkSpeed: Math.min(200, Math.max(20, finiteOr(p.walkSpeed, 55))),
    })),
    volume: Math.min(1, Math.max(0, finiteOr(s.volume, 0.6))),
    bubbleMs: Math.min(10_000, Math.max(500, finiteOr(s.bubbleMs, 2600))),
    gravity: Math.min(8000, Math.max(1000, finiteOr(s.gravity, 3000))),
    bounceRestitution: Math.min(0.8, Math.max(0, finiteOr(s.bounceRestitution, 0.45))),
    flingMinSpeed: Math.min(500, Math.max(100, finiteOr(s.flingMinSpeed, 220))),
    ambientIntervalSec: Math.min(180, Math.max(15, Math.round(finiteOr(s.ambientIntervalSec, 40)))),
    alwaysOnTop: s.alwaysOnTop !== false,
  };
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    return normalizeSettings(await invoke<RawAppSettings>('get_settings'));
  } catch {
    return normalizeSettings(null);
  }
}

/** 合并内置皮肤（/petskins/index.json）与用户皮肤（Rust 列出 appData/petskins） */
export async function loadPackList(): Promise<PackEntry[]> {
  const packs: PackEntry[] = [];
  let users: UserPackInfo[] = [];
  try {
    users = await invoke<UserPackInfo[]>('list_user_petpacks');
  } catch {
    // Rust 侧不可用时忽略（如浏览器里开发调试）
  }
  const usedIds = new Set(users.map((u) => u.id));
  try {
    const res = await fetch('/petskins/index.json');
    const index = (await res.json()) as {
      packs: Array<{ id: string; dir: string; name: string; engine: PetEngineKind }>;
    };
    for (const p of index.packs) {
      if (usedIds.has(p.id)) continue; // 用户包覆盖同名内置包
      packs.push({
        id: p.id,
        name: p.name,
        engine: p.engine,
        source: 'builtin',
        baseUrl: `/petskins/${p.dir}/`,
      });
    }
  } catch {
    // 内置索引缺失时只展示用户包
  }
  for (const u of users) {
    packs.push({
      id: u.id,
      name: u.name,
      engine: u.engine as PetEngineKind,
      source: 'user',
      baseUrl: userPackBaseUrl(u.path, convertFileSrc),
      dirPath: u.path,
      generated: u.generated,
      importedAt: u.importedAt ?? null,
    });
  }
  return packs;
}

/** 纯函数：清单结构与 parts 校验（便于单测） */
export function validateManifest(m: PetpackManifest): PetpackManifest {
  if (!m.id || !m.engine) throw new Error('petpack.json 缺少 id/engine 字段');
  if (!m.animations?.idle) throw new Error('petpack.json 缺少 idle 动画映射');
  if (m.engine === 'live2d' && !m.entry) throw new Error('live2d 皮肤缺少 entry 字段');
  if (m.engine === 'sprite' && !m.sprite) throw new Error('sprite 皮肤缺少 sprite 字段');
  if (
    m.displayScale !== undefined &&
    !(typeof m.displayScale === 'number' && Number.isFinite(m.displayScale) && m.displayScale > 0 && m.displayScale <= 4)
  ) {
    throw new Error('displayScale 必须为 (0, 4] 内的数值');
  }
  if (m.sprite) {
    // 帧尺寸/列数非法（0、负数、小数）会让 fitScale 得到 Infinity、切帧错位，
    // 在加载入口就拒绝（走 loadPack 的降级换肤），而不是渲染出坏窗口
    const { frameW, frameH, cols } = m.sprite;
    if (![frameW, frameH, cols].every((n) => Number.isInteger(n) && n > 0)) {
      throw new Error('sprite.frameW/frameH/cols 必须为正整数');
    }
  }
  for (const part of m.sprite?.parts ?? []) {
    if (!part.sheet || !part.frameW || !part.frameH || !part.cols) {
      throw new Error('sprite.parts 缺少 sheet/frameW/frameH/cols');
    }
    if (!Number.isFinite(part.offsetX) || !Number.isFinite(part.offsetY)) {
      throw new Error('sprite.parts 缺少 offsetX/offsetY');
    }
  }
  return m;
}

export async function fetchManifest(baseUrl: string): Promise<PetpackManifest> {
  const res = await fetch(`${baseUrl}petpack.json`);
  if (!res.ok) throw new Error(`petpack.json 加载失败: HTTP ${res.status}`);
  return validateManifest((await res.json()) as PetpackManifest);
}

/**
 * 解析皮肤包内资源 URL。
 * 注意：asset 协议 URL 的路径是整体 encodeURIComponent 的（'/' -> '%2F'），
 * 不能用标准 URL 相对解析（会把整段路径当单个 segment），统一字符串拼接。
 * 内置包 baseUrl 是同源相对路径，拼接后由浏览器基于页面 origin 解析。
 */
export function resolveUrl(rel: string, baseUrl: string): string {
  return `${baseUrl}${rel}`;
}

/**
 * 用户包的 asset 基础 URL（convertFileSrc 注入以便单测）。
 * convertFileSrc 把整段路径 encodeURIComponent（'/' → '%2F'）：若结尾斜杠也被编码，
 * 模型 URL 里就不存在任何字面 '/'，pixi-live2d-display 内部用 url.resolve 做
 * 相对解析时会把整个目录当单个 segment 丢掉（moc3/贴图/动作/语音全部 404）。
 * 因此先去掉尾部斜杠、编码后再补一个字面 '/'。
 */
export function userPackBaseUrl(rawPath: string, convert: (p: string) => string): string {
  return convert(rawPath.replace(/\\/g, '/').replace(/\/+$/, '')) + '/';
}

/**
 * 皮肤缩略图：sprite → sheet 第一帧绘制成 dataURL；
 * live2d → model3.json 的第一张贴图 URL。
 */
export async function packThumb(pack: PackEntry): Promise<string | null> {
  const m = await fetchManifest(pack.baseUrl);
  if (m.engine === 'sprite' && m.sprite) {
    const sp = m.sprite;
    // 跨源（asset://）图源必须带 CORS 属性，否则画布被污染、toDataURL 抛错
    const loadImg = (url: string) =>
      new Promise<HTMLImageElement>((res, rej) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('sheet 加载失败'));
        im.src = url;
      });
    const img = await loadImg(resolveUrl(sp.sheet, pack.baseUrl));
    // 列表缩略图没必要按原帧尺寸生成（高清皮肤 600x800+），限制到 ~256px
    const scale = Math.min(1, 256 / sp.frameW, 350 / sp.frameH);
    const tw = Math.max(1, Math.round(sp.frameW * scale));
    const th = Math.max(1, Math.round(sp.frameH * scale));
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.drawImage(img, 0, 0, sp.frameW, sp.frameH, 0, 0, tw, th);
    // 合成部件层（取第 0 帧，即 idle 起始帧）
    for (const part of sp.parts ?? []) {
      const pimg = await loadImg(resolveUrl(part.sheet, pack.baseUrl));
      g.drawImage(
        pimg,
        0,
        0,
        part.frameW,
        part.frameH,
        part.offsetX * scale,
        part.offsetY * scale,
        part.frameW * scale,
        part.frameH * scale,
      );
    }
    return c.toDataURL();
  }
  if (m.engine === 'live2d' && m.entry) {
    const m3 = await fetch(resolveUrl(m.entry, pack.baseUrl)).then((r) => r.json());
    const tex = m3?.FileReferences?.Textures?.[0];
    if (typeof tex === 'string') return resolveUrl(tex, pack.baseUrl);
  }
  return null;
}
