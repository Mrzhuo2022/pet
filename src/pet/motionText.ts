import type { SemanticAction } from './types';

/**
 * Live2D 模型 JSON（model3.json / 解包的 model0.json）里一条动作定义的原样字段。
 * 官方字段外的 Text / TextDuration 是解包器从游戏数据还原的台词与气泡时长，
 * 与 File / Sound 同属一条动作 → 播放第 i 条动作时语音与台词天然一一对应。
 */
export interface MotionDef {
  File?: string;
  Sound?: string;
  Text?: unknown;
  TextDuration?: unknown;
  Name?: unknown;
  [key: string]: unknown;
}

/** 引擎播放一条动作后给出的反馈（供行为层做气泡/音效联动） */
export interface MotionFeedback {
  action: SemanticAction;
  group: string;
  index: number;
  /** 该动作自带台词（与语音同条）；无则为 undefined */
  text?: string;
  /** 该动作自带语音文件名（由渲染库在播放动作时自动出声） */
  sound?: string;
  /** 台词建议显示时长（毫秒，模型数据自带） */
  durationMs?: number;
}

/**
 * 从动作组定义里随机挑一条可播放的（以 File 为准：只有 Name/参数或只有
 * Sound 的条目无法作为动作播放）。excludeIndex 用于避免连续重复同一条。
 * weights 为索引→权重（缺省 1、负值视为 0），用于 idle 轮换加权；
 * 返回 null 表示整组不可播放。
 */
export function pickPlayableMotion(
  defs: MotionDef[] | undefined,
  excludeIndex?: number,
  weights?: Record<string, number>,
): { index: number; def: MotionDef } | null {
  if (!defs?.length) return null;
  const playable: { index: number; def: MotionDef }[] = [];
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i]!;
    if (typeof def.File === 'string' && def.File) playable.push({ index: i, def });
  }
  if (!playable.length) return null;
  // 只有一条时可播条目时无法去重，直接返回
  let pool = playable;
  if (playable.length > 1 && typeof excludeIndex === 'number') {
    const filtered = playable.filter((p) => p.index !== excludeIndex);
    if (filtered.length) pool = filtered;
  }
  if (weights) {
    const w = (p: { index: number }): number => Math.max(0, weights[String(p.index)] ?? 1);
    const total = pool.reduce((s, p) => s + w(p), 0);
    if (total > 0) {
      let r = Math.random() * total;
      for (const p of pool) {
        r -= w(p);
        if (r <= 0) return p;
      }
      // 浮点误差兜底：落到最后一个正权重条目
      const last = [...pool].reverse().find((p) => w(p) > 0);
      if (last) return last;
    }
  }
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/** 索引是否指向一条可播放的动作（含 File） */
export function isPlayableIndex(defs: MotionDef[] | undefined, index: number): boolean {
  const def = defs?.[index];
  return !!def && typeof def.File === 'string' && !!def.File;
}

/** 从动作定义提取台词反馈：非字符串/空白的字段一律视为无 */
export function motionFeedback(
  action: SemanticAction,
  group: string,
  picked: { index: number; def: MotionDef },
): MotionFeedback {
  const text = typeof picked.def.Text === 'string' ? picked.def.Text.trim() : '';
  const sound = typeof picked.def.Sound === 'string' && picked.def.Sound ? picked.def.Sound : undefined;
  const dur = typeof picked.def.TextDuration === 'number' && Number.isFinite(picked.def.TextDuration)
    ? picked.def.TextDuration
    : undefined;
  return {
    action,
    group,
    index: picked.index,
    text: text || undefined,
    sound,
    durationMs: dur && dur > 0 ? dur : undefined,
  };
}
