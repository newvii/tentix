import { type CompiledStateGraph } from "@langchain/langgraph";
import { eq, asc } from "drizzle-orm";
import * as schema from "@/db/schema.ts";
import { connectDB } from "../tools";
import { type WorkflowState, AgentMessage } from "./workflow-node/workflow-tools.ts";
import { logError, logInfo } from "@/utils/log.ts";
import { WorkflowBuilder } from "./workflow-builder.ts";
import { convertToMultimodalMessage, sleep } from "./tools";
import { basicUserCols } from "../../api/queryParams.ts";
import { type JSONContentZod } from "../types";
import { type JSONContent } from "@tiptap/core";
import { type WorkflowConfig, NodeType } from "@/utils/const.ts";
import { emotionDetectionNode, escalationOfferNode, ragNode, chatNode, handoffNode } from "./workflow-node/index.ts";

/**
 * 工作流缓存管理类
 *
 * 根据 aiRoleConfig 表管理不同 scope 的工作流缓存
 * 缓存结构（两层索引）:
 * - 第一层：workflowId -> compiledWorkflow (避免重复编译)
 * - 第二层：scope -> { aiUserId, workflowId } (快速查找)
 *
 * @example
 * ```typescript
 * // 初始化缓存
 * await workflowCache.initialize();
 *
 * // 根据 scope 获取工作流
 * const workflow = workflowCache.getWorkflow("default_all");
 * if (workflow) {
 *   const result = await workflow.invoke(initialState);
 * }
 *
 * // 根据 workflowId 获取工作流
 * const workflowById = workflowCache.getWorkflowById("wf-123");
 *
 * // 当配置变化时更新缓存
 * await workflowCache.refresh();
 * ```
 */
export class WorkflowCache {
  // 第一层缓存：workflowId -> 编译后的工作流
  // 一个 workflow 只编译一次，避免重复编译和内存浪费
  private workflowCache: Map<
    string,
    CompiledStateGraph<WorkflowState, Partial<WorkflowState>>
  > = new Map();

  // 第二层缓存：scope -> { aiUserId, workflowId }
  // 用于快速根据 scope 查找对应的 AI 用户和工作流
  private scopeCache: Map<
    string,
    {
      aiUserId: number;
      workflowId: string;
    }
  > = new Map();

  // 第三层缓存：workflowId -> 原始工作流配置（含 node config）
  // 用于并行执行时直接获取各节点的 config
  private workflowConfigCache: Map<string, WorkflowConfig> = new Map();

