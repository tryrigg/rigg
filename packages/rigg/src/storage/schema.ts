import { projectTable } from "../project/project.sql"
import { workspaceTable } from "../project/workspace.sql"
import { eventTable, runTable, stepTable } from "../history/history.sql"

export { eventTable, projectTable, runTable, stepTable, workspaceTable }

export const schema = {
  eventTable,
  projectTable,
  runTable,
  stepTable,
  workspaceTable,
}
