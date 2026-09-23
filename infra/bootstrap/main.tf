locals {
  name       = "inference-simulator"
  account_id = data.aws_caller_identity.current.account_id

  # These must match infra/site: the bucket name prefixes and log delivery
  # names in infra/site/main.tf and logging.tf, and the state key in
  # infra/site/versions.tf.
  site_bucket_prefix = "${local.name}-site-"
  log_bucket_prefix  = "${local.name}-logs-"
  site_state_key     = "site/terraform.tfstate"
}

data "aws_caller_identity" "current" {}

data "aws_route53_zone" "site" {
  name         = var.zone_name
  private_zone = false
}
