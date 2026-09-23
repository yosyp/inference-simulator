# Response headers come from headers.json, the single source of truth that the
# production-CSP smoke test also serves (06 §5, WP I4). Each header maps either
# to a structured field of the CloudFront response headers policy or to a custom
# header sent verbatim. A header in the file that this code doesn't map fails
# `terraform validate`, so nothing in headers.json is silently dropped.

locals {
  headers_file = jsondecode(file("${path.module}/headers.json"))

  # Header names are case-insensitive: match on lower case, and keep the file's
  # spelling for custom headers.
  headers = {
    for name, value in local.headers_file : lower(name) => { name = name, value = value }
  }

  # CloudFront sets these through security_headers_config.
  security_header_names = [
    "content-security-policy",
    "strict-transport-security",
    "x-content-type-options",
    "referrer-policy",
  ]

  # CloudFront sends these verbatim through custom_headers_config. To add a
  # header that has no structured field, list it here.
  custom_header_names = ["permissions-policy"]

  csp                  = try(local.headers["content-security-policy"].value, null)
  referrer_policy      = try(local.headers["referrer-policy"].value, null)
  content_type_options = try(local.headers["x-content-type-options"].value, null)

  # Strict-Transport-Security, split into directives. CloudFront builds the
  # header from max-age, includeSubDomains, and preload.
  hsts_present    = contains(keys(local.headers), "strict-transport-security")
  hsts_directives = [for d in split(";", try(local.headers["strict-transport-security"].value, "")) : trimspace(d) if trimspace(d) != ""]
  hsts_max_age    = [for d in local.hsts_directives : tonumber(regex("^(?i)max-age=([0-9]+)$", d)[0]) if can(regex("^(?i)max-age=[0-9]+$", d))]
  hsts_flags      = [for d in local.hsts_directives : lower(d)]
  hsts_unknown    = [for d in local.hsts_directives : d if !can(regex("^(?i)(max-age=[0-9]+|includesubdomains|preload)$", d))]

  custom_headers = [
    for name in local.custom_header_names : local.headers[name] if contains(keys(local.headers), name)
  ]

  header_problems = concat(
    [
      for key, header in local.headers : "${header.name} has no mapping in headers.tf"
      if !contains(concat(local.security_header_names, local.custom_header_names), key)
    ],
    [for d in local.hsts_unknown : "Strict-Transport-Security directive \"${d}\" is not supported"],
    local.hsts_present && length(local.hsts_max_age) != 1 ? ["Strict-Transport-Security needs exactly one max-age=<seconds>"] : [],
    lower(trimspace(coalesce(local.content_type_options, "nosniff"))) != "nosniff" ? ["X-Content-Type-Options must be nosniff, the only value CloudFront sends"] : [],
  )

  # Terraform has no raise(), so tobool() on the message is what fails. The
  # error names every problem, and it appears in `terraform validate` as well
  # as plan, because both evaluate locals.
  headers_checked = length(local.header_problems) == 0 ? true : tobool("headers.json: ${join("; ", local.header_problems)}")
}

resource "aws_cloudfront_response_headers_policy" "site" {
  name    = "${local.name}-security-headers"
  comment = "Built from infra/site/headers.json"

  security_headers_config {
    dynamic "content_security_policy" {
      for_each = local.csp == null ? [] : [local.csp]

      content {
        content_security_policy = content_security_policy.value
        override                = true
      }
    }

    dynamic "strict_transport_security" {
      for_each = local.hsts_present ? [one(local.hsts_max_age)] : []

      content {
        access_control_max_age_sec = strict_transport_security.value
        include_subdomains         = contains(local.hsts_flags, "includesubdomains")
        preload                    = contains(local.hsts_flags, "preload")
        override                   = true
      }
    }

    dynamic "content_type_options" {
      for_each = local.content_type_options == null ? [] : [local.content_type_options]

      content {
        override = true
      }
    }

    dynamic "referrer_policy" {
      for_each = local.referrer_policy == null ? [] : [local.referrer_policy]

      content {
        referrer_policy = referrer_policy.value
        override        = true
      }
    }
  }

  dynamic "custom_headers_config" {
    for_each = length(local.custom_headers) == 0 ? [] : [local.custom_headers]

    content {
      dynamic "items" {
        for_each = custom_headers_config.value

        content {
          header   = items.value.name
          value    = items.value.value
          override = true
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = local.headers_checked
      error_message = "headers.json has a header that headers.tf does not map."
    }
  }
}
