import express from 'express';
import { trustProxyHops } from './trust-proxy';

describe('trustProxyHops (#378, item 14)', () => {
  it('sem a variável, não confia em proxy (desenvolvimento local)', () => {
    expect(trustProxyHops({})).toBe(0);
    expect(trustProxyHops({ TRUST_PROXY_HOPS: ' ' })).toBe(0);
  });

  it('lê o número de saltos', () => {
    expect(trustProxyHops({ TRUST_PROXY_HOPS: '2' })).toBe(2);
  });

  it.each(['true', '-1', '1.5', 'abc'])('rejeita valor inválido (%s)', (valor) => {
    expect(() => trustProxyHops({ TRUST_PROXY_HOPS: valor })).toThrow('TRUST_PROXY_HOPS inválido');
  });

  describe('IP visto pelo Express atrás do API Gateway e do ALB', () => {
    // O API Gateway grava o IP do cliente no X-Forwarded-For e o ALB acrescenta o IP de quem
    // falou com ele (a ENI do VPC Link). O socket do pod é o ALB.
    // Lê `req.ip` como o Express calcula, sem abrir porta: socket = ALB (10.0.0.9).
    const ipVisto = (hops: number, xff: string): string => {
      const app = express();
      app.set('trust proxy', hops);
      const socket = { remoteAddress: '10.0.0.9' };
      const req = Object.assign(Object.create(app.request) as express.Request, {
        app,
        headers: { 'x-forwarded-for': xff },
        socket,
        connection: socket,
      });
      return req.ip ?? '';
    };

    it('com 2 saltos, o IP é o do cliente', () => {
      expect(ipVisto(2, '203.0.113.7, 10.0.1.25')).toBe('203.0.113.7');
    });

    it('um X-Forwarded-For forjado pelo cliente não muda o IP', () => {
      expect(ipVisto(2, '6.6.6.6, 203.0.113.7, 10.0.1.25')).toBe('203.0.113.7');
    });

    it('sem trust proxy, todos os clientes aparecem com o IP do proxy', () => {
      expect(ipVisto(0, '203.0.113.7, 10.0.1.25')).not.toBe('203.0.113.7');
    });
  });
});
