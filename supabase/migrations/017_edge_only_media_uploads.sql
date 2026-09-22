-- All new media uploads are validated and stored by nihility-secure.
-- Browser roles keep private read/delete access, but can no longer insert
-- directly into Storage and bypass dimension/quota validation.

drop policy if exists "nihility_media_insert_own" on storage.objects;
revoke insert on storage.objects from authenticated;
