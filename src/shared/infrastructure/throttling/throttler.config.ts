// Nome do throttler global (100 req/min/IP, ver AppModule). O @SkipThrottle() sem argumentos só
// isenta o throttler chamado "default"; como este se chama "short", a isenção tem que citá-lo.
export const THROTTLER_GLOBAL = 'short';
