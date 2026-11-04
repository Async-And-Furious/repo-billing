// Preenche os placeholders ${nome} dos manifests de k8s/ no pipeline de deploy (ADR-0015).
//
// ${nome} recebe o valor da variável de ambiente NOME (maiúscula). Um placeholder sem valor
// é erro: nunca se aplica um manifesto pela metade. Só entram no erro os nomes que o arquivo
// referencia, então um manifesto que ainda não usa uma variável (ex.: MP_WEBHOOK_SECRET antes
// do merge da #325) é renderizado sem exigi-la.
//
// Cada valor sai como string JSON, que é YAML válido: PEM com quebras de linha, URLs e senhas
// com caracteres especiais não quebram a indentação. Por isso os placeholders devem ficar sem
// aspas ao redor no template (ex.: `KAFKA_BROKERS: ${kafka_brokers}`).
//
// Uso: node scripts/deploy/render-k8s.mjs <diretorio-de-saida> <manifest>...

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLACEHOLDER = /\$\{([a-z][a-z0-9_]*)\}/g;

export function renderizar(texto, ambiente) {
  const semValor = new Set();
  const saida = texto.replace(PLACEHOLDER, (_, nome) => {
    const variavel = nome.toUpperCase();
    const valor = ambiente[variavel];
    if (valor === undefined || valor === '') {
      semValor.add(variavel);
      return '';
    }
    return JSON.stringify(valor);
  });
  if (semValor.size > 0) {
    throw new Error(`variáveis sem valor: ${[...semValor].join(', ')}`);
  }
  return saida;
}

function main([destino, ...origens]) {
  if (!destino || origens.length === 0) {
    console.error('uso: node scripts/deploy/render-k8s.mjs <diretorio-de-saida> <manifest>...');
    process.exit(2);
  }
  mkdirSync(destino, { recursive: true });
  for (const origem of origens) {
    const saida = renderizar(readFileSync(origem, 'utf8'), process.env);
    writeFileSync(join(destino, basename(origem)), saida);
    console.log(`renderizado: ${origem}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (erro) {
    console.error(`render-k8s: ${erro.message}`);
    process.exit(1);
  }
}
