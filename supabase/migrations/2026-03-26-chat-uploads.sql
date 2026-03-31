-- Add attachments column to orchestrator_messages for image uploads
ALTER TABLE orchestrator_messages
  ADD COLUMN attachments jsonb;

-- Create chat-uploads storage bucket
INSERT INTO storage.buckets (id, name, public)
  VALUES ('chat-uploads', 'chat-uploads', true)
  ON CONFLICT (id) DO NOTHING;

-- Storage RLS: allow all operations for all users
CREATE POLICY "chat_uploads_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'chat-uploads');

CREATE POLICY "chat_uploads_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'chat-uploads');

CREATE POLICY "chat_uploads_delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'chat-uploads');
