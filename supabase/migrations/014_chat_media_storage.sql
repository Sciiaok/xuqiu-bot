-- Create public storage bucket for operator-sent media in chat
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-media', 'chat-media', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'chat-media public read'
  ) THEN
    CREATE POLICY "chat-media public read"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'chat-media');
  END IF;
END $$;

-- Allow authenticated users to upload
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'chat-media auth upload'
  ) THEN
    CREATE POLICY "chat-media auth upload"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'chat-media');
  END IF;
END $$;
