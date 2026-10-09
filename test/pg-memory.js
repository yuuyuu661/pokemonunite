import { newDb } from 'pg-mem';
// pg-mem's repeated CREATE TABLE IF NOT EXISTS flags skipped AST nodes.
const db = newDb({ noAstCoverageCheck: true });
export default db.adapters.createPg();
