// 运行时导入带 .ts 扩展：本模块被 node --test 单测直接加载（strip-only 模式
// 不做扩展名补全）；纯类型的 './petpack'/'./motionText' 同样统一带扩展
import { fetchManifest, resolveUrl, type PackEntry, type PetEngineKind, type PetpackAnimation, type PetpackManifest } from './petpack.ts';
import { SEMANTIC_ACTIONS } from './types.ts';
import type { MotionDef } from './motionText.ts';

/** 皮肤包只读摘要（详情面板用）：规模计数 + 各类绑定的人读文本 */
export interface PackSummary {
  engine: PetEngineKind;
  /** live2d：动作组规模（可播条数/总条数） */
  motionGroups: { name: string; playable: number; total: number }[];
  /** live2d：表情名与命中区域名 */
  expressions: string[];
  hitAreas: string[];
  /** sprite：总帧数 */
  frames: number | null;
  /** live2d：换装名单名称（默认装不计入） */
  outfits: string[];
  /** 已配置的语义绑定（只列存在的） */
  bindings: { action: string; text: string }[];
  hitReactions: { key: string; text: string }[];
  timeGreetings: { key: string; text: string }[];
  clickTexts: number;
  clickSounds: string[];
}

const TIME_LABEL: Record<string, string> = {
  morning: '早上（5–10点）',
  afternoon: '下午（11–16点）',
  evening: '傍晚（17–22点）',
  night: '深夜（23–4点）',
};

/** 纯函数：一条绑定的人读文本（sprite 看帧，live2d 看动作组/条目/表情） */
export function animText(
  engine: PetEngineKind,
  b: PetpackAnimation | undefined,
  defs?: Record<string, MotionDef[]>,
): string {
  if (!b) return '—';
  if (engine === 'sprite') {
    if (!b.frames?.length) return '—';
    const bits = [`${b.frames.length} 帧`];
    if (b.fps) bits.push(`${b.fps}fps`);
    bits.push(b.loop !== false ? '循环' : '单次');
    return bits.join(' · ');
  }
  if (!b.motion) return b.expression ? `表情 ${b.expression}` : '—';
  const bits = [b.motion, typeof b.index === 'number' ? `第 ${b.index} 条` : '随机'];
  const name =
    typeof b.index === 'number' ? defs?.[b.motion]?.[b.index]?.Name : undefined;
  if (typeof name === 'string' && name) bits.push(name);
  if (b.expression) bits.push(`表情 ${b.expression}`);
  return bits.join(' · ');
}

/**
 * 纯函数：manifest（+ 可选的 model3.json 内容）→ 只读摘要。
 * m3 缺失（抓取失败）时动作组规模等降级为空，不影响其余字段。
 */
export function summarizeManifest(
  m: PetpackManifest,
  m3?: { FileReferences?: { Motions?: Record<string, MotionDef[]>; Expressions?: { Name?: unknown }[]; HitAreas?: { Name?: unknown }[] } },
): PackSummary {
  const motions = m3?.FileReferences?.Motions ?? {};
  const motionGroups = Object.entries(motions).map(([name, list]) => ({
    name,
    playable: (list ?? []).filter((d) => typeof d?.File === 'string' && d.File).length,
    total: (list ?? []).length,
  }));
  const bindings = SEMANTIC_ACTIONS.filter((a) => m.animations[a]).map((a) => ({
    action: a,
    text: animText(m.engine, m.animations[a], motions),
  }));
  return {
    engine: m.engine,
    motionGroups,
    expressions: (m3?.FileReferences?.Expressions ?? [])
      .map((e) => (typeof e?.Name === 'string' ? e.Name : ''))
      .filter(Boolean),
    hitAreas: (m3?.FileReferences?.HitAreas ?? [])
      .map((h) => (typeof h?.Name === 'string' ? h.Name : ''))
      .filter(Boolean),
    frames: m.engine === 'sprite' ? (m.animations.idle?.frames?.length ?? null) : null,
    outfits: (m.outfits ?? [])
      .map((o) => (typeof o?.name === 'string' ? o.name : ''))
      .filter(Boolean),
    bindings,
    hitReactions: Object.entries(m.hitReactions ?? {}).map(([key, b]) => ({
      key,
      text: animText('live2d', b, motions),
    })),
    timeGreetings: Object.entries(m.timeGreetings ?? {}).map(([slot, b]) => ({
      key: TIME_LABEL[slot] ?? slot,
      text: animText(m.engine, b, motions),
    })),
    clickTexts: m.interactions?.clickTexts?.length ?? 0,
    clickSounds: m.interactions?.clickSounds ?? [],
  };
}

/** 抓取皮肤包并生成只读摘要（live2d 的 model3.json 抓取失败不致命） */
export async function summarizePack(pack: PackEntry): Promise<PackSummary> {
  const m = await fetchManifest(pack.baseUrl);
  let m3: Parameters<typeof summarizeManifest>[1];
  if (m.engine === 'live2d' && m.entry) {
    m3 = await fetch(resolveUrl(m.entry, pack.baseUrl))
      .then((r) => r.json())
      .catch(() => undefined);
  }
  return summarizeManifest(m, m3);
}
