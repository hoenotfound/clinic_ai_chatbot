const test = require("node:test");
const assert = require("node:assert/strict");

const whatsapp = require("../src/services/whatsappService");
const metaMessaging = require("../src/services/metaMessagingService");

test("WhatsApp parser preserves CTWA referral on the inbound message", () => {
  const parsed = whatsapp.parseIncomingMessages({
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: "60123456789", profile: { name: "Caden" } }],
          messages: [{
            id: "wamid.ctwa-1",
            from: "60123456789",
            type: "text",
            text: { body: "Hi, interested" },
            referral: {
              source_url: "https://fb.me/ctwa",
              source_id: "120200000000001",
              source_type: "ad",
              headline: "HIFU Promo",
              body: "Book now",
              ctwa_clid: "clid-123",
            },
          }],
        },
      }],
    }],
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].profileName, "Caden");
  assert.equal(parsed[0].attribution.source, "meta_ads");
  assert.equal(parsed[0].attribution.adId, "120200000000001");
  assert.equal(parsed[0].attribution.ctwaClid, "clid-123");
});

test("ordinary WhatsApp message keeps the legacy parser shape without an attribution field", () => {
  const parsed = whatsapp.parseIncomingMessages({
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: "60123456789", profile: { name: "Caden" } }],
          messages: [{
            id: "wamid.organic-1",
            from: "60123456789",
            type: "text",
            text: { body: "Hello" },
          }],
        },
      }],
    }],
  });

  assert.equal(parsed.length, 1);
  assert.equal(Object.hasOwn(parsed[0], "attribution"), false);
});

test("Facebook message parser preserves ad referral attached to a message", () => {
  const parsed = metaMessaging.parseIncomingMessages({
    object: "page",
    entry: [{
      id: "page-1",
      messaging: [{
        sender: { id: "psid-1" },
        recipient: { id: "page-1" },
        timestamp: 12345,
        referral: {
          source: "ADS",
          type: "OPEN_THREAD",
          ref: "doctor-video",
          ad_id: "120299900000001",
        },
        message: {
          mid: "m_fb_1",
          text: "How much?",
        },
      }],
    }],
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].channel, "facebook");
  assert.equal(parsed[0].attribution.source, "meta_ads");
  assert.equal(parsed[0].attribution.adId, "120299900000001");
});

test("Instagram OPEN_THREAD referral becomes attribution-only work, not a fake message", () => {
  const parsed = metaMessaging.parseIncomingMessages({
    object: "instagram",
    entry: [{
      id: "ig-page-1",
      messaging: [{
        sender: { id: "igsid-1" },
        recipient: { id: "ig-page-1" },
        timestamp: 1730000000000,
        referral: {
          source: "ADS",
          type: "OPEN_THREAD",
          ref: "hifu-ad",
          ad_id: "120288800000001",
        },
      }],
    }],
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].attributionOnly, true);
  assert.equal(parsed[0].channel, "instagram");
  assert.equal(parsed[0].from, "igsid-1");
  assert.equal(parsed[0].text, undefined);
  assert.equal(parsed[0].attribution.adId, "120288800000001");
});

test("ordinary Instagram DM keeps the legacy parser shape without fake attribution", () => {
  const parsed = metaMessaging.parseIncomingMessages({
    object: "instagram",
    entry: [{
      id: "ig-page-1",
      messaging: [{
        sender: { id: "igsid-2" },
        message: { mid: "m_ig_2", text: "hello" },
      }],
    }],
  });

  assert.equal(parsed.length, 1);
  assert.equal(Object.hasOwn(parsed[0], "attribution"), false);
});
