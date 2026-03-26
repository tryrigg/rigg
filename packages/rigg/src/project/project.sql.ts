import { sqliteTable, text } from "drizzle-orm/sqlite-core"

import { Timestamps } from "../storage/schema.sql"

export const projectTable = sqliteTable("project", {
  id: text("id").primaryKey(),
  ...Timestamps,
})