  /**
   * 初始化缓存
   *
   * 从 aiRoleConfig 表加载所有激活的 AI 角色配置并构建工作流缓存
   *
   * 流程：
   * 1. 查询所有 isActive=true 的 aiRoleConfig 记录
   * 2. 对每个唯一的 workflow，只构建编译一次并存入第一层缓存
   * 3. 将 scope 与 { aiUserId, workflowId } 的映射存入第二层缓存
   *
   * @throws {Error} 如果工作流构建失败会记录错误日志，但不会中断整个初始化过程
   * @returns {Promise<void>}
   *
   * @example
   * ```typescript
   * const cache = new WorkflowCache();
   * await cache.initialize();
   * console.log(`Cached ${cache.workflowSize()} unique workflows for ${cache.scopeSize()} scopes`);
   * ```
   */
  async initialize(): Promise<void> {
    logInfo("[WorkflowCache] Initializing workflow cache...");

    const db = connectDB();

    // 第一步：查询所有工作流用于第一层缓存
    const allWorkflows = await db.query.workflow.findMany();
    logInfo(`[WorkflowCache] Found ${allWorkflows.length} total workflows`);

    // 第二步：查询激活的 AI 角色配置用于第二层缓存
    const activeConfigs = await db.query.aiRoleConfig.findMany({
      where: eq(schema.aiRoleConfig.isActive, true),
      with: {
        workflow: true,
      },
    });
    logInfo(
      `[WorkflowCache] Found ${activeConfigs.length} active AI role configs`,
    );

    // 清空三层缓存
    this.workflowCache.clear();
    this.scopeCache.clear();
    this.workflowConfigCache.clear();

    // 第一层缓存：编译所有工作流（不仅仅是激活的）
    for (const workflow of allWorkflows) {
      try {
        // 保存原始配置到第三层缓存
        this.workflowConfigCache.set(workflow.id, workflow);
        if (!workflow.nodes || !workflow.edges) {
          logInfo(
            `[WorkflowCache] Skipping workflow ${workflow.id} (${workflow.name}) - invalid nodes or edges`,
          );
          continue;
        }

        const builder = new WorkflowBuilder(workflow);
        const compiledWorkflow = builder.build();
        this.workflowCache.set(workflow.id, compiledWorkflow);

        logInfo(
          `[WorkflowCache] Compiled workflow: ${workflow.id} (${workflow.name})`,
        );
      } catch (error) {
        logError(
          `[WorkflowCache] Failed to build workflow ${workflow.id}`,
          error,
        );
      }
    }

    // 第二层缓存：只为激活的配置建立 scope -> { aiUserId, workflowId } 映射
    for (const config of activeConfigs) {
      try {
        if (
          !config.workflow ||
          !config.workflowId ||
          !config.workflow?.nodes ||
          !config.workflow?.edges
        ) {
          logInfo(
            `[WorkflowCache] Skipping config ${config.id} (scope: ${config.scope}) - no workflow bound or workflow is invalid`,
          );
          continue;
        }

        this.scopeCache.set(config.scope, {
          aiUserId: config.aiUserId,
          workflowId: config.workflowId,
        });

        logInfo(
          `[WorkflowCache] Mapped scope: ${config.scope} -> workflowId: ${config.workflowId}, aiUserId: ${config.aiUserId}`,
        );
      } catch (error) {
        logError(
          `[WorkflowCache] Failed to map scope for config ${config.id}`,
          error,
        );
      }
    }

    logInfo(
      `[WorkflowCache] Initialization complete. Compiled ${this.workflowCache.size} unique workflows for ${this.scopeCache.size} active scopes`,
    );
  }

  /**
   * 更新缓存
   *
   * 重新从数据库加载配置并重建缓存
   * 适用场景：
   * - aiRoleConfig 表发生变化（新增、删除、修改配置）
   * - workflow 表发生变化（工作流定义被修改）
   * - isActive 状态被切换
   *
   * @returns {Promise<void>}
   *
   * @example
   * ```typescript
   * // 当管理员更新了 AI 角色配置后
   * await workflowCache.refresh();
   * ```
   */
  async refresh(): Promise<void> {
    logInfo("[WorkflowCache] Refreshing workflow cache...");
    await this.initialize();
  }

  /**
   * 根据 scope 获取编译后的工作流
   *
   * @param {string} scope - AI 角色回答范围（例如: "default_all", "tech_support", "sales"）
   * @returns {CompiledStateGraph<WorkflowState, Partial<WorkflowState>> | null}
   *          编译后的工作流，如果不存在则返回 null
   *
   * @example
   * ```typescript
   * const workflow = workflowCache.getWorkflow("default_all");
   * if (workflow) {
   *   const result = await workflow.invoke(initialState);
   *   console.log(result.response);
   * } else {
   *   console.error("Workflow not found");
   * }
   * ```
   */
  getWorkflow(
    scope: string,
  ): CompiledStateGraph<WorkflowState, Partial<WorkflowState>> | null {
    // 先从第二层缓存获取 workflowId
    const scopeInfo = this.scopeCache.get(scope);
    if (!scopeInfo) {
      logInfo(
        `[WorkflowCache] No workflow found for scope: ${scope}. Available scopes: ${Array.from(this.scopeCache.keys()).join(", ")}`,
      );
      return null;
    }

    // 再从第一层缓存获取编译后的工作流
    const workflow = this.workflowCache.get(scopeInfo.workflowId);
    if (!workflow) {
      logError(
        `[WorkflowCache] CRITICAL: Workflow ${scopeInfo.workflowId} not found in workflowCache for scope: ${scope}`,
      );
      return null;
    }

    return workflow;
  }

