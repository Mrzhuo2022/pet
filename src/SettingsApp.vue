<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
// confirm 必须用插件的异步 API：dialog 插件的 init 脚本把 window.confirm 覆盖成了
// async 函数（返回 Promise，恒为真值），同步 if 判断等于跳过确认直接执行
import { confirm, open, save } from '@tauri-apps/plugin-dialog';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import { enable as enableAutoStart, disable as disableAutoStart, isEnabled as isAutoStartEnabled } from '@tauri-apps/plugin-autostart';
import PackEditor from './PackEditor.vue';
import AppToast from './settings/AppToast.vue';
import PackCard from './settings/PackCard.vue';
import PetCard from './settings/PetCard.vue';
import { toast } from './settings/toast';
import { buildSheet, bitmapFromBytes, base64ToBytes, dataUrlToBase64, decodeGifFrames } from './pet/imaging';
import { coverFor, invalidateCover } from './pet/cover';
import { filterSortPacks, loadPackList, loadSettings, type PackEntry, type PackSort, type PetInfo } from './pet/petpack';
import { summarizePack, type PackSummary } from './pet/packSummary';
import type { WalkFreq } from './pet/types';

/**
 * 布局：左栏 = 宠物卡片列表 + 全局入口；右栏 = 选中桌宠的设置 / 全局设置 / 皮肤库 / 关于。
 * 皮肤库的"作用于"上下文锁定到某只桌宠（从它的设置页"更换皮肤"进来），不再有"当前编辑"概念。
 */
type View = 'pet' | 'global' | 'packs' | 'about';
const view = ref<View>('pet');

// 无边框窗口的自绘标题栏控制按钮（浏览器预览无后端时降级为 no-op）
const settingsWin = (() => {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
})();
function minimizeWindow(): void {
  void settingsWin?.minimize();
}
function closeWindow(): void {
  void settingsWin?.close();
}

const packs = ref<PackEntry[]>([]);
const thumbs = ref<Record<string, string | null>>({});
const busy = ref(false);
const editing = ref<PackEntry | null>(null);

// ---------- 皮肤页：搜索 / 排序 / 导入进度 / 整窗拖拽 ----------
const packQuery = ref('');
const packSort = ref<PackSort>('name');
const importProgress = ref<{ done: number; total: number; current: string } | null>(null);
const dropActive = ref(false);
const visiblePacks = computed(() => filterSortPacks(packs.value, packQuery.value, packSort.value));
const importPct = computed(() => {
  const p = importProgress.value;
  return p && p.total > 0 ? `${Math.round((p.done / p.total) * 100)}%` : '0%';
});
// 详情面板：展开的包 id + 会话内摘要缓存（'loading' = 抓取中，null = 失败）
const expandedPackId = ref('');
const packDetails = ref<Record<string, PackSummary | 'loading' | null>>({});

// ---------- 多桌宠 ----------
const pets = ref<PetInfo[]>([]);
const selectedId = ref('');
/** 添加桌宠弹窗：打开中 + 选中的皮肤 id（会话内记住上次选择） */
const addOpen = ref(false);
const addPickId = ref('');
const addDlgEl = ref<HTMLDivElement | null>(null);
/** 皮肤库当前作用对象（点皮肤 = 给这只换装） */
const packsTargetId = ref('');
/** 桌宠窗口在线状态（Rust 查询可见窗口集合） */
const onlineIds = ref<Set<string>>(new Set());
const onlineKnown = ref(false);

// 当前桌宠设置表单
const scalePercent = ref(100);
const lockPosition = ref(false);
const alwaysOnTop = ref(true);
const soundEnabled = ref(true);
const bubbleEnabled = ref(true);
const ambientEnabled = ref(true);
const flingEnabled = ref(true);
const gazeEnabled = ref(true);
const followEnabled = ref(false);
const groundEnabled = ref(true);
const roamEnabled = ref(true);
const walkFreq = ref<WalkFreq>('normal');
const walkSpeed = ref(55);

// 全局设置（作用于全部桌宠）
const volumePercent = ref(60);
const bubbleSeconds = ref(2.5);
const gravity = ref(3000);
const bouncePercent = ref(45);
const flingMinSpeed = ref(220);
const ambientIntervalSec = ref(40);
const autoStart = ref(false);

const FREQ_TEXT: Record<WalkFreq, string> = {
  quiet: '安静',
  normal: '普通',
  lively: '活泼',
};

/** 步速的定性描述，与数值一起展示 */
const speedLabel = computed(() =>
  walkSpeed.value <= 35 ? '悠闲' : walkSpeed.value <= 75 ? '普通' : '小跑',
);

const selectedPet = computed(
  () => pets.value.find((p) => p.id === selectedId.value) ?? null,
);

const targetPet = computed(
  () => pets.value.find((p) => p.id === packsTargetId.value) ?? pets.value[0] ?? null,
);

const targetPackId = computed(() => {
  const p = targetPet.value;
  return p ? (packOf(p)?.id ?? '') : '';
});

const targetPackName = computed(() => {
  const p = targetPet.value;
  return p ? (packOf(p)?.name ?? '') : '';
});

function packOf(pet: PetInfo): PackEntry | undefined {
  return (
    packs.value.find((p) => p.id === pet.petpack) ??
    (!pet.petpack ? packs.value[0] : undefined)
  );
}

/** 桌宠显示名：自定义名优先，缺省回退「皮肤名 · 序号」 */
function petLabel(pet: PetInfo): string {
  if (pet.displayName) return pet.displayName;
  const name = packOf(pet)?.name ?? '默认皮肤';
  const same = pets.value.filter(
    (p) => !p.displayName && (packOf(p)?.name ?? '默认皮肤') === name,
  );
  return `${name} · ${same.indexOf(pet) + 1}`;
}

function thumbFor(pet: PetInfo): string | null {
  const pack = packOf(pet);
  return pack ? (thumbs.value[pack.id] ?? null) : null;
}

function isOnline(pet: PetInfo): boolean {
  return !onlineKnown.value || onlineIds.value.has(pet.id);
}

/** 查询当前可见的桌宠窗口集合（Rust 侧逐窗口 is_visible） */
async function refreshOnline(): Promise<void> {
  try {
    onlineIds.value = new Set(await invoke<string[]>('pet_visibility'));
    onlineKnown.value = true;
  } catch {
    // Rust 侧不可用（浏览器调试）时保持"都在线"的默认展示
  }
}

const selectedLabel = computed(() =>
  selectedPet.value ? petLabel(selectedPet.value) : '—',
);

/** 把当前桌宠/全局设置回填到表单 */
function syncForm(): void {
  const p = selectedPet.value;
  if (p) {
    scalePercent.value = Math.round((p.scale ?? 1) * 100);
    lockPosition.value = p.lockPosition;
    soundEnabled.value = p.soundEnabled;
    bubbleEnabled.value = p.bubbleEnabled;
    ambientEnabled.value = p.ambientEnabled;
    flingEnabled.value = p.flingEnabled;
    gazeEnabled.value = p.gazeEnabled;
    followEnabled.value = p.followEnabled;
    groundEnabled.value = p.groundEnabled;
    roamEnabled.value = p.roamEnabled;
    walkFreq.value = p.walkFreq;
    walkSpeed.value = Math.round(p.walkSpeed);
  }
}

function selectPet(id: string): void {
  if (!pets.value.some((p) => p.id === id)) return;
  selectedId.value = id;
  view.value = 'pet';
  syncForm();
}

