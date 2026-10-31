/**
 * 任务栏模式（贴地）：把当前显示器工作区的底沿当"地面"——
 * workArea 本来就扣除了任务栏，底边即任务栏上沿（任务栏在左右/顶部时
 * 退化为屏幕底沿，同样成立），因此不需要任何任务栏 API。
 * 纯函数单独成模块便于单测；本模块不能有模块级导入（node --test 约束）。
 */

/** 只关心纵向的工作区描述 */
export interface VerticalArea {
  y: number;
  height: number;
}

/**
 * 窗口底边贴住工作区底沿时，窗口左上角的 y（物理 px）。
 * 窗口高于工作区时贴住工作区顶沿，不越过上边界。
 */
export function groundY(area: VerticalArea, winH: number): number {
  return area.y + Math.max(0, area.height - winH);
}
