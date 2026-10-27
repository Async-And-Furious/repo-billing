import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('usa DATABASE_URL quando definida', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    expect(() => new PrismaService()).not.toThrow();
  });

  it('monta a URL a partir do contrato DB_*', () => {
    delete process.env.DATABASE_URL;
    Object.assign(process.env, { DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u@x', DB_PASSWORD: 'p/w' });
    expect(() => new PrismaService()).not.toThrow();
  });

  it('falha sem DATABASE_URL nem contrato completo', () => {
    delete process.env.DATABASE_URL;
    delete process.env.DB_HOST;
    expect(() => new PrismaService()).toThrow('DATABASE_URL or the explicit');
  });

  it('conecta e desconecta no ciclo de vida do modulo', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    const service = new PrismaService();
    const connect = jest.spyOn(service, '$connect').mockResolvedValue();
    const disconnect = jest.spyOn(service, '$disconnect').mockResolvedValue();
    await service.onModuleInit();
    await service.onModuleDestroy();
    expect(connect).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });
});
