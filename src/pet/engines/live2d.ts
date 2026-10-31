import * as PIXI from 'pixi.js';
import { config, Live2DModel, MotionPreloadStrategy } from 'pixi-live2d-display/cubism4';
import type { PetpackAnimation, PetpackManifest, PetpackOutfit } from '../petpack';
import { resolveUrl } from '../petpack';
import { isPlayableIndex, motionFeedback, pickPlayableMotion, type MotionDef, type MotionFeedback } from '../motionText';
import { voiceBus } from '../voiceBus';
import type { SemanticAction } from '../types';
import { engineDisplayScale, fitScale, normalizeFocus, type MotionPlayOpts, type PetEngine } from './types';

// pixi-live2d-display 通过 window.PIXI 引用 Ticker/Texture 等，需在加载模型前挂载
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

/** Live2D（Cubism moc3）引擎适配器 */
export class Live2DEngine implements PetEngine {
  readonly root = new PIXI.Container();
  private model?: Live2DModel;
  private manifest?: PetpackManifest;
  private facing: 1 | -1 = 1;
  /** 清单 displayScale：画布内容偏大的皮肤整体调小（进 naturalSize，layout 随窗口自适应） */
  private displayScale = 1;
  /** 最近一次播放的「组名:索引」，随机选条时避免连续重复 */
  private lastKey = '';
  private lastIdxInGroup = -1;
  /** 当前换装参数（null = 默认装）；每帧渲染前注入核心模型 */
  private outfitParams: Record<string, number> | null = null;
  /** 模型全部参数的默认值快照（load 时取）：退出服装时显式回填用 */
  private paramDefaults: Record<string, number> = {};

  async load(baseUrl: string, manifest: PetpackManifest): Promise<void> {
    this.manifest = manifest;
    this.displayScale = engineDisplayScale(manifest.displayScale);
    // 动作自带语音常态静默（库的总闸 config.sound）：模型加载初次的自动 idle、
    // 之后的库自动回 idle、走动/待机轮换全部无声；playBinding 内按播放意图
    // 同步放行。不关的话 idle 组带 Sound 的模型会在闲聊关闭时凭空出声。
    config.sound = false;
    const url = resolveUrl(manifest.entry!, baseUrl);
    this.model = await Live2DModel.from(url, {
      autoInteract: false, // 交互由 PointerManager + 状态机驱动
      autoUpdate: true, // 挂到 PIXI.Ticker.shared 自动更新
      // 显式锁定"只预载 idle 组"语义，防库升级把默认值改成别的
      motionPreload: MotionPreloadStrategy.IDLE,
    });
    this.root.addChild(this.model);
    // 换装参数每帧注入：服装开关参数不被动作/物理动画，但 Cubism 每帧
    // update 会把参数复位到上一帧存档，挂 beforeModelUpdate 重设最稳
    this.model.internalModel.on('beforeModelUpdate', this.applyOutfitParams);
    // 快照参数默认值（供退出服装时回填）：moc 内部的 ids/defaultValues 表
    const core = (
      this.model.internalModel as unknown as {
        coreModel: {
          _model?: { parameters?: { ids?: string[]; defaultValues?: number[] } };
        };
      }
    ).coreModel;
    const ids = core._model?.parameters?.ids;
    const defs = core._model?.parameters?.defaultValues;
    if (ids && defs) {
      for (let i = 0; i < Math.min(ids.length, defs.length); i++) {
        this.paramDefaults[ids[i]!] = defs[i]!;
      }
    }
  }

  layout(width: number, height: number): void {
    const model = this.model;
    if (!model) return;
    const ow = model.internalModel.originalWidth;
    const oh = model.internalModel.originalHeight;
    const s = fitScale(ow, oh, width, height);
    model.scale.set(s * this.facing, s);
    model.anchor.set(0.5, 1);
    model.position.set(width / 2, height);
  }

  setFacing(dir: 1 | -1): void {
    this.facing = dir;
    if (this.model) this.model.scale.x = Math.abs(this.model.scale.x) * dir;
  }

  naturalSize(refW: number, refH: number): { w: number; h: number } {
    const model = this.model;
    if (!model) return { w: refW, h: refH };
    // displayScale 只进这里：窗口尺寸由 natural 推导，layout 的 fitScale
    // 会对着缩小后的窗口重新适配，系数天然只生效一次
    const s =
      fitScale(model.internalModel.originalWidth, model.internalModel.originalHeight, refW, refH) *
      this.displayScale;
    return {
      w: model.internalModel.originalWidth * s,
      h: model.internalModel.originalHeight * s,
    };
  }

  play(action: SemanticAction, opts?: MotionPlayOpts): MotionFeedback | undefined {
    const manifest = this.manifest;
    const model = this.model;
    if (!manifest || !model) return undefined;
    const binding = manifest.animations[action] ?? manifest.animations.idle;
    if (!binding) return undefined;
    // 仅表情的绑定（如 hover）：切表情不播动作
    if (!binding.motion) {
      if (binding.expression) model.expression(binding.expression);
      return undefined;
    }
    return this.playBinding(binding, action, opts);
  }

