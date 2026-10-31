<script setup lang="ts">
// 右下角 Toast 堆叠：文本来自 toast() 调用，自动消退
import { toastState } from './toast';
</script>

<template>
  <TransitionGroup name="toast" tag="div" class="toasts">
    <div v-for="t in toastState.items" :key="t.id" :class="['toast', t.kind]">
      {{ t.text }}
    </div>
  </TransitionGroup>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: 340px;
  pointer-events: none;
}

.toast {
  padding: 9px 14px;
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  font-size: 13px;
  line-height: 1.45;
  border: 1px solid var(--border);
  box-shadow: 0 4px 16px var(--accent-shadow);
  word-break: break-all;
}

.toast.error {
  border-color: #f3c3d3;
  background: var(--danger-tint);
  color: var(--danger);
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.22s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
