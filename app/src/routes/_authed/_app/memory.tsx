import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/layout/page-shell";
import { MemoryServiceFrame } from "@/components/memory-service/frame";
import { memoryServiceEntryQueryOptions } from "@/lib/memory-service/queries";

/*
 * #731 记忆管理承载页。保留 _app 布局与侧栏，内容区是记忆服务自己的管理界面
 * （同一服务、同一本人）。未配置 MEMORY_SERVICE_URL 时如实说明未启用，不画
 * 一个空 iframe。登录/退出由承载页发消息，OpenBot 在浏览器顶层完成。
 */
export const Route = createFileRoute("/_authed/_app/memory")({
  component: MemoryPage,
});

function MemoryPage() {
  const { t } = useTranslation("nav");
  const entry = useQuery(memoryServiceEntryQueryOptions());

  return (
    <PageShell title={t("memory")} width="wide">
      {entry.data ? (
        <MemoryServiceFrame
          src={entry.data.src}
          allowedOrigin={entry.data.allowedOrigin}
          requestId={entry.data.requestId}
          title={t("memory")}
          authFailedText={t("memoryAuthFailed")}
          signedOutText={t("memorySignedOut")}
        />
      ) : entry.isPending ? null : (
        <p className="text-muted-foreground text-sm">
          {t("memoryUnavailable")}
        </p>
      )}
    </PageShell>
  );
}
