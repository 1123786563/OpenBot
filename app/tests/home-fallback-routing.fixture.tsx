import { afterAll, spyOn } from "bun:test";
import type { ReactNode } from "react";
import * as Carousel from "@/components/ui/carousel";
import * as SidebarToggle from "@/components/layout/sidebar-toggle";

/*
 * Restorable stand-ins for the sidebar toggle bar and the carousel, installed as NAMESPACE SPIES
 * rather than `mock.module`, because bun cannot take a module mock back off: a registry-level
 * mock would stay installed for every test file walked into the same process afterwards (see
 * composer-queue-attachments.test.tsx). A spy is restorable, and the `afterAll` below genuinely
 * puts the real components back.
 */
const sidebarToggleBarSpy = spyOn(
  SidebarToggle,
  "SidebarToggleBar",
).mockImplementation(() => <div data-testid="sidebar-toggle-bar" />);

const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const carouselSpies = [
  spyOn(Carousel, "Carousel").mockImplementation(pass as never),
  spyOn(Carousel, "CarouselContent").mockImplementation(pass as never),
  spyOn(Carousel, "CarouselItem").mockImplementation(pass as never),
  spyOn(Carousel, "CarouselNext").mockImplementation((() => (
    <button type="button">Next agents</button>
  )) as never),
  spyOn(Carousel, "CarouselPrevious").mockImplementation((() => (
    <button type="button">Previous agents</button>
  )) as never),
];

afterAll(() => {
  sidebarToggleBarSpy.mockRestore();
  for (const spy of carouselSpies) spy.mockRestore();
});
