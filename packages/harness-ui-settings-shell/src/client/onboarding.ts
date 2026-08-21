export interface ProductOnboardingStep { id: string; order: number }

const COMPANY_GATEWAY_STEP = 'accrui-company-gateway'
const OFFICIAL_DEEPSEEK_STEP = 'deepseek-official'

/**
 * The product gateway replaces, rather than follows, the stock DeepSeek key
 * prompt. Keep the welcome notice and every other future step untouched.
 */
export function productOnboardingSteps(steps: readonly ProductOnboardingStep[]): readonly ProductOnboardingStep[] {
  return steps.some(step => step.id === COMPANY_GATEWAY_STEP)
    ? steps.filter(step => step.id !== OFFICIAL_DEEPSEEK_STEP)
    : steps
}
