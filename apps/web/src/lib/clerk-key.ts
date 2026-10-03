export function explicitPublishableKeyFromHost(
  _hostname: string,
  configuredPublishableKey: string | undefined,
): string | undefined {
  return configuredPublishableKey?.trim() || undefined;
}

export function explicitClerkProxyUrl(
  runtimeProxyUrl: string | undefined,
  buildProxyUrl: string | undefined,
): string | undefined {
  const configured = runtimeProxyUrl === undefined ? buildProxyUrl : runtimeProxyUrl;
  return configured?.trim() || undefined;
}