/** 滑杆已填充段比例：把当前值写入元素 --fill 变量（渐变填充样式用） */
function syncRangeFills(): void {
  for (const el of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    const min = Number(el.min) || 0;
    const max = Number(el.max);
    const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--fill', `${pct}%`);
  }
}

/** 进入皮肤库；target 有值 = 由"更换皮肤"进入，锁定作用对象 */
function openPacks(target?: string): void {
  if (target) packsTargetId.value = target;
  else if (!pets.value.some((p) => p.id === packsTargetId.value)) {
    packsTargetId.value = selectedId.value || pets.value[0]?.id || '';
  }
  view.value = 'packs';
}

async function refreshPets(): Promise<void> {
  const s = await loadSettings();
  pets.value = s.pets;
  volumePercent.value = Math.round(s.volume * 100);
  bubbleSeconds.value = Math.round(s.bubbleMs / 100) / 10;
  gravity.value = Math.round(s.gravity);
  bouncePercent.value = Math.round(s.bounceRestitution * 100);
  flingMinSpeed.value = Math.round(s.flingMinSpeed);
  ambientIntervalSec.value = s.ambientIntervalSec;
  alwaysOnTop.value = s.alwaysOnTop;
  if (!pets.value.some((p) => p.id === selectedId.value)) {
    selectedId.value = pets.value[0]?.id ?? '';
  }
  if (!pets.value.some((p) => p.id === packsTargetId.value)) {
    packsTargetId.value = selectedId.value || pets.value[0]?.id || '';
  }
  syncForm();
  syncRangeFills();
}

onMounted(async () => {
  await refresh();
  // 滑杆拖动时实时更新填充色（委托监听，覆盖视图切换后的所有滑杆）
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && el.type === 'range') syncRangeFills();
  });
  try {
    autoStart.value = await isAutoStartEnabled();
  } catch {
    autoStart.value = false;
  }
  // 右键菜单"复制这只"等外部改动后刷新桌宠列表
  void listen('pets-changed', () => {
    void refreshPets();
    void refreshOnline();
  });
  // 右键菜单"更多设置…"定位到对应桌宠
  try {
    const focus = await invoke<string | null>('take_settings_focus');
    if (focus) selectPet(focus);
  } catch {
    // 旧后端/浏览器调试时忽略
  }
  void listen<string>('focus-pet', (e) => selectPet(e.payload));
  // 右键菜单直接改设置时同步当前表单
  void listen<PetInfo>('pet-changed', (e) => {
    const idx = pets.value.findIndex((p) => p.id === e.payload.id);
    if (idx >= 0) pets.value[idx] = e.payload;
    if (e.payload.id === selectedId.value) syncForm();
  });
  // "隐藏这只"后延迟刷新在线状态（等窗口真正 hide）
  void listen<string>('pet-hidden', () => {
    window.setTimeout(() => void refreshOnline(), 400);
  });
  // 在线状态兜底轮询（托盘显示/隐藏全部不发事件）
  window.setInterval(() => void refreshOnline(), 5000);
  void refreshOnline();
  // 导入进度（Rust 逐文件 emit）：顶部细进度条，结束后停留一小会再收起
  let progressSeq = 0;
  void listen<{ done: number; total: number; current: string }>('import-progress', (e) => {
    const seq = ++progressSeq;
    importProgress.value = e.payload;
    if (e.payload.total > 0 && e.payload.done >= e.payload.total) {
      window.setTimeout(() => {
        if (progressSeq === seq) importProgress.value = null;
      }, 600);
    }
  });
  // 整窗拖拽导入（Tauri 原生 drag-drop 事件，文件夹/zip/png/gif 按扩展名分流）
  getCurrentWebview()
    .onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type === 'enter') {
        if (p.paths.length) dropActive.value = true;
      } else if (p.type === 'leave') {
        dropActive.value = false;
      } else if (p.type === 'drop') {
        dropActive.value = false;
        void importDropped(p.paths);
      }
    })
    .catch(() => {
      // 浏览器调试环境无原生拖拽事件
    });
});

async function refresh(): Promise<void> {
  try {
    packs.value = await loadPackList();
    // 封面：优先读已落盘文件，缺失的现场渲染生成（并发限流在 cover 模块内）
    await Promise.all(
      packs.value.map(async (p) => {
        thumbs.value[p.id] = await coverFor(p).catch(() => null);
      }),
    );
    await refreshPets();
  } catch (e) {
    toast(`加载皮肤列表失败：${e}`, 'error');
  }
}

// ---------- 桌宠设置 ----------

/** 更新任意一只桌宠（Rust 落盘并广播 pet-changed，由桌宠窗口热应用） */
async function updatePet(id: string, patch: Record<string, unknown>): Promise<PetInfo | null> {
  try {
    const updated = await invoke<PetInfo>('update_pet', { id, patch });
    const idx = pets.value.findIndex((x) => x.id === updated.id);
    if (idx >= 0) pets.value[idx] = updated;
    if (id === selectedId.value) syncForm();
    return updated;
  } catch (e) {
    toast(`设置失败：${e}`, 'error');
    return null;
  }
}

/** 更新当前表单对应的桌宠 */
function updateSelected(patch: Record<string, unknown>): Promise<PetInfo | null> {
  const p = selectedPet.value;
  return p ? updatePet(p.id, patch) : Promise.resolve(null);
}

function onScaleChange(): void {
  void updateSelected({ scale: scalePercent.value / 100 });
  toast(`「${selectedLabel.value}」大小已调整为 ${scalePercent.value}%`);
}

function onLockChange(): void {
  void updateSelected({ lockPosition: lockPosition.value });
  toast(lockPosition.value ? '已锁定位置（无法拖动桌宠）' : '已解锁位置');
}

/** 左栏卡片上的快捷开关 */
function onCardToggle(pet: PetInfo, field: 'lock' | 'sound' | 'bubble'): void {
  const patch =
    field === 'lock'
      ? { lockPosition: !pet.lockPosition }
      : field === 'sound'
        ? { soundEnabled: !pet.soundEnabled }
        : { bubbleEnabled: !pet.bubbleEnabled };
  void updatePet(pet.id, patch);
  if (field === 'lock') {
    toast(patch.lockPosition ? `「${petLabel(pet)}」已锁定位置` : `「${petLabel(pet)}」已解锁位置`);
  }
}

// ---------- 重命名输入框（替代 window.prompt：原生对话框在本应用里不可靠，且样式不统一） ----------
const nameDialog = ref<{ title: string; value: string; resolve: (v: string | null) => void } | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);

/** 弹出输入框；确定返回去空白的文本（可为空串），取消返回 null */
function askName(title: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    nameDialog.value = { title, value: initial, resolve };
    void nextTick(() => nameInput.value?.focus());
  });
}

function settleName(ok: boolean): void {
  const d = nameDialog.value;
  if (!d) return;
  nameDialog.value = null;
  d.resolve(ok ? d.value.trim() : null);
}

/** 给桌宠起名（displayName）；留空恢复默认「皮肤名 · 序号」 */
async function renamePet(pet: PetInfo): Promise<void> {
  const name = await askName(`给「${petLabel(pet)}」起个名字（留空恢复默认）`, pet.displayName ?? '');
  if (name === null) return;
  if ((pet.displayName ?? '') === name) return;
  const updated = await updatePet(pet.id, { displayName: name });
  if (updated) toast(name ? `已改名为「${name}」` : '已恢复默认名称');
}

async function onTopChange(): Promise<void> {
  try {
    await invoke('update_global_prefs', { patch: { alwaysOnTop: alwaysOnTop.value } });
    toast(alwaysOnTop.value ? '全部桌宠已置顶' : '已取消置顶（可被其他窗口遮挡）');
  } catch (e) {
    toast(`设置失败：${e}`, 'error');
  }
}

