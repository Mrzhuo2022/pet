<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';

const text = ref<string | null>(null);
const theme = ref<'light' | 'dark'>('light');
const accent = ref<string | null>(null);
let unlisteners: UnlistenFn[] = [];
let readyTimer: number | null = null;

const styleVars = computed(() => ({
  ...(accent.value ? { '--accent': accent.value } : {}),
}));

onMounted(async () => {
  unlisteners.push(
    await listen<{ text: string; theme?: string; accent?: string }>('bubble-text', (e) => {
      text.value = e.payload.text;
      theme.value = e.payload.theme === 'dark' ? 'dark' : 'light';
      accent.value = typeof e.payload.accent === 'string' && e.payload.accent ? e.payload.accent : null;
      // 收到文本后停止重发 ready
      if (readyTimer !== null) {
        window.clearInterval(readyTimer);
        readyTimer = null;
      }
    }),
    await listen('bubble-hide', () => {
      text.value = null;
    }),
  );
  // 通知主窗口就绪；启动早期主窗口监听器可能未就位，重发几次兜底
  await emit('bubble-ready');
  let tries = 0;
  readyTimer = window.setInterval(() => {
    tries += 1;
    if (tries > 5) {
      if (readyTimer !== null) window.clearInterval(readyTimer);
      readyTimer = null;
      return;
    }
    void emit('bubble-ready');
  }, 600);
});

onUnmounted(() => {
  if (readyTimer !== null) window.clearInterval(readyTimer);
  unlisteners.forEach((u) => u());
});
</script>

<template>
  <div class="bubble-layer">
    <Transition name="pop">
      <div
        v-if="text"
        :class="['bubble', theme === 'dark' ? 'bubble-dark' : 'bubble-light']"
        :style="styleVars"
      >{{ text }}</div>
    </Transition>
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
}
</style>

<style scoped>
/* 气泡锚定窗口底部中央：窗口底边贴着桌宠头顶，尾巴指向桌宠 */
.bubble-layer {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 10px;
  box-sizing: border-box;
  pointer-events: none;
  user-select: none;
}

.bubble {
  --accent: rgba(20, 24, 32, 0.1);
  max-width: 92%;
  padding: 8px 13px;
  border-radius: 12px;
  font: 13px/1.5 'Segoe UI', 'Microsoft YaHei', sans-serif;
  text-align: center;
  white-space: normal;
  word-break: break-word;
  position: relative;
}

.bubble-light {
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid var(--accent);
  color: #33383f;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);
}

.bubble-dark {
  background: rgba(28, 31, 38, 0.96);
  border: 1px solid var(--accent);
  color: #e7eaf0;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.32);
}

.bubble::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  margin-left: -7px;
  border: 7px solid transparent;
}

.bubble-light::after {
  border-top-color: rgba(255, 255, 255, 0.97);
}

.bubble-dark::after {
  border-top-color: rgba(28, 31, 38, 0.96);
}

.pop-enter-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.pop-leave-active {
  transition: opacity 0.22s ease;
}

.pop-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.92);
}

.pop-leave-to {
  opacity: 0;
}
</style>
