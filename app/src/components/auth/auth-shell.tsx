import { useEffect } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { appConfig } from "@/lib/generated/application-config";

/**
 * The centered credential-page shell: the brand lockup every edge-of-auth page shares, above
 * whatever the current state says. Pages render their own headings and states; this only fixes
 * the frame and the browser-tab title, which used to stay the deployment-generic "OpenBot" on
 * every one of these routes.
 */
function AuthShell({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  useEffect(() => {
    document.title = `${title} · ${appConfig.brand.productName}`;
  }, [title]);

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-5 text-center">
        <div
          aria-hidden="true"
          className="flex items-center justify-center gap-2"
        >
          <AgentOrb size="28px" />
          <span className="text-sm font-medium text-muted-foreground">
            {appConfig.brand.productName}
          </span>
        </div>
        {children}
      </div>
    </main>
  );
}

export default AuthShell;
