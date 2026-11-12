declare module 'newrelic' {
  interface TransacaoNewRelic {
    insertDistributedTraceHeaders(headers: Record<string, string>): void;
    acceptDistributedTraceHeaders(transporte: string, headers: Record<string, string>): void;
  }
  interface NewRelicApi {
    recordCustomEvent(
      eventType: string,
      attributes: Record<string, string | number | boolean>
    ): void;
    getTransaction(): TransacaoNewRelic;
    startBackgroundTransaction<T>(
      nome: string,
      grupo: string,
      handle: () => Promise<T>
    ): Promise<T>;
  }
  const newrelic: NewRelicApi;
  export default newrelic;
}
