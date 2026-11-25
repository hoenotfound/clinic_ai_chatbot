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

// visualViewport uses layout-viewport CSS coordinates, as does the host rect.
export function dashyVisibleArea(host, viewport) {
  const left = Math.max(0, viewport.offsetLeft - host.left);
  const top = Math.max(0, viewport.offsetTop - host.top);
  const right = Math.min(host.width, viewport.offsetLeft + viewport.width - host.left);
  const bottom = Math.min(host.height, viewport.offsetTop + viewport.height - host.top);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
export function offsetDashyBounds(area, size) {
  const b = dashyBounds(area.width, area.height, size);
  return { left: b.left + area.left, right: b.right + area.left,
    top: b.top + area.top, bottom: b.bottom + area.top };
}
const overlaps = (a, b, gap = 8) => a.left < b.right + gap && a.right > b.left - gap &&
  a.top < b.bottom + gap && a.bottom > b.top - gap;

// Fit a scrollable menu next to the mascot without crossing protected controls.
export function dashyMenuPosition(point, size, area, obstacles, desiredWidth = 224, desiredHeight = 260, minHeight = 104) {
  const gap = 8;
  const left = area.left + 12, right = area.left + area.width - 12;
  const top = area.top + 12, bottom = area.top + area.height - 12;
  const width = Math.min(desiredWidth, right - left);
  if (width < Math.min(150, desiredWidth) || bottom - top < minHeight) return null;
  const blocked = [...obstacles, { left: point.x, top: point.y, right: point.x + size, bottom: point.y + size }];
  const xs = [point.x + size + gap, point.x - width - gap, point.x + (size - width) / 2, left, right - width];
  for (const r of blocked) xs.push(r.left - width - gap, r.right + gap);
  let best = null, bestScore = -Infinity;
  for (const rawX of xs) {
    const x = clamp(rawX, left, right - width);
    let intervals = [[top, bottom]];
    for (const r of blocked) {
      if (x + width + gap <= r.left || x >= r.right + gap) continue;
      intervals = intervals.flatMap(([a, b]) => {
        const start = r.top - gap, end = r.bottom + gap;
        if (end <= a || start >= b) return [[a, b]];
        return [[a, Math.min(b, start)], [Math.max(a, end), b]].filter(([u, v]) => v > u);
      });
    }
    for (const [a, b] of intervals) {
      const height = Math.min(desiredHeight, b - a);
      if (height < minHeight) continue;
      const y = clamp(point.y + (size - height) / 2, a, b - height);
      const distance = Math.hypot(x + width / 2 - point.x - size / 2, y + height / 2 - point.y - size / 2);
      const score = height * 3 - distance;
      if (score > bestScore) { bestScore = score; best = { left: x, top: y, width, maxHeight: height }; }
    }
  }
  return best;
}

// Choose a bounded flight rectangle. Every point along the flight (including
// between keyframes) remains inside this rectangle and outside protected UI.
export function dashyFlight(point, bounds, size, obstacles) {
  if (!point) return { x: 0, y: 0 };
  const dxs = [-72, 72, -44, 44, -24, 24, 0];
  const dys = [-38, 38, -20, 20, 0];
  let best = { x: 0, y: 0 }, distance = 0;
  for (const dx of dxs) for (const dy of dys) {
    const end = { x: point.x + dx, y: point.y + dy };
    if (end.x < bounds.left || end.x > bounds.right || end.y < bounds.top || end.y > bounds.bottom) continue;
    const sweep = { left: Math.min(point.x, end.x), top: Math.min(point.y, end.y),
      right: Math.max(point.x, end.x) + size, bottom: Math.max(point.y, end.y) + size };
    if (obstacles.some(r => overlaps(sweep, r))) continue;
    const d = Math.hypot(dx, dy);
    if (d > distance) { distance = d; best = { x: dx, y: dy }; }
  }
  return best;
}
