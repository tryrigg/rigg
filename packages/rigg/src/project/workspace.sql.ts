import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import { Timestamps } from "../storage/schema.sql"
import { projectTable } from "./project.sql"

export const workspaceTable = sqliteTable(
  "workspace",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, { onDelete: "cascade" }),
    rootDir: text("root_dir").notNull(),
    riggDir: text("rigg_dir").notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("workspace_root_dir_unique").on(table.rootDir),
    index("workspace_project_idx").on(table.projectId),
  ],
)
