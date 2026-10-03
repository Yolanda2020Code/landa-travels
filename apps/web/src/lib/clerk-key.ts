export function explicitPublishableKeyFromHost(
  _hostname: string,
  configuredPublishableKey: string | undefined,
): string | undefined {
  return configuredPublishableKey?.trim() || undefined;
}
