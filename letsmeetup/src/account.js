// "Delete my data": removes a signed-in user and everything that is theirs.

// - events they organised, with everything attached (participants, tags, runs, results);
// - their place in other people's events. Those events' calculations were made with them in, so
//   those runs' stored results are erased (the others can simply run it again);
// - their sessions and the account itself.
export async function deleteAccount(db, userId) {
  await db.batch([
    db.prepare('DELETE FROM events WHERE owner_id = ?').bind(userId),
    // A run in progress in someone else's event would otherwise leave it stuck as "calculating".
    db.prepare("UPDATE events SET status = 'open' WHERE status = 'calculating' AND id IN (SELECT event_id FROM participants WHERE user_id = ?)").bind(userId),
    db.prepare("DELETE FROM calc_runs WHERE status = 'running' AND event_id IN (SELECT event_id FROM participants WHERE user_id = ?)").bind(userId),
    db.prepare("UPDATE calc_runs SET result_json = NULL, input_snapshot = NULL WHERE status != 'running' AND event_id IN (SELECT event_id FROM participants WHERE user_id = ?)").bind(userId),
    db.prepare('DELETE FROM participants WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}
