export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecoveredPosition {
  x: number;
  y: number;
  changed: boolean;
}

export function intersectsRect(
  x: number,
  y: number,
  width: number,
  height: number,
  area: ScreenRect,
): boolean {
  return (
    x < area.x + area.width &&
    x + width > area.x &&
    y < area.y + area.height &&
    y + height > area.y
  );
}

export function isVisibleOnWorkAreas(
  x: number,
  y: number,
  width: number,
  height: number,
  areas: ScreenRect[],
): boolean {
  return areas.some((area) => intersectsRect(x, y, width, height, area));
}

export function recoverWindowPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  areas: ScreenRect[],
): RecoveredPosition {
  if (!areas.length || isVisibleOnWorkAreas(x, y, width, height, areas)) {
    return { x, y, changed: false };
  }
  const area = areas[0]!;
  return {
    x: Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - width)),
    y: Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - height)),
    changed: true,
  };
}
