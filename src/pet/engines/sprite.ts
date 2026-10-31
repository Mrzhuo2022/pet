import * as PIXI from 'pixi.js';
import type { PetpackManifest, PetpackAnimation } from '../petpack';
import { resolveUrl } from '../petpack';
import type { MotionFeedback } from '../motionText';
import type { SemanticAction } from '../types';
import { engineDisplayScale, fitScale, type MotionPlayOpts, type PetEngine } from './types';

interface PartRuntime {
  sprite: PIXI.AnimatedSprite;
  textures: PIXI.Texture[];
}

/**
 * 精灵图引擎：sheet.png 网格切帧，语义动作映射到帧序列。
 * 支持可选的 sprite.parts 分层：部件复用主表的动作帧号，各层同步播放；
 * 部件帧可独立裁切（offsetX/Y 为部件左上角在主帧里的位置），拼回主帧坐标系。
 * 循环动画重复调用不重启；单次动画（loop:false）播完回到 back（默认 idle）。
 */
export class SpriteEngine implements PetEngine {
  readonly root = new PIXI.Container();
  private content = new PIXI.Container();
  private base?: PIXI.AnimatedSprite;
  private baseTextures: PIXI.Texture[] = [];
  private parts: PartRuntime[] = [];
  private manifest?: PetpackManifest;
  private frameW = 0;
  private frameH = 0;
  /** 清单 displayScale：画布内容偏大的皮肤整体调小（进 naturalSize，layout 随窗口自适应） */
  private displayScale = 1;
  private currentKey = '';
  private facing: 1 | -1 = 1;
  private scale = 1;
  /** 主表正在播单次（非循环）动作：松手回 idle 时行为层据此不立刻重播截断它 */
  private oneShot = false;

  async load(baseUrl: string, manifest: PetpackManifest): Promise<void> {
    this.manifest = manifest;
    this.displayScale = engineDisplayScale(manifest.displayScale);
    const sp = manifest.sprite;
    if (!sp) throw new Error('sprite 引擎缺少 sprite 元数据');

    const sheet = await PIXI.Assets.load<PIXI.Texture>(resolveUrl(sp.sheet, baseUrl));
    let max = 0;
    for (const anim of Object.values(manifest.animations)) {
      anim?.frames?.forEach((f) => (max = Math.max(max, f)));
    }

    this.frameW = sp.frameW;
    this.frameH = sp.frameH;
    this.baseTextures = this.slice(sheet, sp.frameW, sp.frameH, sp.cols, max);
    this.base = new PIXI.AnimatedSprite([this.baseTextures[0]!]);
    this.base.anchor.set(0.5, 1);
    this.base.position.set(0, 0);
    this.content.addChild(this.base);

    for (const part of sp.parts ?? []) {
      const partSheet = await PIXI.Assets.load<PIXI.Texture>(resolveUrl(part.sheet, baseUrl));
      const textures = this.slice(partSheet, part.frameW, part.frameH, part.cols, max);
      const sprite = new PIXI.AnimatedSprite([textures[0]!]);
      sprite.anchor.set(0, 0);
      // content 原点 = 主帧底边中心；部件坐标换算到主帧左上角
      sprite.position.set(part.offsetX - sp.frameW / 2, part.offsetY - sp.frameH);
      this.content.addChild(sprite);
      this.parts.push({ sprite, textures });
    }

    this.root.addChild(this.content);
  }