function onRoamChange(): void {
  void updateSelected({ roamEnabled: roamEnabled.value });
}

function onFreqChange(freq: WalkFreq): void {
  if (walkFreq.value === freq || !roamEnabled.value) return;
  walkFreq.value = freq;
  void updateSelected({ walkFreq: freq });
  toast(`走动频率：${FREQ_TEXT[freq]}`);
}

function onWalkSpeedChange(): void {
  void updateSelected({ walkSpeed: walkSpeed.value });
}

function onSoundChange(): void {
  void updateSelected({ soundEnabled: soundEnabled.value });
}

function onBubbleChange(): void {
  void updateSelected({ bubbleEnabled: bubbleEnabled.value });
}

function onAmbientChange(): void {
  void updateSelected({ ambientEnabled: ambientEnabled.value });
  toast(
    ambientEnabled.value
      ? '已开启待机闲聊：空闲时桌宠会自己说说话'
      : '已关闭待机闲聊',
  );
}

function onFlingChange(): void {
  void updateSelected({ flingEnabled: flingEnabled.value });
  toast(flingEnabled.value ? '已开启拖拽抛掷：甩出去会惯性滑行' : '已关闭拖拽抛掷');
}

function onGazeChange(): void {
  void updateSelected({ gazeEnabled: gazeEnabled.value });
}

function onFollowChange(): void {
  void updateSelected({ followEnabled: followEnabled.value });
  toast(followEnabled.value ? '已开启跟随鼠标：空闲时会慢慢走到鼠标旁边' : '已关闭跟随鼠标');
}

function onGroundChange(): void {
  void updateSelected({ groundEnabled: groundEnabled.value });
  toast(
    groundEnabled.value
      ? '已开启任务栏模式：桌宠会贴在任务栏上沿活动'
      : '已关闭任务栏模式',
  );
}

async function onResetPosition(): Promise<void> {
  const p = selectedPet.value;
  if (!p) return;
  try {
    await invoke('reset_pet_position', { id: p.id });
    toast('当前桌宠已回到初始位置');
  } catch (e) {
    toast(`重置失败：${e}`, 'error');
  }
}

// ---------- 全局设置 ----------

async function onAutoStartChange() {
  try {
    if (autoStart.value) {
      await enableAutoStart();
      toast('已开启开机自启');
    } else {
      await disableAutoStart();
      toast('已关闭开机自启');
    }
  } catch (e) {
    toast(`设置失败：${e}`, 'error');
  }
}

async function onVolumeChange(): Promise<void> {
  try {
    await invoke('update_global_prefs', { patch: { volume: volumePercent.value / 100 } });
    toast(`音量 ${volumePercent.value}%（全部桌宠）`);
  } catch (e) {
    toast(`设置失败：${e}`, 'error');
  }
}

async function onBubbleSecChange(): Promise<void> {
  try {
    await invoke('update_global_prefs', { patch: { bubbleMs: Math.round(bubbleSeconds.value * 1000) } });
  } catch (e) {
    toast(`设置失败：${e}`, 'error');
  }
}

async function onAmbientIntervalChange(): Promise<void> {
  try {
    await invoke('update_global_prefs', { patch: { ambientIntervalSec: ambientIntervalSec.value } });
  } catch (e) {
    toast(`设置失败：${e}`, 'error');
  }
}

async function onGravityChange(): Promise<void> {
  try {
    await invoke('update_global_prefs', { patch: { gravity: gravity.value } });
    toast(`重力 ${gravity.value} px/s²（全部桌宠）`);
  } catch (e) {
    toast(`设置失败：${e}`, 'error');
  }
}

async function onBounceChange(): Promise<void> {
  try {
    await invoke('update_global_prefs', {
      patch: { bounceRestitution: bouncePercent.value / 100 },
    });
  } catch (e) {
    toast(`设置失败：${e}`, 'error');
  }
}

async function onFlingMinChange(): Promise<void> {
  try {
    await invoke('update_global_prefs', { patch: { flingMinSpeed: flingMinSpeed.value } });
  } catch (e) {
    toast(`设置失败：${e}`, 'error');
  }
}

// ---------- 多宠管理 ----------

/** 皮肤被多少只桌宠使用（添加弹窗的小徽标） */
function packUsage(packId: string): number {
  return pets.value.filter((p) => packOf(p)?.id === packId).length;
}

function openAddDialog(): void {
  if (busy.value || pets.value.length >= 6) return;
  addPickId.value = packs.value.some((p) => p.id === addPickId.value)
    ? addPickId.value
    : (packs.value[0]?.id ?? '');
  addOpen.value = true;
  void nextTick(() => addDlgEl.value?.focus());
}

/** 按弹窗里选中的皮肤创建桌宠；成功后选中新桌宠并关闭弹窗 */
async function confirmAdd(): Promise<void> {
  if (busy.value || !addPickId.value) return;
  busy.value = true;
  try {
    const pet = await invoke<PetInfo>('add_pet', { petpack: addPickId.value });
    addOpen.value = false;
    await refreshPets();
    selectPet(pet.id);
    toast(`已添加「${petLabel(pet)}」，可在下方调整或更换皮肤`);
  } catch (e) {
    toast(`添加失败：${e}`, 'error');
  } finally {
    busy.value = false;
  }
}

/** 从添加弹窗跳去皮肤库导入 */
function gotoPacksFromAdd(): void {
  addOpen.value = false;
  openPacks();
}

async function duplicateSelected(): Promise<void> {
  const p = selectedPet.value;
  if (!p || busy.value) return;
  busy.value = true;
  try {
    const pet = await invoke<PetInfo>('duplicate_pet', { id: p.id });
    await refreshPets();
    selectPet(pet.id);
    toast(`已复制一只桌宠（${petLabel(pet)}）`);
  } catch (e) {
    toast(`复制失败：${e}`, 'error');
  } finally {
    busy.value = false;
  }
}

async function removeSelected(): Promise<void> {
  const p = selectedPet.value;
  if (!p || busy.value) return;
  // busy 在确认前置位：双击不会叠出两个确认框
  busy.value = true;
  try {
    const ok = await confirm(`确定移除「${petLabel(p)}」？`, {
      title: '移除桌宠',
      kind: 'warning',
      okLabel: '移除',
      cancelLabel: '取消',
    });
    if (!ok) return;
    await invoke('remove_pet', { id: p.id });
    await refreshPets();
    void refreshOnline();
    toast('已移除桌宠');
  } catch (e) {
    toast(`移除失败：${e}`, 'error');
  } finally {
    busy.value = false;
  }
}

// ---------- 皮肤管理 ----------

/** 给皮肤库当前作用对象换装 */
async function activate(p: PackEntry) {
  const pet = targetPet.value;
  if (busy.value || !pet || pet.petpack === p.id) return;
  busy.value = true;
  try {
    const updated = await updatePet(pet.id, { petpack: p.id });
    if (updated) toast(`「${petLabel(pet)}」已换上「${p.name}」`);
  } finally {
    busy.value = false;
  }
}

async function importZip() {
  const file = await open({
    multiple: false,
    filters: [{ name: 'Petpack 皮肤包 / Live2D 模型', extensions: ['zip'] }],
  });
  if (!file) return;
  busy.value = true;
  try {
    await importOne(() => invoke<{ id: string; name: string }>('import_petpack', { path: file }));
  } finally {
    busy.value = false;
  }
}

