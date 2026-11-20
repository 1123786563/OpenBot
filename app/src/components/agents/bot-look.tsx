import { createContext, useContext } from "react";

/** How a Bot is drawn: as its orb, or as the generated face. */
export type BotLook = "orb" | "face";

const BotLookContext = createContext<BotLook>("face");

export const BotLookProvider = BotLookContext.Provider;

export function useBotLook(): BotLook {
  return useContext(BotLookContext);
}