  /**
   * 根据 workflow ID 获取编译后的工作流
   *
   * @param {string} workflowId - 工作流 ID
   * @returns {CompiledStateGraph<WorkflowState, Partial<WorkflowState>> | null}
   *          编译后的工作流，如果不存在则返回 null
   *
   * @example
   * ```typescript
   * const workflow = workflowCache.getWorkflowById("wf-123");
   * if (workflow) {
   *   const result = await workflow.invoke(initialState);
   *   console.log(result.response);
   * } else {
   *   console.error("Workflow not found");
   * }
   * ```
   */
  getWorkflowById(
    workflowId: string | undefined,
  ): CompiledStateGraph<WorkflowState, Partial<WorkflowState>> | null {
    if (!workflowId) {
      logInfo(`[WorkflowCache] No workflowId provided`);
      return null;
    }
    const workflow = this.workflowCache.get(workflowId);
    if (!workflow) {
      logInfo(
        `[WorkflowCache] No workflow found for workflowId: ${workflowId}. Available workflowIds: ${Array.from(this.workflowCache.keys()).join(", ")}`,
      );
      return null;
    }
    return workflow;
  }

  getFallbackWorkflow(): CompiledStateGraph<
    WorkflowState,
    Partial<WorkflowState>
  > | null {
    const fallback = this.getWorkflow("default_all");
    if (!fallback) {
      logError(
        `[WorkflowCache] CRITICAL: Fallback workflow (default_all) not found. ` +
          `Available scopes: ${this.getScopes().join(", ") || "none"}`,
      );
    }
    return fallback;
  }

  /**
   * 获取 default_all scope 对应的 AI 用户 ID
   *
   * @returns {number | null} AI 用户 ID，如果不存在则返回 null
   *
   * @example
   * ```typescript
   * const aiUserId = workflowCache.getFallbackAiUserId();
   * if (aiUserId) {
   *   console.log(`Fallback AI User ID: ${aiUserId}`);
   * } else {
   *   console.error("Fallback AI user ID not found");
   * }
   * ```
   */
  getFallbackAiUserId(): number | null {
    const aiUserId = this.getAiUserId("default_all");
    if (!aiUserId) {
      logError(
        `[WorkflowCache] CRITICAL: Fallback AI user ID (default_all) not found. ` +
          `Available scopes: ${this.getScopes().join(", ") || "none"}`,
      );
    }
    return aiUserId;
  }

  /**
   * 根据 scope 获取对应的 AI 用户 ID
   *
   * @param {string} scope - AI 角色回答范围
   * @returns {number | null} AI 用户 ID，如果不存在则返回 null
   *
   * @example
   * ```typescript
   * const aiUserId = workflowCache.getAiUserId("default_all");
   * if (aiUserId) {
   *   console.log(`AI User ID: ${aiUserId}`);
   * }
   * ```
   */
  getAiUserId(scope: string): number | null {
    const scopeInfo = this.scopeCache.get(scope);
    return scopeInfo?.aiUserId ?? null;
  }

  /**
   * 根据 scope 获取对应的 workflow ID
   *
   * @param {string} scope - AI 角色回答范围
   * @returns {string | null} workflow ID，如果不存在则返回 null
   *
   * @example
   * ```typescript
   * const workflowId = workflowCache.getWorkflowId("default_all");
   * if (workflowId) {
   *   console.log(`Workflow ID: ${workflowId}`);
   * }
   * ```
   */
  getWorkflowId(scope: string): string | null {
    const scopeInfo = this.scopeCache.get(scope);
    return scopeInfo?.workflowId ?? null;
  }

  /**
   * 根据工作流 ID 获取原始配置
   */
  getWorkflowConfig(workflowId: string): WorkflowConfig | null {
    return this.workflowConfigCache.get(workflowId) ?? null;
  }

  /**
   * 根据 scope 获取工作流配置
   */
  getWorkflowConfigByScope(scope: string): WorkflowConfig | null {
    const scopeInfo = this.scopeCache.get(scope);
    if (!scopeInfo) return null;
    return this.workflowConfigCache.get(scopeInfo.workflowId) ?? null;
  }

  /**
   * 获取所有已缓存的 scope
   *
   * @returns {string[]} scope 列表
   *
   * @example
   * ```typescript
   * const scopes = workflowCache.getScopes();
   * console.log(`Available scopes: ${scopes.join(", ")}`);
   * // 输出: Available scopes: default_all, tech_support, sales
   * ```
   */
  getScopes(): string[] {
    return Array.from(this.scopeCache.keys());
  }

