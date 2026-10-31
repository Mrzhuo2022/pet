import type { PetState } from './types';

type Listener = (next: PetState, prev: PetState) => void;

/** 极简状态机：idle / drag / click，后续阶段在此扩展 walk/sleep 等 */
export class PetStateMachine {
  private current: PetState = 'idle';
  private listeners = new Set<Listener>();

  get state(): PetState {
    return this.current;
  }

  set(next: PetState): void {
    if (next === this.current) return;
    const prev = this.current;
    this.current = next;
    this.listeners.forEach((l) => l(next, prev));
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
