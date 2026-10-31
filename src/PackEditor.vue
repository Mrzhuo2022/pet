<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { emit as emitEvent, listen } from '@tauri-apps/api/event';
// confirm 用插件异步 API：dialog 插件的 init 脚本把 window.confirm 覆盖成
// async 函数（返回 Promise 恒为真值），同步 if 判断等于跳过确认
import { confirm, open } from '@tauri-apps/plugin-dialog';
import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';
import {
  fetchManifest,
  resolveUrl,
  TIME_SLOTS,
  type PackEntry,
  type PetpackAnimation,
  type PetpackManifest,
  type TimeSlot,
} from './pet/petpack';
import { loadImageEl } from './pet/imaging';
import type { MotionDef } from './pet/motionText';
import { diffManifest } from './pet/manifestDiff';
import { saveCoverFromCanvas } from './pet/cover';
import { toast } from './settings/toast';
import { voiceBus } from './pet/voiceBus';
import { SEMANTIC_ACTIONS, type SemanticAction } from './pet/types';

const props = defineProps<{ pack: PackEntry }>();
const emit = defineEmits<{ (e: 'saved'): void; (e: 'cancel'): void }>();

const manifest = ref<PetpackManifest | null>(null);
const error = ref('');
const busy = ref(false);
const frameThumbs = ref<string[]>([]);
const frameImgs = ref<HTMLImageElement[]>([]);
const frameCount = ref(0);
const motionGroups = ref<string[]>([]);
/** 每个动作组里可播放（含 File）的条数，试播按钮上展示 */
const motionCounts = ref<Record<string, number>>({});
/** 模型 JSON 里的动作定义原样字段（动作抽屉的数据源，零额外请求） */
const motionDefs = ref<Record<string, MotionDef[]>>({});
/** 模型自带表情名（Expressions[].Name），可绑定到语义动作 */
const expressions = ref<string[]>([]);
const textsText = ref('');
const personaText = ref('');
const motionTextOn = ref(true);
/** 气泡样式（随皮肤定制） */
const bubbleTheme = ref<'' | 'light' | 'dark'>('');
const bubbleAccent = ref('');
const previewAction = ref<SemanticAction>('idle');
const previewCanvas = ref<HTMLCanvasElement | null>(null);
const l2dCanvas = ref<HTMLCanvasElement | null>(null);
const l2dStatus = ref('');

// M3：变更摘要 / 撤销 / 动作抽屉 / 预览暂停 / 封面
/** 载入时的原始清单（未预填充），保存时 diff 出改动清单 */
const originalJson = ref('');
const undoStack = ref<string[]>([]);
/** 抽屉当前目标：语义动作绑定 / Live2D 命中区域反应 / 时段问候 */
type PickerTarget =
  | { kind: 'action'; action: SemanticAction }
  | { kind: 'area'; area: string }
  | { kind: 'time'; slot: TimeSlot };
const pickerTarget = ref<PickerTarget | null>(null);
const pickerGroup = ref('');
const previewPaused = ref(false);
const coverBusy = ref(false);
/** 模型自带的 HitArea 区域名（吉雅这类语音看板模型有 voice/HitArea2 等） */
const hitAreaNames = ref<string[]>([]);

let raf = 0;
// shallowRef：模板里的试播/暂停按钮要能响应模型加载完成
const pvApp = shallowRef<PIXI.Application | null>(null);
const pvModel = shallowRef<Live2DModel | null>(null);
let unlistenVoice: (() => void) | null = null;
let lastSnap = '';
let undoTimer = 0;

/** Live2D 预览画布尺寸 */
const PVW = 260;
const PVH = 360;

onMounted(async () => {
  // 跨窗口语音互斥：别处（桌宠点击/拖拽）开始用户语音时，编辑器试播让路
  unlistenVoice = await listen<{ from: string; user: boolean }>('voice-start', (e) => {
    if (e.payload.from === 'editor') return;
    if (e.payload.user) voiceBus.stopAll();
  });
  window.addEventListener('keydown', onKey);
  await load();
  raf = requestAnimationFrame(drawPreview);
});

onUnmounted(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKey);
  window.clearTimeout(undoTimer);
  unlistenVoice?.();
  unlistenVoice = null;
  destroyPreview();
});

// ---------- 撤销（保存前快照栈，仅本次会话） ----------

/** 深度监听清单改动：停顿 600ms 后入栈（合并连续小改动），保留最近 30 步 */
watch(
  manifest,
  (m) => {
    if (!m) return;
    window.clearTimeout(undoTimer);
    undoTimer = window.setTimeout(() => {
      const j = JSON.stringify(m);
      if (j === lastSnap) return;
      if (lastSnap) undoStack.value.push(lastSnap);
      if (undoStack.value.length > 30) undoStack.value.shift();
      lastSnap = j;
    }, 600);
  },
  { deep: true },
);

function undo(): void {
  const prev = undoStack.value.pop();
  if (!prev) return;
  window.clearTimeout(undoTimer);
  lastSnap = prev;
  manifest.value = JSON.parse(prev) as PetpackManifest;
}

function onKey(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  // 输入框里留给原生文本撤销
  const t = e.target as HTMLElement | null;
  if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
  if (!undoStack.value.length) return;
  e.preventDefault();
  undo();
}

