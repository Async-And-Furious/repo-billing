declare module 'newrelic' {
  export function recordCustomEvent(
    eventType: string,
    attributes: Record<string, string | number | boolean>
  ): void;
}
