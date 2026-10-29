#!/usr/bin/env bash
# Resolve a infra e os segredos do deploy HML do Billing (issue #327).
#
# Uso: scripts/deploy/infra.sh <ecr|infra|segredos|eks-abrir|eks-restaurar>
#
#   ecr            nome do repositório ECR tc3-billing-hml (state do repo-k8s-infra)
#   infra          cluster, target group e banco do Billing (states do repo-k8s-infra e do repo-db-infra)
#   segredos       DATABASE_URL, senha do Kafka e chave pública JWT (Secrets Manager e SSM)
#   eks-abrir      libera temporariamente o IP do runner no endpoint público do EKS
#   eks-restaurar  devolve o endpoint do EKS ao estado salvo por eks-abrir
#
# Saídas: no GitHub Actions, variáveis vão para $GITHUB_ENV, saídas de step para $GITHUB_OUTPUT
# e mensagens para $GITHUB_STEP_SUMMARY. Fora do Actions, tudo sai no stdout (para teste local).
# Nenhum valor sensível é impresso: segredos passam por ::add-mask:: antes de qualquer uso.

set -euo pipefail

DEPLOY_ENV=hml
AWS_REGION="${AWS_REGION:-us-east-1}"
WORK_DIR="${RUNNER_TEMP:-$(mktemp -d)}"

erro() {
  echo "infra.sh: $*" >&2
  exit 1
}

mascarar() {
  local linha
  while IFS= read -r linha; do
    if [[ -n "$linha" ]]; then
      printf '::add-mask::%s\n' "$linha"
    fi
  done <<<"$1"
}

# saida <nome> <valor>: vai para $GITHUB_OUTPUT (saída de step).
saida() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  else
    printf '%s=%s\n' "$1" "$2"
  fi
}

# exportar <nome> <valor>: vai para $GITHUB_ENV (suporta valor com quebras de linha).
exportar() {
  local nome="$1" valor="$2"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    local delimitador="${nome}_${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-0}"
    printf '%s<<%s\n%s\n%s\n' "$nome" "$delimitador" "$valor" "$delimitador" >>"$GITHUB_ENV"
  else
    printf '%s=%s\n' "$nome" "$valor"
  fi
}

resumo() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"
  else
    printf '%s\n' "$1"
  fi
}

conta_aws() {
  aws sts get-caller-identity --query Account --output text
}

# baixar_estado <repo>: copia o tfstate HML do repositório de infra e devolve o caminho local.
baixar_estado() {
  local repo="$1" destino="$WORK_DIR/${1}-${DEPLOY_ENV}.tfstate"
  aws s3 cp "s3://tc3-tfstate-${CONTA}/${repo}/${DEPLOY_ENV}/terraform.tfstate" "$destino" --only-show-errors
  printf '%s' "$destino"
}

ecr() {
  local estado repositorio
  CONTA=$(conta_aws)
  estado=$(baixar_estado repo-k8s-infra)
  repositorio=$(jq -er '.outputs.ecr_repository_names.value.billing' "$estado")
  saida repository "$repositorio"
}

infra() {
  local k8s db tg cluster rds_arn db_host db_port db_name db_ssl
  CONTA=$(conta_aws)
  k8s=$(baixar_estado repo-k8s-infra)
  db=$(baixar_estado repo-db-infra)

  tg=$(jq -er '.outputs.service_target_group_arns.value.billing' "$k8s")
  [[ "$tg" =~ ^arn:aws(-[a-z0-9-]+)?:elasticloadbalancing:[a-z0-9-]+:[0-9]{12}:targetgroup/[A-Za-z0-9._+=/@-]+/[0-9a-fA-F]+$ ]] \
    || erro "target group do billing ausente ou inválido no state do repo-k8s-infra"

  rds_arn=$(jq -er '.outputs.db_billing_secret_arn.value' "$db")
  db_host=$(jq -er '.outputs.db_host.value' "$db")
  db_port=$(jq -er '.outputs.db_port.value | tostring' "$db")
  db_name=$(jq -er '.outputs.db_billing_name.value' "$db")
  db_ssl=$(jq -er '.outputs.db_ssl_mode.value' "$db")
  mascarar "$rds_arn"
  mascarar "$db_host"

  cluster=$(jq -er '.outputs.cluster_name.value' "$k8s")
  exportar CLUSTER_NAME "$cluster"
  exportar TARGET_GROUP_ARN "$tg"
  exportar RDS_SECRET_ARN "$rds_arn"
  exportar DB_HOST "$db_host"
  exportar DB_PORT "$db_port"
  exportar DB_NAME "$db_name"
  exportar DB_SSLMODE "$db_ssl"
}

