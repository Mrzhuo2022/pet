import { reactive } from 'vue';

export interface ToastItem {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

const state = reactive<{ items: ToastItem[] }>({ items: [] });
let seq = 0;

/** 弹一条右下角通知（多条叠放、自动消退，取代旧的单行 message） */
export function toast(text: string, kind: 'info' | 'error' = 'info', ms = 3600): void {
  const id = ++seq;
  state.items.push({ id, text, kind });
  if (state.items.length > 5) state.items.shift();
  window.setTimeout(() => {
    const i = state.items.findIndex((t) => t.id === id);
    if (i >= 0) state.items.splice(i, 1);
  }, ms);
}

export const toastState = state;
