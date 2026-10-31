<script setup lang="ts">
// 右键菜单窗口（ctxmenu）：透明无边框小窗渲染 kawaii 风菜单卡，
// 数据来自 Rust show_pet_menu 的 pet-menu-data 事件，动作串回调 run_pet_menu_action
import { onMounted, onUnmounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface MenuEntry {
  label: string;
  action: string;
  checked: boolean;
  danger: boolean;
}

interface PetMenuData {
  name: string;
  scale: number;
  scales: MenuEntry[];
  outfits: MenuEntry[];
  toggles: MenuEntry[];
  actions: MenuEntry[];
  footer: MenuEntry[];
}

const data = ref<PetMenuData | null>(null);
let unlisten: UnlistenFn[] = [];

/** 执行动作并收起菜单（quit 由 Rust 侧退出应用） */
async function run(action: string): Promise<void> {
  try {
    await invoke('run_pet_menu_action', { action });
  } catch (e) {
    console.error('菜单动作失败', e);
  }
  await invoke('hide_pet_menu').catch(() => {});
}

/** 点在菜单卡外（透明区域）也收起——此时窗口仍聚焦，不会触发失焦 */
function onBodyClick(e: MouseEvent): void {
  if (!(e.target as HTMLElement).closest('.menu-card')) void invoke('hide_pet_menu').catch(() => {});
}

// 浏览器预览/旧后端兜底：无后端时用演示数据，方便脱离应用调样式
const DEMO: PetMenuData = {
  name: '上香熊猫',
  scale: 100,
  outfits: [],
  scales: [50, 75, 100, 125, 150, 200].map((p) => ({
    label: `${p}%`,
    action: `demo:${p}`,
    checked: p === 100,
    danger: false,
  })),
  toggles: [
    { label: '锁定位置', action: 'demo:t1', checked: false, danger: false },
    { label: '自动走动', action: 'demo:t2', checked: true, danger: false },
    { label: '跟随鼠标', action: 'demo:t3', checked: false, danger: false },
    { label: '任务栏模式', action: 'demo:t4', checked: true, danger: false },
  ],
  actions: [
    { label: '重置位置', action: 'demo:a1', checked: false, danger: false },
    { label: '隐藏这只', action: 'demo:a2', checked: false, danger: false },
    { label: '复制这只桌宠', action: 'demo:a3', checked: false, danger: false },
    { label: '显示全部', action: 'demo:a4', checked: false, danger: false },
  ],
  footer: [
    { label: '更多设置…', action: 'demo:f1', checked: false, danger: false },
    { label: '退出', action: 'demo:f2', checked: false, danger: true },
  ],
};

onMounted(async () => {
  // 先取暂存数据（竞态兜底：webview 就绪晚于首次 show 时事件已错过）；
  // 无后端（浏览器预览）时退回演示数据
  try {
    const pending = await invoke<PetMenuData | null>('take_pet_menu');
    if (pending && !data.value) data.value = pending;
  } catch {
    data.value = DEMO;
  }
  try {
    unlisten.push(
      await listen<PetMenuData>('pet-menu-data', (e) => {
        data.value = e.payload;
      }),
    );
    // 失焦（点击菜单窗口外）即收起
    unlisten.push(
      await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused && data.value) void invoke('hide_pet_menu').catch(() => {});
      }),
    );
  } catch {
    // 浏览器预览环境无事件通道
  }
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('click', onBodyClick);
});

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') void invoke('hide_pet_menu').catch(() => {});
}

onUnmounted(() => {
  for (const off of unlisten) off();
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('click', onBodyClick);
});
</script>

