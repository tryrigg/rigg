import { renderString } from "../../workflow/expr"
import type { RenderContext } from "../render"
import { stepFailed } from "../error"

export function applyTemplate(template: string, context: RenderContext): string {
  try {
    return renderString(template, context)
  } catch (error) {
    throw stepFailed(error)
  }
}
