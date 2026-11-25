// Coordinates are local to the Inbox. Persist fractions, not screen pixels.
export const DEFAULT_DASHY_POSITION = { x: .93, y: .68 };
export const DASHY_SIZES = ["auto", "small", "medium", "large"];
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export function normalizeDashyPosition(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: clamp(value.x, 0, 1), y: clamp(value.y, 0, 1) } : DEFAULT_DASHY_POSITION;
}
export function dashySize(width, preference) {
  const automatic = width >= 1024 ? 100 : width >= 640 ? 85 : 65;
  const requested = ({ small: 65, medium: 85, large: 100 })[preference] ?? automatic;
  return Math.min(requested, Math.max(0, width - 24));
}
export function dashyBounds(width, height, size) {
  const left = Math.min(12, Math.max(0, (width - size) / 2));
  const top = Math.min(12, Math.max(0, (height - size) / 2));
  return { left, top, right: Math.max(left, width - size - left), bottom: Math.max(top, height - size - top) };
}
export function dashyPoint(position, bounds) {
  const p = normalizeDashyPosition(position);
  return { x: bounds.left + p.x * (bounds.right - bounds.left), y: bounds.top + p.y * (bounds.bottom - bounds.top) };
}
export function dashyFraction(point, bounds) {
  return normalizeDashyPosition({ x: (point.x - bounds.left) / (bounds.right - bounds.left || 1),
    y: (point.y - bounds.top) / (bounds.bottom - bounds.top || 1) });
}
export function clampDashyPoint(point, bounds) {
  return { x: clamp(point.x, bounds.left, bounds.right), y: clamp(point.y, bounds.top, bounds.bottom) };
}
export function safeDashyPoint(point, bounds, size, obstacles = []) {
  const p = clampDashyPoint(point, bounds);
  const gap = 8;
  const clear = q => obstacles.every(r => q.x + size + gap <= r.left || q.x >= r.right + gap ||
    q.y + size + gap <= r.top || q.y >= r.bottom + gap);
  if (clear(p)) return p;
  // A nearest valid point lies on a boundary of one of the expanded rectangles,
  // or the workspace edge. Include all combinations, not just one obstacle.
  const xs = [p.x, bounds.left, bounds.right], ys = [p.y, bounds.top, bounds.bottom];
  for (const r of obstacles) {
    xs.push(clamp(r.left - size - gap, bounds.left, bounds.right), clamp(r.right + gap, bounds.left, bounds.right));
    ys.push(clamp(r.top - size - gap, bounds.top, bounds.bottom), clamp(r.bottom + gap, bounds.top, bounds.bottom));
  }
  let best = null, distance = Infinity;
  for (const x of xs) for (const y of ys) {
    const d = (x - p.x) ** 2 + (y - p.y) ** 2;
    if (d < distance && clear({ x, y })) { best = { x, y }; distance = d; }
  }
  return best; // No safe space (e.g. keyboard or full-height filters): hide temporarily.
}
