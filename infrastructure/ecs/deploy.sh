#!/usr/bin/env bash
# Provisions the iquantum-daemon ECS service + ALB on first run.
# Safe to re-run — checks for existing resources before creating.
# Prerequisites: aws CLI configured, jq installed, ACM cert issued for api.iquantum.co
set -euo pipefail

REGION="eu-north-1"
ACCOUNT="606096000251"
CLUSTER="iquantum-ayhamjo7"
SERVICE="iquantum-daemon"
FAMILY="iquantum-daemon"
VPC_ID="$(aws ec2 describe-vpcs --region "$REGION" \
  --filters "Name=isDefault,Values=true" \
  --query 'Vpcs[0].VpcId' --output text)"
SUBNETS="subnet-00e7c283c7e22f944,subnet-0eada34fa10045729,subnet-0451df18b0b17c05a"
SG="sg-079c14d0ce0e6336b"

echo "=== 1. CloudWatch log groups ==="
aws logs create-log-group --log-group-name /ecs/iquantum-daemon --region "$REGION" 2>/dev/null || true
aws logs create-log-group --log-group-name /ecs/iquantum-sandbox --region "$REGION" 2>/dev/null || true

echo "=== 2. IAM role: iquantumDaemonTaskRole ==="
if ! aws iam get-role --role-name iquantumDaemonTaskRole &>/dev/null; then
  aws iam create-role --role-name iquantumDaemonTaskRole \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }'
  aws iam put-role-policy --role-name iquantumDaemonTaskRole \
    --policy-name iquantum-daemon-policy \
    --policy-document '{
      "Version":"2012-10-17",
      "Statement":[{
        "Effect":"Allow",
        "Action":[
          "ecs:RunTask","ecs:StopTask","ecs:DescribeTasks","ecs:ExecuteCommand",
          "ssmmessages:CreateControlChannel","ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel","ssmmessages:OpenDataChannel",
          "elasticfilesystem:ClientMount","elasticfilesystem:ClientWrite",
          "logs:CreateLogStream","logs:PutLogEvents",
          "iam:PassRole"
        ],
        "Resource":"*"
      }]
    }'
  echo "created iquantumDaemonTaskRole"
else
  echo "iquantumDaemonTaskRole already exists"
fi

echo "=== 3. AWS Secrets Manager: iquantum-daemon ==="
if ! aws secretsmanager describe-secret --secret-id iquantum-daemon --region "$REGION" &>/dev/null; then
  echo "Creating secret — fill in values after creation:"
  aws secretsmanager create-secret \
    --name iquantum-daemon \
    --region "$REGION" \
    --secret-string '{
      "ANTHROPIC_API_KEY":"FILL_ME_IN",
      "JWT_SECRET":"FILL_ME_IN",
      "DATABASE_URL":"FILL_ME_IN",
      "REDIS_URL":"FILL_ME_IN",
      "STRIPE_SECRET_KEY":"FILL_ME_IN",
      "STRIPE_WEBHOOK_SECRET":"FILL_ME_IN"
    }'
  echo "⚠  Update secret values: aws secretsmanager update-secret --secret-id iquantum-daemon --region $REGION --secret-string '{...}'"
else
  echo "secret iquantum-daemon already exists"
fi

echo "=== 4. Register ECS task definitions ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json file://"$SCRIPT_DIR/daemon-task-definition.json"
aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json file://"$SCRIPT_DIR/sandbox-task-definition.json"
echo "task definitions registered"

echo "=== 5. ALB + target group ==="
# Target group
TG_ARN="$(aws elbv2 describe-target-groups --region "$REGION" \
  --names iquantum-daemon 2>/dev/null | jq -r '.TargetGroups[0].TargetGroupArn // empty' 2>/dev/null || true)"
if [[ -z "$TG_ARN" ]]; then
  TG_ARN="$(aws elbv2 create-target-group \
    --region "$REGION" \
    --name iquantum-daemon \
    --protocol HTTP \
    --port 51820 \
    --vpc-id "$VPC_ID" \
    --target-type ip \
    --health-check-path /health \
    --health-check-interval-seconds 30 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)"
  echo "created target group: $TG_ARN"
else
  echo "target group already exists: $TG_ARN"
fi

# ALB
ALB_ARN="$(aws elbv2 describe-load-balancers --region "$REGION" \
  --names iquantum-daemon 2>/dev/null | jq -r '.LoadBalancers[0].LoadBalancerArn // empty' 2>/dev/null || true)"
if [[ -z "$ALB_ARN" ]]; then
  SUBNET_LIST="${SUBNETS//,/ }"
  ALB_ARN="$(aws elbv2 create-load-balancer \
    --region "$REGION" \
    --name iquantum-daemon \
    --scheme internet-facing \
    --type application \
    --subnets $SUBNET_LIST \
    --security-groups "$SG" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
  echo "created ALB: $ALB_ARN"

  # HTTP → HTTPS redirect
  aws elbv2 create-listener \
    --region "$REGION" \
    --load-balancer-arn "$ALB_ARN" \
    --protocol HTTP --port 80 \
    --default-actions '[{"Type":"redirect","RedirectConfig":{"Protocol":"HTTPS","Port":"443","StatusCode":"HTTP_301"}}]'

  # HTTPS listener — requires ACM cert ARN
  echo ""
  echo "⚠  To complete HTTPS setup, run:"
  echo "   ACM_CERT_ARN=arn:aws:acm:eu-north-1:${ACCOUNT}:certificate/<your-cert-id>"
  echo "   aws elbv2 create-listener --region $REGION \\"
  echo "     --load-balancer-arn $ALB_ARN \\"
  echo "     --protocol HTTPS --port 443 \\"
  echo "     --certificates CertificateArn=\$ACM_CERT_ARN \\"
  echo "     --default-actions Type=forward,TargetGroupArn=$TG_ARN"
else
  echo "ALB already exists: $ALB_ARN"
fi

echo "=== 6. ECS service ==="
if ! aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" \
  --services "$SERVICE" | jq -e '.services[0].status == "ACTIVE"' &>/dev/null; then
  SUBNET_LIST_JSON="$(echo "$SUBNETS" | python3 -c "import sys; s=sys.stdin.read().strip(); print('['+','.join('\"'+x+'\"' for x in s.split(','))+']')")"
  aws ecs create-service \
    --region "$REGION" \
    --cluster "$CLUSTER" \
    --service-name "$SERVICE" \
    --task-definition "$FAMILY" \
    --desired-count 1 \
    --launch-type FARGATE \
    --enable-execute-command \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
    --load-balancers "targetGroupArn=$TG_ARN,containerName=daemon,containerPort=51820" \
    --health-check-grace-period-seconds 30
  echo "ECS service created"
else
  echo "ECS service already exists"
fi

echo ""
echo "=== Done ==="
ALB_DNS="$(aws elbv2 describe-load-balancers --region "$REGION" \
  --load-balancer-arns "$ALB_ARN" \
  --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null || echo 'unknown')"
echo "ALB DNS: $ALB_DNS"
echo "Next steps:"
echo "  1. Point api.iquantum.co CNAME → $ALB_DNS"
echo "  2. Issue ACM cert for api.iquantum.co and add HTTPS listener (see above)"
echo "  3. Update iquantum-daemon secret with real values"
echo "  4. Run: aws ecs update-service --cluster $CLUSTER --service $SERVICE --force-new-deployment"
