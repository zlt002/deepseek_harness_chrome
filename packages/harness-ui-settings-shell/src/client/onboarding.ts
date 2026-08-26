export interface ProductOnboardingStep { id: string; order: number }

const COMPANY_GATEWAY_STEP = 'accrui-company-gateway'
const OFFICIAL_DEEPSEEK_STEP = 'deepseek-official'
const WELCOME_NOTICE_STEP = 'welcome-notice'

/**
 * The product gateway replaces the stock DeepSeek key prompt and developer
 * preview notice. Keep every other future onboarding step untouched.
 */
export function productOnboardingSteps(steps: readonly ProductOnboardingStep[]): readonly ProductOnboardingStep[] {
  return steps.some(step => step.id === COMPANY_GATEWAY_STEP)
    ? steps.filter(step => step.id !== OFFICIAL_DEEPSEEK_STEP && step.id !== WELCOME_NOTICE_STEP)
    : steps
}
