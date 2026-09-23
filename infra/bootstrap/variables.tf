variable "site_domain" {
  description = "Full hostname of the site, the same value as the SITE_DOMAIN secret. The deploy role may change DNS records and request certificates for this name only."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.site_domain)) && endswith(var.site_domain, ".${var.zone_name}")
    error_message = "site_domain must be a lower-case hostname under zone_name, with no scheme, path, or trailing dot."
  }
}

variable "zone_name" {
  description = "Public Route 53 hosted zone, in this account, that holds the site's DNS records."
  type        = string
  nullable    = false
  default     = "yoschwab.com"
}

variable "github_oidc_subject_prefix" {
  description = <<-EOT
    The part of this repository's GitHub OIDC subject claim before ":ref:". The
    deploy role trusts "<prefix>:ref:refs/heads/prod". Repositories created after
    2026-07-15 use the immutable form repo:OWNER@OWNER_ID/REPO@REPO_ID. Read the
    prefix with:
      gh api repos/yosyp/inference-simulator/actions/oidc/customization/sub --jq .sub_claim_prefix
  EOT
  type        = string
  nullable    = false
  default     = "repo:yosyp/inference-simulator"

  validation {
    condition     = can(regex("^repo:yosyp(@[0-9]+)?/inference-simulator(@[0-9]+)?$", var.github_oidc_subject_prefix))
    error_message = "github_oidc_subject_prefix must name yosyp/inference-simulator, optionally with the numeric owner and repository IDs: repo:yosyp@<id>/inference-simulator@<id>."
  }
}

variable "create_oidc_provider" {
  description = "Create the GitHub OIDC identity provider. An account can hold only one per URL, so set this to false if it already exists, and the stack looks it up instead."
  type        = bool
  nullable    = false
  default     = true
}

variable "site_distribution_id" {
  description = "Optional hardening after the first deploy: the site's CloudFront distribution ID (the cloudfront_distribution_id output of infra/site). When set, the deploy role's distribution permissions cover only that distribution instead of every distribution in the account."
  type        = string
  default     = null

  validation {
    condition     = var.site_distribution_id == null || can(regex("^E[A-Z0-9]+$", var.site_distribution_id))
    error_message = "site_distribution_id must be a CloudFront distribution ID such as E1ABCDEFGHIJKL."
  }
}
