# Least privilege for what infra/site manages, plus the upload and invalidation
# that follow apply. The role has no IAM permissions. Changing this policy means
# a local apply of this stack; CI can't change it.
#
# Where AWS allows it, access is scoped to this site: S3 by bucket name prefix,
# CloudWatch Logs delivery by name prefix, Route 53 by record name, and new
# certificates by domain name. CloudFront IDs are random, so distributions and
# policies are scoped to the account. After the first deploy, setting
# site_distribution_id limits the distribution permissions to the site's own.

locals {
  state_bucket_arn = aws_s3_bucket.state.arn
  site_bucket_arn  = "arn:aws:s3:::${local.site_bucket_prefix}*"
  log_bucket_arn   = "arn:aws:s3:::${local.log_bucket_prefix}*"

  distribution_arn = "arn:aws:cloudfront::${local.account_id}:distribution/${coalesce(var.site_distribution_id, "*")}"

  log_delivery_arns = [
    "arn:aws:logs:us-east-1:${local.account_id}:delivery-source:${local.name}-*",
    "arn:aws:logs:us-east-1:${local.account_id}:delivery-destination:${local.name}-*",
    "arn:aws:logs:us-east-1:${local.account_id}:delivery:*",
  ]
}

data "aws_iam_policy_document" "deploy" {
  # --- Terraform state: the site key and its lock file only (K20) ---

  # The S3 backend lists the bucket to find workspaces, and S3 needs ListBucket
  # to answer a missing state object with 404 rather than 403 on the first run.
  # Listing shows key names only; the state bucket policy denies this role every
  # object under bootstrap/.
  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = [local.state_bucket_arn]
  }

  statement {
    sid       = "StateReadWrite"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${local.state_bucket_arn}/${local.site_state_key}"]
  }

  statement {
    sid       = "StateLock"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.state_bucket_arn}/${local.site_state_key}.tflock"]
  }

  # --- Site and log buckets ---

  # Reads made by the aws_s3_bucket refresh and its companion resources.
  statement {
    sid = "BucketsRead"
    actions = [
      "s3:ListBucket",
      "s3:GetBucket*",
      "s3:GetAccelerateConfiguration",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
    ]
    resources = [local.site_bucket_arn, local.log_bucket_arn]
  }

  statement {
    sid = "BucketsManage"
    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:PutBucketPolicy",
      "s3:DeleteBucketPolicy",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketOwnershipControls",
      "s3:PutEncryptionConfiguration",
      "s3:PutLifecycleConfiguration",
      "s3:PutBucketTagging",
      "s3:TagResource",
    ]
    resources = [local.site_bucket_arn, local.log_bucket_arn]
  }

  # aws s3 sync --delete uploads the build and prunes old files. The role
  # can't read or write log objects.
  statement {
    sid       = "SiteObjects"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.site_bucket_arn}/*"]
  }

  # --- CloudFront ---

  # Create calls can't be scoped to a resource.
  statement {
    sid = "CloudFrontCreate"
    actions = [
      "cloudfront:CreateDistribution",
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:CreateCachePolicy",
      "cloudfront:CreateResponseHeadersPolicy",
    ]
    resources = ["*"]
  }

  statement {
    sid = "CloudFrontDistribution"
    actions = [
      "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig",
      "cloudfront:UpdateDistribution",
      "cloudfront:DeleteDistribution",
      "cloudfront:ListTagsForResource",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
      # Lets CloudWatch Logs attach the standard logging v2 delivery source.
      "cloudfront:AllowVendedLogDeliveryForResource",
    ]
    resources = [local.distribution_arn]
  }

  statement {
    sid = "CloudFrontPolicies"
    actions = [
      "cloudfront:GetOriginAccessControl",
      "cloudfront:GetOriginAccessControlConfig",
      "cloudfront:UpdateOriginAccessControl",
      "cloudfront:DeleteOriginAccessControl",
      "cloudfront:GetCachePolicy",
      "cloudfront:GetCachePolicyConfig",
      "cloudfront:UpdateCachePolicy",
      "cloudfront:DeleteCachePolicy",
      "cloudfront:GetResponseHeadersPolicy",
      "cloudfront:GetResponseHeadersPolicyConfig",
      "cloudfront:UpdateResponseHeadersPolicy",
      "cloudfront:DeleteResponseHeadersPolicy",
    ]
    resources = [
      "arn:aws:cloudfront::${local.account_id}:origin-access-control/*",
      "arn:aws:cloudfront::${local.account_id}:cache-policy/*",
      "arn:aws:cloudfront::${local.account_id}:response-headers-policy/*",
    ]
  }

  # --- ACM (us-east-1) ---

  statement {
    sid       = "CertificateRequest"
    actions   = ["acm:RequestCertificate"]
    resources = ["*"]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "acm:DomainNames"
      values   = [var.site_domain]
    }

    condition {
      test     = "StringEquals"
      variable = "acm:ValidationMethod"
      values   = ["DNS"]
    }
  }

  statement {
    sid = "CertificateManage"
    actions = [
      "acm:DescribeCertificate",
      "acm:DeleteCertificate",
      "acm:UpdateCertificateOptions",
      "acm:ListTagsForCertificate",
      "acm:AddTagsToCertificate",
      "acm:RemoveTagsFromCertificate",
    ]
    resources = ["arn:aws:acm:us-east-1:${local.account_id}:certificate/*"]
  }

  # --- Route 53: the one zone, and only the site's records ---

  statement {
    sid       = "DnsFindZone"
    actions   = ["route53:ListHostedZones", "route53:ListHostedZonesByName"]
    resources = ["*"]
  }

  statement {
    sid = "DnsReadZone"
    actions = [
      "route53:GetHostedZone",
      "route53:ListResourceRecordSets",
      "route53:ListTagsForResource",
    ]
    resources = [data.aws_route53_zone.site.arn]
  }

  statement {
    sid       = "DnsChangeStatus"
    actions   = ["route53:GetChange"]
    resources = ["arn:aws:route53:::change/*"]
  }

  # The alias records for the site and the ACM validation CNAMEs under it.
  statement {
    sid       = "DnsSiteRecords"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = [data.aws_route53_zone.site.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values   = [var.site_domain, "_*.${var.site_domain}"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsRecordTypes"
      values   = ["A", "AAAA", "CNAME"]
    }
  }

  # --- CloudWatch Logs vended delivery (standard logging v2) ---

  statement {
    sid = "LogDelivery"
    actions = [
      "logs:PutDeliverySource",
      "logs:GetDeliverySource",
      "logs:DeleteDeliverySource",
      "logs:PutDeliveryDestination",
      "logs:GetDeliveryDestination",
      "logs:DeleteDeliveryDestination",
      "logs:CreateDelivery",
      "logs:GetDelivery",
      "logs:DeleteDelivery",
      "logs:UpdateDeliveryConfiguration",
      "logs:ListTagsForResource",
      "logs:TagResource",
      "logs:UntagResource",
    ]
    resources = local.log_delivery_arns
  }

  statement {
    sid = "LogDeliveryDescribe"
    actions = [
      "logs:DescribeDeliveries",
      "logs:DescribeDeliverySources",
      "logs:DescribeDeliveryDestinations",
      "logs:DescribeConfigurationTemplates",
    ]
    resources = ["*"]
  }
}
