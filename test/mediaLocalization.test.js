const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mediaVariants,
  normalizeMediaTranslations,
  resolveLocalizedMedia,
} = require("../src/utils/mediaLocalization");

test("media translations keep only supported non-empty language overrides", () => {
  assert.deepEqual(
    normalizeMediaTranslations({
      en: { caption: " English ", imageUrl: "" },
      ms: { caption: "", imageUrl: " https://example.test/ms.jpg " },
      zh: { caption: "中文", imageUrl: "https://example.test/zh.jpg" },
      fr: { caption: "ignore" },
    }),
    {
      en: { caption: "English" },
      ms: { imageUrl: "https://example.test/ms.jpg" },
      zh: {
        imageUrl: "https://example.test/zh.jpg",
        caption: "中文",
      },
    }
  );
});

test("localized media falls back per field to the approved default", () => {
  const item = {
    imageUrl: "https://example.test/default.jpg",
    caption: "Default caption",
    mediaTranslations: {
      ms: { caption: "Kapsyen BM" },
      zh: { imageUrl: "https://example.test/zh.jpg" },
    },
  };

  assert.deepEqual(
    resolveLocalizedMedia(item, "ms"),
    {
      ...item,
      imageUrl: "https://example.test/default.jpg",
      caption: "Kapsyen BM",
      mediaTranslations: {
        ms: { caption: "Kapsyen BM" },
        zh: { imageUrl: "https://example.test/zh.jpg" },
      },
    }
  );
  assert.equal(resolveLocalizedMedia(item, "zh").imageUrl, "https://example.test/zh.jpg");
  assert.equal(resolveLocalizedMedia(item, "zh").caption, "Default caption");
  assert.equal(resolveLocalizedMedia(item, "en").imageUrl, "https://example.test/default.jpg");
  assert.equal(resolveLocalizedMedia(item, "en").caption, "Default caption");
});

test("media variants deduplicate default and language-specific delivery pairs", () => {
  const variants = mediaVariants({
    imageUrl: "https://example.test/default.jpg",
    caption: "Default",
    mediaTranslations: {
      en: { caption: "Default" },
      ms: { caption: "BM" },
      zh: { imageUrl: "https://example.test/zh.jpg", caption: "中文" },
    },
  });
  assert.deepEqual(
    variants.map(({ imageUrl, caption }) => [imageUrl, caption]),
    [
      ["https://example.test/default.jpg", "Default"],
      ["https://example.test/default.jpg", "BM"],
      ["https://example.test/zh.jpg", "中文"],
    ]
  );
});
