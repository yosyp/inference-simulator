# The deploy workflow reads the first three after apply (infra/README.md, step 6).

output "site_bucket_name" {
  description = "Bucket that aws s3 sync uploads the build to."
  value       = aws_s3_bucket.site.id
}

output "cloudfront_distribution_id" {
  description = "Distribution to invalidate after upload."
  value       = aws_cloudfront_distribution.site.id
}

output "site_url" {
  description = "Public URL of the site."
  value       = "https://${var.site_domain}"
}

output "log_bucket_name" {
  description = "Bucket that receives CloudFront access logs (90-day expiry)."
  value       = aws_s3_bucket.logs.id
}
