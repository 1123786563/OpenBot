import { createFileRoute } from "@tanstack/react-router";
import { PackagesMarketPage } from "@/components/market/packages-page";

export const Route = createFileRoute("/_authed/packages")({
  component: PackagesMarketPage,
});