async function load(): Promise<void> {
  try {
    const m: PetpackManifest = structuredClone(await fetchManifest(props.pack.baseUrl));
    // 原始快照要在预填充之前取：预填充的空绑定不算用户改动
    originalJson.value = JSON.stringify(m);
    if (m.engine === 'live2d' && m.entry) {
      const m3 = await fetch(resolveUrl(m.entry, props.pack.baseUrl)).then((r) => r.json());
      const motions = m3?.FileReferences?.Motions ?? {};
      motionDefs.value = motions;
      motionGroups.value = Object.keys(motions);
      motionCounts.value = Object.fromEntries(
        motionGroups.value.map((g) => [
          g,
          (motions[g] ?? []).filter(
            (d: { File?: unknown }) => typeof d?.File === 'string' && d.File,
          ).length,
        ]),
      );
      expressions.value = (m3?.FileReferences?.Expressions ?? [])
        .map((e: { Name?: unknown }) => (typeof e?.Name === 'string' ? e.Name : ''))
        .filter(Boolean);
      hitAreaNames.value = (m3?.FileReferences?.HitAreas ?? [])
        .map((h: { Name?: unknown }) => (typeof h?.Name === 'string' ? h.Name : ''))
        .filter(Boolean);
    }
    // 预填充所有语义动作的绑定（渲染期零副作用），空绑定在保存时清理
    for (const a of SEMANTIC_ACTIONS) {
      if (!m.animations[a]) {
        m.animations[a] =
          m.engine === 'sprite'
            ? { frames: [], fps: 4, loop: true }
            : { motion: '', expression: '' };
      }
    }
    manifest.value = m;
    lastSnap = '';
    undoStack.value = [];
    textsText.value = (m.interactions?.clickTexts ?? []).join('\n');
    personaText.value = m.persona?.prompt ?? '';
    motionTextOn.value = m.interactions?.motionText !== false;
    bubbleTheme.value = m.bubble?.theme === 'dark' ? 'dark' : m.bubble?.theme === 'light' ? 'light' : '';
    bubbleAccent.value = m.bubble?.accent ?? '';
    if (m.engine === 'live2d') {
      await nextTick();
      await initL2dPreview();
    }
    if (m.engine === 'sprite' && m.sprite) {
      const sp = m.sprite;
      const sheet = await loadImageEl(resolveUrl(sp.sheet, props.pack.baseUrl));
      const cols = Math.max(1, sp.cols);
      const rows = Math.ceil(sheet.naturalHeight / sp.frameH);
      frameCount.value = cols * rows;
      // 分层部件：与主表帧号一一对应，合成到缩略图/预览里
      const partSheets: { part: NonNullable<typeof sp.parts>[number]; img: HTMLImageElement }[] = [];
      for (const part of sp.parts ?? []) {
        const pimg = await loadImageEl(resolveUrl(part.sheet, props.pack.baseUrl));
        partSheets.push({ part, img: pimg });
      }
      // 高清皮肤整帧可达 600x800+，编辑器预览/缩略图按 ~200px 渲染即可，
      // 否则 24 帧全尺寸画布会把设置窗口内存拉爆
      const thumbScale = Math.min(1, 200 / sp.frameW, 260 / sp.frameH);
      const tw = Math.max(1, Math.round(sp.frameW * thumbScale));
      const th = Math.max(1, Math.round(sp.frameH * thumbScale));
      const thumbs: string[] = [];
      const imgs: HTMLImageElement[] = [];
      for (let i = 0; i < frameCount.value; i++) {
        const c = document.createElement('canvas');
        c.width = tw;
        c.height = th;
        const g = c.getContext('2d')!;
        g.imageSmoothingEnabled = true;
        g.drawImage(
          sheet,
          (i % cols) * sp.frameW,
          Math.floor(i / cols) * sp.frameH,
          sp.frameW,
          sp.frameH,
          0,
          0,
          tw,
          th,
        );
        for (const { part, img } of partSheets) {
          const pcols = Math.max(1, part.cols);
          const prows = Math.ceil(img.naturalHeight / part.frameH);
          const pi = Math.min(i, pcols * prows - 1);
          g.drawImage(
            img,
            (pi % pcols) * part.frameW,
            Math.floor(pi / pcols) * part.frameH,
            part.frameW,
            part.frameH,
            part.offsetX * thumbScale,
            part.offsetY * thumbScale,
            part.frameW * thumbScale,
            part.frameH * thumbScale,
          );
        }
        const url = c.toDataURL();
        thumbs.push(url);
        imgs.push(await loadImageEl(url));
      }
      frameThumbs.value = thumbs;
      frameImgs.value = imgs;
    }
  } catch (e) {
    error.value = String(e);
  }
}

/** 取某语义动作的绑定（load 时已全部预填充，渲染期无副作用） */
function animOf(a: SemanticAction): PetpackAnimation {
  return manifest.value!.animations[a]!;
}

// ---------- sprite 帧序列：点选顺序即播放顺序 ----------

/** 点击帧编号：已在序列中则移出，否则追加到序列末尾（不再自动升序） */
function toggleFrame(a: SemanticAction, i: number): void {
  const anim = animOf(a);
  if (!anim.frames) anim.frames = [];
  const idx = anim.frames.indexOf(i);
  if (idx >= 0) anim.frames.splice(idx, 1);
  else anim.frames.push(i);
}

/** 播放序列内的帧左移/右移一位 */
function moveFrame(a: SemanticAction, si: number, dir: -1 | 1): void {
  const frames = animOf(a).frames;
  if (!frames) return;
  const j = si + dir;
  if (j < 0 || j >= frames.length) return;
  const tmp = frames[si]!;
  frames[si] = frames[j]!;
  frames[j] = tmp;
}

function removeAt(a: SemanticAction, si: number): void {
  animOf(a).frames?.splice(si, 1);
}

/** 按帧号升序重排：只调整现有序列的顺序，不增删帧 */
function resetFrames(a: SemanticAction): void {
  const frames = animOf(a).frames;
  if (frames?.length) frames.sort((x, y) => x - y);
}

// ---------- 交互素材 ----------

