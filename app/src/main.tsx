import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./query-client";
import { router } from "./router";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";

function renderApp() {
  const rootElement = document.getElementById("root");

  if (!rootElement) {
    throw new Error("OpenBot could not find the application root element.");
  }

  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} context={{ queryClient }} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

if (import.meta.env.VITE_OPENBOT_ASTRYX_PILOT === "1") {
  void import("./components/astryx-pilot/styles").then(renderApp);
} else {
  renderApp();
}
