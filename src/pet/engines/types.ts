import type * as PIXI from 'pixi.js';
import type { PetpackAnimation, PetpackManifest, PetpackOutfit } from '../petpack';
import type { MotionFeedback } from '../motionText';
import type { SemanticAction } from '../types';

/**
 * 动作播放选项。
 * sound：是否放行动作自带语音（model3 Motion 条目的 Sound 字段）。
 * 默认不放行——待机轮换/走动/库自动回 idle 等"自发性"播放一律静音，
 * 只有闲聊与点击/拖拽/摸头等显式传入 sound:true 的播放才出声，
 * 否则关掉待机闲聊后桌宠仍会凭空冒语音（且没有气泡可配）。
 */
export interface MotionPlayOpts {
  sound?: boolean;
}

/**
 * 渲染引擎适配层：行为层只通过该接口驱动桌宠，
 * 换 Live2D/精灵图引擎不影响状态机与交互逻辑。
 */
export interface PetEngine {
  /** 引擎根容器，由 PetStage 挂载到舞台 */
  readonly root: PIXI.Container;
  /** 加载资源（baseUrl 以 / 结尾） */
  load(baseUrl: string, manifest: PetpackManifest): Promise<void>;
  /** 布局：按画布尺寸铺满给定区域（底边居中） */
  layout(width: number, height: number): void;
  /**
   * 自然尺寸（确定性几何计算，不依赖渲染）：
   * 画布铺满 refW×refH 时的显示尺寸，作为 scale=1 的基准。
   */
  naturalSize(refW: number, refH: number): { w: number; h: number };
  /** 播放语义动作（未映射的动作回退 idle）；返回实际播放的动作反馈（合台词/语音，供气泡联动） */
  play(action: SemanticAction, opts?: MotionPlayOpts): MotionFeedback | undefined;
  /**
   * 播放一条显式绑定（命中区域反应/时段问候用），返回动作反馈。
   * 仅支持显式绑定的引擎实现；不支持时行为层走 play() 回退。
   */
  playBinding?(
    binding: PetpackAnimation,
    action?: SemanticAction,
    opts?: MotionPlayOpts,
  ): MotionFeedback | undefined;
  /** 主表是否正在播单次（非循环）动作（sprite 用；未实现的引擎视为否） */
  playingOneShot?(): boolean;
  /**
   * 命中区域检测（窗口内 CSS 坐标）：返回命中的 HitArea 区域名。
   * 仅 Live2D 实现该能力；sprite 返回 undefined。
   */
  hitAreas?(x: number, y: number): string[];
  /** 复位表情到默认（悬停表情离开时用）；无表情能力的引擎忽略 */
  resetExpression?(): void;
  /**
   * 切换服装（换装）：null = 模型默认。
   * Live2D 通过 manifest.outfits[].params 每帧注入参数实现（服装开关参数
   * 不被动作动画覆盖，但每帧重设最稳）；未实现的引擎忽略。
   */
  setOutfit?(outfit: PetpackOutfit | null): void;
  /** 朝向翻转：1 朝右 / -1 朝左（走动时用；锚点在底部中心，翻转不改变占位） */
  setFacing(dir: 1 | -1): void;
  /** 眼神跟随（可选能力，仅 Live2D） */
  focus?(x: number, y: number): void;
  /** 眼神回正到默认朝向（光标静止超时后用；未实现的引擎忽略） */
  focusCenter?(): void;
  destroy(): void;
}

/** 等比缩放：内容适配到目标区域 */
export function fitScale(contentW: number, contentH: number, w: number, h: number): number {
  return Math.min(w / contentW, h / contentH);
}

/**
 * 清单级整体显示缩放（displayScale）：皮肤画布内容相对参考框（360×480）偏大时，
 * 皮肤作者用 <1 的系数整体调小。非法值回退 1（校验层会拦，这里兜底防 NaN 尺寸）。
 */
export function engineDisplayScale(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 4 ? v : 1;
}

/**
 * 眼神跟随的线性归一化（纯函数，便于单测）：
 * 把模型原始空间内的点换算成 focusController 的 [-1,1] 目标值。
 * 半径统一用模型半高（各向同性，与 Cubism 官方示例一致）：
 * 近处按比例偏转、超过半径 clamp 满偏。
 * 不用库默认 focus() 的方位角归一化（atan2+cos/sin）：那会把距离信息丢掉，
 * 眼神永远接近满偏且只随方位角变 —— 桌宠场景鼠标常在远处，表现为
 * “从模型中心锁定方位”而不是视线跟随。
 */
export function normalizeFocus(
  localX: number,
  localY: number,
  w: number,
  h: number,
): { fx: number; fy: number } {
  if (w <= 0 || h <= 0) return { fx: 0, fy: 0 };
  const r = h / 2;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return {
    fx: clamp((localX - w / 2) / r),
    // pixi y 向下，眼神参数正值=向上看 → 取反
    fy: clamp(-(localY - h / 2) / r),
  };
}
