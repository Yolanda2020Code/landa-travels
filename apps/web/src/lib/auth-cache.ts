export type AuthenticatedUserId = string | null;

export function didAuthenticatedUserChange(
  previousUserId: AuthenticatedUserId | undefined,
  nextUserId: AuthenticatedUserId,
): boolean {
  return previousUserId !== undefined && previousUserId !== nextUserId;
}