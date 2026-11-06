-- ---------------------------------------------------------------------------
-- Enhancement provenance (v1.1.0)
--
-- The studio can draft every field locally. Storing which fields were accepted
-- from the assistant keeps the record honest: a reviewer can see which parts of
-- a proposal are machine-drafted and which were written by the author.
-- ---------------------------------------------------------------------------
ALTER TABLE enhancements ADD COLUMN ai_fields TEXT; -- JSON array of field names
