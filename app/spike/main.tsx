import "../src/lib/i18n";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { ButtonLink } from "@/components/ui/router-link";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import "../src/styles.css";
import "./spike.css";

declare global {
  interface Window {
    __spike: {
      event: (name: string, detail?: unknown) => void;
      events: { name: string; detail?: unknown }[];
      openedAt: { x: number; y: number; via: string } | null;
      closedVia: string | null;
      lastFocusBeforeMenu: string | null;
      focusAfterClose: string | null;
      selectValue: number | null;
      dialogPicked: string[] | null;
      dialogCloseVia: string | null;
    };
  }
}

window.__spike = {
  event: (name, detail) => window.__spike.events.push({ name, detail }),
  events: [],
  openedAt: null,
  closedVia: null,
  lastFocusBeforeMenu: null,
  focusAfterClose: null,
  selectValue: 202,
  dialogPicked: null,
  dialogCloseVia: null,
};

function log(name: string, detail?: unknown) {
  window.__spike.event(name, detail);
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border m-4 rounded-lg border p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/* The migrated controls under the production stylesheet (spike.css imports only
 * ../src/styles.css). The Base UI "legacy" half of this page — the old-side-by-side token
 * comparison that H01 evidenced — was removed together with the `@base-ui/react` dependency
 * in H14; the archived comparison lives in h01's browser evidence. */
function Tokens() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button id="migrated-primary">Migrated primary</Button>
      </div>
      <div className="flex items-center gap-3">
        <Input id="migrated-input" placeholder="Migrated input" />
      </div>
      <div className="flex items-center gap-3">
        <Checkbox id="migrated-checkbox" defaultChecked>
          Migrated checkbox
        </Checkbox>
        <Switch id="migrated-switch" defaultChecked />
      </div>
      <button
        id="style-probe"
        type="button"
        className="text-xs text-muted-foreground"
        onClick={() => {
          const pick = (el: Element | null) =>
            el ? getComputedStyle(el).backgroundColor : "none";
          log("style-probe", {
            migratedButton: pick(document.getElementById("migrated-primary")),
            migratedInputBorder: document.getElementById("migrated-input")
              ? getComputedStyle(
                  // biome-ignore lint/style/noNonNullAssertion: the ternary above just proved it exists
                  document.getElementById("migrated-input")!,
                ).borderColor
              : "none",
          });
        }}
      >
        Probe computed styles
      </button>
    </div>
  );
}

