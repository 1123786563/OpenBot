import { SignInForm, authLocalization } from "better-auth-ui";
import type { ReactElement } from "react";
import type { SignInFormProps } from "better-auth-ui";

/*
 * The fixed UI's auth entry (T01.08, #520): OpenBot's sign-in surfaces render
 * this, not the kit directly, so the pinned source stays behind one seam. The
 * provider wiring (client, router, declarations) comes from
 * app/src/components/auth/provider.tsx; OpenBot-specific method props arrive
 * with the client adapters in T01.09.
 */

export function OpenBotSignIn(
  props: Partial<SignInFormProps> = {},
): ReactElement {
  return <SignInForm localization={authLocalization} {...props} />;
}
