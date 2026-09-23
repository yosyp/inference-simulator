variable "site_domain" {
  description = "Full hostname the site is served at, a subdomain of zone_name. CI passes it from the SITE_DOMAIN secret as TF_VAR_site_domain."
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
