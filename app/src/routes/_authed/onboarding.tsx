import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/VStack";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { ALWAYS_ASKS_SHORT } from "@/components/approvals/ask-first-copy";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { AskFirstSwitch } from "@/components/onboarding/ask-first-switch";
import { BookingCalendar } from "@/components/onboarding/booking-calendar";
import { IntroReel } from "@/components/onboarding/demos/intro-reel";
import { SelfHostDemo } from "@/components/onboarding/demos/self-host-demo";
import { FINISH_MS, useNameStep } from "@/components/onboarding/name-step";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import {
  type OnboardingStep,
  OnboardingWizard,
} from "@/components/onboarding/onboarding-wizard";
import { currentUserQueryOptions, needsOnboarding } from "@/lib/auth/queries";
import { appReturnPath } from "@/lib/auth/resume";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
import {
  advanceOnboardingMutationOptions,
  completeOnboardingMutationOptions,
} from "@/lib/onboarding/mutations";
import { BUSINESS_URL } from "@/lib/openbot-for-business";
import { setupChecklistQueryOptions } from "@/lib/setup/queries";
import { queryClient } from "@/query-client";

const PRODUCT = appConfig.brand.productName;

/**
 * Every step, by id, with the number the server stores for it.
 *
 * `POST /api/me/onboarding` keeps a step as an integer, so each id has a number of its own. A
 * number per id, never a position in the list: OpenBot for Business joins the list only for somebody trying
 * OpenBot alone, and the name step leaves it for somebody whose name is known, so a position would
 * mean different steps to different people. 0 is the server's "not started".
 */
const STEP_NUMBER = {
  welcome: 1,
  selfhost: 2,
  name: 3,
} as const;
type StepId = keyof typeof STEP_NUMBER;

const isStepId = (value: unknown): value is StepId =>
  typeof value === "string" && Object.hasOwn(STEP_NUMBER, value);

/** The step a stored number names, or null for "not started" and for a number no step has. */
function stepForNumber(step: number | undefined): StepId | null {
  const found = Object.entries(STEP_NUMBER).find(([, at]) => at === step);
  return found ? (found[0] as StepId) : null;
}

/**
 * The step somebody was last on. Kept in the history entry Continue pushed (`onboardingFrom`), so
 * Back after a reload still pops the entry instead of adding a second one for the same step.
 */
type OnboardingEntry = {
  onboardingFrom?: unknown;
  onboardingNameSaved?: unknown;
};

