import type { PetpackAnimation, PetpackManifest } from './petpack';
import type { SemanticAction } from './types';

/** 命名绑定表（命中区域/时段问候）的 diff：逐键报告新增/移除/修改 */
function diffNamedMap(
  label: string,
  before: Record<string, PetpackAnimation> | undefined,
  after: Record<string, PetpackAnimation> | undefined,
  lines: string[],
): void {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    const eb = JSON.stringify(before?.[k] ?? null);
    const ea = JSON.stringify(after?.[k] ?? null);
    if (eb === ea) continue;
    if (ea === 'null') lines.push(`${label} ${k}: 移除配置`);
    else if (eb === 'null') lines.push(`${label} ${k}: 新增配置`);
    else lines.push(`${label} ${k}: 已修改`);
  }
}

/**
 * 人读的 manifest 改动清单（编辑器保存确认框用）。
 * 纯函数便于单测；粒度到"语义动作的绑定/文案/样式"，不逐字节 diff。
 */
export function diffManifest(before: PetpackManifest, after: PetpackManifest): string[] {
  const lines: string[] = [];

  // ---- 动作绑定 ----
  const actions = new Set<SemanticAction>([
    ...(Object.keys(before.animations ?? {}) as SemanticAction[]),
    ...(Object.keys(after.animations ?? {}) as SemanticAction[]),
  ]);
  for (const a of actions) {
    const b = before.animations?.[a];
    const c = after.animations?.[a];
    if (b && !c) {
      lines.push(`${a}: 移除绑定`);
      continue;
    }
    if (!b && c) {
      lines.push(`${a}: 新增绑定`);
      continue;
    }
    if (!b || !c) continue;
    if ((b.motion ?? '') !== (c.motion ?? '')) {
      lines.push(
        `${a}: 动作组 ${b.motion || '（回退 idle）'} → ${c.motion || '（回退 idle）'}`,
      );
    }
    const bi = typeof b.index === 'number' ? `#${b.index}` : '随机';
    const ci = typeof c.index === 'number' ? `#${c.index}` : '随机';
    if (bi !== ci) lines.push(`${a}: 条目 ${bi} → ${ci}`);
    if ((b.expression ?? '') !== (c.expression ?? '')) {
      lines.push(`${a}: 表情 ${b.expression || '（无）'} → ${c.expression || '（无）'}`);
    }
    const bf = b.frames?.join(',') ?? '';
    const cf = c.frames?.join(',') ?? '';
    if (bf !== cf) {
      lines.push(`${a}: 帧序列变更（${b.frames?.length ?? 0} → ${c.frames?.length ?? 0} 帧）`);
    }
    if ((b.fps ?? undefined) !== (c.fps ?? undefined)) {
      lines.push(`${a}: fps ${b.fps ?? '—'} → ${c.fps ?? '—'}`);
    }
    if ((b.loop ?? true) !== (c.loop ?? true)) {
      lines.push(`${a}: 循环 ${b.loop !== false ? '开' : '关'} → ${c.loop !== false ? '开' : '关'}`);
    }
  }

  // ---- 命中区域 / 时段问候 ----
  diffNamedMap('命中区域', before.hitReactions, after.hitReactions, lines);
  diffNamedMap('时段问候', before.timeGreetings, after.timeGreetings, lines);

  // ---- 换装名单（按序号逐条报告） ----
  const oCount = Math.max(before.outfits?.length ?? 0, after.outfits?.length ?? 0);
  for (let i = 0; i < oCount; i++) {
    const eb = JSON.stringify(before.outfits?.[i] ?? null);
    const ea = JSON.stringify(after.outfits?.[i] ?? null);
    if (eb === ea) continue;
    const label = after.outfits?.[i]?.name ?? before.outfits?.[i]?.name ?? `第 ${i + 1} 套`;
    if (ea === 'null') lines.push(`服装 ${label}: 移除`);
    else if (eb === 'null') lines.push(`服装 ${label}: 新增`);
    else lines.push(`服装 ${label}: 已修改`);
  }

  // ---- 交互反馈 ----
  const bi = before.interactions ?? {};
  const ai = after.interactions ?? {};
  const bt = bi.clickTexts ?? [];
  const at = ai.clickTexts ?? [];
  if (bt.join('\n') !== at.join('\n')) {
    lines.push(`点击文本：${bt.length} → ${at.length} 条`);
  }
  const bs = bi.clickSounds ?? [];
  const as = ai.clickSounds ?? [];
  if (bs.join('|') !== as.join('|')) {
    lines.push(`点击音效：${bs.length} → ${as.length} 个`);
  }
  if ((bi.motionText ?? true) !== (ai.motionText ?? true)) {
    lines.push(
      `模型台词优先：${(bi.motionText ?? true) ? '开' : '关'} → ${(ai.motionText ?? true) ? '开' : '关'}`,
    );
  }

  // ---- 人设与气泡样式 ----
  const bp = before.persona?.prompt ?? '';
  const ap = after.persona?.prompt ?? '';
  if (bp !== ap) lines.push(ap ? '人设文案已设置' : '人设文案已清除');
  const bth = before.bubble?.theme ?? '';
  const ath = after.bubble?.theme ?? '';
  const bac = before.bubble?.accent ?? '';
  const aac = after.bubble?.accent ?? '';
  if (bth !== ath || bac !== aac) lines.push('气泡样式已调整');

  return lines;
}
