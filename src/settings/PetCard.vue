<script setup lang="ts">
// 左栏桌宠卡片：封面 + 名字 + 在线状态 + 三个内联快捷开关（锁/音/泡）+ 重命名
defineProps<{
  label: string;
  packName: string;
  thumb: string | null;
  selected: boolean;
  online: boolean;
  lockPosition: boolean;
  soundEnabled: boolean;
  bubbleEnabled: boolean;
}>();

const emit = defineEmits<{
  (e: 'select'): void;
  (e: 'rename'): void;
  (e: 'toggle', field: 'lock' | 'sound' | 'bubble'): void;
}>();
</script>

<template>
  <div :class="{ 'pet-card': true, on: selected }" :title="label" @click="emit('select')">
    <div class="cover">
      <img v-if="thumb" :src="thumb" alt="" />
      <span v-else class="ph">?</span>
      <span :class="{ dot: true, off: !online }" :title="online ? '显示中' : '已隐藏'"></span>
    </div>
    <div class="meta">
      <span class="name">{{ label }}</span>
      <span class="pack">{{ packName }}</span>
      <div class="toggles">
        <button
          :class="{ tg: true, on: lockPosition }"
          title="锁定位置（开启后不能拖动/走动）"
          @click.stop="emit('toggle', 'lock')"
        >
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path
              d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 1 0-4 0v2Z"
              fill="currentColor"
            />
          </svg>
        </button>
        <button
          :class="{ tg: true, on: soundEnabled }"
          title="点击音效"
          @click.stop="emit('toggle', 'sound')"
        >
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path d="M8 1.5 4.5 5H2a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2.5L8 14.5V1.5Z" fill="currentColor" />
            <path
              d="M10.5 5.5a3.5 3.5 0 0 1 0 5"
              stroke="currentColor"
              stroke-width="1.4"
              fill="none"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <button
          :class="{ tg: true, on: bubbleEnabled }"
          title="点击气泡"
          @click.stop="emit('toggle', 'bubble')"
        >
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path
              d="M2 3a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7l-3.4 2.8A.7.7 0 0 1 2.5 13V3Z"
              fill="currentColor"
            />
          </svg>
        </button>
        <button class="tg" title="重命名（留空恢复默认）" @click.stop="emit('rename')">
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path
              d="M11.3 1.6a2 2 0 0 1 2.8 2.8l-.9.9-2.8-2.8.9-.9ZM9.6 3.3l2.8 2.8-6.6 6.6-3.1.7.7-3.1 6.2-7Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pet-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: 10px;
  background: var(--panel);
  border: 1px solid var(--border-soft);
  cursor: pointer;
}

.pet-card:hover {
  background: var(--panel-hover);
}

.pet-card.on {
  border-color: var(--accent);
  background: var(--accent-tint);
}

.cover {
  position: relative;
  width: 42px;
  height: 42px;
  border-radius: 8px;
  background: var(--panel-deep);
  overflow: hidden;
  flex: none;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 12px;
  color: var(--text-4);
}

.dot {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ok);
  border: 1.5px solid var(--panel-deep);
}

.dot.off {
  background: var(--text-4);
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.name {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pack {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toggles {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.tg {
  width: 22px;
  height: 20px;
  padding: 0;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 5px;
  background: var(--border-soft);
  color: var(--text-4);
  cursor: pointer;
}

.tg:hover {
  background: var(--border);
}

.tg.on {
  background: var(--accent-tint);
  color: var(--accent);
}

.tg:not(.on) {
  opacity: 0.75;
}
</style>
