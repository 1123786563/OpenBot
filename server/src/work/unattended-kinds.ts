export const unattendedWorkLabels = {
  "group.turn": "Group run",
  "bot.wakeup": "Bot follow-up",
  "bot.message": "Bot handoff",
  "proactive.run": "Check-in",
  "responsibility.run": "Responsibility",
  "delivery.outbound": "Background notification",
};

export const backgroundBotKinds = Object.keys(unattendedWorkLabels).filter(
  (kind) => kind !== "delivery.outbound",
);