export const Route = createFileRoute("/_authed/onboarding")({
  /*
   * WHERE SOMEBODY IS LIVES IN THE ADDRESS. `?step=<id>` is the step on screen, so a reload stays
   * on it, and browser Back and Forward walk the steps. Anything else is ignored.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { step?: StepId; returnTo?: string } => ({
    // Named even when absent: the router lays this over the raw search, so a key left out would
    // keep whatever was typed into the address.
    step: isStepId(search.step) ? search.step : undefined,
    returnTo: appReturnPath(search.returnTo),
  }),
  beforeLoad: async ({ context, search }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    // Somebody who has finished, or whose deployment tracks no onboarding, has no business here.
    if (!user || !needsOnboarding(user)) {
      throw search.returnTo
        ? redirect({ href: search.returnTo, replace: true })
        : redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

/*
 * THREE CLICKS AT MOST INTO THE APP. Welcome, then OpenBot for Business for somebody trying OpenBot alone,
 * then the name. Everything else waits for the app: the setup checklist lives in Settings → Setup,
 * apps are connected from Connections when a Bot needs one, and notifications are offered once the
 * first task has started (`NotifyPrompt`), when what they are for is plain.
 */

/**
 * The welcome step: one animation of what OpenBot does, and beside it the one choice worth making
 * before the first task, whether a Bot asks before it changes anything.
 *
 * What always asks is said above the switch, so nobody reads turning it off as turning those off
 * too. The switch only adds routine changes on top (reported on 0.3.3).
 *
 * A few lines a new person takes in at a glance: what asks, the one choice, and where to change it
 * later. The detail (allowing an action always, passwords, a Bot's own workspace) lives in
 * Settings → Approvals, said in full there.
 *
 * The animation is a picture and the switch is real, so they never share a pane: the switch sits
 * with the words, and the picture stays a picture.
 */
function welcomeStep(computer: boolean): OnboardingStep {
  return {
    id: "welcome",
    title: `Welcome to ${PRODUCT}`,
    intro: () => (
      <StepIntro
        after={
          <VStack
            aria-labelledby="onboarding-permissions"
            as="section"
            className="text-left"
            gap={2}
          >
            <h2 className="text-base font-semibold" id="onboarding-permissions">
              Approval preferences
            </h2>
            <p className="text-sm text-pretty text-muted-foreground">
              {ALWAYS_ASKS_SHORT}
            </p>
            <AskFirstSwitch />
            <p className="text-sm text-pretty text-muted-foreground">
              Change this anytime in Settings → Approvals.
            </p>
          </VStack>
        }
      >
        <p>Finish setup to give a Bot your first task in plain words.</p>
      </StepIntro>
    ),
    demo: () => <IntroReel computer={computer} />,
  };
}

/*
 * OPENBOT FOR BUSINESS IS FOR SOMEBODY TRYING OPENBOT ON THEIR OWN MACHINE, and only they see it (see
 * `localEvaluation` in RouteComponent). None of it is said to an organization's own people, who
 * already have OpenBot.
 *
 * WHAT IT IS COMES BEFORE ASKING FOR A CALL. The step opens on what OpenBot for Business adds, beside
 * the picture of running OpenBot yourself. The explanation gives people enough context to decide
 * whether they want a demo.
 *
 * Booking is optional. Keep the way through setup in the footer, and put the booking action
 * with its explanation. The calendar opens in the picture's place.
 *
 * When the calendar fails, Book a call opens the business page in a new tab.
 */
function useBookDemoStep(): OnboardingStep {
  const [calendar, setCalendar] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [booked, setBooked] = React.useState(false);
  const fail = React.useCallback(() => setFailed(true), []);
  const book = React.useCallback(() => setBooked(true), []);
  const value: OnboardingStep = {
    id: "selfhost",
    title: "OpenBot for Business",
    intro: () => (
      <StepIntro
        after={
          <Button
            className="min-h-11 rounded-lg! border! border-border! px-4! focus-visible:outline-2! focus-visible:outline-offset-2! focus-visible:outline-ring!"
            label={failed ? "Book a call" : "Book a demo"}
            onClick={() => {
              if (failed)
                window.open(BUSINESS_URL, "_blank", "noopener,noreferrer");
              else setCalendar(true);
            }}
            variant="secondary"
          />
        }
      >
        <p>
          Bring {PRODUCT} to your team on your own servers, with work accounts,
          shared Bots, and an audit trail. You can book a demo or continue
          setup.
        </p>
        {failed && (
          <p role="status">
            The calendar couldn’t load. Book a call opens it in a new tab.
          </p>
        )}
      </StepIntro>
    ),
    demo: () => <SelfHostDemo />,
    primaryLabel: "Continue setup",
  };
  if (!calendar || failed) return value;
  return {
    ...value,
    intro: () => (
      <StepIntro>
        <p>
          {booked
            ? "Your demo is booked. You can continue setup."
            : "Pick a time for a demo or continue setup without booking."}
        </p>
      </StepIntro>
    ),
    demo: () => <BookingCalendar onBooked={book} onFailed={fail} />,
  };
}

function RouteComponent() {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const entry = location.state as OnboardingEntry;
  const search = Route.useSearch();
  const me = useQuery(currentUserQueryOptions());
  const complete = useMutation({
    ...completeOnboardingMutationOptions(queryClient),
    networkMode: "always",
  });
  const advance = useMutation({
    ...advanceOnboardingMutationOptions(queryClient),
    networkMode: "always",
    scope: { id: `onboarding:${me.data?.id}` },
  });

  /*
   * OpenBot for Business is for somebody evaluating OpenBot locally, never for an organization's people: the
   * server says single-user mode, which an organization's deployment, always behind sign-in, cannot
   * be in. Until the answer arrives it is left out, and Welcome's button waits for it, so a slow or
   * failed request never shows an organization's employees a page about booking a call, and an
   * evaluator never walks past theirs.
   *
   * NOT GATED ON `selfHostBanner` AS WELL. That flag is off for any deployment with a paid
   * Intelligence entitlement, and the stack `copilotkit local` installs runs on an enterprise
   * evaluation licence, so every CLI evaluator, the person this step is for, would never see it.
   */
  const {
    data: capabilities,
    error: capabilitiesError,
    refetch: retryCapabilities,
    isFetching: loadingCapabilities,
    isPending: askingCapabilities,
  } = useQuery(deploymentCapabilitiesQueryOptions());

  /*
   * A sign-in that brought a name skips the name step. If the person reached that step and
   * saved their name before completion failed, reload lets them finish there.
   */
  const [askName] = React.useState(
    () =>
      me.data?.needsName === true ||
      !me.data?.name ||
      me.data.name === me.data.email ||
      me.data.onboarding?.step === STEP_NUMBER.name ||
      entry.onboardingNameSaved === true,
  );
  const ids: StepId[] = [
    "welcome",
    ...(capabilities?.localEvaluation ? (["selfhost"] as const) : []),
    ...(askName ? (["name"] as const) : []),
  ];

  /*
   * The step on screen: the address's, else the one the server saved, else the first. A step not in
   * this person's list (OpenBot for Business for an organization's person, the name step once it is known)
   * reads as the last one they have, once the answer that decides it is in. Arriving without a step
   * writes it into the address in place, so the entry the person lands on already names its step.
   */
  const reachable = (step: StepId | null | undefined): StepId | undefined => {
    if (!step) return undefined;
    if (step === "selfhost" && !capabilities) return step;
    return ids.includes(step) ? step : ids[ids.length - 1];
  };
  const saved = reachable(stepForNumber(me.data?.onboarding?.step));
  const asked = reachable(isStepId(search.step) ? search.step : undefined);
  const current: StepId = asked ?? saved ?? "welcome";
  React.useEffect(() => {
    if (asked !== undefined && asked === search.step) return;
    navigate({
      to: "/onboarding",
      search: { step: current, returnTo: search.returnTo },
      replace: true,
    });
  }, [navigate, current, asked, search.step, search.returnTo]);

  // Saved wherever the person goes, by Continue, Back or the browser.
  const onboarding = me.data?.onboarding;
  const { mutate: save, variables: requestedStep } = advance;
  const stepNumber = STEP_NUMBER[current];
  React.useEffect(() => {
    if (!onboarding || onboarding.completedAt !== null) return;
    if (current === "selfhost" && !capabilities) return;
    // Save Back as well as forward moves while a preceding request is still in flight.
    if (stepNumber === (requestedStep ?? onboarding.step)) return;
    save(stepNumber);
  }, [current, onboarding, requestedStep, save, capabilities, stepNumber]);

  /*
   * CONTINUE PUSHES, AND BACK RETURNS THROUGH HISTORY WHEN IT CAN. Continue adds an entry carrying
   * the step it was pressed on, so browser Back walks back a step. The frame's Back pops that entry
   * when it was pushed from the step behind, and otherwise (arriving by a link, say) replaces this
   * entry with the step behind, so history never holds the same step twice in a row.
   */
  const cameFrom = entry.onboardingFrom;
  const move = (to: string, way: "forward" | "back") => {
    if (!isStepId(to)) return;
    if (way === "back" && cameFrom === to) {
      router.history.back();
      return;
    }
    const state: Record<string, unknown> =
      way === "forward" ? { onboardingFrom: current } : {};
    navigate({
      to: "/onboarding",
      search: { step: to, returnTo: search.returnTo },
      replace: way === "back",
      state,
    });
  };

  /*
   * THE WAY OUT IS THE LAST STEP'S BUTTON. On the name step, Get started saves the name first. Then
   * completion is saved, the orb or the button plays its finish, the page fades, and the app opens.
   * A completion that fails is said on the step, and the button can be pressed again.
   */
  const reduced = useReducedMotion() === true;
  const [finished, setFinished] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const finishing = React.useRef(false);
  const finish = async () => {
    if (finishing.current) return;
    finishing.current = true;
    try {
      // Keep the name step on reload even if its progress write could not reach the server.
      if (current === "name" && onboarding?.step !== STEP_NUMBER.name) {
        const active = router.state.location;
        if (active.href === location.href) {
          router.history.replace(active.href, {
            ...active.state,
            onboardingNameSaved: true,
          });
        }
      }
      await complete.mutateAsync(undefined);
    } catch {
      finishing.current = false;
      return;
    }
    setFinished(true);
    await new Promise((resolve) =>
      setTimeout(resolve, reduced ? 150 : FINISH_MS),
    );
    setLeaving(true);
  };
  React.useEffect(() => {
    if (!leaving) return;
    // Navigation must also complete in a background tab, where animation frames may pause.
    const timer = setTimeout(
      () => {
        if (search.returnTo) window.location.replace(search.returnTo);
        else void navigate({ to: "/", replace: true });
      },
      reduced ? 0 : 300,
    );
    return () => clearTimeout(timer);
  }, [leaving, navigate, reduced, search.returnTo]);

  const name = useNameStep({
    finish,
    finished,
    completing: complete.isPending,
    retry: complete.isError,
  });
  const selfhost = useBookDemoStep();
  /*
   * The checklist says whether there is a Bot computer, and the intro shows one only where there
   * is. Until it answers, the usual case: a computer that is there.
   */
  const { data: checklist } = useQuery(setupChecklistQueryOptions());
  const computerMissing =
    checklist?.rows.find((row) => row.id === "computer")?.status ===
    "needs_setup";

  const lastId = ids[ids.length - 1];
  const progressFailed =
    advance.isError && advance.variables === stepNumber && !finished;
  const notice =
    askingCapabilities && current === "welcome" ? (
      <p className="text-sm text-muted-foreground" role="status">
        Checking which setup steps you need…
      </p>
    ) : capabilitiesError && !capabilities ? (
      <Banner
        endContent={
          <Button
            className="min-h-11"
            isLoading={loadingCapabilities}
            label="Try again"
            onClick={() => void retryCapabilities()}
            size="sm"
            variant="secondary"
          />
        }
        role="alert"
        status="error"
        title="Couldn’t load your setup"
      />
    ) : complete.isError && current === lastId ? (
      <Banner
        description="Use Retry setup to finish and open your workspace."
        role="alert"
        status="error"
        title="Couldn’t finish setup"
      />
    ) : progressFailed ? (
      <Banner
        description="You can keep going. Reopening this address returns you to this step."
        endContent={
          <Button
            className="min-h-11"
            label="Retry save"
            onClick={() => save(stepNumber)}
            size="sm"
            variant="secondary"
          />
        }
        role="alert"
        status="warning"
        title="Couldn’t save your place"
      />
    ) : undefined;

  const byId: Record<StepId, OnboardingStep> = {
    welcome: {
      ...welcomeStep(!computerMissing),
      primaryDisabled: !capabilities,
    },
    selfhost,
    name,
  };
  // The name form saves any changes before completing. The other last steps can finish directly.
  const steps: OnboardingStep[] = ids.map((id) => {
    const step = byId[id];
    if (id !== lastId || id === "name") return step;
    return {
      ...step,
      primaryLabel: finished
        ? "All set"
        : complete.isPending
          ? "Finishing…"
          : complete.isError
            ? "Retry setup"
            : "Get started",
      primaryDone: finished,
      primaryPending: complete.isPending,
      onPrimary: () => void finish(),
    };
  });

  // An OpenBot for Business step in the address waits for the answer that puts it in the list, rather than
  // drawing Welcome for a moment and then jumping.
  const waiting = askingCapabilities && current === "selfhost";

  return (
    // Outside `_app` on purpose: no sidebar and no chrome until onboarding is done.
    // The fade runs only after the completion is saved, so a failed save never fades a page the
    // person still needs, and navigation waits for the fade, so the next screen never pops in over
    // a half-faded onboarding.
    <AstryxSurface className="min-h-svh">
      <motion.div
        animate={{ opacity: leaving ? 0 : 1 }}
        className={`min-h-svh w-full ${leaving ? "pointer-events-none" : ""}`}
        initial={false}
        transition={{ duration: reduced ? 0 : 0.3, ease: "easeOut" }}
      >
        {waiting ? null : (
          <OnboardingWizard
            notice={notice}
            onMove={(to, way) => move(to, way)}
            stepId={current}
            steps={steps}
          />
        )}
      </motion.div>
    </AstryxSurface>
  );
}
