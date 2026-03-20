export const planTemplate = `
id: plan
inputs:
  requirements:
    type: string
    description: Requirements for the implementation plan
  output_path:
    type: string
    description: Path to write the generated plan
steps:
  - id: draft
    type: codex
    with:
      action: run
      model: gpt-5.4
      prompt: |
        Draft a detailed implementation plan from the requirements below.

        Requirements:
        \${{ inputs.requirements }}

  - id: write
    type: write_file
    with:
      path: \${{ inputs.output_path }}
      content: \${{ steps.draft.result }}
`.trimStart()

export const uncommittedTemplate = `
id: review-uncommitted
steps:
  - id: remediation
    type: loop
    max: 5
    until: \${{ len(steps.review.result.findings) == 0 }}
    steps:
      - id: review
        type: codex
        with:
          action: review
          model: gpt-5.4
          review:
            target:
              type: uncommitted

      - id: fix
        if: \${{ len(steps.review.result.findings) > 0 }}
        type: codex
        with:
          action: run
          model: gpt-5.4
          prompt: |
            Address the findings from this review.

            Review:
            \${{ toJSON(steps.review.result) }}
    exports:
      finding_count: \${{ len(steps.review.result.findings) }}
`.trimStart()

export const branchTemplate = `
id: review-branch
inputs:
  base_branch:
    type: string
    description: Base branch to diff against
steps:
  - id: remediation
    type: loop
    max: 5
    until: \${{ len(steps.review.result.findings) == 0 }}
    steps:
      - id: review
        type: codex
        with:
          action: review
          model: gpt-5.4
          review:
            target:
              type: base
              branch: \${{ inputs.base_branch }}

      - id: fix
        if: \${{ len(steps.review.result.findings) > 0 }}
        type: codex
        with:
          action: run
          model: gpt-5.4
          prompt: |
            Address the findings from this review.

            Review:
            \${{ toJSON(steps.review.result) }}
    exports:
      finding_count: \${{ len(steps.review.result.findings) }}
`.trimStart()

export const commitTemplate = `
id: review-commit
inputs:
  commit_sha:
    type: string
    description: Commit to review
steps:
  - id: remediation
    type: loop
    max: 5
    until: \${{ len(steps.review.result.findings) == 0 }}
    steps:
      - id: review
        type: codex
        with:
          action: review
          model: gpt-5.4
          review:
            target:
              type: commit
              sha: \${{ inputs.commit_sha }}

      - id: fix
        if: \${{ len(steps.review.result.findings) > 0 }}
        type: codex
        with:
          action: run
          model: gpt-5.4
          prompt: |
            Address the findings from this review.

            Review:
            \${{ toJSON(steps.review.result) }}
    exports:
      finding_count: \${{ len(steps.review.result.findings) }}
`.trimStart()
