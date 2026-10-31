/**
 * 语义动作：行为层只认识这些抽象动作，
 * 由引擎适配层翻译成具体模型的 motion/expression（阶段 2 换成 petpack.json 数据驱动）。
 */
export type SemanticAction =
  | 'idle'
  | 'walk'
  | 'drag'
  | 'click'
  | 'pat'
  | 'sleep'
  | 'hover'
  | 'thinking'
  | 'speaking'
  | 'done'
  | 'failed';

/** 桌宠行为状态机的状态 */
export type PetState = 'idle' | 'walk' | 'drag' | 'click';

/** 走动频率档位（设置）：安静 / 普通 / 活泼 */
export type WalkFreq = 'quiet' | 'normal' | 'lively';

/** 语义动作全集（petpack animations 的合法键） */
export const SEMANTIC_ACTIONS: SemanticAction[] = [
  'idle',
  'walk',
  'drag',
  'click',
  'pat',
  'sleep',
  'hover',
  'thinking',
  'speaking',
  'done',
  'failed',
];
