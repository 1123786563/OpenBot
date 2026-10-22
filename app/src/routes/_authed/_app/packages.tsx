import { createFileRoute } from "@tanstack/react-router";
import { PackagesMarketPage } from "@/components/market/packages-page";

export const Route = createFileRoute("/_authed/_app/packages")({
  component: PackagesMarketPage,
});