  private slice(
    sheet: PIXI.Texture,
    frameW: number,
    frameH: number,
    cols: number,
    max: number,
  ): PIXI.Texture[] {
    const textures: PIXI.Texture[] = [];
    // 帧数按 sheet 实际容纳的网格数封顶：清单帧号越界（坏配置）时不生成
    // 越界纹理，缺帧由 apply 的 textures[i] ?? textures[0] 兜底
    const rows = Math.max(1, Math.floor(sheet.height / frameH));
    const count = Math.min(max + 1, cols * rows);
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      textures.push(
        new PIXI.Texture(sheet.baseTexture, new PIXI.Rectangle(col * frameW, row * frameH, frameW, frameH)),
      );
    }
    return textures;
  }

  layout(width: number, height: number): void {
    if (!this.base) return;
    const s = fitScale(this.frameW, this.frameH, width, height);
    this.scale = s;
    this.content.position.set(width / 2, height);
    this.content.scale.set(s * this.facing, s);
  }

  setFacing(dir: 1 | -1): void {
    this.facing = dir;
    this.content.scale.x = this.scale * dir;
  }

  /**
   * 自然尺寸：主帧画布在参考窗口下的显示尺寸（确定性几何计算）。
   * 部件都在主帧坐标范围内，不影响占位。
   * displayScale 只进这里：窗口尺寸由 natural 推导，layout 的 fitScale
   * 会对着缩小后的窗口重新适配，系数天然只生效一次。
   */
  naturalSize(refW: number, refH: number): { w: number; h: number } {
    const s = fitScale(this.frameW, this.frameH, refW, refH) * this.displayScale;
    return { w: this.frameW * s, h: this.frameH * s };
  }

  play(action: SemanticAction, _opts?: MotionPlayOpts): MotionFeedback | undefined {
    const manifest = this.manifest;
    const base = this.base;
    if (!base || !manifest) return undefined;
    const mapped = manifest.animations[action];
    const anim: PetpackAnimation | undefined = mapped ?? manifest.animations.idle;
    if (!anim?.frames?.length) return undefined;
    const key = mapped ? action : 'idle';

    // 循环动画已在播时重复调用不重启（idle 轮换等场景）
    if (key === this.currentKey && anim.loop !== false) return;
    this.currentKey = key;

    this.apply(base, this.baseTextures, anim, true);
    for (const part of this.parts) this.apply(part.sprite, part.textures, anim, false);
  }

  /** 播放一条显式绑定（时段问候等）：帧序列直接套用，不做去重 */
  playBinding(
    binding: PetpackAnimation,
    _action?: SemanticAction,
    _opts?: MotionPlayOpts,
  ): MotionFeedback | undefined {
    const base = this.base;
    if (!base || !binding.frames?.length) return undefined;
    this.currentKey = '';
    this.apply(base, this.baseTextures, binding, true);
    for (const part of this.parts) this.apply(part.sprite, part.textures, binding, false);
    // sprite 没有 motionText，反馈仅作占位（气泡走 clickTexts 回退）
    return { action: 'idle', group: 'frames', index: binding.frames[0] ?? 0 };
  }

  private apply(
    sprite: PIXI.AnimatedSprite,
    textures: PIXI.Texture[],
    anim: PetpackAnimation,
    isBase: boolean,
  ): void {
    sprite.textures = anim.frames!.map((i) => textures[i] ?? textures[0]!);
    sprite.animationSpeed = (anim.fps ?? 4) / 60;
    sprite.loop = anim.loop !== false;
    sprite.onComplete =
      isBase && !sprite.loop
        ? () => {
            this.play(anim.back ?? 'idle');
          }
        : undefined;
    if (isBase) this.oneShot = !sprite.loop;
    sprite.gotoAndPlay(0);
  }

  /** 主表是否正在播单次（非循环）动作（播完经 back 自动回 idle） */
  playingOneShot(): boolean {
    return this.oneShot;
  }

  destroy(): void {
    // sheet 基础纹理在 pixi 缓存中共享，不销毁，仅清理切帧纹理与精灵
    for (const part of this.parts) {
      for (const t of part.textures) t.destroy();
      part.sprite.destroy();
    }
    this.parts = [];
    for (const t of this.baseTextures) t.destroy();
    this.baseTextures = [];
    this.base?.destroy();
    this.content.destroy({ children: true });
    this.root.destroy({ children: true });
  }
}
