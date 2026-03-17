import { Box, useInput } from "ink"
import { useMemo, useSyncExternalStore } from "react"

import type { CodexInteractionResolution } from "../../codex/interaction"
import type { WorkflowDocument } from "../../compile/schema"
import { BarrierPrompt } from "./barrier-prompt"
import { Header } from "./header"
import { InteractionPrompt } from "./interaction-prompt"
import type { TuiStore } from "./store"
import { Summary } from "./summary"
import { formatElapsedClock } from "./time"
import { buildTree } from "./tree"
import { WorkflowTree } from "./workflow-tree"

export function App({
  onInterrupt,
  onResolveBarrier,
  onResolveInteraction,
  store,
  workflow,
}: {
  onInterrupt: () => void
  onResolveBarrier: (barrierId: string, action: "abort" | "continue") => void
  onResolveInteraction: (interactionId: string, resolution: CodexInteractionResolution) => void
  store: TuiStore
  workflow: WorkflowDocument
}) {
  const { state } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { snapshot, liveOutputs, completedOutputs } = state
  const elapsed = formatElapsedClock(snapshot?.started_at ?? null, snapshot?.finished_at ?? null)
  const isFinished = snapshot !== null && snapshot.status !== "running"
  const entries = useMemo(() => buildTree(workflow, snapshot), [workflow, snapshot])
  const activeBarrier = snapshot?.active_barrier ?? null
  const activeInteraction = snapshot?.active_interaction ?? null

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt()
    }
  })

  return (
    <Box flexDirection="column">
      <Header snapshot={snapshot} elapsed={elapsed} />
      <WorkflowTree entries={entries} liveOutputs={liveOutputs} completedOutputs={completedOutputs} />
      {activeBarrier !== null && (
        <BarrierPrompt
          key={activeBarrier.barrier_id}
          barrier={activeBarrier}
          onResolve={(action) => onResolveBarrier(activeBarrier.barrier_id, action)}
        />
      )}
      {activeInteraction !== null && (
        <InteractionPrompt
          key={activeInteraction.interaction_id}
          interaction={activeInteraction}
          onResolve={(resolution) => onResolveInteraction(activeInteraction.interaction_id, resolution)}
        />
      )}
      {isFinished && activeBarrier === null && activeInteraction === null && (
        <Summary snapshot={snapshot} entries={entries} />
      )}
    </Box>
  )
}
