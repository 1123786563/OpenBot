#!/bin/sh
set -eu
: "${AWS_ACCESS_KEY_ID:?Set RustFS bootstrap access key}"
: "${AWS_SECRET_ACCESS_KEY:?Set RustFS bootstrap secret key}"
bucket=${S3_BUCKET:?}
endpoint=${S3_ENDPOINT:?}
# Create if absent. Existing objects and policies stay intact unless explicitly configured below.
if ! aws --endpoint-url "$endpoint" s3api head-bucket --bucket "$bucket"; then
  aws --endpoint-url "$endpoint" s3api create-bucket --bucket "$bucket"
fi
aws --endpoint-url "$endpoint" s3api put-bucket-cors --bucket "$bucket" \
  --cors-configuration "{\"CORSRules\":[{\"AllowedOrigins\":[\"${OPIK_BROWSER_ORIGIN:?}\"],\"AllowedMethods\":[\"GET\",\"PUT\",\"HEAD\"],\"AllowedHeaders\":[\"*\"],\"ExposeHeaders\":[\"ETag\"]}]}"
if [ "${OPIK_S3_PUBLIC_DOWNLOAD:-false}" = true ]; then
  aws --endpoint-url "$endpoint" s3api put-bucket-policy --bucket "$bucket" \
    --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":[\"s3:GetObject\"],\"Resource\":[\"arn:aws:s3:::$bucket/*\"]}]}"
fi
