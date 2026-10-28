import { expect, test } from "../../../tests/support/bun-test-compat";
import {
  createPasswordRecoveryIngress,
  PASSWORD_RECOVERY_NOT_WIRED,
  type PasswordRecoveryIngressDeps,
} from "../../src/auth/password-recovery";

/*
 * T05.14 r1 F2 (#570): the production assembly runs with outbox:null until a
 * delivery-worker ticket wires a real outbox, and that fail-closed posture is
 * load-bearing — two user rulings name it, and the T05.14 report's honesty
 * rests on "no token is ever half-issued". No suite pinned it, so a future
 * wiring that reorders the check would mint the reset token before refusing,
 * silently. This pin needs no database on purpose: the guarantee is the
 * ordering — the 503 refusal must come before any command transaction opens,
 * and every later dependency (native route, session read, bound build) must
 * stay untouched on the not-wired arm.
 */

test("not_wired_refuses_request_reset_503_before_any_token", async () => {
  let transactionsOpened = 0;
  const deps = {
    database: {
      transaction: () => {
        transactionsOpened += 1;
        throw new Error(
          "the not-wired refusal must come before any command transaction",
        );
      },
    },
    auth: {
      api: {
        requestPasswordReset: () => {
          throw new Error(
            "the not-wired refusal must come before the native route",
          );
        },
      },
    },
    getSession: () => {
      throw new Error(
        "the not-wired refusal must come before any session read",
      );
    },
    bound: {
      run: () => {
        throw new Error(
          "the not-wired refusal must come before the bound build runs",
        );
      },
    },
    outbox: null,
    identity: null,
    passwordEnabled: true,
  } as unknown as PasswordRecoveryIngressDeps;

  const ingress = createPasswordRecoveryIngress(deps);
  const response = await ingress.handle(
    new Request("http://127.0.0.1:9/api/auth/request-password-reset", {
      method: "POST",
      body: JSON.stringify({
        email: "person@example.test",
        redirectTo: "/reset-password",
      }),
    }),
  );

  expect(response.status).toBe(503);
  const body = JSON.parse(await response.text()) as {
    error?: string;
    code?: string;
  };
  expect(body.code).toBe(PASSWORD_RECOVERY_NOT_WIRED);
  expect(transactionsOpened).toBe(0);
});
