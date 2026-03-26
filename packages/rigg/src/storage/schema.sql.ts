import { integer } from "drizzle-orm/sqlite-core"

export const Timestamps = {
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .$default(() => Date.now()),
  updatedAt: integer("updated_at", { mode: "number" })
    .notNull()
    .$onUpdate(() => Date.now()),
}
