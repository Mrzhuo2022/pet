<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { availableMonitors, currentMonitor, getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { PetStage, PAD_X, PAD_BOTTOM } from './pet/PetStage';
import { SoundManager } from 'pixi-live2d-display/cubism4';
import type { MotionFeedback } from './pet/motionText';
import { PointerManager } from './pet/pointer';
import { FlingController } from './pet/fling';
import { FollowController } from './pet/follow';
import { voiceBus } from './pet/voiceBus';
import { PetStateMachine } from './pet/stateMachine';
import { WanderController } from './pet/wander';
import { groundY } from './pet/ground';
import { loadPackList, loadSettings, resolveUrl, timeSlot, type PetInfo, type PetpackAnimation } from './pet/petpack';
import {
  isVisibleOnWorkAreas,
  recoverWindowPosition,
  type ScreenRect,
} from './pet/windowGeometry';

const win = getCurrentWindow();
const petId = win.label;
const error = ref('');
const el = ref<HTMLDivElement | null>(null);
const stage = new PetStage();
const machine = new PetStateMachine();
const pointer = new PointerManager(stage);
let wander: WanderController | null = null;
let pressed = false;
let moved = false;
let downX = 0;
let downY = 0;
let lockPosition = false;
let roamEnabled = true;
let soundEnabled = true;
let bubbleEnabled = true;
let flingEnabled = true;
let gazeEnabled = true;
let followEnabled = false;
let groundEnabled = true;
/** 当前服装：0 = 模型默认，i = manifest.outfits[i-1]（右键菜单换装） */
let outfitIndex = 0;
let walkSpeedCss = 55;
let volume = 0.6;
let bubbleMs = 2600;
// ---------- 全局手感参数（global-prefs-changed 热更新） ----------
/** 抛掷重力（物理 px/s²），任务栏模式落地手感 */
let gravity = 3000;
/** 反弹恢复系数：撞墙/落地弹跳强度 */
let bounceRestitution = 0.45;
/** 触发抛掷的最低松手速度（物理 px/s） */
let flingMinSpeed = 220;
/** 待机闲聊最短间隔（秒，实际随机到 ~2.75 倍） */
let ambientIntervalSec = 40;
let scaleSetting = 1;
let renderVisible = true;
let activityBusy = false;
let activityTimer: number | null = null;
/** 服装自愈同步定时器：事件偶发丢失时 2s 内自动补上 */
let outfitSyncTimer: number | null = null;
/** 无边框窗口装饰回归的自愈定时器（比活动节拍更快，压短边框闪现时长） */
let frameHealTimer: number | null = null;
let unlisteners: UnlistenFn[] = [];
/** 本次按下/拖拽所播动作的反馈（台词与语音同条），松开时用于气泡联动 */
let clickFb: MotionFeedback | null = null;
let dragFb: MotionFeedback | null = null;
// ---------- 双击摸头 / 长按亲昵 ----------
const DOUBLE_TAP_MS = 350;
const LONG_PRESS_MS = 800;
/** 最近一次"点一下没拖"的松手时刻（双击判定基准） */
let lastTapAt = 0;
let longPressTimer: number | null = null;
// ---------- 跟随鼠标（空闲时慢慢走向光标） ----------
const FOLLOW_DEADZONE_CSS = 56;
/** 抛掷自然停下后跟随的冷却：立刻走回去会让"甩出去"形同虚设，且来回拉扯闪烁 */
const FOLLOW_FLING_COOLDOWN_MS = 4_000;
let follow: FollowController | null = null;
/** 跟随最近一次落位（去重冗余 setPosition 用） */
let followLastX = Number.NaN;
let followLastY = Number.NaN;
/** 抛掷落地后跟随的冷却截止时刻（用户主动交互立即解除） */
let followCooldownUntil = 0;
/** 松手收尾进行中（取状态→抛掷/落地的窗口）：期间跟随让位，避免抢跑拉扯 */
let releaseBusy = false;
/** 抛掷落地/贴地停稳后待显示的台词（松手时只出声效，停在最终位置再出气泡） */
let pendingQuote: MotionFeedback | null = null;
const fling = new FlingController(
  (x, y) => void win.setPosition(new PhysicalPosition(x, y)),
  () => {
    follow?.invalidateFrame();
    // 落地后跟随冷却一会：立刻走回去会让"甩出去"形同虚设；用户一点击即解除
    followCooldownUntil = performance.now() + FOLLOW_FLING_COOLDOWN_MS;
    stage.suppressHitToggle = false;
    void (async () => {
      if (groundEnabled) await settleGround();
      else void saveWindowState();
      // 兜底：没触过地（无重力滑行中途未撞下边界）时，停在终点再显示台词
      if (pendingQuote) {
        const quote = pendingQuote;
        pendingQuote = null;
        showFeedbackBubble(quote);
      }
    })();
  },
  () => {
    // 任务栏模式重力抛掷的第一次触地弹跳：台词就在落点出现（不等到完全停稳）
    if (!groundEnabled || !pendingQuote) return;
    const quote = pendingQuote;
    pendingQuote = null;
    showFeedbackBubble(quote);
  },
);

/** 外部停止滑行（抓取/锁定/重置/隐藏）：待显示的落地台词一并作废 */
function stopFling(): void {
  fling.stop();
  stage.suppressHitToggle = false;
  pendingQuote = null;
}
/** 待机闲聊：空闲时每隔一阵随机播一条动作+语音+气泡 */
let ambientEnabled = true;
let ambientTimer: number | null = null;
// ---------- 休眠（深度待机 2 分钟后播 sleep 绑定，任何交互唤醒） ----------
let sleeping = false;
let sleepCheckTimer: number | null = null;
// ---------- 悬停表情（指针停留 > 2s 应用 hover 绑定，离开恢复） ----------
let hoverSince = 0;
let hoverApplied = false;
const HOVER_MS = 2_000;
/** 其他窗口（另一只桌宠/编辑器）最近发声的截止时刻：闲聊避让用 */
let foreignVoiceUntil = 0;
const FOREIGN_VOICE_HOLD_MS = 10_000;

/** 广播「本窗口开始了一条语音」：user=true（点击/拖拽）会让其他窗口让路并停声 */
function announceVoice(user: boolean): void {
  void emit('voice-start', { from: petId, user });
}

/** Live2D 动作语音由库的 SoundManager 出声：同步到设置（全局音量 + 本桌宠音效开关） */
function applySoundVolume(): void {
  SoundManager.volume = soundEnabled ? volume : 0;
}

const BUBBLE_W = 320;
const BUBBLE_H = 120;
let bubbleVisible = false;
/** showBubble 在途或已显示：hideBubble 据此取消尚未完成的显示（竞态防护） */
let bubbleShowing = false;
/** 递增代数：显示在途时又发生 hide/新 show，旧一次的后半段发现代数不符即放弃 */
let bubbleShowGen = 0;
let bubbleReady = false;
let lastBubbleText: string | null = null;
let lastBubbleStyle: { theme?: string; accent?: string } = {};
let pendingBubble: string | null = null;
let bubbleTimer: number | null = null;

/** 气泡样式来自当前皮肤包（manifest.bubble），随文本一起发给气泡窗口 */
function bubbleStyle(): { theme?: string; accent?: string } {
  const b = stage.packContext?.manifest.bubble;
  if (!b) return {};
  return { theme: b.theme, accent: b.accent };
}

function sendBubbleText(text: string): void {
  lastBubbleText = text;
  lastBubbleStyle = bubbleStyle();
  void emit('bubble-text', { text, ...lastBubbleStyle });
}

function hideBubble(): void {
  if (bubbleTimer !== null) {
    window.clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
  if (!bubbleShowing) return;
  bubbleShowing = false;
  bubbleVisible = false;
  bubbleShowGen++; // 作废在途的 showBubble：其后半段发现代数不符即放弃
  void invoke('hide_bubble', { owner: petId }).catch(() => {});
}

/** 气泡锚点：桌宠头顶上方居中（物理 px） */
async function bubbleAnchorPos(): Promise<{ x: number; y: number }> {
  const [sf, outer, size] = await Promise.all([
    win.scaleFactor(),
    win.outerPosition(),
    win.outerSize(),
  ]);
  const contentTop = stage.visibleTop() ?? 0;
  const bw = Math.round(BUBBLE_W * sf);
  const bh = Math.round(BUBBLE_H * sf);
  return {
    x: outer.x + Math.round((size.width - bw) / 2),
    y: Math.max(0, outer.y + Math.round(contentTop * sf) - bh - Math.round(8 * sf)),
  };
}

async function showBubble(text: string, durationMs?: number): Promise<void> {
  const gen = ++bubbleShowGen;
  bubbleShowing = true;
  try {
    const pos = await bubbleAnchorPos();
    if (gen !== bubbleShowGen) return;
    // 先广播文本再显示窗口：气泡窗口常驻、监听器早已就绪，显示出来时就是新文案；
    // 若先显窗后发文本，上一条气泡的旧文案会闪现一瞬
    sendBubbleText(text);
    if (!bubbleReady) pendingBubble = text;
    await invoke('show_bubble', { x: pos.x, y: pos.y, owner: petId });
    if (gen !== bubbleShowGen) {
      // 显示期间被 hide/新 show 取代：仅当没有更新的一次在途或可见时才补一手隐藏，
      // 否则会误杀新气泡
      if (!bubbleShowing && !bubbleVisible) {
        void invoke('hide_bubble', { owner: petId }).catch(() => {});
      }
      return;
    }
    bubbleVisible = true;
    if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
    // 模型自带 TextDuration 时优先用它的时长（与语音同步），否则用全局设置
    const ms = Math.min(10_000, Math.max(800, Math.round(durationMs ?? bubbleMs)));
    bubbleTimer = window.setTimeout(() => {
      bubbleTimer = null;
      hideBubble();
    }, ms);
  } catch {
    // Bubble failure must not interrupt pet interaction.
    if (gen === bubbleShowGen) bubbleShowing = false;
  }
}

/**
 * 动作反馈拆成两半：
 * - 音效半边：无动作语音时回退 clickSounds 随机（ambient 不播）；
 * - 台词半边（气泡）：松手后桌宠还会移动（落地/滑行）时延迟到停稳再调，
 *   让台词出现在最终位置而不是松手点（跟随式气泡在 WebView2 上会闪）。
 */
function playFeedbackSound(fb: MotionFeedback | null | undefined, ambient = false): void {
  const ctx = stage.packContext;
  const inter = ctx?.manifest.interactions;
  if (ambient || !soundEnabled || fb?.sound || !inter?.clickSounds?.length) return;
  const pick = inter.clickSounds[Math.floor(Math.random() * inter.clickSounds.length)]!;
  voiceBus.play(resolveUrl(pick, ctx!.baseUrl), volume);
  announceVoice(true);
}

function showFeedbackBubble(fb: MotionFeedback | null | undefined): void {
  const inter = stage.packContext?.manifest.interactions;
  const motionTextOn = inter?.motionText !== false;
  if (!bubbleEnabled) return;
  let text: string | undefined;
  let dur: number | undefined;
  if (fb?.text && motionTextOn) {
    text = fb.text;
    dur = fb.durationMs;
  } else if (inter?.clickTexts?.length) {
    text = inter.clickTexts[Math.floor(Math.random() * inter.clickTexts.length)]!;
  }
  if (text) void showBubble(text, dur);
}

function playMotionFeedback(fb: MotionFeedback | null | undefined, ambient = false): void {
  playFeedbackSound(fb, ambient);
  showFeedbackBubble(fb);
}

/** 绑定是否可用：sprite 看帧序列；live2d 有动作组或仅表情（hover 用）都算 */
function bindingUsable(b: PetpackAnimation | undefined): boolean {
  if (!b) return false;
  return stage.packContext?.manifest.engine === 'sprite'
    ? !!b.frames?.length
    : !!b.motion || !!b.expression;
}

/**
 * 休眠检查（2s 一次）：深度待机且皮肤配了 sleep 绑定 → 播入睡动作，
 * 气泡收起、眼神跟随暂停、闲聊顺延；计时被任何交互刷新后自动唤醒。
 */
function checkSleep(): void {
  if (sleeping) {
    if (!stage.deepIdle) wake();
    return;
  }
  if (!bindingUsable(stage.packContext?.manifest.animations.sleep)) return;
  if (stage.ready && !document.hidden && renderVisible && stage.deepIdle) {
    sleeping = true;
    stage.sleeping = true;
    hideBubble();
    stage.play('sleep');
  }
}

function wake(): void {
  if (!sleeping) return;
  sleeping = false;
  stage.sleeping = false;
  stage.play('idle');
}

/** 悬停表情节拍（1s 一次）：停留超 2s 应用 hover 绑定，离开恢复默认表情/待机 */
function hoverTick(): void {
  if (!stage.ready || sleeping) return;
  if (pressed || pointer.dragging) {
    hoverSince = 0;
    if (hoverApplied) removeHover();
    return;
  }
  if (stage.hovered) {
    if (hoverSince === 0) {
      hoverSince = performance.now();
    } else if (!hoverApplied && performance.now() - hoverSince > HOVER_MS) {
      if (bindingUsable(stage.packContext?.manifest.animations.hover)) {
        hoverApplied = true;
        stage.play('hover');
      } else {
        // 无绑定不再重试，直到指针离开再进入
        hoverSince = performance.now();
      }
    }
  } else {
    if (hoverApplied) removeHover();
    hoverSince = 0;
  }
}

function removeHover(): void {
  if (!hoverApplied) return;
  hoverApplied = false;
  stage.resetExpression();
  // 精灵引擎的 hover 帧是循环序列，必须显式播回 idle
  if (stage.packContext?.manifest.engine === 'sprite') stage.play('idle');
}

/**
 * 待机闲聊：空闲且可见时隔 40–110s 随机播一条 idle 绑定的动作。
 * 语音随动作出声（音量已同步设置），台词走气泡；悬停/拖拽/走动时顺延。
 * 有时段问候（timeGreetings）时优先播当前时段的条目。
 */
function scheduleAmbient(): void {
  if (ambientTimer !== null) {
    window.clearTimeout(ambientTimer);
    ambientTimer = null;
  }
  if (!ambientEnabled) return;
  const delay = ambientIntervalSec * 1000 * (1 + Math.random() * 1.75);
  ambientTimer = window.setTimeout(() => {
    ambientTimer = null;
    const busy =
      !renderVisible ||
      document.hidden ||
      sleeping ||
      stage.hovered ||
      machine.state !== 'idle' ||
      !stage.ready ||
      voiceBus.busy || // 本窗口还有语音在播：不打断，顺延下一轮
      performance.now() < foreignVoiceUntil; // 别的窗口刚说过话：稍等再聊
    if (!busy) {
      const greet = stage.packContext?.manifest.timeGreetings?.[timeSlot(new Date().getHours())];
      const fb =
        (greet?.motion ? stage.playBinding(greet, undefined, { sound: true }) : undefined) ??
        stage.play('idle', { sound: true });
      if (fb?.sound) announceVoice(false);
      if (fb?.text || stage.packContext?.manifest.interactions?.clickTexts?.length) {
        playMotionFeedback(fb, true);
      }
    }
    scheduleAmbient();
  }, delay);
}

async function reloadPack(preferredId?: string): Promise<void> {
  // 皮肤/轮廓变了：地面补偿缓存作废（立刻 + 稍后 alpha 缓存重刷新后再作废一次）
  invalidateGroundGap();
  const packs = await loadPackList().catch(() => []);
  if (!packs.length) {
    error.value = '没有可用的皮肤包';
    return;
  }
  const target = packs.find((p) => p.id === preferredId) ?? packs[0];
  try {
    await stage.loadPack(target);
    error.value = '';
  } catch (e) {
    // 皮肤损坏降级：换上列表里的其他包（内置包兜底），不让桌宠变成空白窗
    const fallback = packs.find((p) => p.id !== target.id);
    if (!fallback) {
      error.value = `皮肤加载失败：${e}`;
      return;
    }
    try {
      await stage.loadPack(fallback);
      error.value = `「${target.name}」加载失败，已临时使用「${fallback.name}」`;
    } catch (e2) {
      error.value = `皮肤加载失败：${e2}`;
    }
  }
  stage.setOutfit(outfitIndex);
  invalidateGroundGap();
}

async function applyScale(next: number): Promise<void> {
  const s = Math.min(3, Math.max(0.2, next));
  scaleSetting = s;
  const { w, h } = stage.natural;
  await win.setSize(new LogicalSize(Math.round(w * s + PAD_X * 2), Math.round(h * s + PAD_BOTTOM)));
  // 窗口尺寸变了：地面补偿作废（画布经 ResizeObserver 异步重排，稍后再作废一次）
  invalidateGroundGap();
  window.setTimeout(invalidateGroundGap, 600);
  // 窗口/DPI 可能变化：跟随的运动参数按新 scale 重算
  void syncFollowMotion();
}

async function saveWindowState(): Promise<void> {
  try {
    const o = await win.outerPosition();
    await invoke('save_pet_state', { id: petId, x: o.x, y: o.y, scale: scaleSetting });
  } catch {
    // The settings file may be unavailable while closing.
  }
}

async function monitorWorkAreas(): Promise<ScreenRect[]> {
  // 显示器拓扑几乎不变：5s 内复用缓存，省掉每秒两次枚举显示器的 IPC
  const now = performance.now();
  if (areasCache && now - areasCache.at < AREAS_TTL_MS) return areasCache.areas;
  const [primary, monitors] = await Promise.all([primaryMonitor(), availableMonitors()]);
  const areas = [primary, ...monitors].filter((m) => m !== null).map((m) => ({
    x: m.workArea.position.x,
    y: m.workArea.position.y,
    width: m.workArea.size.width,
    height: m.workArea.size.height,
  }));
  areasCache = { at: now, areas };
  return areas;
}

/** 工作区缓存（显示器热插拔最多 5s 后感知） */
let areasCache: { at: number; areas: ScreenRect[] } | null = null;
const AREAS_TTL_MS = 5000;

async function restoreWindowPosition(pet: PetInfo): Promise<void> {
  const areas = await monitorWorkAreas();
  const size = await win.outerSize();
  const fallback = areas[0];
  const x = pet.x ?? (fallback ? fallback.x + fallback.width - size.width - 32 : 120);
  const y = pet.y ?? (fallback ? fallback.y + fallback.height - size.height - 32 : 120);
  const recovered = recoverWindowPosition(x, y, size.width, size.height, areas);
  await win.setPosition(new PhysicalPosition(recovered.x, recovered.y)).catch(() => {});
  if (recovered.changed || pet.x == null || pet.y == null) await saveWindowState();
  // 任务栏模式：启动即贴地（记忆的 y 可能悬空）
  await settleGround();
}

/**
 * 地面线的"脚底补偿"（逻辑 px）缓存：alpha 缓存随呼吸/待机动画每 400ms 刷新，
 * 可见底行会 ±1 档（4 逻辑 px）跳动。若落点与跟随各算各的线，桌宠会在几像素间
 * 来回拉扯（持续抖动/闪烁）。因此补偿只在皮肤/缩放变化时重算
 * （invalidateGroundGap），其余时刻全部复用同一条地面线。
 */
let groundGapLogical: number | null = null;

function invalidateGroundGap(): void {
  groundGapLogical = null;
}

/**
 * 任务栏模式的地面线（窗口左上角 y，物理 px）：workArea 底边即任务栏上沿，
 * 可见脚底（alpha 扫描；模型画布常自带脚下留白，固定内边距会悬空）踩在线上。
 * alpha 缓存暂不可用时退回底部内边距，等缓存就绪后由失效机制重取。
 */
function groundLineY(areaY: number, areaH: number, winH: number, sf: number): number {
  if (groundGapLogical === null) {
    const bottom = stage.visibleBottom();
    if (bottom != null) groundGapLogical = winH / sf - bottom;
  }
  const gap = groundGapLogical ?? PAD_BOTTOM;
  return groundY({ y: areaY, height: areaH }, winH) + Math.round(gap * sf);
}

/** 把窗口贴到地面线（x 不动）；返回是否真的移动了 */
async function applyGround(
  area: { position: { x: number; y: number }; size: { width: number; height: number } },
  winH: number,
  pos: { x: number; y: number },
  sf: number,
): Promise<boolean> {
  const gy = groundLineY(area.position.y, area.size.height, winH, sf);
  if (gy === pos.y) return false;
  // 台词气泡有跟随节拍，落地时会跟着桌宠走，不再吞台词
  follow?.invalidateFrame();
  await win.setPosition(new PhysicalPosition(pos.x, gy));
  return true;
}

/** 任务栏模式落地：取一次窗口状态贴地（幂等），移动了则保存位置 */
async function settleGround(): Promise<void> {
  if (!groundEnabled) return;
  try {
    const [monitor, size, pos, sf] = await Promise.all([
      currentMonitor(),
      win.outerSize(),
      win.outerPosition(),
      win.scaleFactor(),
    ]);
    if (!monitor) return;
    // 抛掷落在地面线上时 applyGround 不动窗口；落点无论如何都要持久化
    await applyGround(monitor.workArea, size.height, pos, sf);
    await saveWindowState();
  } catch {
    // 窗口状态暂时拿不到就不吸
  }
}

function updateWanderEnabled(): void {
  wander?.setEnabled(roamEnabled && renderVisible);
}

/** 跟随的运动参数换算成物理像素下发（启动/步速变化/DPI 变化时调用） */
async function syncFollowMotion(): Promise<void> {
  const sf = await win.scaleFactor().catch(() => 1);
  follow?.setMotion(walkSpeedCss * sf, FOLLOW_DEADZONE_CSS * sf);
}

async function syncRenderActivity(): Promise<void> {
  if (activityBusy) return;
  if (document.hidden) {
    renderVisible = false;
    stage.setPaused(true);
    updateWanderEnabled();
    return;
  }
  activityBusy = true;
  try {
    const [position, size, areas] = await Promise.all([
      win.outerPosition(),
      win.outerSize(),
      monitorWorkAreas(),
    ]);
    const visible = isVisibleOnWorkAreas(position.x, position.y, size.width, size.height, areas);
    if (visible !== renderVisible) {
      renderVisible = visible;
      stage.setPaused(!visible);
      updateWanderEnabled();
    }
  } catch {
    // Keep the previous activity state while the window is changing visibility.
  } finally {
    activityBusy = false;
  }
}

onMounted(async () => {
  if (!el.value) return;
  // 这两个监听必须在任何 await 之前注册：
  // - bubble-ready：气泡窗口启动时的 ready 重试只有 600ms×5，大模型（吉雅 121MB）
  //   加载数秒，等加载完再注册就永远收不到 → bubbleReady 恒 false → 文本发不出去
  // - voice-start：跨窗口语音互斥（用户点击优先，闲聊避让）
  unlisteners.push(
    await listen('bubble-ready', () => {
      bubbleReady = true;
      if (pendingBubble) {
        const text = pendingBubble;
        pendingBubble = null;
        sendBubbleText(text);
      } else if (bubbleVisible && lastBubbleText) {
        // 气泡窗口（重新）就绪后补发当前文本：覆盖文本早于监听器挂载的竞态
        sendBubbleText(lastBubbleText);
      }
    }),
    await listen<{ from: string; user: boolean }>('voice-start', (e) => {
      if (e.payload.from === petId) return;
      foreignVoiceUntil = performance.now() + FOREIGN_VOICE_HOLD_MS;
      if (e.payload.user) {
        // 别的窗口开始了用户触发的语音（点击/拖拽/编辑器试播）：本窗口让路
        voiceBus.stopAll();
        hideBubble();
      }
    }),
  );
  const settings = await loadSettings();
  volume = settings.volume;
  bubbleMs = settings.bubbleMs;
  gravity = settings.gravity;
  bounceRestitution = settings.bounceRestitution;
  flingMinSpeed = settings.flingMinSpeed;
  ambientIntervalSec = settings.ambientIntervalSec;
  const pet = settings.pets.find((p) => p.id === petId);
  if (!pet) {
    error.value = `桌宠配置不存在：${petId}`;
    await win.show();
    return;
  }
  lockPosition = pet.lockPosition;
  roamEnabled = pet.roamEnabled;
  soundEnabled = pet.soundEnabled;
  bubbleEnabled = pet.bubbleEnabled;
  ambientEnabled = pet.ambientEnabled;
  flingEnabled = pet.flingEnabled;
  gazeEnabled = pet.gazeEnabled;
  stage.gazeEnabled = gazeEnabled;
  followEnabled = pet.followEnabled;
  groundEnabled = pet.groundEnabled;
  outfitIndex = pet.outfitIndex ?? 0;
  walkSpeedCss = pet.walkSpeed;
  applySoundVolume();
  scheduleAmbient();

  await stage.init(el.value);
  machine.onChange((st, prev) => {
    stage.setAnimating(st !== 'idle');
    if (st === 'walk') {
      stage.play('walk');
      hideBubble();
    }
    if (st === 'idle') {
      // 精灵引擎的 click/drag 常是循环帧，必须重播 idle 才能退出；
      // 但正在播单次（非循环）动作时不重播：onComplete 会经 back 自动回 idle，
      // 立刻重播会把 pat/pop 这类一次性反应截断。Live2D 不重播：
      // 避免刚播的反应动作（及其语音）被立刻叠上一条新随机动件
      // ——有 Idle 组的模型动作播完后库会自行恢复待机循环
      const replayIdle =
        prev === 'walk' ||
        (prev !== 'idle' &&
          stage.packContext?.manifest.engine !== 'live2d' &&
          !stage.playingOneShot());
      if (replayIdle) stage.play('idle');
      if (prev === 'walk') void saveWindowState();
    }
  });
  await reloadPack(pet.petpack ?? undefined);
  stage.setOutfit(outfitIndex);
  await applyScale(pet.scale ?? 1);
  await restoreWindowPosition(pet);
  await win.setAlwaysOnTop(settings.alwaysOnTop).catch(() => {});
  await win.show();

  pointer.start();
  wander = new WanderController(machine, stage, win, {
    enabled: roamEnabled,
    locked: pet.lockPosition,
    freq: pet.walkFreq,
    speed: pet.walkSpeed,
  });
  // 跟随鼠标启用时压制随机走动（两者都驱动 walk 状态，会抢位置）
  if (followEnabled) wander.setSuppressed(true);
  wander.start();
  follow = new FollowController(
    {
      canRun: () =>
        followEnabled &&
        !lockPosition &&
        !pressed &&
        !fling.active &&
        !releaseBusy &&
        performance.now() >= followCooldownUntil &&
        renderVisible &&
        !document.hidden,
      getCursor: async () => {
        try {
          const c = await invoke<{ cursorX: number; cursorY: number }>('hit_context');
          return { x: c.cursorX, y: c.cursorY };
        } catch {
          return null;
        }
      },
      getFrame: async () => {
        try {
          const [monitor, size, pos, sf] = await Promise.all([
            currentMonitor(),
            win.outerSize(),
            win.outerPosition(),
            win.scaleFactor(),
          ]);
          if (!monitor) return null;
          const area = monitor.workArea;
          // 任务栏模式：y 方向范围压成一条地面线 → 跟随变成沿任务栏的纯水平走
          const groundTop = groundLineY(area.position.y, area.size.height, size.height, sf);
          return {
            minX: area.position.x,
            minY: groundEnabled ? groundTop : area.position.y,
            maxX: area.position.x + area.size.width - size.width,
            maxY: groundEnabled
              ? groundTop
              : area.position.y + area.size.height - size.height,
            x: pos.x,
            y: pos.y,
            w: size.width,
            h: size.height,
          };
        } catch {
          return null;
        }
      },
      apply: (x, y) => {
        // 步长不足 1px 时 Math.round 后坐标连续多帧相同：跳过冗余 setPosition
        //（同坐标高频 SetWindowPos 在 WebView2 上也可能触发重排）
        if (x === followLastX && y === followLastY) return;
        followLastX = x;
        followLastY = y;
        void win.setPosition(new PhysicalPosition(x, y));
      },
      onMoveStart: (dir) => {
        stage.setFacing(dir);
        if (machine.state !== 'walk') machine.set('walk');
      },
      onMoveStop: () => {
        if (machine.state === 'walk') machine.set('idle');
      },
      onCursorMoved: () => {
        if (sleeping) wake();
      },
    },
    { enabled: followEnabled, speed: walkSpeedCss },
  );
  follow.start();
  void syncFollowMotion();
  document.addEventListener('visibilitychange', syncRenderActivity);
  activityTimer = window.setInterval(() => {
    void syncRenderActivity();
    hoverTick();
  }, 1_000);
  // 无边框窗口偶发标题栏/边框回归（WM_NCCALCSIZE 竞态，走动等频繁 reposition
  // 时更易触发）：独立 300ms 快速自愈，把边框闪现的可见时长压到 300ms 内
  frameHealTimer = window.setInterval(() => {
    void invoke('ensure_undecorated').catch(() => {});
  }, 300);
  sleepCheckTimer = window.setInterval(checkSleep, 2_000);
  // 服装自愈：右键菜单换装走 pet-changed 事件即时应用；这里兜底轮询，
  // 事件偶发丢失/竞态时 2s 内自动补上（查的是轻量命令，不整份拉设置）
  outfitSyncTimer = window.setInterval(() => {
    if (document.hidden) return;
    void invoke<number>('get_pet_outfit', { id: petId })
      .then((idx) => {
        if (Number.isFinite(idx) && idx !== outfitIndex) {
          outfitIndex = idx;
          stage.setOutfit(outfitIndex);
        }
      })
      .catch(() => {});
  }, 2_000);
  await syncRenderActivity();

  unlisteners.push(
    await listen<PetInfo>('pet-changed', (e) => {
      const p = e.payload;
      if (p.id !== petId) return;
      lockPosition = p.lockPosition;
      roamEnabled = p.roamEnabled;
      soundEnabled = p.soundEnabled;
      bubbleEnabled = p.bubbleEnabled;
      ambientEnabled = p.ambientEnabled;
      flingEnabled = p.flingEnabled;
      gazeEnabled = p.gazeEnabled;
      stage.gazeEnabled = gazeEnabled;
      followEnabled = p.followEnabled;
      const outfitWas = outfitIndex;
      outfitIndex = p.outfitIndex ?? 0;
      if (outfitIndex !== outfitWas) stage.setOutfit(outfitIndex);
      const groundWas = groundEnabled;
      groundEnabled = p.groundEnabled;
      if (groundEnabled && !groundWas) {
        // 刚打开：先停掉在飞的抛掷和散步再贴地，否则 settle 会被
        // fling/wander 按它们缓存的旧轨迹逐帧覆盖（互相抢位置）
        stopFling();
        wander?.interrupt();
        void settleGround();
      }
      walkSpeedCss = p.walkSpeed;
      if (p.lockPosition) {
        const wasFlying = fling.active;
        stopFling();
        // 锁定打断抛掷：任务栏模式直接落地，不留悬空
        if (wasFlying && groundEnabled) void settleGround();
      }
      applySoundVolume();
      scheduleAmbient();
      wander?.setLocked(p.lockPosition);
      updateWanderEnabled();
      wander?.setSuppressed(p.followEnabled);
      wander?.setConfig({ freq: p.walkFreq, speed: p.walkSpeed });
      follow?.setEnabled(p.followEnabled);
      void syncFollowMotion();
      void (async () => {
        if (p.petpack && p.petpack !== stage.currentPackId) await reloadPack(p.petpack);
        if (typeof p.scale === 'number') {
          // 缩放改变窗口尺寸：停掉散步，旧边界/旧 y 已失效，避免和落地抢位
          wander?.interrupt();
          await applyScale(p.scale);
          // 窗口高度变了，任务栏模式的地面线跟着变
          if (groundEnabled) void settleGround();
        }
      })();
    }),
    await listen<{
      volume: number;
      bubbleMs: number;
      alwaysOnTop: boolean;
      gravity: number;
      bounceRestitution: number;
      flingMinSpeed: number;
      ambientIntervalSec: number;
    }>('global-prefs-changed', (e) => {
      volume = Math.min(1, Math.max(0, e.payload.volume));
      bubbleMs = Math.min(10_000, Math.max(500, e.payload.bubbleMs));
      gravity = e.payload.gravity;
      bounceRestitution = e.payload.bounceRestitution;
      flingMinSpeed = e.payload.flingMinSpeed;
      ambientIntervalSec = e.payload.ambientIntervalSec;
      applySoundVolume();
      // 闲聊间隔变了：重新排下一次闲聊
      scheduleAmbient();
      void win.setAlwaysOnTop(e.payload.alwaysOnTop).catch(() => {});
    }),
    await listen<{ id: string }>('petpack-changed', (e) => {
      if (e.payload.id === stage.currentPackId) void reloadPack(e.payload.id);
    }),
    await listen<{ id: string; x: number; y: number }>('pet-moved', (e) => {
      if (e.payload.id !== petId) return;
      wander?.interrupt();
      stopFling(); // 重置位置等外部移动优先于滑行
      follow?.invalidateFrame();
      // 重置位置是明确落点：给跟随同样的冷却，否则一秒内又被拽回光标旁
      followCooldownUntil = performance.now() + FOLLOW_FLING_COOLDOWN_MS;
      void win.setPosition(new PhysicalPosition(e.payload.x, e.payload.y));
      if (groundEnabled) void settleGround(); // 重置位置后同样贴地
    }),
    await listen<string>('pet-hidden', (e) => {
      if (e.payload === petId) {
        stopFling();
        hideBubble();
        void win.hide();
      }
    }),
  );
});

onUnmounted(() => {
  unlisteners.forEach((u) => u());
  document.removeEventListener('visibilitychange', syncRenderActivity);
  if (activityTimer !== null) window.clearInterval(activityTimer);
  if (frameHealTimer !== null) window.clearInterval(frameHealTimer);
  if (sleepCheckTimer !== null) window.clearInterval(sleepCheckTimer);
  if (outfitSyncTimer !== null) window.clearInterval(outfitSyncTimer);
  if (ambientTimer !== null) window.clearTimeout(ambientTimer);
  disarmLongPress();
  stopFling();
  follow?.stop();
  wander?.stop();
  pointer.stop();
  stage.destroy();
  hideBubble();
});

function onDown(e: PointerEvent): void {
  if (e.button !== 0 || !stage.hitTest(e.offsetX, e.offsetY)) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  pressed = true;
  moved = false;
  downX = e.clientX;
  downY = e.clientY;
  // 用户主动交互：解除抛掷后的跟随冷却
  followCooldownUntil = 0;
  // 滑行中再按：立即抓住
  if (fling.active) {
    stopFling();
    void saveWindowState();
  }
  // 休眠中交互：立即唤醒（不补播 idle，让随后的反应动作直接接管）
  if (sleeping) {
    sleeping = false;
    stage.sleeping = false;
  }
  machine.set('click');
  // 快速二次按下 = 双击摸头（pat 绑定可缺省；缺省时维持普通点击行为）
  const isDouble = performance.now() - lastTapAt < DOUBLE_TAP_MS;
  if (isDouble && hasPatBinding()) {
    clickFb = stage.play('pat', { sound: true }) ?? null;
  } else {
    // 命中区域差异化反应：命中的 HitArea 配置了 hitReactions → 播对应绑定，否则回退 click
    clickFb = (reactionFor(e.offsetX, e.offsetY) ?? stage.play('click', { sound: true })) ?? null;
  }
  if (clickFb?.sound) announceVoice(true);
  stage.noteActivity(true);
  // 按住期间统一暂停命中轮询；锁定位置时只按不拖（follow=false 不移动窗口）
  pointer.beginDrag(!lockPosition);
  armLongPress();
}

/** pet 里有没有可用的 pat（摸头）绑定：sprite 看帧序列，live2d 看动作组 */
function hasPatBinding(): boolean {
  const m = stage.packContext?.manifest;
  const b = m?.animations.pat;
  if (!m || !b) return false;
  return m.engine === 'sprite' ? !!b.frames?.length : !!b.motion;
}

/** 命中区域反应：命中的 HitArea 名在 hitReactions 里有配置 → 播对应绑定 */
function reactionFor(x: number, y: number): MotionFeedback | undefined {
  const reactions = stage.packContext?.manifest.hitReactions;
  if (!reactions) return undefined;
  for (const name of stage.hitAreasAt(x, y)) {
    const binding = reactions[name];
    if (binding?.motion) return stage.playBinding(binding, undefined, { sound: true }) ?? undefined;
  }
  return undefined;
}

/** 原地按住 LONG_PRESS_MS（没拖动、没松手）→ 触发摸头亲昵动作 */
function armLongPress(): void {
  disarmLongPress();
  if (!hasPatBinding()) return;
  longPressTimer = window.setTimeout(() => {
    longPressTimer = null;
    if (!pressed || moved) return;
    clickFb = stage.play('pat', { sound: true }) ?? null;
    if (clickFb?.sound) announceVoice(true);
  }, LONG_PRESS_MS);
}

function disarmLongPress(): void {
  if (longPressTimer !== null) {
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

/**
 * 松手/点放收尾：一次取齐窗口状态，立刻决定抛掷或贴地。
 * 台词不在此刻显示——抛掷时记到 pendingQuote（首次触地弹跳时显示，未触地则
 * 停在终点后显示），不抛则等贴地完成后就地显示，避免台词落在桌宠已经离开的松手点。
 */
async function afterDragRelease(quote: MotionFeedback | null): Promise<void> {
  try {
    const [monitor, size, pos, sf] = await Promise.all([
      currentMonitor(),
      win.outerSize(),
      win.outerPosition(),
      win.scaleFactor(),
    ]);
    if (!monitor) {
      showFeedbackBubble(quote);
      return;
    }
    const { vx, vy } = pointer.velocity();
    if (flingEnabled && !lockPosition && !fling.active && Math.hypot(vx, vy) >= flingMinSpeed) {
      wander?.interrupt();
      // 抛掷会带着窗口飞：先收起气泡，台词等滑行停在最终位置再显示；
      // 飞行期间抑制穿透切换（状态高频翻转 + 每次切换都闪）
      hideBubble();
      stage.suppressHitToggle = true;
      pendingQuote = quote;
      const area = monitor.workArea;
      // 任务栏模式：下边界延长到地面线（脚底踩线），抛体受重力落在线上弹跳，
      // 停下时就在地面——不再有"滑行停下后再吸附一下"的二段跳变
      const maxY = groundEnabled
        ? groundLineY(area.position.y, area.size.height, size.height, sf)
        : area.position.y + area.size.height - size.height;
      fling.start(
        { x: pos.x, y: pos.y },
        { vx, vy },
        {
          x: area.position.x,
          y: area.position.y,
          width: area.size.width,
          height: maxY + size.height - area.position.y,
        },
        { w: size.width, h: size.height },
        // 重力仅任务栏模式生效；弹性两种模式共用（撞墙/落地一致）
        groundEnabled
          ? { gravity, restitution: bounceRestitution }
          : { restitution: bounceRestitution },
      );
      return;
    }
    // 锁定位置时贴地路径也跳过：锁定语义下点放不许挪动桌宠，只显示台词
    if (groundEnabled && !lockPosition) {
      await applyGround(monitor.workArea, size.height, pos, sf);
      await saveWindowState();
    }
    // 没抛出去且已贴地（或本来就在地面）：停在最终位置再显示台词
    showFeedbackBubble(quote);
  } catch {
    // 窗口状态暂时拿不到就放弃本次收尾
  } finally {
    releaseBusy = false;
  }
}

async function onContextMenu(e: MouseEvent): Promise<void> {
  e.preventDefault();
  // 菜单窗口锚在光标处：把窗口内坐标换算成屏幕物理坐标传给 Rust
  try {
    const [sf, pos] = await Promise.all([win.scaleFactor(), win.outerPosition()]);
    await invoke('show_pet_menu', {
      id: petId,
      x: pos.x + Math.round(e.clientX * sf),
      y: pos.y + Math.round(e.clientY * sf),
    });
  } catch {
    // 菜单窗口不可用（旧后端/浏览器调试）就静默放弃
  }
}

function onMove(e: PointerEvent): void {
  if (!pressed || lockPosition) return;
  if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) > 6) {
    moved = true;
    disarmLongPress();
    machine.set('drag');
    dragFb = stage.play('drag', { sound: true }) ?? null;
    if (dragFb?.sound) announceVoice(true);
    hideBubble();
  }
}

function onUp(): void {
  if (!pressed) return;
  pressed = false;
  // 收尾闸门立起：抛掷/落地取状态期间跟随让位（见 afterDragRelease 的 finally）
  releaseBusy = true;
  const wasTap = !moved;
  disarmLongPress();
  pointer.endDrag();
  machine.set('idle');
  stage.noteActivity(true);
  if (wasTap) {
    playFeedbackSound(clickFb);
    lastTapAt = performance.now();
    const quote = clickFb;
    clickFb = null;
    // 点放/微动（不足 moved 阈值的几像素）也算一次收尾；可能落地 → 台词停稳再显示
    void afterDragRelease(quote);
  } else {
    // 拖拽结束：音效立即出，台词（如"别拽我啦"）等停在最终位置再弹
    playFeedbackSound(dragFb);
    const quote = dragFb;
    dragFb = null;
    follow?.invalidateFrame(); // 拖拽挪了窗口，跟随需要重新定位
    void afterDragRelease(quote);
  }
  void saveWindowState();
}
</script>

<template>
  <div class="root">
    <div
      ref="el"
      class="stage"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @lostpointercapture="onUp"
      @contextmenu="onContextMenu"
    />
    <div v-if="error" class="badge">{{ error }}</div>
  </div>
</template>

<style scoped>
.root {
  position: relative;
  width: 100vw;
  height: 100vh;
  user-select: none;
}

.stage {
  position: absolute;
  inset: 0;
  touch-action: none;
}

.badge {
  position: absolute;
  top: 4px;
  left: 6px;
  max-width: 90%;
  font: 12px/1.4 'Segoe UI', 'Microsoft YaHei', sans-serif;
  color: #ffb4b4;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}
</style>
