use miette::{IntoDiagnostic, Result};
use std::fs;
use std::path::Path;

pub(super) fn run() -> Result<()> {
    let cwd = std::env::current_dir().into_diagnostic()?;
    let rigg_dir = cwd.join(".rigg");
    fs::create_dir_all(&rigg_dir).into_diagnostic()?;

    write_if_missing(&rigg_dir.join("plan.yaml"), PLAN_TEMPLATE.trim_start())?;
    write_if_missing(
        &rigg_dir.join("review-uncommitted.yaml"),
        REVIEW_UNCOMMITTED_TEMPLATE.trim_start(),
    )?;
    write_if_missing(&rigg_dir.join("review-branch.yaml"), REVIEW_BRANCH_TEMPLATE.trim_start())?;
    write_if_missing(&rigg_dir.join("review-commit.yaml"), REVIEW_COMMIT_TEMPLATE.trim_start())?;

    let docs_dir = rigg_dir.join("docs");
    fs::create_dir_all(&docs_dir).into_diagnostic()?;
    write_if_missing(&docs_dir.join("workflow-syntax.md"), DOCS_WORKFLOW_SYNTAX)?;
    write_if_missing(&docs_dir.join("schema-reference.md"), DOCS_SCHEMA_REFERENCE)?;
    write_if_missing(&docs_dir.join("examples.md"), DOCS_EXAMPLES)?;

    for skill_dir in [".agents/skills/rigg", ".claude/skills/rigg"] {
        let dir = cwd.join(skill_dir);
        fs::create_dir_all(&dir).into_diagnostic()?;
        write_if_missing(&dir.join("SKILL.md"), SKILL)?;
    }

    ensure_gitignore(&cwd.join(".gitignore"), "/.rigg/runs/")?;

    println!("Initialized .rigg/ with example workflows.");
    println!("Generated workflows: plan, review-uncommitted, review-branch, review-commit.");
    println!("Generated .rigg/docs/ with workflow authoring documentation.");
    println!(
        "Generated .agents/skills/rigg/ and .claude/skills/rigg/ for AI-assisted workflow authoring."
    );
    println!("Examples:");
    println!("  rigg run plan --input requirements='...' --input output_path=plan.md");
    println!("  rigg run review-uncommitted");
    println!("  rigg run review-branch --input base_branch=main");
    println!("  rigg run review-commit --input commit_sha=HEAD~1");
    Ok(())
}

fn write_if_missing(path: &Path, contents: &str) -> Result<()> {
    if path.exists() {
        return Ok(());
    }

    fs::write(path, contents).into_diagnostic()?;
    Ok(())
}

fn ensure_gitignore(path: &Path, line: &str) -> Result<()> {
    let mut contents =
        if path.exists() { fs::read_to_string(path).into_diagnostic()? } else { String::new() };

    if !contents.lines().any(|existing| existing == line) {
        if !contents.is_empty() && !contents.ends_with('\n') {
            contents.push('\n');
        }
        contents.push_str(line);
        contents.push('\n');
        fs::write(path, contents).into_diagnostic()?;
    }
    Ok(())
}

const PLAN_TEMPLATE: &str = r#"
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
        You are a senior software architect. Draft a detailed implementation plan from the requirements below.

        Your output must be a specification document that the next implementer can follow WITHOUT any ambiguity. Include:
        - Clear problem statement and goals
        - Step-by-step implementation instructions with exact file paths, function signatures, and data structures
        - Decision rationale for every non-obvious choice (why this approach over alternatives)
        - Concrete examples, expected inputs/outputs, and edge cases
        - Dependencies and prerequisite setup
        - Acceptance criteria that are testable and unambiguous
        - Potential risks, pitfalls, and how to mitigate them

        Do NOT leave any room for interpretation. If a future developer reads this document, they should be able to implement it without asking a single clarifying question.

        Requirements:
        ${{ inputs.requirements }}
      output_schema:
        type: object
        required: [markdown]
        additionalProperties: false
        properties:
          markdown:
            type: string

  - id: review
    type: claude
    with:
      action: prompt
      model: claude-opus-4-6
      prompt: |
        You are a principal engineer reviewing the implementation plan below.

        Review it critically and identify:
        1. Ambiguities or gaps that would confuse an implementer
        2. Technical inaccuracies or flawed assumptions
        3. Missing edge cases or error handling considerations
        4. Architectural concerns or better alternatives
        5. Unclear or incomplete acceptance criteria

        For each finding, provide a structured entry. If the plan is already solid and you have no findings, return has_findings: false and an empty findings array.

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
              required: [severity, category, description, suggestion]
              additionalProperties: false
              properties:
                severity:
                  type: string
                category:
                  type: string
                description:
                  type: string
                suggestion:
                  type: string

  - id: finalize
    type: branch
    cases:
      - if: ${{ steps.review.result.has_findings }}
        steps:
          - id: evaluate_and_apply
            type: codex
            with:
              action: exec
              model: gpt-5.4
              prompt: |
                You are a senior software architect. You wrote the original draft below, and a reviewer has provided findings.

                Your task:
                1. Evaluate each finding for validity. Accept findings that are genuinely correct and improve the plan. Reject findings that are nitpicks, subjective preferences, or based on incorrect assumptions.
                2. For each accepted finding, apply the improvement directly into the plan.
                3. Produce the final, polished implementation plan incorporating all accepted changes.

                The final document must be complete, self-contained, and unambiguous — a developer should be able to implement it without asking any clarifying questions.

                Original draft:
                ${{ steps.draft.result.markdown }}

                Review findings:
                ${{ toJSON(steps.review.result.findings) }}
              output_schema:
                type: object
                required: [markdown]
                additionalProperties: false
                properties:
                  markdown:
                    type: string
        exports:
          markdown: ${{ steps.evaluate_and_apply.result.markdown }}
      - else:
        steps:
          - id: passthrough
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
"#;

const REVIEW_UNCOMMITTED_TEMPLATE: &str = r#"
id: review-uncommitted
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
            ${{ steps.review.result }}
            
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
"#;

const REVIEW_BRANCH_TEMPLATE: &str = r#"
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
            ${{ steps.review.result }}
            
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
"#;

const REVIEW_COMMIT_TEMPLATE: &str = r#"
id: review-commit
inputs:
  commit_sha:
    type: string
    description: Commit to review
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
            ${{ steps.review.result }}

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
"#;

const DOCS_WORKFLOW_SYNTAX: &str = include_str!("../../skills/docs/workflow-syntax.md");
const DOCS_SCHEMA_REFERENCE: &str = include_str!("../../skills/docs/schema-reference.md");
const DOCS_EXAMPLES: &str = include_str!("../../skills/docs/examples.md");
const SKILL: &str = include_str!("../../skills/skill.md");
