/**
 * Quantos proxies confiáveis existem na frente do Billing (#378, item 14). Em HML e PROD são dois:
 * o API Gateway, via VPC Link, e o ALB interno. Com o número certo, o Express lê o IP real do
 * cliente no `X-Forwarded-For`, e o throttling das rotas públicas (aprovar e recusar orçamento)
 * deixa de juntar todos os clientes no IP do ALB. Nunca `true`: confiar em qualquer salto
 * deixaria o cliente escolher o próprio IP pelo header. Sem a variável, 0 (desenvolvimento local).
 */
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const bruto = env.TRUST_PROXY_HOPS;
  if (bruto === undefined || bruto.trim() === '') return 0;
  const hops = Number(bruto);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUST_PROXY_HOPS inválido: ${bruto}`);
  }
  return hops;
}
