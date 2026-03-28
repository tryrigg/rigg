export const implementTemplate = `
id: implement
inputs:
  requirements:
    type: string
    description: Task or change request to implement
steps:
  - id: build
    type: opencode
    with:
      prompt: |
        Implement the following change in the current repository.

        Requirements:
        \${{ inputs.requirements }}
`.trimStart()

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
      kind: turn
      collaboration_mode: plan
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
          kind: review
          model: gpt-5.4
          target:
            type: uncommitted

      - id: fix
        if: \${{ len(steps.review.result.findings) > 0 }}
        retry:
          max: 3
          delay: 1s
        type: codex
        with:
          kind: turn
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
          kind: review
          model: gpt-5.4
          target:
            type: base
            branch: \${{ inputs.base_branch }}

      - id: fix
        if: \${{ len(steps.review.result.findings) > 0 }}
        retry:
          max: 3
          delay: 1s
        type: codex
        with:
          kind: turn
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
          kind: review
          model: gpt-5.4
          target:
            type: commit
            sha: \${{ inputs.commit_sha }}

      - id: fix
        if: \${{ len(steps.review.result.findings) > 0 }}
        retry:
          max: 3
          delay: 1s
        type: codex
        with:
          kind: turn
          model: gpt-5.4
          prompt: |
            Address the findings from this review.

            Review:
            \${{ toJSON(steps.review.result) }}
    exports:
      finding_count: \${{ len(steps.review.result.findings) }}
`.trimStart()
