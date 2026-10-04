ALTER TABLE promo_images
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'public_config';

ALTER TABLE promo_images
  DROP CONSTRAINT IF EXISTS promo_images_purpose_check;

ALTER TABLE promo_images
  ADD CONSTRAINT promo_images_purpose_check
  CHECK (purpose IN ('public_config', 'result_media'));

-- Result-media uploads created before this migration used the historical
-- /promo-images/:id URL. Mark any images referenced by the live resultMedia
-- config private so upgrading an existing client does not leave patient result
-- photos publicly fetchable.
WITH result_media_urls AS (
  SELECT item->>'imageUrl' AS image_url
  FROM clinic_config c
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(c.data->'resultMedia') = 'array'
        THEN c.data->'resultMedia'
      ELSE '[]'::jsonb
    END
  ) AS result_set
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(result_set->'items') = 'array'
        THEN result_set->'items'
      ELSE '[]'::jsonb
    END
  ) AS item
),
result_media_ids AS (
  SELECT DISTINCT
    (regexp_match(image_url, '/promo-images/([0-9]+)([/?#]|$)'))[1]::integer AS id
  FROM result_media_urls
  WHERE image_url ~ '/promo-images/[0-9]+'
)
UPDATE promo_images
SET purpose = 'result_media'
WHERE id IN (SELECT id FROM result_media_ids WHERE id IS NOT NULL);
