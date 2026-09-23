locals {
  name = "inference-simulator"

  # The deploy role's policy (infra/bootstrap/deploy_policy.tf) grants S3 and
  # CloudWatch Logs access by these name prefixes. Change both stacks together.
  site_bucket_prefix = "${local.name}-site-"
  log_bucket_prefix  = "${local.name}-logs-"

  account_id = data.aws_caller_identity.current.account_id
}

data "aws_caller_identity" "current" {}
