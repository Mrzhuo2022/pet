import { SoundManager } from 'pixi-live2d-display/cubism4';

/**
 * 窗口内单例语音闸：桌宠所有出声路径统一互斥 —— 同时只允许一条语音。
 * - 动作语音：渲染库的 SoundManager 播放，本闸在每次新动作前 destroy 清场；
 * - 点击音效等自带音频：经 play() 走同一把锁。
 * 跨窗口（多只桌宠 / 设置窗口编辑器试播）的互斥由 'voice-start' 事件仲裁，
 * 不在本模块内（避免渲染引擎层耦合 Tauri API）。
 */
class VoiceBus {
  private current: HTMLAudioElement | null = null;

  /** 本窗口是否有声音在播/在加载（待机闲聊避让用） */
  get busy(): boolean {
    return this.current !== null || SoundManager.audios.length > 0;
  }

  /** 播放一条音频（clickSounds 等）：先停掉本窗口所有声音 */
  play(url: string, volume: number): void {
    this.stopAll();
    const a = new Audio(url);
    a.volume = Math.min(1, Math.max(0, volume));
    const done = () => {
      if (this.current === a) this.current = null;
    };
    a.addEventListener('ended', done);
    a.addEventListener('error', done);
    this.current = a;
    void a.play().catch(() => {});
  }

  /** 停掉本窗口一切声音：自带音频 + 渲染库里还在播/还在加载的动作语音 */
  stopAll(): void {
    if (this.current) {
      this.current.pause();
      this.current.removeAttribute('src');
      this.current = null;
    }
    SoundManager.destroy();
  }
}

export const voiceBus = new VoiceBus();
