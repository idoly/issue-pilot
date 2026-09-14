export function validateReadOnlySql(query: string, maximumCharacters: number): string {
  const statement = query.trim().replace(/;\s*$/, "");
  if (!statement || statement.length > maximumCharacters) throw new Error("invalid_database_query");
  if (statement.includes(";") || /--|#|\/\*/.test(statement)) throw new Error("database_query_must_be_one_statement_without_comments");
  if (!/^(select|show|describe|desc|explain)\b/i.test(statement)) throw new Error("database_query_must_be_read_only");
  if (/\b(insert|update|delete|replace|create|alter|drop|truncate|rename|grant|revoke|call|do|handler|load|lock|unlock|set|use|begin|commit|rollback|savepoint|release)\b/i.test(statement)) throw new Error("database_query_must_be_read_only");
  if (/\binto\s+(?:out|dump)file\b|\binto\s+@|\bfor\s+update\b|\block\s+in\s+share\s+mode\b|\bprocedure\s+analyse\b|\bexplain\s+analyze\b|\b(?:sleep|benchmark|load_file|get_lock|release_lock|is_free_lock|is_used_lock|master_pos_wait|source_pos_wait|sys_exec|sys_eval)\s*\(/i.test(statement)) throw new Error("database_query_must_be_read_only");
  return statement;
}
