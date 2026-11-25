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
