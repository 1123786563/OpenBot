import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema/coworker";
import type { IssuedScope, SourceAccess } from "./source-check";

/*
 * #733 OpenBot 自己的来源 Access（SourceAccess 的真实现）：签发时绑定的
 * 本人/Bot 关系到裁决时还成立吗。Bot 被删除（软删）或不再归属该本人 =
 * 失权（denied）；库不可读 = 无法核验（unavailable）。revision 取该 Bot
 * 档案的 updatedAt：任何触碰档案的变动都会换 revision，MEMORY 侧可据此
 * 发现缓存过期的来源资格。
 *
 * 版本级归属（ownsVersion）恒真：版本表在 MEMORY 的权威行集里，OpenBot 的
 * 篱笥是"来源范围"级——scopeRef 是它签的；某个版本是否真的源于该范围由
 * MEMORY 自己的行集与交付前重读裁决，OpenBot 无法枚举他方版本号。
 */
export function createOpenBotSourceAccess(deps: {
  database: Database;
}): SourceAccess {
  return {
    async resolve(scope: IssuedScope) {
      try {
        const [profile] = await deps.database
          .select({
            ownerUserId: agentProfiles.ownerUserId,
            deletedAt: agentProfiles.deletedAt,
            updatedAt: agentProfiles.updatedAt,
          })
          .from(agentProfiles)
          .where(eq(agentProfiles.agentId, scope.botId));
        if (!profile || profile.deletedAt !== null) {
          return { state: "denied" as const };
        }
        if (profile.ownerUserId !== scope.subjectId) {
          return { state: "denied" as const };
        }
        return {
          state: "allowed" as const,
          revision: profile.updatedAt.toISOString(),
        };
      } catch {
        return { state: "unavailable" as const };
      }
    },
    async ownsVersion(_scope: IssuedScope, _versionId: string) {
      return true;
    },
  };
}
