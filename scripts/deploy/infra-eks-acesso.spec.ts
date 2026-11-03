import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Testa a função real de infra.sh: extrai `eks_acesso_restaurado` do script e a roda no bash.
const SCRIPT = join(__dirname, 'infra.sh');
const funcao = (() => {
  const texto = readFileSync(SCRIPT, 'utf8');
  const inicio = texto.indexOf('eks_acesso_restaurado() {');
  const fim = texto.indexOf('\n}\n', inicio);
  return texto.slice(inicio, fim + 2);
})();

const ADMIN = '10.0.0.1/32';
const BILLING = '1.1.1.1/32';
const OS = '2.2.2.2/32';

const config = (publico: boolean, cidrs: string[]) => ({
  endpointPrivateAccess: true,
  endpointPublicAccess: publico,
  publicAccessCidrs: cidrs,
});

function restaurar(
  original: ReturnType<typeof config>,
  atual: ReturnType<typeof config>,
  cidrRunner: string
): string {
  const dir = mkdtempSync(join(tmpdir(), 'eks-acesso-'));
  try {
    writeFileSync(join(dir, 'original.json'), JSON.stringify(original));
    writeFileSync(join(dir, 'atual.json'), JSON.stringify(atual));
    return execFileSync(
      'bash',
      [
        '-c',
        `${funcao}\neks_acesso_restaurado "$1" "$2" "$3"`,
        'teste',
        join(dir, 'original.json'),
        join(dir, 'atual.json'),
        cidrRunner,
      ],
      { encoding: 'utf8' }
    ).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  it('acesso público originalmente desligado volta a desligado quando ninguém mais usa', () => {
    expect(
      restaurar(config(false, ['0.0.0.0/0']), config(true, ['0.0.0.0/0', BILLING]), BILLING)
    ).toBe('endpointPrivateAccess=true,endpointPublicAccess=false,publicAccessCidrs=0.0.0.0/0');
  });

  it('acesso público fica ligado enquanto outro deploy ainda usa o endpoint', () => {
    expect(
      restaurar(config(false, ['0.0.0.0/0']), config(true, ['0.0.0.0/0', BILLING, OS]), BILLING)
    ).toBe(
      `endpointPrivateAccess=true,endpointPublicAccess=true,publicAccessCidrs=0.0.0.0/0,${OS}`
    );
  });

  it('IP do runner que já estava na lista original não é removido', () => {
    expect(restaurar(config(true, [ADMIN, BILLING]), config(true, [ADMIN, BILLING]), BILLING)).toBe(
      ''
    );
  });

  it('endpoint já restaurado: nada a fazer', () => {
    expect(restaurar(config(true, [ADMIN]), config(true, [ADMIN]), BILLING)).toBe('');
  });
});