segredos() {
  local rds usuario senha kafka kafka_senha jwt url
  : "${RDS_SECRET_ARN:?RDS_SECRET_ARN ausente (rode infra antes)}"
  : "${DB_HOST:?DB_HOST ausente}"
  : "${DB_PORT:?DB_PORT ausente}"
  : "${DB_NAME:?DB_NAME ausente}"
  : "${DB_SSLMODE:?DB_SSLMODE ausente}"
  : "${JWT_PUBLIC_KEY_PARAMETER_NAME:?JWT_PUBLIC_KEY_PARAMETER_NAME ausente (variável do environment hml)}"
  # Checado aqui, antes de abrir o endpoint do EKS, para não falhar no meio do deploy.
  : "${MP_ACCESS_TOKEN:?MP_ACCESS_TOKEN ausente (secret do environment hml)}"
  : "${MP_NOTIFICATION_URL:?MP_NOTIFICATION_URL ausente (variável do environment hml)}"

  rds=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$RDS_SECRET_ARN" --query SecretString --output text)
  usuario=$(jq -er '.username' <<<"$rds")
  senha=$(jq -er '.password' <<<"$rds")
  [[ -n "$senha" ]] || erro "senha do banco vazia no secret do RDS"
  mascarar "$usuario"
  mascarar "$senha"
  url="postgresql://$(jq -rn --arg v "$usuario" '$v|@uri'):$(jq -rn --arg v "$senha" '$v|@uri')@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=${DB_SSLMODE}&connection_limit=3"
  mascarar "$url"

  kafka=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "tc3/kafka/${DEPLOY_ENV}" --query SecretString --output text)
  kafka_senha=$(jq -er '.password' <<<"$kafka")
  [[ -n "$kafka_senha" ]] || erro "senha do Kafka vazia no secret tc3/kafka/${DEPLOY_ENV}"
  mascarar "$kafka_senha"

  jwt=$(aws ssm get-parameter --region "$AWS_REGION" --name "$JWT_PUBLIC_KEY_PARAMETER_NAME" --with-decryption --query 'Parameter.Value' --output text)
  [[ -n "$jwt" && "$jwt" != 'None' ]] || erro "chave pública JWT vazia no SSM"
  mascarar "$jwt"

  exportar DATABASE_URL "$url"
  exportar KAFKA_SASL_PASSWORD "$kafka_senha"
  exportar JWT_PUBLIC_KEY "$jwt"
}

eks_estado_original() {
  printf '%s' "$WORK_DIR/eks-endpoint-original.json"
}

# atualizar_acesso_eks <configuração de resources-vpc-config>: espera o update terminar com sucesso.
atualizar_acesso_eks() {
  local acesso="$1" erro_arquivo update_id status deadline
  erro_arquivo=$(mktemp)
  deadline=$((SECONDS + 600))
  while ! update_id=$(aws eks update-cluster-config --region "$AWS_REGION" --name "$CLUSTER_NAME" \
    --resources-vpc-config "$acesso" --query 'update.id' --output text 2>"$erro_arquivo"); do
    grep -q ResourceInUseException "$erro_arquivo" || { cat "$erro_arquivo" >&2; rm -f "$erro_arquivo"; return 1; }
    (( SECONDS < deadline )) || { echo 'Tempo esgotado aguardando a vez de atualizar o endpoint do EKS.' >&2; rm -f "$erro_arquivo"; return 1; }
    sleep 10
  done
  rm -f "$erro_arquivo"

  deadline=$((SECONDS + 600))
  while (( SECONDS < deadline )); do
    status=$(aws eks describe-update --region "$AWS_REGION" --name "$CLUSTER_NAME" --update-id "$update_id" --query 'update.status' --output text)
    case "$status" in
      Successful) return 0 ;;
      Failed|Cancelled) echo "Atualização do endpoint do EKS terminou com status $status." >&2; return 1 ;;
    esac
    sleep 10
  done
  echo 'Tempo esgotado aguardando a atualização do endpoint do EKS.' >&2
  return 1
}

eks_abrir() {
  local estado ip acesso
  : "${CLUSTER_NAME:?CLUSTER_NAME ausente (rode infra antes)}"
  estado=$(eks_estado_original)
  aws eks describe-cluster --region "$AWS_REGION" --name "$CLUSTER_NAME" \
    --query 'cluster.resourcesVpcConfig.{endpointPrivateAccess:endpointPrivateAccess,endpointPublicAccess:endpointPublicAccess,publicAccessCidrs:publicAccessCidrs}' \
    --output json >"$estado"

  ip=$(curl --fail --silent --show-error --ipv4 --proto '=https' https://checkip.amazonaws.com | tr -d '[:space:]')
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || erro "IP do runner inesperado"

  acesso=$(jq -r --arg cidr "$ip/32" \
    '"endpointPrivateAccess=\(.endpointPrivateAccess),endpointPublicAccess=true,publicAccessCidrs=\(([.publicAccessCidrs[]?, $cidr] | unique) | join(","))"' \
    "$estado")
  atualizar_acesso_eks "$acesso"
  resumo "Acesso temporário do runner ($ip/32) ao EKS HML liberado."
}

eks_restaurar() {
  local estado acesso
  estado=$(eks_estado_original)
  if [[ ! -s "$estado" ]]; then
    resumo 'Sem estado salvo do endpoint do EKS (o acesso nunca foi aberto); nada a restaurar.'
    return 0
  fi
  : "${CLUSTER_NAME:?CLUSTER_NAME ausente: sem ele não há como restaurar o endpoint}"
  acesso=$(jq -r \
    '"endpointPrivateAccess=\(.endpointPrivateAccess),endpointPublicAccess=\(.endpointPublicAccess)" + (if (.publicAccessCidrs | length) > 0 then ",publicAccessCidrs=" + (.publicAccessCidrs | join(",")) else "" end)' \
    "$estado")
  atualizar_acesso_eks "$acesso"
  resumo 'Endpoint do EKS HML restaurado para a configuração original.'
}

CONTA=""
case "${1:-}" in
  ecr | infra | segredos)
    "$1"
    ;;
  eks-abrir)
    eks_abrir
    ;;
  eks-restaurar)
    eks_restaurar
    ;;
  *)
    echo "uso: $0 <ecr|infra|segredos|eks-abrir|eks-restaurar>" >&2
    exit 2
    ;;
esac
