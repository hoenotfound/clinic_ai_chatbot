const { pool } = require("./db");

/** All notes for one contact, most recent first — shown on their profile in the Contacts directory. */
async function listNotes(contactId) {
  const result = await pool.query(
    "SELECT * FROM contact_notes WHERE contact_id = $1 ORDER BY created_at DESC, id DESC",
    [contactId]
  );
  return result.rows;
}

/** Adds a note. `author` is the staff username (from req.session.username), never the AI. */
async function addNote(contactId, author, content) {
  const result = await pool.query(
    "INSERT INTO contact_notes (contact_id, author, content) VALUES ($1, $2, $3) RETURNING *",
    [contactId, author, content]
  );
  return result.rows[0];
}

/**
 * Deletes a note, scoped to the given contactId so a stray/guessed note id
 * from a different contact can never be deleted through this call.
 */
async function deleteNote(contactId, noteId) {
  await pool.query("DELETE FROM contact_notes WHERE id = $1 AND contact_id = $2", [noteId, contactId]);
}

module.exports = { listNotes, addNote, deleteNote };
