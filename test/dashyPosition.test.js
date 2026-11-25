const test = require("node:test");
const assert = require("node:assert/strict");
const load = () => import("../portal-frontend/src/utils/dashyPosition.js");
test("Dashy remembers normalized positions across workspace sizes and clamps invalid data", async () => {
  const { dashyBounds, dashyPoint, dashyFraction, normalizeDashyPosition, dashySize } = await load();
  assert.equal(dashySize(1400, "auto"), 100);
  assert.equal(dashySize(800, "auto"), 85);
  assert.equal(dashySize(390, "auto"), 65);
  const b = dashyBounds(1000, 800, 100);
  const p = dashyPoint({ x: .7, y: .25 }, b);
  const f = dashyFraction(p, b);
  assert.ok(Math.abs(f.x - .7) < 1e-9);
  assert.ok(Math.abs(f.y - .25) < 1e-9);
  assert.deepEqual(normalizeDashyPosition({ x: -1, y: 10 }), { x: 0, y: 1 });
  const phone = dashyBounds(320, 600, 65);
  const q = dashyPoint(f, phone);
  assert.ok(q.x >= phone.left && q.x <= phone.right && q.y >= phone.top && q.y <= phone.bottom);
});
test("Dashy moves away from protected controls and hides if no safe space", async () => {
  const { dashyBounds, safeDashyPoint } = await load();
  const b = dashyBounds(400, 600, 80);
  const obstacles = [{ left: 0, right: 400, top: 0, bottom: 120 }, { left: 0, right: 400, top: 480, bottom: 600 }];
  assert.deepEqual(safeDashyPoint({ x: 120, y: 40 }, b, 80, obstacles), { x: 120, y: 128 });
  assert.deepEqual(safeDashyPoint({ x: 120, y: 500 }, b, 80, obstacles), { x: 120, y: 392 });
  assert.deepEqual(safeDashyPoint({ x: 120, y: 250 }, b, 80, obstacles), { x: 120, y: 250 });
  assert.equal(safeDashyPoint({ x: 0, y: 0 }, b, 80, [{ left: 0, right: 400, top: 0, bottom: 600 }]), null);
});

test("Dashy respects a panned or keyboard-reduced visual viewport", async () => {
  const { dashyVisibleArea, offsetDashyBounds } = await load();
  const area = dashyVisibleArea({ left: 0, top: 0, width: 390, height: 844 },
    { offsetLeft: 10, offsetTop: 40, width: 360, height: 360 });
  assert.deepEqual(area, { left: 10, top: 40, width: 360, height: 360 });
  assert.deepEqual(offsetDashyBounds(area, 65), { left: 22, top: 52, right: 293, bottom: 323 });
});
test("Dashy menu avoids protected controls and flight stays inside its safe rectangle", async () => {
  const { dashyMenuPosition, dashyFlight, dashyBounds } = await load();
  const area = { left: 0, top: 0, width: 390, height: 600 };
  const obstacles = [{ left: 0, right: 390, top: 0, bottom: 120 }, { left: 0, right: 390, top: 480, bottom: 600 }];
  const p = { x: 300, y: 300 }, size = 65;
  const menu = dashyMenuPosition(p, size, area, obstacles);
  assert.ok(menu);
  assert.ok(menu.top >= 128 && menu.top + menu.maxHeight <= 472);
  assert.ok(menu.left + menu.width <= p.x - 8 || menu.top + menu.maxHeight <= p.y - 8 || menu.top >= p.y + size + 8);
  const flight = dashyFlight(p, dashyBounds(390, 600, size), size, obstacles);
  assert.ok(Math.abs(flight.x) >= 24);
  assert.ok(p.x + flight.x >= 12 && p.x + flight.x + size <= 378);
  assert.ok(Math.min(p.y, p.y + flight.y) >= 128 && Math.max(p.y, p.y + flight.y) + size <= 472);
  assert.equal(dashyMenuPosition(p, size, { ...area, height: 70 }, obstacles), null);
});

test("Compact Dashy flight stays within smaller travel caps and skips blocked paths", async () => {
  const { dashyFlight, dashyBounds } = await load();
  const size = 65, bounds = dashyBounds(390, 600, size);
  const p = { x: 200, y: 250 };
  const open = dashyFlight(p, bounds, size, [], true);
  assert.equal(Math.abs(open.x), 35);
  assert.equal(Math.abs(open.y), 20);
  const blocked = [{ left: 0, right: 390, top: 0, bottom: 242 },
    { left: 0, right: 390, top: 323, bottom: 600 },
    { left: 0, right: 192, top: 0, bottom: 600 },
    { left: 273, right: 390, top: 0, bottom: 600 }];
  assert.deepEqual(dashyFlight(p, bounds, size, blocked, true), { x: 0, y: 0 });
});
