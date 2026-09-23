# CloudFront standard logging v2 (06 §7, K20). CloudWatch Logs vended delivery
# writes access logs into the log bucket without bucket ACLs. The delivery
# source must be created in us-east-1, where the provider runs.

resource "aws_cloudwatch_log_delivery_source" "cloudfront" {
  name         = "${local.name}-cloudfront"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.site.arn
}

resource "aws_cloudwatch_log_delivery_destination" "logs_bucket" {
  name = "${local.name}-logs-bucket"

  # W3C is the tab-separated layout of legacy CloudFront logs, which common log
  # tools already read. AWS can't change it in place; changing it replaces the
  # destination and the delivery.
  output_format = "w3c"

  delivery_destination_configuration {
    destination_resource_arn = aws_s3_bucket.logs.arn
  }
}

resource "aws_cloudwatch_log_delivery" "cloudfront_to_s3" {
  delivery_source_name     = aws_cloudwatch_log_delivery_source.cloudfront.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.logs_bucket.arn

  # CloudFront prefixes this with AWSLogs/<account-id>/CloudFront/, which is
  # the path the log bucket policy allows. Daily folders make it easy to count
  # visits for a day.
  s3_delivery_configuration = [{
    suffix_path                 = "{yyyy}/{MM}/{dd}"
    enable_hive_compatible_path = false
  }]

  depends_on = [aws_s3_bucket_policy.logs]
}
