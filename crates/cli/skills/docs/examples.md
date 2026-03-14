# Rigg Workflow Examples

## 1. Simple Shell Pipeline

```yaml
id: build-and-test
steps:
  - id: install
    type: shell
    with:
      command: npm install
      result: none

  - id: build
    type: shell
    with:
      command: npm run build
      result: text

  - id: test
    type: shell
    with:
      command: npm test
      result: json
```

## 2. Code Review with Remediation Loop

```yaml
id: review-uncommitted
steps:
  - id: remediation
    type: loop
    max: 5
    until: ${{ len(steps.review.result.findings) == 0 || steps.judge.result.accepted_count == 0 }}
    steps:
      - id: review
        type: codex
        with:
          action: review
          model: gpt-5.4
          target: uncommitted
          prompt: Review current uncommitted changes for bugs and missing tests.

      - id: judge
        type: claude
        with:
          action: prompt
          model: claude-opus-4-6
          prompt: |
            Read the review below.

            Review:
            ${{ toJSON(steps.review.result) }}

            Accept only findings that are valid and actionable.
          output_schema:
            type: object
            required: [accepted_count, fix_brief]
            additionalProperties: false
            properties:
              accepted_count:
                type: integer
              fix_brief:
                type: string

      - id: fix
        if: ${{ steps.judge.result.accepted_count > 0 }}
        type: codex
        with:
          action: exec
          model: gpt-5.4
          mode: full_auto
          prompt: ${{ steps.judge.result.fix_brief }}
    exports:
      accepted_count: ${{ steps.judge.result.accepted_count }}
      fix_brief: ${{ steps.judge.result.fix_brief }}
```

## 3. Branch-Based Review (Base Branch Diff)

```yaml
id: review-branch
inputs:
  base_branch:
    type: string
    description: Base branch to diff against
steps:
  - id: remediation
    type: loop
    max: 5
    until: ${{ steps.judge.result.accepted_count == 0 }}
    steps:
      - id: review
        type: codex
        with:
          action: review
          model: gpt-5.4
          target: base
          base: ${{ inputs.base_branch }}
          prompt: Review the current branch diff for bugs and missing tests.

      - id: judge
        type: claude
        with:
          action: prompt
          model: claude-opus-4-6
          prompt: |
            Read the review below.

            Review:
            ${{ toJSON(steps.review.result) }}

            Accept only findings that are valid and actionable.
          output_schema:
            type: object
            required: [accepted_count, fix_brief]
            additionalProperties: false
            properties:
              accepted_count:
                type: integer
              fix_brief:
                type: string

      - id: fix
        if: ${{ steps.judge.result.accepted_count > 0 }}
        type: codex
        with:
          action: exec
          model: gpt-5.4
          mode: full_auto
          prompt: ${{ steps.judge.result.fix_brief }}
    exports:
      accepted_count: ${{ steps.judge.result.accepted_count }}
      fix_brief: ${{ steps.judge.result.fix_brief }}
```

## 4. Plan with Review and Conditional Refinement

```yaml
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
      action: exec
      model: gpt-5.4
      prompt: |
        Draft a detailed implementation plan from the requirements below.
        Requirements:
        ${{ inputs.requirements }}
      output_schema:
        type: object
        required: [markdown]
        additionalProperties: false
        properties:
          markdown:
            type: string

  - id: critique
    type: claude
    with:
      action: prompt
      model: claude-opus-4-6
      prompt: |
        Review this plan critically. Identify ambiguities, gaps, or technical issues.
        Draft:
        ${{ steps.draft.result.markdown }}
      output_schema:
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
      - if: ${{ steps.critique.result.has_findings }}
        steps:
          - id: improve
            type: codex
            with:
              action: exec
              model: gpt-5.4
              prompt: |
                Apply review feedback to improve the plan.
                Original: ${{ steps.draft.result.markdown }}
                Findings: ${{ toJSON(steps.critique.result.findings) }}
              output_schema:
                type: object
                required: [markdown]
                additionalProperties: false
                properties:
                  markdown:
                    type: string
        exports:
          markdown: ${{ steps.improve.result.markdown }}
      - else:
        steps:
          - id: noop
            type: shell
            with:
              command: "true"
              result: none
        exports:
          markdown: ${{ steps.draft.result.markdown }}

  - id: write
    type: write_file
    with:
      path: ${{ inputs.output_path }}
      content: ${{ steps.finalize.result.markdown }}
```

## 5. Parallel Test Execution

