export type CodexReviewResult = {
  findings: Array<{
    body: string
    code_location: {
      absolute_file_path: string
      line_range: {
        end: number
        start: number
      }
    }
    confidence_score: number
    priority?: number | null | undefined
    title: string
  }>
  overall_confidence_score: number
  overall_correctness: string
  overall_explanation: string
}