async function addSound(): Promise<void> {
  const f = await open({
    multiple: false,
    filters: [{ name: '音频文件', extensions: ['wav', 'mp3', 'ogg'] }],
  });
  if (!f || !manifest.value) return;
  busy.value = true;
  try {
    const rel = await invoke<string>('add_pack_sound', { id: props.pack.id, path: f });
    const m = manifest.value;
    m.interactions ??= {};
    m.interactions.clickSounds ??= [];
    if (!m.interactions.clickSounds.includes(rel)) m.interactions.clickSounds.push(rel);
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

function removeSound(i: number): void {
  manifest.value?.interactions?.clickSounds?.splice(i, 1);
}

/** 试听皮肤包里的音效（不落盘，纯播放；走语音闸，同时只有一条声音） */
function previewSound(rel: string): void {
  voiceBus.play(resolveUrl(rel, props.pack.baseUrl), 1);
  void emitEvent('voice-start', { from: 'editor', user: true });
}

// ---------- Live2D 实时预览 ----------

/** 初始化 Live2D 预览画布（设置窗口与桌宠窗口共用 Cubism Core，可直接渲染） */
async function initL2dPreview(): Promise<void> {
  const m = manifest.value;
  if (!m || m.engine !== 'live2d' || !m.entry) return;
  const canvas = l2dCanvas.value;
  if (!canvas) return;
  l2dStatus.value = '加载模型中…';
  let app: PIXI.Application | null = null;
  try {
    // pixi-live2d-display 通过 window.PIXI 引用 Ticker/Texture
    (window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
    app = new PIXI.Application({
      view: canvas,
      width: PVW,
      height: PVH,
      backgroundAlpha: 0,
      antialias: false,
    });
    const model = await Live2DModel.from(resolveUrl(m.entry, props.pack.baseUrl), {
      autoInteract: false,
      autoUpdate: true,
    });
    pvApp.value = app;
    pvModel.value = model;
    app.stage.addChild(model);
    const ow = model.internalModel.originalWidth;
    const oh = model.internalModel.originalHeight;
    const s = Math.min(PVW / ow, PVH / oh) * 0.95;
    model.anchor.set(0.5, 1);
    model.scale.set(s);
    model.position.set(PVW / 2, PVH - 4);
    l2dStatus.value = '';
  } catch (e) {
    // 模型加载失败也必须销毁已创建的渲染器，否则泄漏 WebGL 上下文（浏览器有约 16 个上限）
    app?.destroy(false, { children: true });
    l2dStatus.value = `预览加载失败：${e}`;
  }
}

/** 编辑器试播前广播：用户触发，桌宠窗口的语音/气泡让路 */
function announceEditorVoice(): void {
  voiceBus.stopAll();
  void emitEvent('voice-start', { from: 'editor', user: true });
}

/** 试播某个动作组（随机一条，含模型自带语音） */
function testMotion(group: string): void {
  const model = pvModel.value;
  if (!model) return;
  announceEditorVoice();
  model.motion(group, undefined, 3);
}

/** 按当前绑定试播语义动作：指定索引则播那一条，否则随机；含表情切换 */
function testBinding(a: SemanticAction): void {
  const m = manifest.value;
  const model = pvModel.value;
  if (!m || !model) return;
  const binding = m.animations[a] ?? m.animations.idle;
  if (!binding?.motion) return;
  const idx =
    typeof binding.index === 'number' && Number.isInteger(binding.index) && binding.index >= 0
      ? binding.index
      : undefined;
  announceEditorVoice();
  model.motion(binding.motion, idx, 3);
  if (binding.expression) model.expression(binding.expression);
}

/** 暂停/继续模型更新：暂停后画面定格，方便"设为封面"取满意一帧 */
function togglePause(): void {
  const model = pvModel.value;
  if (!model) return;
  previewPaused.value = !previewPaused.value;
  model.autoUpdate = !previewPaused.value;
}

/** 表情下拉选中即应用到预览；清空（回退 idle）时复位默认表情 */
function onExprChange(a: SemanticAction): void {
  const ex = animOf(a).expression;
  const model = pvModel.value;
  if (!model) return;
  if (ex) void model.expression(ex);
  else resetPreviewExpression();
}

/** 试表情：应用 3 秒后自动复位 */
function testExpression(a: SemanticAction): void {
  const ex = animOf(a).expression;
  const model = pvModel.value;
  if (!model || !ex) return;
  void model.expression(ex);
  window.setTimeout(() => resetPreviewExpression(), 3000);
}

function resetPreviewExpression(): void {
  const em = (
    pvModel.value?.internalModel as unknown as {
      motionManager?: { expressionManager?: { resetExpression?: () => void } };
    }
  )?.motionManager?.expressionManager;
  em?.resetExpression?.();
}

function destroyPreview(): void {
  pvModel.value?.destroy();
  pvModel.value = null;
  pvApp.value?.destroy(false, { children: true });
  pvApp.value = null;
  previewPaused.value = false;
}

// ---------- 动作选择抽屉（语义动作绑定 / 命中区域反应共用） ----------

const currentPickerIndex = computed<number | null>(() => {
  const t = pickerTarget.value;
  if (!t) return null;
  const b = bindingOf(t);
  return b && b.motion === pickerGroup.value && typeof b.index === 'number' ? b.index : null;
});

function bindingOf(t: PickerTarget): PetpackAnimation | undefined {
  const m = manifest.value!;
  if (t.kind === 'action') return m.animations[t.action];
  if (t.kind === 'area') return m.hitReactions?.[t.area];
  return m.timeGreetings?.[t.slot];
}

function setBinding(t: PickerTarget, group: string, index: number | null): void {
  const m = manifest.value!;
  if (t.kind === 'action') {
    const anim = m.animations[t.action]!;
    anim.motion = group;
    if (index === null) delete anim.index;
    else anim.index = index;
  } else if (t.kind === 'area') {
    const map = (m.hitReactions ??= {});
    map[t.area] = index === null ? { motion: group } : { motion: group, index };
  } else {
    const map = (m.timeGreetings ??= {});
    map[t.slot] = index === null ? { motion: group } : { motion: group, index };
  }
}

function openPicker(t: PickerTarget): void {
  const b = bindingOf(t);
  pickerGroup.value =
    b?.motion && motionGroups.value.includes(b.motion)
      ? b.motion
      : (motionGroups.value[0] ?? '');
  pickerTarget.value = t;
}

function closePicker(): void {
  pickerTarget.value = null;
}

/** 绑定抽屉里的选择：i=null = 组内随机 */
function pickEntry(i: number | null): void {
  const t = pickerTarget.value;
  if (!t || !pickerGroup.value) return;
  setBinding(t, pickerGroup.value, i);
  closePicker();
}

function targetLabel(t: PickerTarget): string {
  if (t.kind === 'action') return t.action;
  if (t.kind === 'area') return `命中区域 · ${t.area}`;
  return `时段问候 · ${TIME_LABEL[t.slot]}`;
}

/** 抽屉里直接试播某一条（不改变绑定） */
function previewEntry(group: string, i: number): void {
  const model = pvModel.value;
  if (!model) return;
  announceEditorVoice();
  model.motion(group, i, 3);
}

/** 绑定按钮上的一行摘要，替代"第 N 条"手输 */
function bindingSummary(t: PickerTarget): string {
  const b = bindingOf(t);
  if (!b?.motion) {
    const fallback =
      t.kind === 'action' ? '选择动作（当前回退 idle）' : t.kind === 'area' ? '未配置（点击走 click 绑定）' : '未配置（走 idle 绑定）';
    return fallback;
  }
  const defs = motionDefs.value[b.motion] ?? [];
  if (typeof b.index !== 'number') return `${b.motion} · 随机`;
  const name = typeof defs[b.index]?.Name === 'string' ? (defs[b.index]!.Name as string) : '';
  return `${b.motion} · 第 ${b.index} 条${name ? ` · ${name}` : ''}`;
}

/** 试播某命中区域当前配置的反应 */
function testHit(area: string): void {
  const b = manifest.value?.hitReactions?.[area];
  const model = pvModel.value;
  if (!model || !b?.motion) return;
  announceEditorVoice();
  model.motion(b.motion, typeof b.index === 'number' ? b.index : undefined, 3);
  if (b.expression) model.expression(b.expression);
}

function clearHit(area: string): void {
  delete manifest.value?.hitReactions?.[area];
}

/** 试播某时段问候当前配置的动作 */
function testTime(slot: TimeSlot): void {
  const b = manifest.value?.timeGreetings?.[slot];
  const model = pvModel.value;
  if (!model || !b?.motion) return;
  announceEditorVoice();
  model.motion(b.motion, typeof b.index === 'number' ? b.index : undefined, 3);
  if (b.expression) model.expression(b.expression);
}

function clearTime(slot: TimeSlot): void {
  delete manifest.value?.timeGreetings?.[slot];
}

const TIME_LABEL: Record<TimeSlot, string> = {
  morning: '早上（5–10点）',
  afternoon: '下午（11–16点）',
  evening: '傍晚（17–22点）',
  night: '深夜（23–4点）',
};

const isPlayable = (d: MotionDef): boolean => typeof d.File === 'string' && !!d.File;
const defName = (d: MotionDef): string => (typeof d.Name === 'string' ? d.Name : '');
const defText = (d: MotionDef): string => (typeof d.Text === 'string' ? d.Text : '');
const defDuration = (d: MotionDef): string =>
  typeof d.TextDuration === 'number' && Number.isFinite(d.TextDuration)
    ? `${Math.round(d.TextDuration * 10) / 10}s`
    : '';

// ---------- 设为封面 ----------

/** 把预览当前帧导出为皮肤封面（Live2D 走 extract 重取一帧，sprite 直接用 2d 画布） */
async function setCover(): Promise<void> {
  if (coverBusy.value || !manifest.value) return;
  let source: HTMLCanvasElement | null = null;
  if (manifest.value.engine === 'live2d') {
    const app = pvApp.value;
    if (!app) return;
    source = app.renderer.extract.canvas(app.stage) as unknown as HTMLCanvasElement;
  } else {
    source = previewCanvas.value;
  }
  if (!source) return;
  coverBusy.value = true;
  try {
    const ok = await saveCoverFromCanvas(props.pack.id, source);
    if (ok) toast('已把当前预览画面设为封面');
    else toast('封面保存失败', 'error');
  } finally {
    coverBusy.value = false;
  }
}

// ---------- 保存（先 diff 出变更清单，确认后写入） ----------

async function save(): Promise<void> {
  const m = manifest.value;
  if (!m || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const cleaned: PetpackManifest = structuredClone(m);
    cleaned.interactions ??= {};
    cleaned.interactions.clickTexts = textsText.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    // 台词优先级开关：默认 true（不写入），关显式写 false
    if (motionTextOn.value) delete cleaned.interactions.motionText;
    else cleaned.interactions.motionText = false;
    // 空数组不落盘（加载侧按缺失处理）；interactions 全空则整体移除
    if (!cleaned.interactions.clickSounds?.length) delete cleaned.interactions.clickSounds;
    if (!cleaned.interactions.clickTexts?.length) delete cleaned.interactions.clickTexts;
    if (!Object.keys(cleaned.interactions).length) delete cleaned.interactions;
    // 人设：空则移除
    const prompt = personaText.value.trim();
    if (prompt) cleaned.persona = { ...(cleaned.persona ?? {}), prompt };
    else if (cleaned.persona) {
      delete cleaned.persona.prompt;
      if (!Object.keys(cleaned.persona).length) delete cleaned.persona;
    }
    // 清理空绑定（运行时回退 idle）；索引非法时剔除
    for (const a of SEMANTIC_ACTIONS) {
      const an = cleaned.animations[a];
      if (!an) continue;
      if (!an.expression) delete an.expression;
      if (typeof an.index !== 'number' || !Number.isInteger(an.index) || an.index < 0) {
        delete an.index;
      }
      const empty =
        cleaned.engine === 'sprite' ? !an.frames || an.frames.length === 0 : !an.motion;
      if (empty) delete cleaned.animations[a];
    }
    // 命中区域反应：无 motion 的条目剔除，空对象整体移除
    if (cleaned.hitReactions) {
      for (const k of Object.keys(cleaned.hitReactions)) {
        if (!cleaned.hitReactions[k]?.motion) delete cleaned.hitReactions[k];
      }
      if (!Object.keys(cleaned.hitReactions).length) delete cleaned.hitReactions;
    }
    // 时段问候：无 motion 的时段剔除，空对象整体移除
    if (cleaned.timeGreetings) {
      for (const slot of TIME_SLOTS) {
        if (!cleaned.timeGreetings[slot]?.motion) delete cleaned.timeGreetings[slot];
      }
      if (!Object.keys(cleaned.timeGreetings).length) delete cleaned.timeGreetings;
    }
    // 气泡样式：全默认时不写字段
    if (bubbleTheme.value === 'dark' || bubbleAccent.value.trim()) {
      cleaned.bubble = {
        ...(bubbleTheme.value ? { theme: bubbleTheme.value } : {}),
        ...(bubbleAccent.value.trim() ? { accent: bubbleAccent.value.trim() } : {}),
      };
    } else {
      delete cleaned.bubble;
    }
    // idle 是规范必填：被清空时回填全帧/首个分组，避免皮肤加载失败
    if (cleaned.engine === 'sprite' && !cleaned.animations.idle?.frames?.length) {
      cleaned.animations.idle = {
        frames: Array.from({ length: Math.max(frameCount.value, 1) }, (_, i) => i),
        fps: 4,
        loop: true,
      };
    }
    if (cleaned.engine === 'live2d' && !cleaned.animations.idle?.motion) {
      cleaned.animations.idle = { motion: motionGroups.value[0] ?? 'Idle' };
    }

    const changes = originalJson.value
      ? diffManifest(JSON.parse(originalJson.value) as PetpackManifest, cleaned)
      : [];
    if (!changes.length) {
      toast('没有需要保存的改动');
      return;
    }
    const okToSave = await confirm(
      `将保存 ${changes.length} 处改动：\n· ${changes.join('\n· ')}\n\n确认写入皮肤包？`,
      { title: '保存皮肤包', okLabel: '保存', cancelLabel: '取消' },
    );
    if (!okToSave) return;
    await invoke('write_pack_manifest', {
      id: props.pack.id,
      manifest: JSON.stringify(cleaned),
    });
    // 回填空绑定后再同步到表单状态（与 load 的预填充一致），
    // 否则清理掉空绑定的 cleaned 会让模板里的 animOf(a) 取到 undefined
    for (const a of SEMANTIC_ACTIONS) {
      if (!cleaned.animations[a]) {
        cleaned.animations[a] =
          cleaned.engine === 'sprite'
            ? { frames: [], fps: 4, loop: true }
            : { motion: '', expression: '' };
      }
    }
    manifest.value = cleaned;
    emit('saved');
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

/** 预览：按当前动作的帧序列循环播放（仅 sprite 引擎） */
function drawPreview(ts: number): void {
  raf = requestAnimationFrame(drawPreview);
  const c = previewCanvas.value;
  const m = manifest.value;
  if (!c || !m || m.engine !== 'sprite' || !m.sprite || frameImgs.value.length === 0) return;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  const anim = m.animations[previewAction.value] ?? m.animations.idle;
  const frames = anim?.frames?.length ? anim.frames : [0];
  const fps = Math.max(1, anim?.fps ?? 4);
  let idx: number;
  if (anim?.loop === false) {
    // 单次播放：播完停 0.5s 再重来，便于观察一次性动作的收尾帧
    const playMs = (frames.length / fps) * 1000;
    const cycleMs = playMs + 500;
    const t = ts % cycleMs;
    idx = t < playMs ? Math.floor((t / 1000) * fps) : 0;
  } else {
    idx = Math.floor((ts / 1000) * fps) % frames.length;
  }
  const img = frameImgs.value[frames[idx] ?? 0];
  if (!img) return;
  const scale = Math.min(c.width / img.naturalWidth, c.height / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  g.imageSmoothingEnabled = true;
  g.drawImage(img, (c.width - w) / 2, c.height - h, w, h);
}
</script>

<template>
  <div class="editor">
    <header>
      <b class="title">编辑器 · {{ pack.name }}</b>
      <div class="head-actions">
        <button class="ghost" :disabled="!undoStack.length" title="撤销上一步改动（Ctrl+Z）" @click="undo">
          撤销
        </button>
        <button class="primary" :disabled="busy || !manifest" @click="save">保存</button>
        <button class="ghost" @click="emit('cancel')">返回</button>
      </div>
    </header>

    <p v-if="error" class="msg err">{{ error }}</p>

    <template v-if="manifest">
      <div class="editor-body">
        <!-- 左：大预览 + 试播控制 -->
        <aside class="preview-col">
          <template v-if="manifest.engine === 'live2d'">
            <canvas ref="l2dCanvas" :width="PVW" :height="PVH" class="preview-l2d"></canvas>
            <div class="pv-tools">
              <button class="mini" :disabled="!pvModel" @click="togglePause">
                {{ previewPaused ? '▶ 继续' : '⏸ 暂停' }}
              </button>
              <button class="mini" :disabled="!pvModel || coverBusy" title="把当前预览画面保存为皮肤封面" @click="setCover">
                设为封面
              </button>
            </div>
            <b class="col-title">试播动作组</b>
            <div class="test-btns">
              <button
                v-for="gr in motionGroups"
                :key="gr"
                class="mini"
                :title="`试播 ${gr}（随机一条）`"
                @click="testMotion(gr)"
              >
                {{ gr }}<span v-if="motionCounts[gr]" class="cnt">·{{ motionCounts[gr] }}</span>
              </button>
            </div>
            <span v-if="l2dStatus" class="desc">{{ l2dStatus }}</span>
            <span class="desc">暂停可定格画面，满意的一帧可设为封面</span>
          </template>

          <template v-else>
            <canvas ref="previewCanvas" width="220" height="220" class="preview"></canvas>
            <div class="pv-tools">
              <select v-model="previewAction" title="预览哪个语义动作">
                <option v-for="a in SEMANTIC_ACTIONS" :key="a" :value="a">{{ a }}</option>
              </select>
              <button class="mini" :disabled="coverBusy" title="把当前预览画面保存为皮肤封面" @click="setCover">
                设为封面
              </button>
            </div>
            <span class="desc">预览按当前绑定的帧序列播放</span>
          </template>
        </aside>

        <!-- 右：配置面板（独立滚动） -->
        <section class="config-col">
          <!-- 动作映射 -->
          <div class="edit-rows">
            <div v-for="a in SEMANTIC_ACTIONS" :key="a" class="edit-row">
              <div class="row-head">
                <b class="act">{{ a }}</b>
                <template v-if="manifest.engine === 'sprite'">
                  <label class="mini-field">
                    fps
                    <input v-model.number="animOf(a).fps" type="number" min="1" max="30" />
                  </label>
                  <label class="mini-field">
                    <input v-model="animOf(a).loop" type="checkbox" /> 循环
                  </label>
                </template>
              </div>

              <template v-if="manifest.engine === 'sprite'">
                <div class="chips">
                  <button
                    v-for="i in frameCount"
                    :key="i - 1"
                    :class="{ chip: true, on: animOf(a).frames?.includes(i - 1) }"
                    :title="`帧 ${i - 1}（点击加入/移出序列，加入顺序即播放顺序）`"
                    @click="toggleFrame(a, i - 1)"
                  >
                    <img :src="frameThumbs[i - 1]" alt="" />
                  </button>
                </div>
                <div class="seq">
                  <span class="seq-label">播放序列</span>
                  <template v-if="animOf(a).frames?.length">
                    <span v-for="(f, si) in animOf(a).frames" :key="`${a}-${si}-${f}`" class="seq-item">
                      <button class="mini sq" title="左移一位" :disabled="si === 0" @click="moveFrame(a, si, -1)">←</button>
                      <span class="seq-num" :title="`帧 ${f}`">{{ f }}</span>
                      <button class="mini sq" title="右移一位" :disabled="si === animOf(a).frames!.length - 1" @click="moveFrame(a, si, 1)">→</button>
                      <button class="mini sq del" title="移出序列" @click="removeAt(a, si)">×</button>
                    </span>
                    <button class="mini" title="恢复为帧号升序" @click="resetFrames(a)">按帧号重排</button>
                  </template>
                  <span v-else class="desc">（空 = 回退 idle）</span>
                </div>
              </template>

              <template v-else>
                <div class="binding-tools">
                  <button class="pick-btn" title="打开动作选择抽屉（组内全部条目可视化点选）" @click="openPicker({ kind: 'action', action: a })">
                    {{ bindingSummary({ kind: 'action', action: a }) }}
                  </button>
                  <button class="mini" title="按当前绑定试播（含语音/表情）" :disabled="!pvModel" @click="testBinding(a)">
                    ▶ 试播
                  </button>
                </div>
                <div v-if="expressions.length" class="expr-row">
                  <span class="expr-label">表情</span>
                  <select v-model="animOf(a).expression" class="motion-select" @change="onExprChange(a)">
                    <option value="">（不切换）</option>
                    <option v-for="ex in expressions" :key="ex" :value="ex">{{ ex }}</option>
                  </select>
                  <button
                    class="mini"
                    :disabled="!pvModel || !animOf(a).expression"
                    title="应用该表情 3 秒后复位"
                    @click="testExpression(a)"
                  >
                    试表情
                  </button>
                </div>
              </template>
            </div>
          </div>

          <!-- 命中区域反应（Live2D 且模型声明了 HitAreas 时） -->
          <div v-if="manifest.engine === 'live2d' && hitAreaNames.length" class="edit-row">
            <div class="row-head">
              <b class="act">命中区域</b>
              <span class="desc">点模型不同部位触发不同反应；未配置的部位走 click 绑定</span>
            </div>
            <div v-for="h in hitAreaNames" :key="h" class="binding-tools">
              <span class="area-name" :title="h">{{ h }}</span>
              <button class="pick-btn" title="为该区域选择反应动作" @click="openPicker({ kind: 'area', area: h })">
                {{ bindingSummary({ kind: 'area', area: h }) }}
              </button>
              <button class="mini" title="试播该区域当前配置的反应" :disabled="!pvModel" @click="testHit(h)">
                ▶
              </button>
              <button v-if="manifest.hitReactions?.[h]?.motion" class="mini del" title="清除该区域配置" @click="clearHit(h)">
                清除
              </button>
            </div>
          </div>

          <!-- 时段问候（待机闲聊按系统时段取对应条目） -->
          <div class="edit-row">
            <div class="row-head">
              <b class="act">时段问候</b>
              <span class="desc">待机闲聊优先播当前时段的动作；无配置的时段走 idle 绑定</span>
            </div>
            <div v-for="s in TIME_SLOTS" :key="s" class="binding-tools">
              <span class="area-name">{{ TIME_LABEL[s] }}</span>
              <button class="pick-btn" title="为该时段选择问候动作" @click="openPicker({ kind: 'time', slot: s })">
                {{ bindingSummary({ kind: 'time', slot: s }) }}
              </button>
              <button class="mini" title="试播该时段当前配置的动作" :disabled="!pvModel" @click="testTime(s)">
                ▶
              </button>
              <button v-if="manifest.timeGreetings?.[s]?.motion" class="mini del" title="清除该时段配置" @click="clearTime(s)">
                清除
              </button>
            </div>
          </div>

          <!-- 交互反馈 -->
          <div class="inter">
            <label v-if="manifest.engine === 'live2d'" class="check-row">
              <input v-model="motionTextOn" type="checkbox" />
              <span>动作自带台词时，气泡优先显示模型台词（与语音同条对应）</span>
            </label>

            <b>点击文本（每行一条，随机气泡；模型台词开启时作为回退）</b>
            <textarea v-model="textsText" rows="4" placeholder="别戳我！&#10;咕噜噜？"></textarea>

            <b>点击音效</b>
            <ul class="sounds">
              <li v-for="(s, i) in manifest.interactions?.clickSounds" :key="s + i">
                <span class="snd">{{ s }}</span>
                <span class="snd-tools">
                  <button class="mini" title="试听" @click="previewSound(s)">▶</button>
                  <button class="mini del" @click="removeSound(i)">移除</button>
                </span>
              </li>
            </ul>
            <button class="ghost" :disabled="busy" @click="addSound">添加音效文件</button>

            <b>人设（persona · 阶段 3 聊天生效）</b>
            <textarea v-model="personaText" rows="3" placeholder="她是…（system prompt）"></textarea>

            <b>气泡样式（随皮肤定制）</b>
            <div class="bubble-edit">
              <div class="bubble-controls">
                <label class="mini-field">
                  主题
                  <select v-model="bubbleTheme">
                    <option value="">默认（浅色）</option>
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </label>
                <label class="mini-field">
                  强调色（边框）
                  <input v-model="bubbleAccent" type="color" class="accent-input" />
                </label>
              </div>
              <div
                :class="['bubble-sample', bubbleTheme === 'dark' ? 'sample-dark' : 'sample-light']"
                :style="bubbleAccent ? { borderColor: bubbleAccent } : {}"
              >
                {{ textsText.split('\n').find((s) => s.trim()) || '这是气泡的样子～' }}
              </div>
            </div>
          </div>

          <p class="desc hint">
            保存前列出全部改动供确认；Ctrl+Z 撤销（文案输入框内为原生撤销）。引擎：{{ manifest.engine }}
          </p>
        </section>
      </div>
    </template>
    <p v-else-if="!error" class="desc">加载中…</p>

    <!-- 动作选择抽屉：组内全部条目（索引/名称/台词/时长/语音），单选即绑定 -->
    <div v-if="pickerTarget" class="drawer-mask" @click.self="closePicker">
      <div class="drawer">
        <header>
          <b>选择动作 · {{ targetLabel(pickerTarget) }}</b>
          <button class="mini" @click="closePicker">关闭</button>
        </header>
        <div class="drawer-groups">
          <button
            v-for="g in motionGroups"
            :key="g"
            :class="{ 'group-chip': true, on: g === pickerGroup }"
            @click="pickerGroup = g"
          >
            {{ g }}<span v-if="motionCounts[g]" class="cnt">·{{ motionCounts[g] }}</span>
          </button>
        </div>
        <ul class="drawer-entries">
          <li
            :class="{ entry: true, on: currentPickerIndex === null }"
            @click="pickEntry(null)"
          >
            <span class="idx">—</span>
            <span class="txt"><b>随机</b><em>组内随机播放，不连续重复同一条</em></span>
          </li>
          <li
            v-for="(d, i) in motionDefs[pickerGroup] ?? []"
            :key="i"
            :class="{ entry: true, on: currentPickerIndex === i, unplayable: !isPlayable(d) }"
            @click="isPlayable(d) && pickEntry(i)"
          >
            <span class="idx">#{{ i }}</span>
            <span class="txt">
              <b>{{ defName(d) || `条目 ${i}` }}</b>
              <em v-if="defText(d)">{{ defText(d) }}</em>
            </span>
            <span v-if="defDuration(d)" class="dur" title="台词建议显示时长">{{ defDuration(d) }}</span>
            <span v-if="d.Sound" class="snd" title="自带语音">🔊</span>
            <span v-if="!isPlayable(d)" class="noplay" title="无动作文件（仅参数/语音），不能作为动作绑定">不可播</span>
            <button v-else class="mini" title="试播这一条" @click.stop="previewEntry(pickerGroup, i)">▶</button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title {
  font-size: 15px;
}

.head-actions {
  display: flex;
  gap: 6px;
}

.msg.err {
  color: #f0a58f;
  font-size: 12px;
}

/* 双栏：左预览右配置；窗口太窄时自动换行成上下堆叠 */
.editor-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
}

.preview-col {
  flex: none;
  width: 284px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--panel);
  border-radius: 8px;
  padding: 10px;
}

.config-col {
  flex: 1 1 340px;
  min-width: 340px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  align-self: stretch;
}

.col-title {
  font-size: 12px;
  color: var(--text-3);
  letter-spacing: 0.06em;
}

.preview {
  background: var(--panel-deep);
  border-radius: 6px;
  width: 220px;
  height: 220px;
  image-rendering: pixelated;
}

.preview-l2d {
  background: var(--panel-deep);
  border-radius: 6px;
  width: 264px;
  height: 364px;
  flex: none;
}

.pv-tools {
  display: flex;
  gap: 6px;
  align-items: center;
}

.pv-tools select {
  flex: 1;
  min-width: 0;
}

.test-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.cnt {
  opacity: 0.6;
  margin-left: 2px;
}

/* 动作绑定行 */
.edit-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.edit-row {
  background: var(--panel);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.act {
  text-transform: uppercase;
  color: var(--ok);
  font-size: 12px;
  min-width: 70px;
}

.mini-field {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}

.mini-field input[type='number'] {
  width: 46px;
  font: inherit;
  background: var(--border-soft);
  color: var(--text);
  border: none;
  border-radius: 4px;
  padding: 2px 4px;
}

/* 绑定摘要按钮（打开抽屉） */
.pick-btn {
  font: inherit;
  font-size: 12px;
  text-align: left;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--panel-deep);
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 10px;
  cursor: pointer;
}

.pick-btn:hover {
  border-color: var(--accent);
}

.binding-tools {
  display: flex;
  align-items: center;
  gap: 10px;
}

.area-name {
  min-width: 76px;
  max-width: 110px;
  font-size: 12px;
  color: var(--ok);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: none;
}

.expr-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.expr-label {
  font-size: 12px;
  color: var(--text-2);
}

/* 帧网格与播放序列 */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip {
  width: 44px;
  height: 44px;
  padding: 2px;
  border-radius: 6px;
  border: 2px solid transparent;
  background: var(--panel-deep);
  cursor: pointer;
}

.chip img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}

.chip.on {
  border-color: var(--accent);
  background: var(--accent-tint);
}

.seq {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.seq-label {
  font-size: 12px;
  color: var(--text-3);
  margin-right: 2px;
}

.seq-item {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: var(--bg);
  border-radius: 6px;
  padding: 2px;
}

.seq-num {
  min-width: 22px;
  text-align: center;
  font-family: Consolas, monospace;
  font-size: 12px;
  color: var(--ok);
}

.mini.sq {
  padding: 1px 6px;
}

/* 交互素材 */
.inter {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--panel);
  border-radius: 8px;
  padding: 10px;
}

.check-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}

.check-row input {
  accent-color: var(--accent);
  margin-top: 2px;
}

textarea {
  font: inherit;
  background: var(--panel-deep);
  color: var(--text);
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  padding: 8px;
  resize: vertical;
}

.sounds {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sounds li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-2);
}

.snd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.snd-tools {
  display: flex;
  gap: 4px;
  flex: none;
}

.bubble-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bubble-controls {
  display: flex;
  gap: 14px;
  align-items: center;
}

.accent-input {
  width: 40px;
  height: 26px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
}

.bubble-sample {
  align-self: center;
  max-width: 86%;
  padding: 8px 13px;
  border-radius: 12px;
  border: 1px solid rgba(20, 24, 32, 0.1);
  font: 13px/1.5 'Segoe UI', 'Microsoft YaHei', sans-serif;
  text-align: center;
}

.sample-light {
  background: rgba(255, 255, 255, 0.97);
  color: #5c4452; /* 浅色气泡在游戏里的实际观感：白底深字（不用主题变量） */
}

.sample-dark {
  background: rgba(29, 26, 22, 0.96);
  color: var(--text);
  border-color: rgba(255, 255, 255, 0.14);
}

select {
  font: inherit;
  background: var(--border-soft);
  color: var(--text);
  border: none;
  border-radius: 6px;
  padding: 5px 8px;
}

.motion-select {
  max-width: 240px;
}

.desc {
  color: var(--text-3);
  font-size: 12px;
}

.hint {
  margin-top: auto;
}

button.primary,
button.ghost {
  font: inherit;
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
}

button.primary {
  background: var(--accent);
  color: var(--accent-ink);
}

button.ghost {
  background: var(--border-soft);
  color: var(--text);
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

.mini {
  font-size: 12px;
  padding: 2px 10px;
  background: var(--border-soft);
  color: var(--text);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.mini.del {
  color: var(--danger);
}

/* 动作选择抽屉 */
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: rgba(92, 68, 82, 0.38);
  display: flex;
  align-items: center;
  justify-content: center;
}

.drawer {
  width: min(560px, 92vw);
  max-height: 80vh;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 10px 36px var(--accent-shadow);
}

.drawer > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-soft);
}

.drawer-groups {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 10px 12px 0;
}

.group-chip {
  font: inherit;
  font-size: 12px;
  padding: 4px 12px;
  border: none;
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-2);
  cursor: pointer;
}

.group-chip.on {
  background: var(--accent);
  color: var(--accent-ink);
}

.drawer-entries {
  list-style: none;
  margin: 0;
  padding: 8px 12px 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--bg);
  cursor: pointer;
}

.entry:hover {
  background: var(--panel-2);
}

.entry.on {
  outline: 1px solid var(--accent);
  background: var(--accent-tint);
}

.entry.unplayable {
  opacity: 0.55;
  cursor: default;
}

.entry .idx {
  font-family: Consolas, monospace;
  color: var(--ok);
  min-width: 28px;
  text-align: right;
}

.entry .txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.entry .txt em {
  font-style: normal;
  color: var(--text-3);
  font-size: 12px;
  word-break: break-all;
}

.entry .dur {
  font-size: 11px;
  color: var(--text-4);
  flex: none;
}

.entry .snd {
  flex: none;
  font-size: 12px;
}

.entry .noplay {
  font-size: 11px;
  color: #f0a58f;
  flex: none;
}
</style>
