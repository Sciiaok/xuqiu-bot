-- Fix: allow anon role to upload to aigc-assets bucket
-- The backend uses the anon key, so the INSERT policy must include anon
DROP POLICY IF EXISTS "Authenticated users can upload aigc assets" ON storage.objects;

CREATE POLICY "Anyone can upload aigc assets"
  ON storage.objects FOR INSERT TO authenticated, anon
  WITH CHECK (bucket_id = 'aigc-assets');