async function importFolder() {
  const dir = await open({ multiple: false, directory: true });
  if (!dir) return;
  busy.value = true;
  try {
    await importOne(() =>
      invoke<{ id: string; name: string }>('import_model_folder', { path: dir }),
    );
  } finally {
    busy.value = false;
  }
}

/** 跑一次导入命令：成功后刷新列表并提示，失败弹错误 toast */
async function importOne(run: () => Promise<{ id: string; name: string }>): Promise<void> {
  try {
    const info = await run();
    await refresh();
    toast(`已导入「${info.name}」，点击列表启用`);
  } catch (e) {
    toast(`导入失败：${e}`, 'error');
  }
}

/** 整窗拖拽导入：按扩展名分流（文件夹 / zip / png / gif），逐个处理 */
async function importDropped(paths: string[]): Promise<void> {
  if (busy.value || !paths.length) return;
  const dirs: string[] = [];
  const zips: string[] = [];
  const pngs: string[] = [];
  const gifs: string[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (lower.endsWith('.zip')) zips.push(p);
    else if (lower.endsWith('.png')) pngs.push(p);
    else if (lower.endsWith('.gif')) gifs.push(p);
    else dirs.push(p); // 文件夹（无扩展名）→ 交由模型文件夹导入校验
  }
  if (!dirs.length && !zips.length && !pngs.length && !gifs.length) return;
  busy.value = true;
  try {
    for (const p of dirs) {
      await importOne(() => invoke<{ id: string; name: string }>('import_model_folder', { path: p }));
    }
    for (const p of zips) {
      await importOne(() => invoke<{ id: string; name: string }>('import_petpack', { path: p }));
    }
    if (pngs.length) await importFramesFromPaths(pngs);
    for (const p of gifs) await importFramesFromPaths([p], true);
  } finally {
    busy.value = false;
  }
}

async function editManifest(p: PackEntry) {
  if (!p.dirPath) return;
  try {
    // Windows 下正斜杠路径 openPath 也能处理
    await openPath(`${p.dirPath.replace(/\\/g, '/')}/petpack.json`);
  } catch (e) {
    toast(`打开失败：${e}`, 'error');
  }
}

async function reloadPack(p: PackEntry) {
  if (busy.value) return;
  busy.value = true;
  try {
    await emit('petpack-changed', { id: p.id });
    toast(`已重新加载「${p.name}」`);
  } finally {
    busy.value = false;
  }
}

function onEditorSaved(): void {
  const p = editing.value;
  editing.value = null;
  if (!p) return;
  delete packDetails.value[p.id]; // 详情缓存失效，重开面板重抓
  void (async () => {
    await emit('petpack-changed', { id: p.id });
    await refresh();
    toast(`「${p.name}」已保存并热重载`);
  })();
}

async function remove(p: PackEntry) {
  if (p.source !== 'user' || busy.value) return;
  busy.value = true;
  try {
    const ok = await confirm(`确定删除皮肤包「${p.name}」？`, {
      title: '删除皮肤包',
      kind: 'warning',
      okLabel: '删除',
      cancelLabel: '取消',
    });
    if (!ok) return;
    await invoke('delete_petpack', { id: p.id });
    invalidateCover(p.id);
    delete packDetails.value[p.id];
    if (expandedPackId.value === p.id) expandedPackId.value = '';
    await refresh();
    toast(`已删除「${p.name}」`);
  } catch (e) {
    toast(`删除失败：${e}`, 'error');
  } finally {
    busy.value = false;
  }
}

/** 重命名皮肤包：改写 petpack.json 的 name，列表与桌宠标签随之同步 */
async function renamePack(p: PackEntry): Promise<void> {
  const name = await askName('新的皮肤名称', p.name);
  if (name === null) return;
  if (!name || name === p.name) return;
  try {
    await invoke('rename_petpack', { id: p.id, name });
    await refresh();
    toast(`已重命名为「${name}」`);
  } catch (e) {
    toast(`重命名失败：${e}`, 'error');
  }
}

/** 在资源管理器中打开皮肤包目录 */
async function openPackFolder(p: PackEntry): Promise<void> {
  if (!p.dirPath) return;
  try {
    // Windows 下正斜杠路径 openPath 也能处理
    await openPath(p.dirPath.replace(/\\/g, '/'));
  } catch (e) {
    toast(`打开失败：${e}`, 'error');
  }
}

/** 展开/收起皮肤包详情（摘要按会话缓存；编辑器保存后由 onEditorSaved 失效） */
async function toggleDetails(p: PackEntry): Promise<void> {
  if (expandedPackId.value === p.id) {
    expandedPackId.value = '';
    return;
  }
  expandedPackId.value = p.id;
  const cached = packDetails.value[p.id];
  if (cached && cached !== 'loading') return;
  packDetails.value[p.id] = 'loading';
  packDetails.value[p.id] = await summarizePack(p).catch(() => null);
}

async function exportPack(p: PackEntry) {
  if (p.source !== 'user' || busy.value) return;
  const dest = await save({
    defaultPath: `${p.id}.zip`,
    filters: [{ name: 'Petpack 皮肤包', extensions: ['zip'] }],
  });
  if (!dest) return;
  busy.value = true;
  try {
    await invoke('export_petpack', { id: p.id, dest });
    toast(`已导出到 ${dest}`);
  } catch (e) {
    toast(`导出失败：${e}`, 'error');
  } finally {
    busy.value = false;
  }
}

/** 由图片帧创建精灵图皮肤包（前端拼 sheet，Rust 落盘） */
async function createFromFrames(name: string, frames: ImageBitmap[]): Promise<void> {
  const sheet = buildSheet(frames);
  const frameIdx = Array.from({ length: sheet.frames }, (_, i) => i);
  const manifest = {
    name,
    version: '1.0.0',
    engine: 'sprite',
    sprite: { sheet: 'sheet.png', frameW: sheet.frameW, frameH: sheet.frameH, cols: sheet.cols },
    animations: {
      idle: { frames: frameIdx, fps: sheet.frames > 1 ? 6 : 1, loop: true },
    },
    interactions: { clickTexts: ['戳我干嘛？', '(·ω·)'] },
    generated: true,
  };
  await invoke<{ id: string; name: string }>('create_sprite_pack', {
    name,
    sheetBase64: dataUrlToBase64(sheet.dataUrl),
    frameW: sheet.frameW,
    frameH: sheet.frameH,
    cols: sheet.cols,
    manifest: JSON.stringify(manifest),
  });
}

/** 从文件路径导入图片帧（png 多张 = 动画、单张 = 静态）或 GIF（自动抽帧） */
async function importFramesFromPaths(list: string[], gif = false): Promise<void> {
  if (!list.length) return;
  try {
    const frames: ImageBitmap[] = [];
    for (const f of list) {
      const b64 = await invoke<string>('read_file_base64', { path: f });
      const bytes = base64ToBytes(b64);
      if (gif) frames.push(...(await decodeGifFrames(bytes)));
      else frames.push(await bitmapFromBytes(bytes, 'image/png'));
    }
    const stem = list[0]!.replace(/\\/g, '/').split('/').pop()!.replace(/\.(png|gif)$/i, '');
    await createFromFrames(stem + (list.length > 1 ? ` ×${list.length}` : ''), frames);
    await refresh();
    toast(`已导入「${stem}」，点击列表启用`);
  } catch (e) {
    toast(`导入失败：${e}`, 'error');
  }
}

