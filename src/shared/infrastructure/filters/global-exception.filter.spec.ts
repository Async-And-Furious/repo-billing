import { ArgumentsHost, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import { GlobalExceptionFilter } from './global-exception.filter';
import { DomainException } from '../../domain/exceptions/domain.exception';
import { EntityNotFoundException } from '../../domain/exceptions/entity-not-found.exception';
import { ConflitoException } from '../../domain/exceptions/conflito.exception';

describe('GlobalExceptionFilter', () => {
  const logger = { error: jest.fn(), warn: jest.fn() };
  const filter = new GlobalExceptionFilter(logger as unknown as PinoLogger);
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });

  function host(request: Record<string, unknown> = { url: '/x', id: 'corr-1' }): ArgumentsHost {
    return {
      switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => request }),
    } as unknown as ArgumentsHost;
  }

  beforeEach(() => jest.clearAllMocks());

  it('EntityNotFoundException vira 404', () => {
    filter.catch(new EntityNotFoundException('Pagamento', '1'), host());
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Not Found', path: '/x', correlationId: 'corr-1' })
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it('ConflitoException vira 409', () => {
    filter.catch(new ConflitoException('em andamento'), host());
    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'em andamento', error: 'Conflict' })
    );
  });

  it('DomainException vira 400', () => {
    filter.catch(new DomainException('invalido'), host());
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: 'invalido' }));
  });

  it('HttpException com objeto usa message e normaliza o nome', () => {
    filter.catch(new BadRequestException(['campo obrigatorio']), host());
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: ['campo obrigatorio'], error: 'Bad Request' })
    );
  });

  it('HttpException com string usa a string como mensagem', () => {
    filter.catch(new HttpException('teapot', HttpStatus.I_AM_A_TEAPOT), host());
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 418, message: 'teapot' })
    );
  });

  it('HttpException com objeto vazio cai em exception.message e nome generico', () => {
    filter.catch(new HttpException({}, HttpStatus.CONFLICT), host());
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, message: 'Http Exception', error: 'Error' })
    );
  });

  it('Error generico vira 500 e loga como error, sem correlationId se ausente', () => {
    filter.catch(new Error('boom'), host({ url: '/y' }));
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json.mock.calls[0][0]).not.toHaveProperty('correlationId');
    expect(json.mock.calls[0][0]).toMatchObject({ message: 'boom' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('valor desconhecido vira 500 com mensagem padrao', () => {
    filter.catch('algo', host());
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, message: 'Internal server error' })
    );
  });
});