  /**
   * 获取所有已缓存的 workflow ID
   *
   * @returns {string[]} workflow ID 列表
   *
   * @example
   * ```typescript
   * const workflowIds = workflowCache.getWorkflowIds();
   * console.log(`Available workflowIds: ${workflowIds.join(", ")}`);
   * ```
   */
  getWorkflowIds(): string[] {
    return Array.from(this.workflowCache.keys());
  }

  /**
   * 根据 workflowId 获取所有使用该 workflow 的 scope
   *
   * @param {string} workflowId - 工作流 ID
   * @returns {string[]} 使用该 workflow 的 scope 列表
   *
   * @example
   * ```typescript
   * const scopes = workflowCache.getScopesByWorkflowId("wf-123");
   * console.log(`Scopes using workflow wf-123: ${scopes.join(", ")}`);
   * ```
   */
  getScopesByWorkflowId(workflowId: string): string[] {
    const scopes: string[] = [];
    for (const [scope, info] of this.scopeCache.entries()) {
      if (info.workflowId === workflowId) {
        scopes.push(scope);
      }
    }
    return scopes;
  }

  /**
   * 检查指定 scope 是否有缓存
   *
   * @param {string} scope - AI 角色回答范围
   * @returns {boolean} 是否存在缓存
   *
   * @example
   * ```typescript
   * if (workflowCache.has("default_all")) {
   *   const workflow = workflowCache.getWorkflow("default_all");
   * } else {
   *   await workflowCache.initialize();
   * }
   * ```
   */
  has(scope: string): boolean {
    return this.scopeCache.has(scope);
  }

  /**
   * 检查指定 workflow ID 是否有缓存
   *
   * @param {string} workflowId - 工作流 ID
   * @returns {boolean} 是否存在缓存
   *
   * @example
   * ```typescript
   * if (workflowCache.hasWorkflow("wf-123")) {
   *   const workflow = workflowCache.getWorkflowById("wf-123");
   * }
   * ```
   */
  hasWorkflow(workflowId: string): boolean {
    return this.workflowCache.has(workflowId);
  }

  /**
   * 获取 scope 缓存的大小
   *
   * @returns {number} 缓存中的 scope 数量
   *
   * @example
   * ```typescript
   * console.log(`Cached scopes: ${workflowCache.scopeSize()}`);
   * ```
   */
  scopeSize(): number {
    return this.scopeCache.size;
  }

  /**
   * 获取 workflow 缓存的大小
   *
   * @returns {number} 缓存中的唯一 workflow 数量
   *
   * @example
   * ```typescript
   * console.log(`Cached unique workflows: ${workflowCache.workflowSize()}`);
   * ```
   */
  workflowSize(): number {
    return this.workflowCache.size;
  }

  /**
   * 获取缓存的大小（兼容旧 API）
   *
   * @returns {number} 缓存中的 scope 数量
   * @deprecated 使用 scopeSize() 或 workflowSize() 代替
   *
   * @example
   * ```typescript
   * console.log(`Cached scopes: ${workflowCache.size()}`);
   * ```
   */
  size(): number {
    return this.scopeCache.size;
  }

  /**
   * 清空所有缓存
   *
   * 用于测试或需要完全重置缓存的场景
   * 注意：清空后需要调用 initialize() 重新加载
   *
   * @returns {void}
   *
   * @example
   * ```typescript
   * workflowCache.clear();
   * await workflowCache.initialize();
   * ```
   */
  clear(): void {
    logInfo("[WorkflowCache] Clearing all cached workflows");
    this.workflowCache.clear();
    this.scopeCache.clear();
    this.workflowConfigCache.clear();
  }
}

/**
 * 全局工作流缓存单例实例
 *
 * 在应用启动时需要调用 initialize() 进行初始化
 *
 * @example
 * ```typescript
 * // 在应用启动时
 * await workflowCache.initialize();
 *
 * // 在业务代码中使用
 * const workflow = workflowCache.getWorkflow("default_all");
 * ```
 */
export const workflowCache = new WorkflowCache();

