/** 判定模式与 agent 预算(spec §4.6)。Task 6 落 app_settings;缺配置一律用默认。 */
export interface JudgeConfig {
  mode: 'quality' | 'economy'
  /** 每批候选工具轮次上限。 */
  maxRounds: number
  /** 每批候选时间预算(秒)。 */
  timeBudgetS: number
}
export const DEFAULT_JUDGE_CONFIG: JudgeConfig = { mode: 'quality', maxRounds: 30, timeBudgetS: 300 }
