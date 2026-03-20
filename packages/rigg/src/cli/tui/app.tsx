import { Box, Text, useInput } from "ink"
import { useMemo, useSyncExternalStore } from "react"

import type { CodexInteractionResolution } from "../../codex/interaction"
import type { WorkflowProject } from "../../compile/project"
import type { WorkflowDocument } from "../../compile/schema"
import type { BarrierApprovalMode } from "../run"
import { BarrierPrompt } from "./barrier-prompt"
import { Header } from "./header"
import { InteractionPrompt } from "./interaction-prompt"
import { formatStepProgress, summarizeStepProgress } from "./step-progress"
import type { TuiStore } from "./store"
import { Summary } from "./summary"
import { formatElapsedClock } from "./time"
import { buildTree } from "./tree"
import { WorkflowTree } from "./workflow-tree"

export function App({
  barrierMode,
  onInterrupt,
  onResolveBarrier,
  onResolveInteraction,
  project,
  store,
  workflow,
}: {
  barrierMode: BarrierApprovalMode
  onInterrupt: () => void
  onResolveBarrier: (barrierId: string, action: "abort" | "continue") => void
  onResolveInteraction: (interactionId: string, resolution: CodexInteractionResolution) => void
  project?: WorkflowProject | undefined
  store: TuiStore
  workflow: WorkflowDocument
}) {
  const { state } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { snapshot, liveOutputs, completedOutputs } = state
  const elapsed = formatElapsedClock(snapshot?.started_at ?? null, snapshot?.finished_at ?? null)
  const isFinished = snapshot !== null && snapshot.status !== "running"
  const entries = useMemo(() => buildTree(workflow, snapshot, project), [workflow, snapshot, project])
  const stepProgress = useMemo(
    () => formatStepProgress(summarizeStepProgress(workflow, snapshot, project)),
    [workflow, snapshot, project],
  )
  const activeBarrier = snapshot?.active_barrier ?? null
  const activeInteraction = snapshot?.active_interaction ?? null

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt()
    }
  })

  return (
    <Box flexDirection="column">
      <Header barrierMode={barrierMode} snapshot={snapshot} elapsed={elapsed} stepProgress={stepProgress} />
      <WorkflowTree entries={entries} liveOutputs={liveOutputs} completedOutputs={completedOutputs} />
      {activeBarrier !== null && barrierMode === "manual" && (
        <Box borderStyle="single" borderColor="yellow" marginTop={1} paddingX={1}>
          <Box flexDirection="column">
            <Text inverse color="yellow">
              {" ⚠ ACTION REQUIRED "}
            </Text>
            <BarrierPrompt
              key={activeBarrier.barrier_id}
              barrier={activeBarrier}
              onResolve={(action) => onResolveBarrier(activeBarrier.barrier_id, action)}
            />
          </Box>
        </Box>
      )}
      {activeInteraction !== null && (
        <Box borderStyle="single" borderColor="cyan" marginTop={1} paddingX={1}>
          <Box flexDirection="column">
            <Text inverse color="cyan">
              {" ◇ INPUT NEEDED "}
            </Text>
            <InteractionPrompt
              key={activeInteraction.interaction_id}
              interaction={activeInteraction}
              onResolve={(resolution) => onResolveInteraction(activeInteraction.interaction_id, resolution)}
            />
          </Box>
        </Box>
      )}
      {isFinished && activeBarrier === null && activeInteraction === null && (
        <Summary snapshot={snapshot} entries={entries} />
      )}
    </Box>
  )
}
