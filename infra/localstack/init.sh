#!/bin/sh
set -eu
ENDPOINT="${AWS_ENDPOINT_URL:-http://localstack:4566}"
aws --endpoint-url="$ENDPOINT" s3 mb s3://woundcare-audit
aws --endpoint-url="$ENDPOINT" s3 mb s3://woundcare-raw
aws --endpoint-url="$ENDPOINT" s3 mb s3://woundcare-curated
aws --endpoint-url="$ENDPOINT" dynamodb create-table \
  --table-name woundcare-idempotency \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
