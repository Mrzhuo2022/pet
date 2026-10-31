<script setup lang="ts">
// 皮肤库卡片：封面 + 名称 + 标签行 + 操作按钮组 + 可展开的只读详情（内置包也能看）
import type { PackEntry } from '../pet/petpack';
import type { PackSummary } from '../pet/packSummary';

defineProps<{
  pack: PackEntry;
  thumb: string | null;
  /** 当前目标桌宠正在使用此皮肤 */
  active: boolean;
  /** 详情展开中 */
  expanded: boolean;
  /** 详情数据（'loading' = 抓取中，null = 抓取失败） */
  details: PackSummary | 'loading' | null;
}>();

const emit = defineEmits<{
  (e: 'activate'): void;
  (e: 'details'): void;
  (e: 'edit'): void;
  (e: 'export'): void;
  (e: 'rename'): void;
  (e: 'folder'): void;
  (e: 'json'): void;
  (e: 'reload'): void;
  (e: 'remove'): void;
}>();

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}
</script>

<template>
  <li :class="{ pack: true, active, open: expanded }" @click="emit('activate')">
    <div class="pack-main">
      <div class="thumb">
        <img v-if="thumb" :src="thumb" alt="" />
        <span v-else class="thumb-empty">{{ pack.engine === 'live2d' ? 'L2D' : 'SPR' }}</span>
      </div>
      <div class="info">
        <span class="name">{{ pack.name }}</span>
        <span class="meta">
          <span class="tag engine">{{ pack.engine }}</span>
          <span class="tag">{{ pack.source === 'builtin' ? '内置' : '用户' }}</span>
          <span v-if="pack.importedAt" class="tag" :title="`导入于 ${formatDate(pack.importedAt)}`">
            {{ formatDate(pack.importedAt) }}
          </span>
          <span v-if="pack.generated" class="tag gen" title="导入时自动生成的配置，可用编辑器精调">自动生成</span>
          <span v-if="active" class="tag on">使用中</span>
        </span>
      </div>
      <div class="pack-actions">
        <button class="mini" title="查看皮肤包摘要（只读）" @click.stop="emit('details')">
          {{ expanded ? '收起' : '详情' }}
        </button>
        <template v-if="pack.source === 'user'">
          <button class="mini" title="打开可视化皮肤编辑器" @click.stop="emit('edit')">编辑器</button>
          <button class="mini" title="导出为 zip 分享" @click.stop="emit('export')">导出</button>
          <button class="mini" title="重命名（列表与桌宠标签同步）" @click.stop="emit('rename')">重命名</button>
          <button class="mini" title="在资源管理器中打开皮肤包目录" @click.stop="emit('folder')">目录</button>
          <button class="mini" title="直接编辑 petpack.json（高级）" @click.stop="emit('json')">JSON</button>
          <button class="mini" title="重新加载此皮肤包" @click.stop="emit('reload')">重载</button>
          <button class="mini del" title="删除此皮肤包" @click.stop="emit('remove')">删除</button>
        </template>
      </div>
    </div>

    <!-- 只读详情：规模计数 + 绑定摘要（抓取自 petpack.json / model3.json） -->
    <div v-if="expanded" class="detail" @click.stop>
      <span v-if="details === 'loading'" class="d-load">加载中…</span>
      <span v-else-if="!details" class="d-load">详情加载失败</span>
      <template v-else>
        <div v-if="details.motionGroups.length" class="drow">
          <span class="dl">动作组</span>
          <span class="dv">
            <span v-for="g in details.motionGroups" :key="g.name" class="dchip" :class="{ empty: !g.playable }">
              {{ g.name }} {{ g.playable }}/{{ g.total }}
            </span>
          </span>
        </div>
        <div v-if="details.frames != null" class="drow">
          <span class="dl">帧数</span>
          <span class="dv">{{ details.frames }} 帧（idle 序列）</span>
        </div>
        <div v-if="details.expressions.length" class="drow">
          <span class="dl">表情</span>
          <span class="dv">{{ details.expressions.join('、') }}</span>
        </div>
        <div v-if="details.hitAreas.length" class="drow">
          <span class="dl">命中区</span>
          <span class="dv">{{ details.hitAreas.join('、') }}</span>
        </div>
        <div v-for="b in details.bindings" :key="b.action" class="drow">
          <span class="dl">{{ b.action }}</span>
          <span class="dv">{{ b.text }}</span>
        </div>
        <div v-for="b in details.hitReactions" :key="`h-${b.key}`" class="drow">
          <span class="dl">点「{{ b.key }}」</span>
          <span class="dv">{{ b.text }}</span>
        </div>
        <div v-for="b in details.timeGreetings" :key="`t-${b.key}`" class="drow">
          <span class="dl">{{ b.key }}</span>
          <span class="dv">{{ b.text }}</span>
        </div>
        <div v-if="details.outfits.length" class="drow">
          <span class="dl">服装</span>
          <span class="dv">默认 + {{ details.outfits.join('、') }}</span>
        </div>
        <div class="drow">
          <span class="dl">互动</span>
          <span class="dv">
            文本 {{ details.clickTexts }} 条 · 音效 {{ details.clickSounds.length }} 个<template v-if="details.clickSounds.length">（{{ details.clickSounds.slice(0, 3).join('、') }}{{ details.clickSounds.length > 3 ? '…' : '' }}）</template>
          </span>
        </div>
      </template>
    </div>
  </li>
</template>

<style scoped>
.pack {
  display: block;
  border-radius: 8px;
  background: var(--panel);
  cursor: pointer;
  border: 1px solid var(--border-soft);
}

.pack:hover {
  background: var(--panel-hover);
}

.pack.active {
  border-color: var(--accent);
  background: var(--accent-tint);
}

.pack-main {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
}

.detail {
  margin: 0 10px;
  padding: 8px 2px 10px;
  border-top: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: default;
}

.drow {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.5;
}

.dl {
  flex: none;
  width: 84px;
  color: var(--text-3);
  text-align: right;
}

.dv {
  flex: 1;
  min-width: 0;
  color: var(--text-2);
  word-break: break-all;
}

.dchip {
  display: inline-block;
  padding: 0 8px;
  margin: 0 4px 4px 0;
  border-radius: 999px;
  background: var(--border-soft);
  font-variant-numeric: tabular-nums;
}

.dchip.empty {
  opacity: 0.55;
}

.d-load {
  font-size: 12px;
  color: var(--text-3);
}

.thumb {
  width: 52px;
  height: 52px;
  border-radius: 6px;
  background: var(--panel-deep);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex-shrink: 0;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.thumb-empty {
  font-size: 11px;
  color: var(--text-4);
}

.info {
  flex: 1;
  min-width: 0;
}

.name {
  display: block;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.tag {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--border-soft);
  color: var(--text-2);
}

.tag.engine {
  text-transform: uppercase;
  color: var(--ok);
}

.tag.on {
  background: var(--accent);
  color: var(--accent-ink);
}

.tag.gen {
  background: #fdf3d9;
  color: #8a6a2f;
}

.pack-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  flex-shrink: 0;
}

.mini {
  font-size: 12px;
  padding: 3px 10px;
  background: var(--border-soft);
  color: var(--text);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.mini.del {
  color: var(--danger);
}
</style>
