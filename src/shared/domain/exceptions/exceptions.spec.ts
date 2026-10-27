import { DomainException } from './domain.exception';
import { EntityNotFoundException } from './entity-not-found.exception';
import { ConflitoException } from './conflito.exception';

describe('exceptions de dominio', () => {
  it('DomainException carrega mensagem e nome', () => {
    const e = new DomainException('regra violada');
    expect(e.message).toBe('regra violada');
    expect(e.name).toBe('DomainException');
  });

  it('EntityNotFoundException monta a mensagem e herda de DomainException', () => {
    const e = new EntityNotFoundException('Pagamento', 'x-1');
    expect(e.message).toBe("Pagamento with id 'x-1' not found");
    expect(e.name).toBe('EntityNotFoundException');
    expect(e).toBeInstanceOf(DomainException);
  });

  it('ConflitoException herda de DomainException', () => {
    const e = new ConflitoException('em andamento');
    expect(e.name).toBe('ConflitoException');
    expect(e).toBeInstanceOf(DomainException);
  });
});