async function importImages(): Promise<void> {
  const files = await open({
    multiple: true,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (!files) return;
  const list = Array.isArray(files) ? files : [files];
  if (list.length > 64) {
    toast('最多 64 帧', 'error');
    return;
  }
  busy.value = true;
  try {
    await importFramesFromPaths(list);
  } finally {
    busy.value = false;
  }
}

async function importGif(): Promise<void> {
  const file = await open({
    multiple: false,
    filters: [{ name: 'GIF 动图', extensions: ['gif'] }],
  });
  if (!file) return;
  busy.value = true;
  try {
    await importFramesFromPaths([file], true);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="settings">
    <!-- 导入进度条（Rust 逐文件 emit 的 import-progress 事件） -->
    <div v-if="importProgress" class="import-progress" :title="importProgress.current">
      <div class="import-fill" :style="{ width: importPct }"></div>
    </div>

    <!-- 整窗拖拽导入遮罩（原生 drag-drop，不拦截落点） -->
    <div v-if="dropActive" class="drop-mask">
      <div class="drop-hint">松开鼠标导入皮肤（文件夹 / zip / PNG / GIF）</div>
    </div>

    <!-- 自绘标题栏（窗口无边框）：拖拽区 + 最小化/关闭 -->
    <div class="titlebar" data-tauri-drag-region>
      <span class="tb-title" data-tauri-drag-region>
        <!-- 粉色像素史莱姆小图标（与内置皮肤同款造型） -->
        <svg class="tb-slime" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M12 4c5 0 8 4.2 8 9.5 0 2.5-1.6 4.5-4 4.5H8c-2.4 0-4-2-4-4.5C4 8.2 7 4 12 4Z"
            fill="#f08ab4"
            stroke="#b24a7a"
            stroke-width="1.6"
            stroke-linejoin="round"
          />
          <path
            d="M8.2 8.8c.6-1.5 1.7-2.5 3-2.9"
            fill="none"
            stroke="#ffd9ea"
            stroke-width="1.6"
            stroke-linecap="round"
          />
          <rect x="9" y="12" width="1.9" height="3.1" rx="0.95" fill="#2c2030" />
          <rect x="13.1" y="12" width="1.9" height="3.1" rx="0.95" fill="#2c2030" />
          <path
            d="M10.8 16.6c.4.5.8.7 1.2.7s.8-.2 1.2-.7"
            fill="none"
            stroke="#2c2030"
            stroke-width="1.2"
            stroke-linecap="round"
          />
        </svg>
        Pet 桌宠 · 设置
      </span>
      <div class="tb-actions">
        <button class="tb-btn" title="最小化" @click="minimizeWindow">
          <svg viewBox="0 0 12 12" width="12" height="12">
            <path d="M2 6h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>
        <button class="tb-btn close" title="关闭" @click="closeWindow">
          <svg viewBox="0 0 12 12" width="12" height="12">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>

    <div class="body">
    <!-- 左栏：桌宠卡片 + 全局入口 -->
    <aside class="sidebar">
      <div class="side-head">
        <span class="side-title">桌宠</span>
        <span class="side-count">{{ pets.length }}/6</span>
      </div>
      <div class="pet-list">
        <PetCard
          v-for="p in pets"
          :key="p.id"
          :label="petLabel(p)"
          :pack-name="packOf(p)?.name ?? '默认皮肤'"
          :thumb="thumbFor(p)"
          :selected="p.id === selectedId && view === 'pet'"
          :online="isOnline(p)"
          :lock-position="p.lockPosition"
          :sound-enabled="p.soundEnabled"
          :bubble-enabled="p.bubbleEnabled"
          @select="selectPet(p.id)"
          @rename="renamePet(p)"
          @toggle="(f) => onCardToggle(p, f)"
        />
      </div>
      <div class="side-foot">
        <button
          class="primary add"
          :disabled="busy || pets.length >= 6"
          :title="pets.length >= 6 ? '最多同时显示 6 只桌宠' : '选一个皮肤添加'"
          @click="openAddDialog"
        >
          ＋ 添加桌宠
        </button>
        <button :class="{ 'nav-item': true, on: view === 'global' }" @click="view = 'global'">
          全局设置
        </button>
        <button :class="{ 'nav-item': true, on: view === 'packs' }" @click="openPacks()">
          皮肤库
        </button>
        <button :class="{ 'nav-item': true, on: view === 'about' }" @click="view = 'about'">
          关于
        </button>
      </div>
    </aside>

    <!-- 右栏内容 -->
    <main class="content">
      <!-- 桌宠设置 -->
      <section v-if="view === 'pet' && selectedPet" class="pane">
        <div class="pane-head">
          <div class="pane-title">
            <b>{{ selectedLabel }}</b>
            <span class="desc">这里的设置只作用于这只桌宠</span>
          </div>
          <button class="primary" @click="openPacks(selectedPet.id)">更换皮肤</button>
        </div>

        <div class="groups">
          <div class="group">
            <h3 class="group-title">外观</h3>
            <div class="row">
              <div class="row-main">
                <b>桌宠大小</b>
                <span class="desc">缩放（20%–200%），立即生效并自动记忆</span>
              </div>
              <div class="side">
                <input
                  v-model.number="scalePercent"
                  type="range"
                  min="20"
                  max="200"
                  step="5"
                  @change="onScaleChange"
                />
                <span class="pct">{{ scalePercent }}%</span>
              </div>
            </div>
          </div>

          <div class="group">
            <h3 class="group-title">行为</h3>
            <label class="row clickable">
              <div class="row-main">
                <b>自动走动</b>
                <span class="desc">空闲一段时间后在桌面上散步，点击或拖动会立即打断</span>
              </div>
              <input v-model="roamEnabled" type="checkbox" @change="onRoamChange" />
            </label>
            <div :class="{ row: true, sub: true, off: !roamEnabled }">
              <div class="row-main">
                <b>走动频率</b>
                <span class="desc">安静很少起身，活泼会经常起来溜达</span>
              </div>
              <div class="seg">
                <button
                  v-for="f in (['quiet', 'normal', 'lively'] as WalkFreq[])"
                  :key="f"
                  :class="{ on: walkFreq === f }"
                  :disabled="!roamEnabled"
                  @click="onFreqChange(f)"
                >
                  {{ FREQ_TEXT[f] }}
                </button>
              </div>
            </div>
            <div :class="{ row: true, sub: true, off: !roamEnabled }">
              <div class="row-main">
                <b>走动速度</b>
                <span class="desc">散步的步速，速度拉满会变成小跑</span>
              </div>
              <div class="side">
                <input
                  v-model.number="walkSpeed"
                  type="range"
                  min="20"
                  max="120"
                  step="5"
                  :disabled="!roamEnabled"
                  @change="onWalkSpeedChange"
                />
                <span class="pct wide">{{ walkSpeed }} px/s · {{ speedLabel }}</span>
              </div>
            </div>
            <label class="row clickable">
              <div class="row-main">
                <b>锁定位置</b>
                <span class="desc">开启后桌宠既不能被拖动，也不会自动走动</span>
              </div>
              <input v-model="lockPosition" type="checkbox" @change="onLockChange" />
            </label>
            <label class="row clickable">
              <div class="row-main">
                <b>拖拽抛掷</b>
                <span class="desc">甩出去会带惯性滑行一段，撞到屏幕边缘轻轻反弹</span>
              </div>
              <input v-model="flingEnabled" type="checkbox" @change="onFlingChange" />
            </label>
            <label class="row clickable">
              <div class="row-main">
                <b>跟随鼠标</b>
                <span class="desc">空闲时慢慢走到鼠标旁边，鼠标移动会实时改变路径（点击、拖拽、抛掷时让开；任务栏模式下沿地面水平走向鼠标）</span>
              </div>
              <input v-model="followEnabled" type="checkbox" @change="onFollowChange" />
            </label>
            <label class="row clickable">
              <div class="row-main">
                <b>任务栏模式</b>
                <span class="desc">桌宠贴着任务栏上沿活动：拖拽松手、抛掷停下后落到任务栏，走动和跟随都沿地面</span>
              </div>
              <input v-model="groundEnabled" type="checkbox" @change="onGroundChange" />
            </label>
          </div>

          <div class="group">
            <h3 class="group-title">互动</h3>
            <label class="row clickable">
              <div class="row-main">
                <b>点击音效</b>
                <span class="desc">点击桌宠时随机播放皮肤包里的音效</span>
              </div>
              <input v-model="soundEnabled" type="checkbox" @change="onSoundChange" />
            </label>
            <label class="row clickable">
              <div class="row-main">
                <b>点击气泡</b>
                <span class="desc">点击桌宠时随机弹出皮肤包配置的对话气泡</span>
              </div>
              <input v-model="bubbleEnabled" type="checkbox" @change="onBubbleChange" />
            </label>
            <label class="row clickable">
              <div class="row-main">
                <b>待机闲聊</b>
                <span class="desc">空闲时每隔一阵随机播一条动作和语音（有台词的皮肤会配气泡）</span>
              </div>
              <input v-model="ambientEnabled" type="checkbox" @change="onAmbientChange" />
            </label>
            <label class="row clickable">
              <div class="row-main">
                <b>视角跟随</b>
                <span class="desc">眼神看向鼠标方向，鼠标停下一会儿后会慢慢回正</span>
              </div>
              <input v-model="gazeEnabled" type="checkbox" @change="onGazeChange" />
            </label>
          </div>

          <div class="group">
            <h3 class="group-title">管理</h3>
            <div class="row">
              <div class="row-main">
                <b>窗口位置</b>
                <span class="desc">拖动或散步结束后自动记忆位置</span>
              </div>
              <button class="ghost" @click="onResetPosition">重置位置</button>
            </div>
            <div class="row">
              <div class="row-main">
                <b>复制这只</b>
                <span class="desc">再添一只同样偏好和大小的桌宠</span>
              </div>
              <button class="ghost" :disabled="busy || pets.length >= 6" @click="duplicateSelected">
                复制
              </button>
            </div>
            <div class="row">
              <div class="row-main">
                <b>移除这只</b>
                <span class="desc">从桌面移除（至少保留一只）</span>
              </div>
              <button class="ghost danger" :disabled="busy || pets.length <= 1" @click="removeSelected">
                移除
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 全局设置 -->
      <section v-else-if="view === 'global'" class="pane">
        <div class="pane-head">
          <div class="pane-title">
            <b>全局设置</b>
            <span class="desc">作用于全部桌宠</span>
          </div>
        </div>
        <div class="groups">
          <div class="group">
            <h3 class="group-title">声音与气泡</h3>
            <div class="row">
              <div class="row-main">
                <b>音量</b>
                <span class="desc">音效播放的音量大小（全部桌宠共用）</span>
              </div>
              <div class="side">
                <input
                  v-model.number="volumePercent"
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  @change="onVolumeChange"
                />
                <span class="pct">{{ volumePercent }}%</span>
              </div>
            </div>
            <div class="row">
              <div class="row-main">
                <b>气泡停留</b>
                <span class="desc">气泡在头顶停留的时长（全部桌宠共用）</span>
              </div>
              <div class="side">
                <input
                  v-model.number="bubbleSeconds"
                  type="range"
                  min="1"
                  max="6"
                  step="0.5"
                  @change="onBubbleSecChange"
                />
                <span class="pct wide">{{ bubbleSeconds.toFixed(1) }} 秒</span>
              </div>
            </div>
            <div class="row">
              <div class="row-main">
                <b>闲聊间隔</b>
                <span class="desc">空闲时桌宠隔多久可能自己说说话（最短间隔，实际随机浮动）</span>
              </div>
              <div class="side">
                <input
                  v-model.number="ambientIntervalSec"
                  type="range"
                  min="15"
                  max="180"
                  step="5"
                  @change="onAmbientIntervalChange"
                />
                <span class="pct wide">{{ ambientIntervalSec }} 秒起</span>
              </div>
            </div>
          </div>

          <div class="group">
            <h3 class="group-title">抛掷物理</h3>
            <div class="row">
              <div class="row-main">
                <b>重力</b>
                <span class="desc">抛出去后的下坠加速度（任务栏模式生效），越大摔得越快</span>
              </div>
              <div class="side">
                <input
                  v-model.number="gravity"
                  type="range"
                  min="1000"
                  max="8000"
                  step="250"
                  @change="onGravityChange"
                />
                <span class="pct wide">{{ gravity }} px/s²</span>
              </div>
            </div>
            <div class="row">
              <div class="row-main">
                <b>弹性</b>
                <span class="desc">撞墙和落地时的反弹强度，0% 落地不弹直接趴下</span>
              </div>
              <div class="side">
                <input
                  v-model.number="bouncePercent"
                  type="range"
                  min="0"
                  max="80"
                  step="5"
                  @change="onBounceChange"
                />
                <span class="pct">{{ bouncePercent }}%</span>
              </div>
            </div>
            <div class="row">
              <div class="row-main">
                <b>抛掷门槛</b>
                <span class="desc">松手速度超过它才会惯性滑行，低于则直接落下（调低更容易甩飞）</span>
              </div>
              <div class="side">
                <input
                  v-model.number="flingMinSpeed"
                  type="range"
                  min="100"
                  max="500"
                  step="10"
                  @change="onFlingMinChange"
                />
                <span class="pct wide">{{ flingMinSpeed }} px/s</span>
              </div>
            </div>
          </div>

          <div class="group">
            <h3 class="group-title">窗口与系统</h3>
            <label class="row clickable">
              <div class="row-main">
                <b>窗口置顶</b>
                <span class="desc">统一设置所有桌宠窗口的置顶状态</span>
              </div>
              <input v-model="alwaysOnTop" type="checkbox" @change="onTopChange" />
            </label>
            <label class="row clickable">
              <div class="row-main">
                <b>开机自启</b>
                <span class="desc">登录 Windows 后自动运行全部桌宠</span>
              </div>
              <input v-model="autoStart" type="checkbox" @change="onAutoStartChange" />
            </label>
          </div>
        </div>
      </section>

      <!-- 皮肤库 -->
      <section v-else-if="view === 'packs'" class="pane">
        <template v-if="!editing">
          <div class="pane-head">
            <div class="ctx">
              <span class="desc">作用于</span>
              <select v-model="packsTargetId" title="点皮肤 = 给这只桌宠换装">
                <option v-for="p in pets" :key="p.id" :value="p.id">{{ petLabel(p) }}</option>
              </select>
              <span v-if="targetPackName" class="tag on">使用中：{{ targetPackName }}</span>
            </div>
          </div>

          <div class="pack-tools">
            <input v-model="packQuery" class="search" type="search" placeholder="搜索皮肤名称或 id…" />
            <select v-model="packSort" title="排序方式">
              <option value="name">按名称</option>
              <option value="engine">按引擎</option>
              <option value="recent">按导入时间</option>
            </select>
          </div>

          <div class="actions">
            <button class="primary" :disabled="busy" @click="importFolder">导入模型文件夹</button>
            <button class="primary ghost-btn" :disabled="busy" @click="importImages">导入图片帧</button>
            <button class="primary ghost-btn" :disabled="busy" @click="importGif">导入 GIF</button>
            <button class="primary ghost-btn" :disabled="busy" @click="importZip">导入 ZIP</button>
          </div>

          <p class="hint-line">也可以把模型文件夹 / zip / PNG / GIF 直接拖进本窗口导入</p>

          <ul class="packs">
            <PackCard
              v-for="p in visiblePacks"
              :key="p.id"
              :pack="p"
              :thumb="thumbs[p.id] ?? null"
              :active="p.id === targetPackId"
              :expanded="expandedPackId === p.id"
              :details="packDetails[p.id] ?? null"
              @activate="activate(p)"
              @details="toggleDetails(p)"
              @edit="editing = p"
              @export="exportPack(p)"
              @rename="renamePack(p)"
              @folder="openPackFolder(p)"
              @json="editManifest(p)"
              @reload="reloadPack(p)"
              @remove="remove(p)"
            />
          </ul>

          <p v-if="packs.length === 0" class="empty">
            暂无皮肤包。可导入 Live2D 模型文件夹、PNG 图片（多张=动画）、GIF 动图或含
            petpack.json 的皮肤 zip。
          </p>
          <p v-else-if="visiblePacks.length === 0" class="empty">没有匹配「{{ packQuery }}」的皮肤</p>

          <p class="hint">
            点击皮肤即给上方选中的桌宠换上；同一皮肤可以同时用在多只桌宠上。
            支持的导入方式：Live2D 模型文件夹（.model3.json 或解包的 model*.json）→ 自动生成配置；
            多张 PNG → 序列帧动画；单张 PNG → 静态桌宠；GIF → 自动抽帧。
            PSD 素材可先把各图层导出为 PNG 再批量导入。导入后点「编辑器」精调动作与文案。
          </p>
        </template>
        <PackEditor
          v-else
          :pack="editing"
          @saved="onEditorSaved"
          @cancel="editing = null"
        />
      </section>

      <!-- 关于 -->
      <section v-else class="pane">
        <h2>Pet 桌宠</h2>
        <p class="desc">v0.1.0 · Tauri 2 + Vue 3 + PixiJS + Live2D</p>
        <ul class="credits">
          <li>渲染：<a href="https://github.com/guansss/pixi-live2d-display" @click.prevent="openUrl('https://github.com/guansss/pixi-live2d-display')">pixi-live2d-display</a>（MIT）</li>
          <li>示例模型：Live2D 官方 Hiyori（仅开发测试用，分发前请确认 Cubism SDK 发布许可）</li>
          <li>设计参考：BongoCat、VPet、Shimeji</li>
        </ul>
      </section>
    </main>
    </div>
    <!-- /.body -->

    <!-- 添加桌宠：选皮肤弹窗（单击选中，双击直接添加，Enter 确认） -->
    <div v-if="addOpen" class="dlg-mask" @click.self="addOpen = false">
      <div ref="addDlgEl" class="dlg add-dlg" tabindex="-1" @keydown.esc="addOpen = false" @keydown.enter.prevent="confirmAdd">
        <b class="dlg-title">添加桌宠 · 选一个皮肤</b>
        <div v-if="packs.length" class="pick-grid">
          <button
            v-for="p in packs"
            :key="p.id"
            :class="{ pick: true, on: p.id === addPickId }"
            :title="p.name"
            @click="addPickId = p.id"
            @dblclick="confirmAdd"
          >
            <span class="pick-cover">
              <img v-if="thumbs[p.id]" :src="thumbs[p.id] ?? undefined" alt="" />
              <span v-else class="pick-ph">{{ p.engine === 'live2d' ? 'L2D' : 'SPR' }}</span>
              <span v-if="packUsage(p.id)" class="pick-used">已用 ×{{ packUsage(p.id) }}</span>
            </span>
            <span class="pick-name">{{ p.name }}</span>
          </button>
        </div>
        <p v-else class="empty">
          还没有可用皮肤。Live2D 模型文件夹、PNG 序列帧、GIF 或皮肤 zip 都能导入。
        </p>
        <div class="dlg-actions">
          <button class="ghost" @click="gotoPacksFromAdd">去皮肤库导入</button>
          <span class="dlg-space"></span>
          <button class="ghost" @click="addOpen = false">取消</button>
          <button class="primary" :disabled="busy || !addPickId" @click="confirmAdd">添加</button>
        </div>
      </div>
    </div>

    <!-- 重命名输入框（Enter 确定 / Esc 取消） -->
    <div v-if="nameDialog" class="dlg-mask" @click.self="settleName(false)">
      <div class="dlg">
        <b class="dlg-title">{{ nameDialog.title }}</b>
        <input
          ref="nameInput"
          v-model="nameDialog.value"
          type="text"
          maxlength="64"
          @keydown.enter.prevent="settleName(true)"
          @keydown.esc="settleName(false)"
        />
        <div class="dlg-actions">
          <button class="ghost" @click="settleName(false)">取消</button>
          <button class="primary" @click="settleName(true)">确定</button>
        </div>
      </div>
    </div>

    <AppToast />
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0;
  padding: 0;
  height: 100%;
  background: transparent;
}

/*
 * 设置窗口主题变量：KawaiiLogos 风格 —— 莓白底 + 樱花粉主色 + 圆润柔和。
 * 挂在 .settings 根元素上，窗口内所有组件（PetCard/PackCard/PackEditor/AppToast）
 * 都通过 var() 取色，改这里即全局换肤。
 */
.settings {
  --bg: #fdf5f9;          /* 主内容底（莓白） */
  --bg-side: #f9ecf3;     /* 侧栏底（浅樱） */
  --panel: #ffffff;       /* 卡片/设置行（纯白浮起） */
  --panel-hover: #fdf0f6; /* 卡片悬停 */
  --panel-2: #faf1f6;     /* 输入框/从属行/弹窗 */
  --panel-deep: #f4e3ed;  /* 缩略图底/分段轨道/进度槽 */
  --border: #f0c6da;      /* 强边框（弹窗/悬停描边） */
  --border-soft: #f6dfe9; /* 发丝线/输入框描边/次级按钮 */
  --text: #5c4452;        /* 主文字（深莓棕） */
  --text-2: #82687a;      /* 数值/次级 */
  --text-3: #a08797;      /* 说明文字 */
  --text-4: #bfa8b8;      /* 提示/占位 */
  --accent: #ee85b1;      /* 樱花粉主色 */
  --accent-strong: #f79cc4;
  --accent-ink: #ffffff;  /* 粉底上的文字（kawaii 白字） */
  --accent-tint: #fce9f2; /* 选中态粉色调底 */
  --accent-shadow: rgba(238, 133, 177, 0.35); /* 主按钮/弹窗的粉色柔影 */
  --danger: #e05e80;
  --danger-tint: #fdeef3;
  --ok: #5cb992;          /* 在线点/引擎标签（薄荷绿） */
}

/* 隐藏窗口内所有滚动条（列表/面板/编辑器）：滚轮滚动仍可用，视觉更干净 */
.settings *::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.settings * {
  scrollbar-width: none;
}

/* 滑杆：粉色已填充段 + 白圆拇指（原生 accent-color 的未填充段是深色，与浅色主题不符）。
   填充比例由 SettingsApp 挂载时的委托 input 监听写入每个元素的 --fill。 */
.settings input[type='range'] {
  -webkit-appearance: none;
  appearance: none;
  height: 18px;
  background: transparent;
  cursor: pointer;
}

.settings input[type='range']::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--accent) var(--fill, 50%),
    var(--panel-deep) var(--fill, 50%)
  );
}