  /**
   * 播放一条显式绑定（语义动作回退链或命中区域反应）。
   * 自己选随机条目而不是交给库：解包模型的动作条目自带 Text/Sound/TextDuration，
   * 选定后语音仍由库按同一索引自动播放，合词气泡才能和语音严格对应。
   */
  playBinding(
    binding: PetpackAnimation,
    action?: SemanticAction,
    opts?: MotionPlayOpts,
  ): MotionFeedback | undefined {
    const model = this.model;
    if (!model || !binding.motion) return undefined;
    const group = binding.motion;
    // settings.motions 由库以 mixin 方式在运行时合并（类型上没有），这里显式收窄
    const settings = model.internalModel.settings as unknown as {
      motions?: Record<string, MotionDef[]>;
    };
    const defs = settings.motions?.[group] ?? [];
    // 指定索引：直接用（不可播放时回退随机）；未指定：组内随机且不与上次重复
    const lastIdx = this.lastKey === group ? this.lastIdxInGroup : undefined;
    const picked =
      typeof binding.index === 'number' && isPlayableIndex(defs, binding.index)
        ? { index: binding.index, def: defs[binding.index]! }
        : pickPlayableMotion(defs, lastIdx, binding.weights);
    if (!picked) return undefined; // 整组都无 File（空组/纯语音组）：不播放
    this.lastKey = group;
    this.lastIdxInGroup = picked.index;
    // 新动作语音开始前清场：停掉本窗口所有还在播/还在加载的声音（单语音互斥）。
    // 库自己的 startMotion 只停它记录的 currentAudio，审计不到的音频（加载中/
    // 点击音效）会叠着响，这里统一拦截
    voiceBus.stopAll();
    // 动作自带语音的精确闸门：库的 startMotion 在首个 await 之前同步创建音频，
    // 所以在同步窗口内开关 config.sound 即可放行/拦截，零时序竞态。
    // 常态关闭（见 load）：仅闲聊与点击/拖拽/摸头等显式 sound:true 的播放出声
    config.sound = opts?.sound === true;
    try {
      // priority 3 = FORCE，可打断当前动作
      model.motion(group, picked.index, 3);
    } finally {
      config.sound = false;
    }
    if (binding.expression) model.expression(binding.expression);
    // 命中区域反应的反馈按 click 语义走气泡/音效联动
    return motionFeedback(action ?? 'click', group, picked);
  }

  /** 命中区域检测：坐标为窗口内 CSS 坐标（库内部 toModelPosition 转模型空间） */
  hitAreas(x: number, y: number): string[] {
    return this.model ? this.model.hitTest(x, y) : [];
  }

  private applyOutfitParams = (): void => {
    if (!this.outfitParams || !this.model) return;
    const core = (
      this.model.internalModel as unknown as {
        coreModel: {
          setParameterValueById(id: string, value: number): void;
        };
      }
    ).coreModel;
    for (const [id, value] of Object.entries(this.outfitParams)) {
      core.setParameterValueById(id, value);
    }
  };

  /**
   * 切换服装（换装）：null 回模型默认。
   * 关键：换装/退出时，把上一次服装注入过的参数**显式回填默认值**并继续每帧注入——
   * 不能依赖库的参数复位把旧值"洗掉"（动作系统的内部存档会在动作切换时
   * 把当时还在生效的服装参数存回去，导致旧服装残留、切不回默认）。
   */
  setOutfit(outfit: PetpackOutfit | null): void {
    const params = outfit?.params;
    const next: Record<string, number> =
      params && Object.keys(params).length > 0 ? { ...params } : {};
    // 旧服装的参数若不再由新服装接管，钉在默认值上持续注入
    for (const id of Object.keys(this.outfitParams ?? {})) {
      if (!(id in next)) next[id] = this.paramDefaults[id] ?? 0;
    }
    this.outfitParams = Object.keys(next).length > 0 ? next : null;
    // 立即生效一次（渲染循环下一帧也会持续注入）
    this.applyOutfitParams();
  }

  /** 复位表情到默认（悬停表情离开时用） */
  resetExpression(): void {
    const em = (
      this.model?.internalModel as unknown as {
        motionManager?: { expressionManager?: { resetExpression?: () => void } };
      }
    )?.motionManager?.expressionManager;
    em?.resetExpression?.();
  }

  focus(x: number, y: number): void {
    const model = this.model;
    const im = model?.internalModel;
    if (!model || !im) return;
    // 全局（窗口 CSS）坐标 → 模型原始空间坐标；
    // root 偏移、缩放、朝向镜像全部由 toModelPosition 的逆变换自动处理
    const local = model.toModelPosition(new PIXI.Point(x, y));
    const { fx, fy } = normalizeFocus(
      local.x,
      local.y,
      im.originalWidth,
      im.originalHeight,
    );
    im.focusController.focus(fx, fy);
  }

  /** 眼神回正到默认朝向（光标静止超时后用；focusController 内部自行缓动） */
  focusCenter(): void {
    const im = this.model?.internalModel;
    if (!im) return;
    im.focusController.focus(0, 0);
  }

  destroy(): void {
    this.model?.internalModel?.off?.('beforeModelUpdate', this.applyOutfitParams);
    this.model?.destroy();
    this.root.destroy({ children: true });
  }
}
