/**
 * Blank the contents of quoted literals and identifiers so keyword checks ignore words inside them
 * (for example a log search for '%update%'). Any backslash or unterminated quote makes the boundaries
 * dialect-dependent, so the original text is returned and checked as is.
 */
function maskQuoted(statement: string): string {
  // Masking must not hide text MySQL or PostgreSQL will execute. Dollar-quoted strings and Oracle
  // alternate quoting have different boundaries, so any of them disables masking for the whole statement.
  if (/\$[^\s$]*\$/.test(statement) || /[qQ]'./.test(statement)) return statement;
  let masked = "";
  for (let index = 0; index < statement.length; ) {
    const quote = statement[index]!;
    if (quote !== "'" && quote !== '"' && quote !== "`") {
      masked += quote;
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < statement.length) {
      const character = statement[end]!;
      if (character === "\\") return statement;
      if (character === quote) {
        if (statement[end + 1] === quote) {
          end += 2;
          continue;
        }
        break;
      }
      end += 1;
    }
    if (end >= statement.length) return statement;
    masked += quote + " ".repeat(end - index - 1) + quote;
    index = end + 1;
  }
  return masked;
}

export function validateReadOnlySql(query: string, maximumCharacters: number): string {
  const statement = query.trim().replace(/;\s*$/, "");
  if (!statement || statement.length > maximumCharacters) throw new Error("invalid_database_query");
  if (statement.includes(";") || /--|#|\/\*/.test(statement)) throw new Error("database_query_must_be_one_statement_without_comments");
  if (!/^(select|show|describe|desc|explain)\b/i.test(statement)) throw new Error("database_query_must_be_read_only");
  const unquoted = maskQuoted(statement);
  if (/\b(insert|update|delete|replace|create|alter|drop|truncate|rename|grant|revoke|call|do|handler|load|lock|unlock|set|use|begin|commit|rollback|savepoint|release)\b/i.test(unquoted))
    throw new Error("database_query_must_be_read_only");
  // A blocklist only narrows obvious side effects; the database account itself must be read-only.
  if (/\binto\b|\bfor\s+(?:(?:no\s+key\s+)?update|(?:key\s+)?share)\b|\block\s+in\s+share\s+mode\b|\bprocedure\s+analyse\b|\bexplain\s+analyze\b/i.test(unquoted))
    throw new Error("database_query_must_be_read_only");
  // Function names are checked on the original text: a quoted name such as "pg_sleep"(1) still calls the function.
  if (
    /\b(?:sleep|benchmark|load_file|get_lock|release_lock|is_free_lock|is_used_lock|master_pos_wait|source_pos_wait|sys_exec|sys_eval|nextval|setval|set_config|pg_sleep\w*|pg_advisory\w*|pg_try_advisory\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_restore_point|pg_notify|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_\w+|dblink\w*|query_to_xml\w*)["`]?\s*\(/i.test(
      statement,
    )
  )
    throw new Error("database_query_must_be_read_only");
  return statement;
}
