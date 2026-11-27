export const browserGesturePaths: readonly string[] = [
  "/click",
  "/type",
  "/key",
  "/scroll",
];

export const botBrowserActionPaths: readonly string[] = [
  "/navigate",
  ...browserGesturePaths,
  "/browser-upload",
  "/sign-in/fill",
  "/sign-in/code",
];

export const browserObservationPaths: readonly string[] = [
  "/screenshot",
  "/read",
];

export const humanBrowserInputPaths: readonly string[] = [
  "/human/click",
  "/human/type",
  "/human/key",
  "/human/scroll",
];

export const browserControlPaths: readonly string[] = [
  "/control",
  "/control/request",
  "/control/take",
  "/control/release",
  "/control/cancel",
  "/control/secret",
  "/human/secret",
];
