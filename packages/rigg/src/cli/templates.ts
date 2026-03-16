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
      output:
        schema:
          type: object
          required: [markdown]
          additionalProperties: false
          properties:
            markdown:
              type: string

  - id: critique
    type: codex
    with:
      action: run
      model: gpt-5.4
      prompt: |
        Review this implementation plan critically.
        Identify ambiguities, flawed assumptions, and missing edge cases.

        Draft:
        \${{ steps.draft.result.markdown }}
      output:
        schema:
          type: object
          required: [has_findings, findings]
          additionalProperties: false
          properties:
            has_findings:
              type: boolean
            findings:
              type: array
              items:
                type: object
                required: [description, suggestion]
                additionalProperties: false
                properties:
                  description:
                    type: string
                  suggestion:
                    type: string

  - id: finalize
    type: branch
    cases:
      - if: \${{ steps.critique.result.has_findings }}
        steps:
          - id: improve
            type: codex
            with:
              action: run
              model: gpt-5.4
              prompt: |
                Improve the plan using the accepted findings below.

                Original draft:
                \${{ steps.draft.result.markdown }}

                Findings:
                \${{ toJSON(steps.critique.result.findings) }}
              output:
                schema:
                  type: object
                  required: [markdown]
                  additionalProperties: false
                  properties:
                    markdown:
                      type: string
        exports:
          markdown: \${{ steps.improve.result.markdown }}
      - else:
        steps:
          - id: noop
            type: shell
            with:
              command: "true"
              result: none
        exports:
          markdown: \${{ steps.draft.result.markdown }}

  - id: write
    type: write_file
    with:
      path: \${{ inputs.output_path }}
      content: \${{ steps.finalize.result.markdown }}
`.trimStart()

export const reviewUncommittedTemplate = `
id: review-uncommitted
steps:
  - id: remediation
    type: loop
    max: 5
    until: \${{ len(steps.review.result.findings) == 0 || steps.judge.result.accepted_count == 0 }}
    steps:
      - id: review
        type: codex
        with:
          action: review
          model: gpt-5.4
          review:
            target:
              type: uncommitted

      - id: judge
        type: codex
        with:
          action: run
          model: gpt-5.4
          prompt: |
            Read the review below.

            Review:
            \${{ toJSON(steps.review.result) }}

            Accept only findings that are valid and actionable.
          output:
            schema:
              type: object
              required: [accepted_count, fix_brief]
              additionalProperties: false
              properties:
                accepted_count:
                  type: integer
                fix_brief:
                  type: string

      - id: fix
        if: \${{ steps.judge.result.accepted_count > 0 }}
        type: codex
        with:
          action: run
          model: gpt-5.4
          prompt: \${{ steps.judge.result.fix_brief }}
    exports:
      accepted_count: \${{ steps.judge.result.accepted_count }}
      fix_brief: \${{ steps.judge.result.fix_brief }}
`.trimStart()

export const reviewBranchTemplate = `
id: review-branch
inputs:
  base_branch:
    type: string
    description: Base branch to diff against
steps:
  - id: remediation
    type: loop
    max: 5
    until: \${{ len(steps.review.result.findings) == 0 || steps.judge.result.accepted_count == 0 }}
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

      - id: judge
        type: codex
        with:
          action: run
          model: gpt-5.4
          prompt: |
            Read the review below.

            Review:
            \${{ toJSON(steps.review.result) }}

            Accept only findings that are valid and actionable.
          output:
            schema:
              type: object
              required: [accepted_count, fix_brief]
              additionalProperties: false
              properties:
                accepted_count:
                  type: integer
                fix_brief:
                  type: string

      - id: fix
        if: \${{ steps.judge.result.accepted_count > 0 }}
        type: codex
        with:
          action: run
          model: gpt-5.4
          prompt: \${{ steps.judge.result.fix_brief }}
    exports:
      accepted_count: \${{ steps.judge.result.accepted_count }}
      fix_brief: \${{ steps.judge.result.fix_brief }}
`.trimStart()

export const reviewCommitTemplate = `
id: review-commit
inputs:
  commit_sha:
    type: string
    description: Commit to review
steps:
  - id: remediation
    type: loop
    max: 5
    until: \${{ len(steps.review.result.findings) == 0 || steps.judge.result.accepted_count == 0 }}
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

      - id: judge
        type: codex
        with:
          action: run
          model: gpt-5.4
          prompt: |
            Read the review below.

            Review:
            \${{ toJSON(steps.review.result) }}

            Accept only findings that are valid and actionable.
          output:
            schema:
              type: object
              required: [accepted_count, fix_brief]
              additionalProperties: false
              properties:
                accepted_count:
                  type: integer
                fix_brief:
                  type: string

      - id: fix
        if: \${{ steps.judge.result.accepted_count > 0 }}
        type: codex
        with:
          action: run
          model: gpt-5.4
          prompt: \${{ steps.judge.result.fix_brief }}
    exports:
      accepted_count: \${{ steps.judge.result.accepted_count }}
      fix_brief: \${{ steps.judge.result.fix_brief }}
`.trimStart()
