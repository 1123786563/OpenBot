import { AsyncLocalStorage } from "node:async_hooks";

const runnerRequest = new AsyncLocalStorage<Request>();

export function withRunnerRequestContext<T>(
  request: Request,
  operation: () => T,
): T {
  return runnerRequest.run(request, operation);
}

export function currentRunnerRequest(): Request {
  const request = runnerRequest.getStore();
  if (!request) throw new Error("RUNNER_REQUEST_CONTEXT_UNAVAILABLE");
  return request;
}
