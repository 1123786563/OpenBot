/*
 * #733 MEMORY 登记事实的 OpenBot 视图（MemoryConsumerRegistry 的真实现）：
 * 来源裁决（source-check）问 MEMORY ——接收应用是否登记且 active、本人是否
 * 对它授权了该动作。MEMORY 是登记与委托的权威；这里只实时转述，不缓存、
 * 不自判。故障按"无法核验"处理：来源应用不放大也不降级 MEMORY 的回答。
 */
export function createMemoryConsumersRegistry(options: {
  baseUrl: string;
  appId: string;
  appSecret: string;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const verify = async (body: {
    subjectId: string;
    consumerAppId: string;
    action: "collect" | "recall" | "review";
  }): Promise<{ active: boolean; delegated: boolean }> => {
    const response = await fetch(`${options.baseUrl}/v1/consumers/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-memory-app": options.appId,
        authorization: `Bearer ${options.appSecret}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`consumers/verify ${response.status}`);
    return (await response.json()) as { active: boolean; delegated: boolean };
  };
  return {
    async isActive(consumerAppId: string): Promise<boolean> {
      // 登记事实与动作无关；这里带 recall 仅为满足端点形状。
      return (await verify({ subjectId: "", consumerAppId, action: "recall" }))
        .active;
    },
    async delegated(input: {
      subjectId: string;
      consumerAppId: string;
      action: "collect" | "recall" | "review";
    }): Promise<boolean> {
      return (await verify(input)).delegated;
    },
  };
}

export type MemoryConsumersRegistry = ReturnType<
  typeof createMemoryConsumersRegistry
>;
