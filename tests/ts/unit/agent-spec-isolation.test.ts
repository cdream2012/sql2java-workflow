/**
 * agent-spec-isolation.test.ts — 规约单一来源回归门禁
 *
 * 设计意图：Java 代码规约的单一来源是 docs/java-code-spec.md（或 --spec 指定的用户文件），
 * 由引擎 JAVA_SPEC_AGENTS 白名单 + system.transform hook 注入子 agent 系统提示。
 * 子 agent 的 .md 提示词不得内联具体规约条款——否则内联版本比注入的 spec 更具指令性，
 * LLM 优先遵循内联，导致 --spec 自定义失效（详见 plan: logical-rolling-quiche.md）。
 *
 * 本测试扫描 .opencode/agent/*.md，断言不含 Java 侧规约 token。
 * 注意：token 列表只收"无歧义的 Java 侧规约内容"——PL/SQL 构造名（RAISE_APPLICATION_ERROR、
 * PRAGMA AUTONOMOUS_TRANSACTION）和框架注解（@Autowired 用于 Spring 测试注入、@Mock 等）
 * 有合法用途，不纳入，避免假阳性。
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"

const AGENT_DIR = resolve(import.meta.dirname, "../../../.opencode/agent")
const ENGINE_PATH = resolve(import.meta.dirname, "../../../.opencode/plugins/workflow-engine.ts")

/** 无歧义的 Java 侧规约 token——出现即说明规约被内联进 agent 提示词。 */
const FORBIDDEN_TOKENS = [
  "TranFailException", // 统一业务异常类名（spec §3.4/§十四）
  "serialVersionUID", // 序列化约定（spec §2.1/§4.1）
  "implements Serializable", // 聚合根序列化约定（spec §2.1）
  "mergeSpecSections", // 已删的合并函数——不应在引擎残留
]

describe("规约单一来源：agent 提示词不得内联具体规约内容", () => {
  const agentFiles = existsSync(AGENT_DIR)
    ? readdirSync(AGENT_DIR).filter((f) => f.endsWith(".md"))
    : []

  it("agent 目录存在且非空", () => {
    expect(agentFiles.length, "应至少有一个 agent .md 文件").toBeGreaterThan(0)
  })

  for (const file of agentFiles) {
    it(`${file} 不含 Java 侧规约 token`, () => {
      const content = readFileSync(join(AGENT_DIR, file), "utf8")
      const hits = FORBIDDEN_TOKENS.filter((t) => content.includes(t))
      expect(hits, `发现内联规约 token: ${hits.join(", ")}。应改为引用注入的 Java 代码规约。`).toEqual([])
    })
  }

  it("workflow-engine.ts 不再含 mergeSpecSections（--spec 已改整体替换）", () => {
    const engine = readFileSync(ENGINE_PATH, "utf8")
    expect(engine.includes("mergeSpecSections"), "mergeSpecSections 应已删除").toBe(false)
  })
})
