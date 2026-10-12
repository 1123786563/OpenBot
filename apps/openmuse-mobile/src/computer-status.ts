/** The agent computer's status, shown in the header and read out by its button label. */
export function computerStatus(available: boolean, activeSessions: number) {
  return !available ? "离线" : activeSessions > 0 ? "可接管" : "就绪";
}
