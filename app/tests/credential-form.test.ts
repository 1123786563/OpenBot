import "./preload";
import "./preload";
import { expect, test } from "../../tests/support/e2e-compat";
import { credentialFormSchema } from "@/lib/credentials/form";

test("requires credential type, provider, key ID, and secret", () => {
  expect(
    credentialFormSchema.safeParse({
      kind: "model",
      provider: "",
      keyId: "",
      plaintext: "",
    }).success,
  ).toBeFalse();
});
