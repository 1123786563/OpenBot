import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/*
 * #731 内嵌承载入口。地址与允许 Origin 由服务器给出——浏览器不拼 URL，
 * 也不从查询参数取宿主；requestId 把宿主与本次装载的消息配到一起。
 */
export type MemoryServiceEntry = {
  src: string;
  allowedOrigin: string;
  requestId: string;
};

export const memoryServiceKeys = {
  entry: () => ["memory-service", "entry"] as const,
};

export function memoryServiceEntryQueryOptions() {
  return queryOptions({
    queryKey: memoryServiceKeys.entry(),
    queryFn: () =>
      client<MemoryServiceEntry>("/api/memory-service/entry", "entry", {
        fallbackKey: "memoryService.load",
      }),
    retry: false,
  });
}
