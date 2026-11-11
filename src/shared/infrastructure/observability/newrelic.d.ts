declare module 'newrelic' {
  interface NewRelicApi {
    recordCustomEvent(
      eventType: string,
      attributes: Record<string, string | number | boolean>
    ): void;
  }
  const newrelic: NewRelicApi;
  export default newrelic;
}
