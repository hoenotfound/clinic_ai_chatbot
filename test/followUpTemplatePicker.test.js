const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const file = (path) => fs.readFileSync(path, "utf8");

test("Follow-up Tools template catalog reuses approved Meta template service without a contact", () => {
  const routes = file("src/routes/config.js");
  assert.match(routes, /router\.get\("\/automated-follow-up\/template-catalog"/);
  assert.match(routes, /whatsappTemplate\.listApprovedTemplates\(/);
  assert.match(routes, /whatsappTemplateMedia\.listReusableMedia\(/);
  assert.match(routes, /clinic's Meta WABA|templates: catalog\.templates/);
  const permissions = file("src/middleware/requireAuth.js");
  assert.match(permissions, /parts\[0\] === "automated-follow-up"/);
  assert.match(permissions, /return canTools \? true : forbidden/);
});

test("IMAGE template attachments use bounded validation and private clinic R2 objects", () => {
  const routes = file("src/routes/config.js");
  const image = routes.slice(
    routes.indexOf('router.post("/automated-follow-up/template-media-image"'),
    routes.indexOf('router.post("/automated-follow-up/template-library-image"'),
  );
  assert.match(image, /handleImageUpload/);
  assert.match(image, /whatsappTemplateMedia\.prepareImage\(/);
  assert.match(image, /mediaStorage\.uploadMedia\(buffer, req\.file\.mimetype, \{ contactId: "follow-up-config" \}\)/);
  const preview = routes.slice(
    routes.indexOf('router.get("/automated-follow-up/template-media-preview"'),
    routes.indexOf('router.get("/automated-follow-up/free-entry-status"'),
  );
  assert.match(preview, /mediaStorage\.isReferencedClinicFollowUpMediaKey\(key, configRepo\.getConfig\(\)\)/);
  assert.match(preview, /mediaStorage\.createPresignedGetUrl\(/);
  assert.match(preview, /expiresSeconds: 5 \* 60/);
  assert.match(preview, /private, no-store/);
});

test("Front-end template picker supports approved IMAGE and VIDEO attachments without changing send payload", () => {
  const editor = file("portal-frontend/src/pages/Tools.jsx");
  const picker = file("portal-frontend/src/components/FollowUpTemplatePicker.jsx");
  const api = file("portal-frontend/src/api.js");
  assert.match(editor, /ApprovedFollowUpTemplatePicker/);
  assert.match(editor, /FollowUpTemplateMediaPicker/);
  assert.match(editor, /templateRules: \(form\.freeEntry\?\.templateRules/);
  assert.match(picker, /template\.category !== "MARKETING"/);
  assert.match(picker, /format === "IMAGE" \|\| format === "VIDEO"/);
  assert.match(picker, /api\.uploadFollowUpTemplateImage\(file\)/);
  assert.match(picker, /api\.uploadFollowUpVideo\(file\)/);
  assert.match(picker, /videoCodecVerified: format === "VIDEO"/);
  assert.match(api, /template-catalog/);
  assert.match(api, /template-media-image/);
});
