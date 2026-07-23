/**
 * 阶段拒绝引导语 — 每个 advance 被拒绝时追加，引导 LLM 重做阶段工作而非仅修补 JSON。
 *
 * 设计意图：Zod 只检查结构合规性，LLM 可能凑字段过关。
 * 追加的引导语指明"此错误通常意味着执行不完整"，引导 LLM 回到正确的执行路径。
 *
 * P2c: 新增结构 vs 内容区分：
 *   - STRUCTURAL_FIX_GUIDANCE: 格式问题，只需修正 JSON 字段
 *   - PHASE_REJECTION_GUIDANCE: 内容问题，需重新执行阶段工作
 */

/** 结构格式问题的引导语 */
export const STRUCTURAL_FIX_GUIDANCE =
  "⚠️ 这是结构格式问题。你不需要重新执行阶段工作，只需修正上方列出的具体 JSON 字段即可。确保 JSON 结构完全符合 Schema 校验要求。"

/** 阶段 → 针对性引导语 */
export const PHASE_REJECTION_GUIDANCE: Record<string, string> = {
  "inventory":
    "⚠️ 此错误通常意味着 inventory 扫描不完整。请重新审视扫描过程，确保所有包的 procedures/types/variables 均被捕获，而非仅修补 JSON 字段。",
  "scaffold":
    "⚠️ 此错误通常意味着脚手架生成不完整。请重新审视项目结构生成过程，确保目录、POM、实体、Mapper、packageMappings 均正确生成，而非仅修补 JSON 字段。",
  "translate":
    "⚠️ 此错误通常意味着翻译不完整。请重新审视翻译过程，确保每个子程序都被正确翻译、subprogramMethods 完整覆盖，而非仅修补 JSON 字段。",
  "review":
    "⚠️ 此错误通常意味着审查不完整。请重新审视审查过程，确保每个包的每个 procedure 都有对应的检查项，passed/mustFix 一致，而非仅修补 JSON 字段。",
  "verify":
    "⚠️ 此错误通常意味着验证不完整。请重新审视验证过程，确保编译结果、MyBatis 校验、测试执行等均真实执行，而非仅修补 JSON 字段。",
  "dedup":
    "⚠️ 此错误通常意味着去重不完整。请重新审视去重过程，确保所有包的重复代码都被扫描，公共模块正确抽取，而非仅修补 JSON 字段。",
  "fix":
    "⚠️ 此错误通常意味着修复不完整。请重新审视修复过程，确保所有 mustFix 项都被实际修改，而非仅修补 JSON 字段。",
}

/** 为 rejection 消息追加阶段针对性引导语 */
export function enhanceRejection(
  phase: string | null,
  rawError: string,
  isStructural: boolean = false,
): string {
  if (!phase) return rawError
  const guidance = isStructural
    ? STRUCTURAL_FIX_GUIDANCE
    : PHASE_REJECTION_GUIDANCE[phase]
  if (!guidance) return rawError
  return `${rawError}\n\n${guidance}`
}