<template>
  <div class="ctx-root">
    <div v-if="data" class="menu-card">
      <div class="menu-head">
        <!-- 粉色像素史莱姆小图标（与内置皮肤同款造型） -->
        <svg class="slime" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
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
        <span class="name">{{ data.name }}</span>
      </div>

      <template v-if="data.scales.length">
        <div class="sec-title">大小 · {{ data.scale }}%</div>
        <div class="chips">
          <button
            v-for="s in data.scales"
            :key="s.action"
            :class="{ chip: true, on: s.checked }"
            @click="run(s.action)"
          >
            {{ s.label }}
          </button>
        </div>
      </template>

      <template v-if="data.outfits.length">
        <div class="sec-title">服装</div>
        <div class="chips">
          <button
            v-for="o in data.outfits"
            :key="o.action"
            :class="{ chip: true, on: o.checked }"
            @click="run(o.action)"
          >
            {{ o.label }}
          </button>
        </div>
      </template>

      <template v-if="data.toggles.length">
        <div class="sec-title">开关</div>
        <div class="grid2">
          <button
            v-for="t in data.toggles"
            :key="t.action"
            :class="{ row: true, on: t.checked }"
            @click="run(t.action)"
          >
            <span class="tick"></span>
            <span class="label">{{ t.label }}</span>
          </button>
        </div>
      </template>

      <template v-if="data.actions.length">
        <div class="sep"></div>
        <div class="grid2">
          <button v-for="a in data.actions" :key="a.action" class="row plain" @click="run(a.action)">
            <span class="label">{{ a.label }}</span>
          </button>
        </div>
      </template>

      <div class="sep"></div>
      <button v-for="f in data.footer" :key="f.action" :class="{ row: true, plain: true, danger: f.danger }" @click="run(f.action)">
        <span class="label">{{ f.label }}</span>
      </button>
    </div>
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
  overflow: hidden;
}

/* 隐藏滚动条（菜单卡/皮肤列表）：滚轮滚动仍可用 */
.ctx-root *::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.ctx-root * {
  scrollbar-width: none;
}
</style>

<style scoped>
.ctx-root {
  box-sizing: border-box;
  height: 100vh;
  padding: 6px;
  overflow: hidden;
}

/* 菜单卡：白色圆角 + 粉色柔影 + 入场小动画 */
.menu-card {
  box-sizing: border-box;
  width: 244px;
  max-height: calc(100vh - 12px);
  overflow-y: auto;
  background: #fffdfa;
  border: 1px solid #f6dfe9;
  border-radius: 14px;
  padding: 7px;
  box-shadow: 0 8px 28px rgba(238, 133, 177, 0.38);
  animation: pop 0.16s ease-out;
  font: 13px/1.45 'Segoe UI', 'Microsoft YaHei', sans-serif;
  color: #5c4452;
}

@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.94) translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.menu-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px 5px;
  border-bottom: 1px dashed #f6dfe9;
  margin-bottom: 4px;
}

.slime {
  flex: none;
}

.name {
  font-weight: 700;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sec-title {
  font-size: 11px;
  font-weight: 600;
  color: #b48ea2;
  letter-spacing: 0.05em;
  padding: 4px 6px 2px;
}

/* 缩放档位：一行小圆片 */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 2px;
}

.chip {
  font: inherit;
  font-size: 12px;
  padding: 2px 9px;
  border: 1px solid #f0c6da;
  border-radius: 999px;
  background: #fff;
  color: #82687a;
  cursor: pointer;
}

.chip:hover {
  border-color: #ee85b1;
  color: #d4508a;
}

.chip.on {
  background: #ee85b1;
  border-color: #ee85b1;
  color: #fff;
  font-weight: 600;
}

/* 通用行 */
.row {
  font: inherit;
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 4px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.row:hover {
  background: #fde9f2;
}

.row.on {
  color: #d4508a;
  font-weight: 600;
}

.row .label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 开关的圆点 */
.tick {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ecd9e4;
  transition: background 0.12s;
}

.row.on .tick {
  background: #ee85b1;
  box-shadow: 0 0 0 3px rgba(238, 133, 177, 0.18);
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
}

.row.plain {
  color: #7c6472;
}

.row.danger {
  color: #e05e80;
}

.sep {
  height: 1px;
  margin: 5px 4px;
  background: #f6dfe9;
}
</style>
