import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema.ts";
import * as anonymoMoney from "../anonymo/deposits/schema.ts"; // WS05: kept out of db/schema.ts so the migration image needs no new file

export type SchemaColumn = { name: string; type: string; nullable: boolean };
export type SchemaTable = { name: string; columns: SchemaColumn[] };

/** Every table and column declared in src/db/schema.ts (and the Anonymo money tables), sorted by name, read from the drizzle definitions. */
export function schemaTables(): SchemaTable[] {
  const out: SchemaTable[] = [];
  for (const value of [...Object.values(schema), ...Object.values(anonymoMoney)]) {
    if (!is(value, PgTable)) continue;
    const t = getTableConfig(value);
    out.push({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.getSQLType(), nullable: !c.notNull })) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}