/* Modal-contained Select over the PRODUCTION wrappers, numeric domain IDs and null. */
function ModalWithSelect() {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<number | null>(202);
  const models = [
    { id: 101, name: "Alpha" },
    { id: 202, name: "Beta" },
    { id: 303, name: "Gamma" },
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        id="open-modal"
        render={(props) => (
          <button
            {...props}
            id="open-modal"
            onClick={() => {
              window.__spike.lastFocusBeforeMenu =
                document.activeElement?.id ?? null;
              props.onClick?.(undefined as never);
            }}
          >
            Open modal
          </button>
        )}
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Model access</DialogTitle>
          <DialogDescription>
            Numeric IDs must survive the round trip.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Select
            value={model}
            onValueChange={(next) => {
              window.__spike.selectValue = next;
              setModel(next);
              log("select-change", {
                next,
                type: typeof next,
                triggerRole: document
                  .getElementById("modal-select-trigger")
                  ?.getAttribute("role"),
              });
            }}
          >
            <SelectTrigger id="modal-select-trigger" className="w-56">
              <SelectValue placeholder="Pick a model" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Available models</SelectLabel>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </DialogBody>
        <DialogFooter>
          <Button
            id="close-modal"
            onClick={() => {
              setOpen(false);
              log("modal-close", { via: "footer" });
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* TRUE nesting: a second Dialog inside the first Dialog's body, and a Sheet (Drawer)
 * opened from inside the first Dialog. */
function NestedOverlays() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  const [drawer, setDrawer] = useState(false);
  return (
    <Dialog open={outer} onOpenChange={setOuter}>
      <Button id="open-outer" onClick={() => setOuter(true)}>
        Open outer dialog
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Outer</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex gap-2">
            <Button id="open-inner" onClick={() => setInner(true)}>
              Open inner dialog
            </Button>
            <Sheet open={drawer} onOpenChange={setDrawer}>
              <SheetTrigger
                render={(props) => (
                  <button
                    {...props}
                    id="open-drawer"
                    onClick={() => {
                      props.onClick?.(undefined as never);
                      setDrawer(true);
                    }}
                  >
                    Open drawer
                  </button>
                )}
              />
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>Settings drawer</SheetTitle>
                </SheetHeader>
                <p className="text-sm text-muted-foreground">drawer body</p>
              </SheetContent>
            </Sheet>
          </div>
        </DialogBody>
      </DialogContent>
      <Dialog open={inner} onOpenChange={setInner}>
        <DialogContent overlayClassName="bg-black/40">
          <DialogHeader>
            <DialogTitle>Inner</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {/* F2 fixture: a Select whose dying popup must answer to the innermost dialog only. */}
            <div className="flex items-center gap-3">
              <p className="text-sm">inner body</p>
              <Select id="inner-select" defaultValue={202}>
                <SelectTrigger id="inner-select-trigger" className="w-40">
                  <SelectValue placeholder="Inner pick" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Inner models</SelectLabel>
                    <SelectItem value={101}>Alpha</SelectItem>
                    <SelectItem value={202}>Beta</SelectItem>
                    <SelectItem value={303}>Gamma</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button id="close-inner" onClick={() => setInner(false)}>
              Close inner
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

/* TanStack Link through ButtonLink: real anchor semantics under a real router. */
function LinkSpike() {
  return (
    <div className="flex items-center gap-3">
      <ButtonLink id="router-link" to="/target" data-testid="router-link">
        Router link
      </ButtonLink>
      <ButtonLink
        id="external-link"
        href="https://example.com"
        variant="outline"
      >
        External link
      </ButtonLink>
      <span id="route-indicator" className="text-xs text-muted-foreground" />
    </div>
  );
}

/* Questionnaire + MessageScroller over the production wrappers (engines retained). */
function EnginesSpike() {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [answer, _setAnswer] = useState<string | null>(null);
  return (
    <div className="flex gap-4">
      <div className="w-80">
        <Questionnaire>
          <QuestionnaireItem>
            <QuestionnaireTitle>Which channel?</QuestionnaireTitle>
            <QuestionnaireChoices>
              <QuestionnaireChoice value="email" type="radio">
                Email
              </QuestionnaireChoice>
              <QuestionnaireChoice value="push" type="radio">
                Push
              </QuestionnaireChoice>
            </QuestionnaireChoices>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                id="questionnaire-next"
                className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground"
                onClick={() => {
                  log("questionnaire-next", { answer });
                }}
              >
                Next
              </button>
              <span id="questionnaire-answer" className="self-center text-xs">
                {answer ?? "none"}
              </span>
            </div>
          </QuestionnaireItem>
        </Questionnaire>
      </div>
      <div
        ref={scrollerRef}
        id="scroller-frame"
        className="relative h-40 w-72 overflow-y-auto rounded-lg border p-3"
      >
        <MessageScrollerProvider>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <MessageScrollerItem key={i} scrollAnchor={i === 7}>
                    <p className="text-sm">message {i}</p>
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton
              render={<Button variant="secondary" size="icon-sm" />}
            />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
      {/* choice wiring: radio inputs inside Questionnaire.Choice carry values — this inline script
          is the spike harness's own bridge over a static string, not app code. */}
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: spike fixture bridge, static string
        dangerouslySetInnerHTML={{
          __html: `document.querySelectorAll('[data-slot=questionnaire-choice-input]').forEach(function(i){i.addEventListener('change',function(e){window.__spike.event('questionnaire-choice',{value:e.target.value})});});`,
        }}
      />
    </div>
  );
}

/* Production context-menu adapter: right-click, Shift+F10, ContextMenu key, long-press. */
function ContextMenuSpike() {
  const targetId = "ctx-target";
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) {
          log("context-menu-open");
        } else {
          window.__spike.closedVia = "onOpenChange-false";
          window.__spike.focusAfterClose =
            document.activeElement?.id ??
            (document.activeElement instanceof HTMLElement
              ? document.activeElement.tagName
              : null);
          log("context-menu-close");
        }
      }}
    >
      <ContextMenuTrigger
        id={targetId}
        data-testid="ctx-target"
        tabIndex={0}
        className="border-border w-72 rounded-md border p-3 text-sm"
      >
        Right-click me, focus me and press Shift+F10 / ContextMenu key, or
        long-press.
      </ContextMenuTrigger>
      <ContextMenuContent>
        <DropdownMenuLabel>Message actions</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => log("context-menu-action", "copy")}>
          Copy
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => log("context-menu-action", "quote")}>
          Quote
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => log("context-menu-action", "delete")}
        >
          Delete
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/* IME guard: synthetic composition events through the real browser event path. */
function ImeSpike() {
  const [value, setValue] = useState("");
  const composing = useRef(false);
  return (
    <Textarea
      aria-label="IME"
      id="ime-input"
      value={value}
      onCompositionStart={() => {
        composing.current = true;
        log("composition-start");
      }}
      onCompositionEnd={() => {
        composing.current = false;
        log("composition-end");
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        if (composing.current || event.nativeEvent.isComposing) {
          log("enter-while-composing", { guarded: true });
          return;
        }
        event.preventDefault();
        log("enter-sent", { value });
      }}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

/* Multi-select combobox adapter fixture: chips pick-order, removal, filter, ESC-does-not-clear. */
function MultiSelectFixture() {
  const bots = [
    { id: "b1", name: "Alpha", title: "writer" },
    { id: "b2", name: "Beta", title: "coder" },
    { id: "b3", name: "Gamma", title: "reviewer" },
    { id: "b4", name: "Delta", title: "ops" },
  ];
  const [picked, setPicked] = useState<typeof bots>([]);
  window.__spike.pickedOrder = picked.map((bot) => bot.id);
  return (
    <div className="w-96">
      <Combobox
        items={bots}
        getKey={(bot) => bot.id}
        itemLabel={(bot) => bot.name}
        itemSecondary={(bot) => (
          <span className="truncate text-muted-foreground ml-1">
            {bot.title}
          </span>
        )}
        chipMedia={(bot) => (
          <span className="inline-block size-4 rounded-full bg-primary text-[8px] leading-4 text-center text-primary-foreground">
            {bot.name[0]}
          </span>
        )}
        selected={picked}
        onSelectedChange={(ids) =>
          setPicked(bots.filter((bot) => ids.includes(bot.id)))
        }
        emptyText="No Bots found."
        placeholder="Choose a Bot…"
      />
      <p data-testid="picked-order">
        {window.__spike.pickedOrder?.join(",") || "none"}
      </p>
    </div>
  );
}

/* Combobox inside a controlled Dialog: ESC must close only the popover, then the dialog. */
function DialogWithCombobox() {
  const [open, setOpen] = useState(false);
  const bots = [
    { id: "b1", name: "Alpha", title: "writer" },
    { id: "b2", name: "Beta", title: "coder" },
    { id: "b3", name: "Gamma", title: "reviewer" },
    { id: "b4", name: "Delta", title: "ops" },
  ];
  const [picked, setPicked] = useState<typeof bots>([]);
  window.__spike.dialogPicked = picked.map((bot) => bot.id);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        window.__spike.dialogCloseVia = next ? "open" : "onOpenChange-false";
        setOpen(next);
      }}
    >
      <Button id="open-cb-dialog" onClick={() => setOpen(true)}>
        Open combobox dialog
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pick Bots</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Combobox
            items={bots}
            getKey={(bot) => bot.id}
            itemLabel={(bot) => bot.name}
            selected={picked}
            onSelectedChange={(ids) =>
              setPicked(bots.filter((bot) => ids.includes(bot.id)))
            }
            emptyText="No Bots found."
            placeholder="Choose a Bot…"
          />
        </DialogBody>
        <DialogFooter>
          <Button id="close-cb-dialog" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const rootRoute = createRootRoute({ component: App });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});
const targetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/target",
  component: () => null,
  beforeLoad: () => {
    log("route-navigated", { to: "/target" });
    const el = document.getElementById("route-indicator");
    if (el) el.textContent = "on /target";
  },
});
const routeTree = rootRoute.addChildren([indexRoute, targetRoute]);
const router = createRouter({ routeTree });

function App() {
  useEffect(() => {
    log("mounted");
  }, []);
  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-semibold">HeroUI H01 browser spike</h1>
      <Section title="Migrated controls, one production stylesheet">
        <Tokens />
      </Section>
      <Section title="Production Dialog + Select (numeric IDs, null, ESC, focus return)">
        <ModalWithSelect />
      </Section>
      <Section title="Nested Dialog-in-Dialog and Drawer-in-Dialog">
        <NestedOverlays />
      </Section>
      <Section title="TanStack Link via ButtonLink (real anchor)">
        <LinkSpike />
      </Section>
      <Section title="Questionnaire + MessageScroller (engines retained)">
        <EnginesSpike />
      </Section>
      <Section title="Multi-select combobox (chips, order, ESC keeps selection)">
        <MultiSelectFixture />
      </Section>
      <Section title="Combobox inside a Dialog (ESC layering: popover, then dialog)">
        <DialogWithCombobox />
      </Section>
      <Section title="Context menu: pointer / Shift+F10 / ContextMenu key / long-press">
        <ContextMenuSpike />
      </Section>
      <Section title="IME composition guard">
        <ImeSpike />
      </Section>
    </main>
  );
}

createRoot(
  // biome-ignore lint/style/noNonNullAssertion: the mount point this document exists for
  document.getElementById("root")!,
).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
