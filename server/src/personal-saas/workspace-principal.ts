// Resource stores share owner columns with local users. Each workspace lifecycle
// has its own principal, separate from local users and Casdoor email addresses.
export function workspaceResourceOwner(workspaceId: string) {
  return `personal-workspace:${workspaceId}`;
}
