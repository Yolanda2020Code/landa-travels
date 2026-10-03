export function isEmbeddedWindow(
  browserWindow: { self: unknown; readonly top: unknown } | undefined,
): boolean {
  if (!browserWindow) return false;
  try {
    return browserWindow.self !== browserWindow.top;
  } catch {
    // A restricted frame is not a safe place to start an OAuth redirect.
    return true;
  }
}