// 定义消息查询结果的类型（基于 schema 和查询配置）
type MessageWithSender = Pick<
  | typeof schema.workflowTestMessage.$inferSelect
  | typeof schema.chatMessages.$inferSelect,
  "id" | "senderId" | "content" | "createdAt"
> & {
  sender: Pick<
    typeof schema.users.$inferSelect,
    "id" | "name" | "nickname" | "avatar" | "role"
  > | null;
};

/**
 * 从工作流配置中按节点类型提取 config
 */
function findNodeConfig<T extends { type: NodeType; config: any }>(
  workflowConfig: WorkflowConfig,
  nodeType: NodeType,
): T | undefined {
  return workflowConfig.nodes.find((n) => n.type === nodeType) as
    | T
    | undefined;
}

/**
 * 合并多个节点的状态更新到初始状态
 */
function mergeStateUpdates(
  initial: WorkflowState,
  ...updates: Partial<WorkflowState>[]
): WorkflowState {
  let merged = { ...initial };
  for (const update of updates) {
    merged = { ...merged, ...update };
  }
  return merged;
}

/**
 * 并行执行模式：跳过 LangGraph 串行调度，手动并行运行预处理节点
 *
 * 流程：
 * 1. 并行执行 emotion_detection + escalation_offer + rag_node
 * 2. 如果需要转人工 → 执行 handoff_node
 * 3. 如果 escalation 提议升级且有 response → 直接返回
 * 4. 执行 chat_node 生成最终回复
 */
async function executeParallelWorkflow(
  initialState: WorkflowState,
  workflowConfig: WorkflowConfig,
): Promise<string> {
  const emotionConfig = findNodeConfig(workflowConfig, NodeType.EMOTION_DETECTOR);
  const escalationConfig = findNodeConfig(workflowConfig, NodeType.ESCALATION_OFFER);
  const ragConfig = findNodeConfig(workflowConfig, NodeType.RAG);
  const chatConfig = findNodeConfig(workflowConfig, NodeType.SMART_CHAT);
  const handoffConfig = findNodeConfig(workflowConfig, NodeType.HANDOFF);

  // 并行执行预处理节点（互不依赖）
  const [emotionResult, escalationResult, ragResult] = await Promise.all([
    emotionConfig
      ? emotionDetectionNode(initialState, emotionConfig.config)
      : Promise.resolve<Partial<WorkflowState>>({}),
    escalationConfig
      ? escalationOfferNode(initialState, escalationConfig.config)
      : Promise.resolve<Partial<WorkflowState>>({}),
    ragConfig
      ? ragNode(initialState, ragConfig.config)
      : Promise.resolve<Partial<WorkflowState>>({}),
  ]);

  // 合并状态
  const state = mergeStateUpdates(
    initialState,
    emotionResult,
    escalationResult,
    ragResult,
  );

  // 转人工
  if (state.handoffRequired && handoffConfig) {
    const handoffResult = await handoffNode(state, handoffConfig.config);
    return handoffResult.response || "";
  }

  // 升级提议（escalation 节点直接生成了 response）
  if (state.proposeEscalation && escalationResult?.response) {
    return escalationResult.response;
  }

  // 生成最终回复
  if (chatConfig) {
    const chatResult = await chatNode(state, chatConfig.config);
    return chatResult.response || "";
  }

  return "";
}

