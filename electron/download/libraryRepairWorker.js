// Legacy library identity reconciliation is potentially expensive on large
// libraries and can stat aliases on unavailable network drives. Keep it off
// Electron's main event loop so the player window can render immediately.
const { parentPort, workerData } = require('node:worker_threads')
const Database = require('better-sqlite3')
let db
try {
  db = new Database(workerData.databasePath, { fileMustExist: true })
  // The renderer and library scanner can still access this WAL database.
  // Respect their write transactions rather than failing with SQLITE_BUSY.
  db.pragma('busy_timeout = 5000')
  const repaired = require('../libraryPathIdentity').repairSameFileRows(db)
  parentPort.postMessage({ repaired })
} catch (error) {
  parentPort.postMessage({ error: error.message || String(error) })
} finally {
  try { db?.close() } catch {}
}
