type AssistantTranscriptEntry = {
  completed: boolean
  completedText: string | null
  itemId: string | null
  streamedText: string
}

export type AssistantMessageCompletion = {
  itemId: string | null
  text: string | null
}

export type AssistantMessageDelta = {
  itemId: string | null
  text: string
}

export type AssistantTranscript = {
  entries: AssistantTranscriptEntry[]
}

export function createTranscript(): AssistantTranscript {
  return {
    entries: [],
  }
}

export function appendDelta(transcript: AssistantTranscript, delta: AssistantMessageDelta): void {
  const entry = getOrCreateEntry(transcript, delta.itemId)
  entry.streamedText += delta.text
}

export function completeMessage(transcript: AssistantTranscript, completion: AssistantMessageCompletion): string {
  const entry = getOrCreateEntry(transcript, completion.itemId)
  entry.completed = true
  if (completion.text !== null) {
    entry.completedText = completion.text
  }
  return resolveEntryText(entry)
}

export function renderTranscript(transcript: AssistantTranscript): string {
  return transcript.entries
    .map((entry) => resolveEntryText(entry))
    .filter((text) => text.length > 0)
    .join("\n")
}

function getOrCreateEntry(transcript: AssistantTranscript, itemId: string | null): AssistantTranscriptEntry {
  if (itemId !== null) {
    const existing = transcript.entries.find((entry) => entry.itemId === itemId)
    if (existing !== undefined) {
      return existing
    }

    const entry = createEntry(itemId)
    transcript.entries.push(entry)
    return entry
  }

  const existingAnonymous = [...transcript.entries].reverse().find((entry) => entry.itemId === null && !entry.completed)
  if (existingAnonymous !== undefined) {
    return existingAnonymous
  }

  const entry = createEntry(null)
  transcript.entries.push(entry)
  return entry
}

function createEntry(itemId: string | null): AssistantTranscriptEntry {
  return {
    completed: false,
    completedText: null,
    itemId,
    streamedText: "",
  }
}

function resolveEntryText(entry: AssistantTranscriptEntry): string {
  return entry.completedText ?? entry.streamedText
}