```yaml
id: parallel-tests
steps:
  - id: all_tests
    type: parallel
    branches:
      - id: unit
        steps:
          - id: run_unit
            type: shell
            with:
              command: cargo test --lib
              result: text
      - id: integration
        steps:
          - id: run_integration
            type: shell
            with:
              command: cargo test --test '*'
              result: text
      - id: lint
        steps:
          - id: run_lint
            type: shell
            with:
              command: cargo clippy -- -D warnings
              result: text
    exports:
      unit_output: ${{ steps.run_unit.result }}
      integration_output: ${{ steps.run_integration.result }}
      lint_output: ${{ steps.run_lint.result }}

  - id: report
    type: claude
    with:
      action: prompt
      prompt: |
        Summarize the test results:
        Unit: ${{ steps.all_tests.result.unit_output }}
        Integration: ${{ steps.all_tests.result.integration_output }}
        Lint: ${{ steps.all_tests.result.lint_output }}
      output_schema:
        type: object
        required: [summary, passed]
        additionalProperties: false
        properties:
          summary:
            type: string
          passed:
            type: boolean
```

## 6. Group with Encapsulated Logic

```yaml
id: analysis
steps:
  - id: gather
    type: group
    steps:
      - id: git_log
        type: shell
        with:
          command: git log --oneline -20
          result: text
      - id: git_diff
        type: shell
        with:
          command: git diff --stat
          result: text
    exports:
      log: ${{ steps.git_log.result }}
      diff: ${{ steps.git_diff.result }}

  - id: analyze
    type: claude
    with:
      action: prompt
      prompt: |
        Analyze recent changes:
        Log: ${{ steps.gather.result.log }}
        Diff: ${{ steps.gather.result.diff }}
```

## 7. Conversation Persistence Across Loop Iterations

```yaml
id: iterative-refinement
inputs:
  task:
    type: string
    description: Task to refine
steps:
  - id: refine
    type: loop
    max: 3
    until: ${{ steps.evaluate.result.quality >= 8 }}
    steps:
      - id: work
        type: codex
        with:
          action: exec
          prompt: |
            Iteration ${{ run.iteration }} of ${{ run.max_iterations }}.
            Task: ${{ inputs.task }}
            Refine and improve the implementation.
          conversation:
            name: worker
            scope: loop

      - id: evaluate
        type: claude
        with:
          action: prompt
          prompt: |
            Rate the quality of this work (1-10):
            ${{ steps.work.result }}
          output_schema:
            type: object
            required: [quality, feedback]
            additionalProperties: false
            properties:
              quality:
                type: integer
              feedback:
                type: string
    exports:
      work_result: ${{ steps.work.result }}
      quality: ${{ steps.evaluate.result.quality }}
```

## 8. Conditional Step Execution

```yaml
id: conditional-workflow
inputs:
  run_tests:
    type: boolean
    default: true
  environment:
    type: string
    enum: ["dev", "staging", "prod"]
steps:
  - id: build
    type: shell
    with:
      command: npm run build
      result: text

  - id: test
    if: ${{ inputs.run_tests }}
    type: shell
    with:
      command: npm test
      result: text

  - id: deploy
    type: shell
    env:
      DEPLOY_ENV: ${{ inputs.environment }}
    with:
      command: ./deploy.sh
      result: text
```

## 9. Commit-Specific Review

```yaml
id: review-commit
inputs:
  commit_sha:
    type: string
    description: Commit SHA to review
steps:
  - id: remediation
    type: loop
    max: 5
    until: ${{ steps.judge.result.accepted_count == 0 }}
    steps:
      - id: review
        type: codex
        with:
          action: review
          model: gpt-5.4
          target: commit
          commit: ${{ inputs.commit_sha }}
          title: Review commit
          prompt: Review the selected commit for bugs and missing tests.

      - id: judge
        type: claude
        with:
          action: prompt
          model: claude-opus-4-6
          prompt: |
            Read the review below.

            Review:
            ${{ toJSON(steps.review.result) }}

            Accept only findings that are valid and actionable.
          output_schema:
            type: object
            required: [accepted_count, fix_brief]
            additionalProperties: false
            properties:
              accepted_count:
                type: integer
              fix_brief:
                type: string

      - id: fix
        if: ${{ steps.judge.result.accepted_count > 0 }}
        type: codex
        with:
          action: exec
          model: gpt-5.4
          mode: full_auto
          prompt: ${{ steps.judge.result.fix_brief }}
    exports:
      accepted_count: ${{ steps.judge.result.accepted_count }}
      fix_brief: ${{ steps.judge.result.fix_brief }}
```

## Common Patterns

### Pattern: Structured output with validation

Always use `additionalProperties: false` and `required` to get strict validation:

```yaml
output_schema:
  type: object
  required: [field1, field2]
  additionalProperties: false
  properties:
    field1:
      type: string
    field2:
      type: integer
```

### Pattern: Passthrough in branch else

When one branch does work and the other passes through:

```yaml
- else:
  steps:
    - id: noop
      type: shell
      with:
        command: "true"
        result: none
  exports:
    value: ${{ steps.previous_step.result }}
```

### Pattern: Loop with conversation context

Use `scope: loop` to maintain conversation across all iterations:

```yaml
conversation:
  name: my_context
  scope: loop # Persists across iterations
```

Use `scope: iteration` (default in loops) for fresh context each iteration.
