import i18next from "i18next";
import { Component, type ReactNode } from "react";

/**
 * A component that throws must not take the conversation with it.
 *
 * Browser-authored components render in the transcript from model-supplied arguments, sometimes
 * while a tool call is still streaming. A render failure is isolated to the component card and shown
 * as a user-readable failure line; stacks stay in the developer console.
 */
export class ToolRenderBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Keep stack details out of the conversation while preserving them for component authors.
    console.error(
      "[gallery] a component failed to render",
      this.props.name,
      error,
    );
  }

  render() {
    if (this.state.failed) {
      // A class component cannot take the `useTranslation` hook, so the translator is bound
      // from the shared instance here; an error fallback renders once and needs no reactivity.
      const t = i18next.getFixedT<"channels">(null, "channels");
      return (
        <p className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span className="font-medium">{this.props.name}</span>{" "}
          {t("toolBoundary.failedSuffix")}
        </p>
      );
    }
    return this.props.children;
  }
}
