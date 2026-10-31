<script setup lang="ts">
// 同一前端入口服务四个窗口：主窗口（桌宠）、设置窗口、气泡窗口、右键菜单窗口，按 label 分流
import { computed } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import PetApp from './PetApp.vue';
import SettingsApp from './SettingsApp.vue';
import BubbleApp from './BubbleApp.vue';
import CtxMenuApp from './CtxMenuApp.vue';

const label = getCurrentWindow().label;
const view = computed(() =>
  label === 'settings'
    ? SettingsApp
    : label === 'bubble'
      ? BubbleApp
      : label === 'ctxmenu'
        ? CtxMenuApp
        : PetApp,
);
</script>

<template>
  <component :is="view" />
</template>
