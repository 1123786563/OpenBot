import {
  personalSaasCallbackUrl,
  personalSaasMode,
} from "../src/personal-saas-contract";

export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}) {
  if (personalSaasMode && path.startsWith(`${personalSaasCallbackUrl}?`))
    return "/";
  return path;
}