.settings input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  margin-top: -5px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--accent);
  box-shadow: 0 1px 4px var(--accent-shadow);
}

.settings input[type='range']:disabled::-webkit-slider-thumb {
  border-color: var(--text-4);
  box-shadow: none;
}
</style>

<style scoped>
.settings {
  box-sizing: border-box;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 'Segoe UI', 'Microsoft YaHei', sans-serif;
}

/* ---------- 自绘标题栏（窗口无边框） ---------- */
.titlebar {
  flex: none;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: 14px;
  background: var(--bg-side);
  border-bottom: 1px solid var(--border-soft);
  user-select: none;
}

.tb-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.tb-slime {
  flex: none;
}

.tb-actions {
  display: flex;
  height: 100%;
}

.tb-btn {
  width: 44px;
  height: 100%;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  display: grid;
  place-items: center;
}

.tb-btn:hover {
  background: var(--panel-hover);
  color: var(--text);
}

.tb-btn.close:hover {
  background: var(--danger);
  color: #fff;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* ---------- 左栏 ---------- */
.sidebar {
  width: 224px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-side);
  border-right: 1px solid var(--border-soft);
}

.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 14px 8px;
}

.side-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-3);
}

.side-count {
  font-size: 11px;
  color: var(--text-4);
  font-variant-numeric: tabular-nums;
}

