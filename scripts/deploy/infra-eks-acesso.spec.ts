import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Testa as funções reais de infra.sh: extrai cada uma do script e a roda no bash.
const SCRIPT = readFileSync(join(__dirname, 'infra.sh'), 'utf8');
const funcao = (nome: string) => {
  const inicio = SCRIPT.indexOf(`${nome}() {`);
  const fim = SCRIPT.indexOf('\n}\n', inicio);
  return SCRIPT.slice(inicio, fim + 2);
};

const ADMIN = '10.0.0.1/32';
const BILLING = '1.1.1.1/32';
const OS = '2.2.2.2/32';
const TODOS = '0.0.0.0/0';

type Config = {
  endpointPrivateAccess: boolean;
  endpointPublicAccess: boolean;
  publicAccessCidrs: string[];
};
const config = (publico: boolean, cidrs: string[]): Config => ({
  endpointPrivateAccess: true,
  endpointPublicAccess: publico,
  publicAccessCidrs: cidrs,
});
// Endpoint só privado: o EKS devolve 0.0.0.0/0 na lista mesmo com o acesso público desligado.
const PRIVADO = config(false, [TODOS]);

function rodar(nome: string, argumentos: (string | Config)[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'eks-acesso-'));
  try {
    const args = argumentos.map((arg, i) => {
      if (typeof arg === 'string') return arg;
      const arquivo = join(dir, `${i}.json`);
      writeFileSync(arquivo, JSON.stringify(arg));
      return arquivo;
    });
    return execFileSync('bash', ['-c', `${funcao(nome)}\n${nome} "$@"`, 'teste', ...args], {
      encoding: 'utf8',
    }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const abrir = (atual: Config, cidr: string) => rodar('eks_acesso_aberto', [atual, cidr]);
const restaurar = (original: Config, atual: Config, cidr: string) =>
  rodar('eks_acesso_restaurado', [original, atual, cidr]);

describe('infra.sh: abertura do endpoint do EKS', () => {
  // O jq `unique` ordena a lista; a ordem não importa para o EKS.
  it('com o acesso público ligado, acrescenta o runner à lista atual', () => {
    expect(abrir(config(true, [ADMIN, OS]), BILLING)).toBe(
      `endpointPrivateAccess=true,endpointPublicAccess=true,publicAccessCidrs=${BILLING},${ADMIN},${OS}`
    );
  });

  it('com o endpoint só privado, abre apenas para o runner, nunca para 0.0.0.0/0', () => {
    expect(abrir(PRIVADO, BILLING)).toBe(
      `endpointPrivateAccess=true,endpointPublicAccess=true,publicAccessCidrs=${BILLING}`
    );
  });
});

describe('infra.sh: restauração do endpoint do EKS com deploys concorrentes', () => {
  it('run isolado volta à lista original', () => {
    expect(restaurar(config(true, [ADMIN]), config(true, [ADMIN, BILLING]), BILLING)).toBe(
      `endpointPrivateAccess=true,endpointPublicAccess=true,publicAccessCidrs=${ADMIN}`
    );
  });

  it('o Billing termina antes do OS: tira só o próprio IP e mantém o do OS', () => {
    expect(restaurar(config(true, [ADMIN]), config(true, [ADMIN, BILLING, OS]), BILLING)).toBe(
      `endpointPrivateAccess=true,endpointPublicAccess=true,publicAccessCidrs=${ADMIN},${OS}`
    );
  });

  it('o OS termina depois: o IP do Billing, que estava na foto do OS, não volta', () => {
    expect(restaurar(config(true, [ADMIN, BILLING]), config(true, [ADMIN, OS]), OS)).toBe(
      `endpointPrivateAccess=true,endpointPublicAccess=true,publicAccessCidrs=${ADMIN}`
    );
  });

  it('endpoint só privado: o último a sair desliga o acesso público', () => {
    expect(restaurar(PRIVADO, config(true, [BILLING]), BILLING)).toBe(
      'endpointPrivateAccess=true,endpointPublicAccess=false'
    );
  });

  it('endpoint só privado com outro deploy em andamento: fica ligado só para o outro runner', () => {
    expect(restaurar(PRIVADO, config(true, [BILLING, OS]), BILLING)).toBe(
      `endpointPrivateAccess=true,endpointPublicAccess=true,publicAccessCidrs=${OS}`
    );
  });

  it('foto tirada com o endpoint aberto por outro run: sem CIDR restante, desliga em vez de abrir para todos', () => {
    // O Billing fotografou o endpoint enquanto o OS o mantinha aberto; o OS já saiu.
    expect(restaurar(config(true, [OS]), config(true, [BILLING]), BILLING)).toBe(
      'endpointPrivateAccess=true,endpointPublicAccess=false'
    );
  });

  it('abertura antiga (0.0.0.0/0 + runner) num endpoint privado volta a privado', () => {
    expect(restaurar(PRIVADO, config(true, [TODOS, BILLING]), BILLING)).toBe(
      `endpointPrivateAccess=true,endpointPublicAccess=false,publicAccessCidrs=${TODOS}`
    );
  });

  it('IP do runner que já estava na lista original não é removido', () => {
    expect(restaurar(config(true, [ADMIN, BILLING]), config(true, [ADMIN, BILLING]), BILLING)).toBe(
      ''
    );
  });

  it('endpoint já restaurado: nada a fazer', () => {
    expect(restaurar(config(true, [ADMIN]), config(true, [ADMIN]), BILLING)).toBe('');
    expect(restaurar(PRIVADO, PRIVADO, BILLING)).toBe('');
  });
});
