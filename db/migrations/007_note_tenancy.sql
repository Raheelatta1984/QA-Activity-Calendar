-- Sticky notes are operator content, so they follow the selected tenant.
-- Existing notes belong to the pre-tenancy (default) workspace; nothing is
-- guessed for notes that cannot be attributed.
ALTER TABLE sticky_notes ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;

-- Prefer the author's tenant when a user wrote the note. AI guidance notes keep
-- their default owner but are treated as shared reference content by notesFor.
UPDATE sticky_notes
   SET company_id = (
     SELECT d.company_id
       FROM people p JOIN departments d ON d.id = p.department_id
      WHERE p.id = sticky_notes.author_id
   )
 WHERE company_id IS NULL AND author_id IS NOT NULL;

UPDATE sticky_notes
   SET company_id = (
     SELECT id FROM companies
      ORDER BY is_default DESC, created_at, id
      LIMIT 1
   )
 WHERE company_id IS NULL;

CREATE INDEX IF NOT EXISTS ix_sticky_notes_company ON sticky_notes(company_id);