export async function getAIResponse(
  ticket: Pick<
    typeof schema.tickets.$inferSelect,
    "id" | "title" | "description" | "module" | "category"
  >,
  isWorkflowTest: boolean = false,
  workflowId?: string,
): Promise<string> {
  const db = connectDB();

  // 查询该工单的对话（带 sender 用户信息），按时间升序
  let msgs: MessageWithSender[];
  if (isWorkflowTest) {
    msgs = await db.query.workflowTestMessage.findMany({
      where: (m, { eq }) => eq(m.testTicketId, ticket.id),
      orderBy: [asc(schema.workflowTestMessage.createdAt)],
      columns: {
        id: true,
        senderId: true,
        content: true,
        createdAt: true,
      },
      with: {
        sender: basicUserCols,
      },
    });
  } else {
    msgs = await db.query.chatMessages.findMany({
      where: (m, { and, eq }) =>
        and(eq(m.ticketId, ticket.id), eq(m.isInternal, false)),
      orderBy: [asc(schema.chatMessages.createdAt)],
      columns: {
        id: true,
        senderId: true,
        content: true,
        createdAt: true,
      },
      with: {
        sender: basicUserCols,
      },
    });
  }

  const history: AgentMessage[] = [];
  for (const m of msgs) {
    if (!m) continue;
    let role = m.sender?.role ?? "user";
    // 当 isWorkflowTest 为 true 时，所有非 ai 的 role 都改成 customer
    if (isWorkflowTest && role !== "ai") {
      role = "customer";
    }
    const multimodalContent = convertToMultimodalMessage(
      m.content as JSONContentZod,
    );
    history.push({ role, content: multimodalContent, createdAt: m.createdAt });
  }
  history.sort((a: AgentMessage, b: AgentMessage) => {
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return at - bt;
  });

  // 准备初始状态
  const initialState: WorkflowState = {
    messages: history,
    currentTicket: ticket
      ? {
          id: ticket.id,
          title: ticket.title,
          description: ticket.description as JSONContentZod | undefined,
          module: ticket.module ?? undefined,
          category: ticket.category ?? undefined,
        }
      : undefined,
    userQuery: "",
    sentimentLabel: "NEUTRAL",
    handoffRequired: false,
    handoffReason: "",
    handoffPriority: "P2",
    searchQueries: [],
    retrievedContext: [],
    response: "",
    proposeEscalation: false,
    escalationReason: "",
    variables: {},
  };

  // 工作流测试：使用 LangGraph 串行执行
  if (isWorkflowTest) {
    const workflow = workflowCache.getWorkflowById(workflowId);
    if (!workflow) {
      throw new Error(`No workflow found for workflowId: ${workflowId}`);
    }
    try {
      const result = (await workflow.invoke(initialState)) as WorkflowState;
      return result.response ?? "";
    } catch (e) {
      logError(String(e));
      return "";
    }
  }

  // 生产环境：获取工作流配置，并行执行
  const workflowConfig =
    workflowCache.getWorkflowConfigByScope(ticket.module) ??
    workflowCache.getWorkflowConfigByScope("default_all");

  if (!workflowConfig) {
    const availableScopes = workflowCache.getScopes();
    throw new Error(
      `No workflow available for scope: ${ticket.module}. ` +
        `Available scopes: ${availableScopes.join(", ") || "none"}`,
    );
  }

  // 重试逻辑（无 sleep）
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await executeParallelWorkflow(
        initialState,
        workflowConfig,
      );
      if (response !== "") {
        return response;
      }
    } catch (e) {
      logError(String(e));
    }
  }

  return "";
}

// 流式响应支持
export async function* streamAIResponse(
  ticket: Pick<
    typeof schema.tickets.$inferSelect,
    "id" | "title" | "description" | "module" | "category"
  >,
  isWorkflowTest: boolean = false,
  workflowId?: string,
) {
  // 流式模式下，直接调用 getAIResponse（并行执行已内置）
  // 流式 yield 将在 chat_node 逐步返回时产生
  const result = await getAIResponse(ticket, isWorkflowTest, workflowId);
  if (result) {
    yield result;
  }
}

/**
 * 将 AI 回复的字符串转换成 TipTap JSONContent 格式
 *
 * 该函数将整个字符串作为一个段落，不做任何分割处理
 *
 * @param {string} aiResponse - AI 回复的字符串内容
 * @returns {JSONContent} TipTap JSONContent 对象
 *
 * @example
 * ```typescript
 * const response = "这是 AI 的完整回复内容。\n可能包含多行。";
 * const json = convertAIResponseToTipTapJSON(response);
 * // 返回: {
 * //   type: "doc",
 * //   content: [
 * //     { type: "paragraph", content: [{ type: "text", text: "这是 AI 的完整回复内容。\n可能包含多行。" }] }
 * //   ]
 * // }
 * ```
 */
export function convertAIResponseToTipTapJSON(aiResponse: string): JSONContent {
  // 如果是空字符串，返回空文档
  if (!aiResponse || aiResponse.trim() === "") {
    return {
      type: "doc",
      content: [],
    };
  }

  // 将整个字符串作为一个段落
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: aiResponse,
          },
        ],
      },
    ],
  };
}
