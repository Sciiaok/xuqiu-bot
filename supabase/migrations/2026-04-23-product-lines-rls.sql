-- Mirror the RLS pattern used by the other admin-managed tables
-- (product_documents / product_specs / kb_* / agents ...):
-- enable RLS + add a permissive policy for authenticated + anon.
-- Without this, the anon key on the browser gets an empty array
-- from SELECT * FROM product_lines, which surfaced as an empty list page.

ALTER TABLE product_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "product_lines_auth_all" ON product_lines;
CREATE POLICY "product_lines_auth_all" ON product_lines
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);