.pet-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.side-foot {
  padding: 10px;
  border-top: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.side-foot .add {
  margin-bottom: 6px;
}

.nav-item {
  font: inherit;
  font-size: 13px;
  text-align: left;
  border: none;
  background: transparent;
  color: var(--text-2);
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.nav-item:hover {
  background: var(--panel-2);
  color: var(--text);
}

.nav-item.on {
  background: var(--panel);
  color: var(--text);
}

/* ---------- 右栏 ---------- */
.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.pane {
  flex: 1;
  min-height: 0;
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.pane-title {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.pane-title b {
  font-size: 15px;
}

.ctx {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ctx select {
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  padding: 5px 8px;
  font: inherit;
  font-size: 12px;
}

/* 响应式分组：窗口拉宽时自动排成两列 */
.groups {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 12px;
  align-items: start;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
}

.row.clickable {
  cursor: pointer;
}

.row.clickable:hover {
  background: var(--panel-hover);
}

.row input[type='checkbox'] {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
  cursor: pointer;
}

.row input[type='range'] {
  accent-color: var(--accent);
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.side {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pct {
  min-width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
}

.pct.wide {
  min-width: 128px;
  white-space: nowrap;
}

/* 设置分组 */
.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-title {
  margin: 6px 2px 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-3);
}

/* 从属设置：跟随父开关，父项关闭时整体禁用 */
.row.sub {
  margin-left: 16px;
  background: var(--panel-2);
  border-left: 2px solid var(--border-soft);
}

.row.sub b {
  font-weight: 500;
  font-size: 13px;
}

.row.off {
  opacity: 0.45;
}

.row.off input,
.row.off .seg {
  pointer-events: none;
}

/* 三档分段选择 */
.seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: var(--panel-deep);
}

.seg button {
  font: inherit;
  font-size: 12px;
  padding: 4px 14px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}

.seg button:hover:not(:disabled) {
  color: var(--text);
}

.seg button.on {
  background: var(--accent);
  color: var(--accent-ink);
}

.desc {
  color: var(--text-3);
  font-size: 12px;
}

button {
  font: inherit;
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  cursor: pointer;
}

button.primary {
  background: linear-gradient(135deg, var(--accent-strong), var(--accent));
  color: var(--accent-ink);
  box-shadow: 0 2px 10px var(--accent-shadow);
}

button.primary:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--accent), var(--accent-strong));
  box-shadow: 0 3px 14px var(--accent-shadow);
}

button.ghost {
  background: var(--border-soft);
  color: var(--text);
}

button.danger {
  color: var(--danger);
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 压过 button.primary 的优先级：导入区只有一个主按钮，其余安静些 */
.actions button.ghost-btn {
  background: var(--border-soft);
  color: var(--text);
}

.actions button.ghost-btn:hover:not(:disabled) {
  background: var(--border);
}

/* 导入进度条：贴窗口顶部的细条 */
.import-progress {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--panel-deep);
  z-index: 1000;
}

.import-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s ease;
}

/* 整窗拖拽导入遮罩：原生 drag-drop 落点不受影响 */
.drop-mask {
  position: fixed;
  inset: 0;
  z-index: 999;
  border: 2px dashed var(--accent);
  background: rgba(253, 240, 247, 0.88);
  display: grid;
  place-items: center;
  pointer-events: none;
}

.drop-hint {
  font-size: 15px;
  font-weight: 600;
  color: var(--accent);
  background: var(--panel);
  border: 1px solid var(--accent);
  box-shadow: 0 4px 18px var(--accent-shadow);
  padding: 14px 22px;
  border-radius: 12px;
}

/* 皮肤页工具行：搜索 + 排序 */
.pack-tools {
  display: flex;
  gap: 8px;
}

.pack-tools .search {
  flex: 1;
  min-width: 0;
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  padding: 6px 10px;
  font: inherit;
}

.pack-tools .search::placeholder {
  color: var(--text-4);
}

.pack-tools select {
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  padding: 5px 8px;
  font: inherit;
}

.hint-line {
  margin: 0;
  color: var(--text-4);
  font-size: 12px;
}

.packs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tag.on {
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
}

.empty {
  color: var(--text-3);
  font-size: 13px;
}

.hint {
  margin-top: auto;
  color: var(--text-4);
  font-size: 12px;
}

.credits {
  color: var(--text-3);
  font-size: 13px;
  padding-left: 18px;
  margin: 0;
}

/* 重命名输入框 */
.dlg-mask {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: rgba(92, 68, 82, 0.38); /* 莓调遮罩，与主题一致 */
  display: grid;
  place-items: center;
}

.dlg {
  width: min(380px, 90vw);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 10px 36px var(--accent-shadow);
}

.dlg-title {
  font-size: 14px;
}

.dlg input {
  font: inherit;
  background: var(--panel-deep);
  color: var(--text);
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  padding: 8px;
}

.dlg input:focus {
  outline: none;
  border-color: var(--accent);
}

.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.dlg-space {
  flex: 1;
}

.dlg[tabindex='-1']:focus {
  outline: none;
}

/* 添加桌宠：皮肤选择网格 */
.add-dlg {
  width: min(520px, 92vw);
}

.pick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
  padding: 2px;
}

.pick {
  font: inherit;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 6px 8px;
  background: var(--panel-2);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  cursor: pointer;
  min-width: 0;
}

.pick:hover {
  border-color: var(--border);
  background: var(--panel);
}

.pick.on {
  border-color: var(--accent);
  background: var(--accent-tint);
}

.pick-cover {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: 8px;
  background: var(--panel-deep);
  display: grid;
  place-items: center;
  overflow: hidden;
}

.pick-cover img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.pick-ph {
  font-size: 11px;
  color: var(--text-4);
}

.pick-used {
  position: absolute;
  left: 3px;
  bottom: 3px;
  font-size: 10px;
  line-height: 1.5;
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(92, 68, 82, 0.72); /* 压在封面图上，用莓棕半透明 */
  color: #fff;
  font-variant-numeric: tabular-nums;
}

.pick-name {
  font-size: 12px;
  color: var(--text);
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

h2 {
  margin: 4px 0 0;
  font-size: 18px;
}
</style>
